// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Lease-termination memory cleanup for Sandbox Agent.
 *
 * Deletes a terminated lease's LTM records: every actor's records under the
 * lease.
 *
 * STM events (raw conversation turns) are NOT deleted here: they expire through
 * the User memory's 30-day `eventExpiryDuration`, and are unreachable meanwhile
 * because the Worker and history API reject terminated leases.
 */

import {
  BatchDeleteMemoryRecordsCommand,
  BedrockAgentCoreClient,
  paginateListMemoryRecords,
} from "@aws-sdk/client-bedrock-agentcore";
import { STSClient } from "@aws-sdk/client-sts";

import { chunk } from "@amzn/innovation-sandbox-commons/data/utils.js";
import { memoryIdFromArn } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/sandbox-agent.service.js";
import { leaseMemoryNamespace } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/sandbox-agent.types.js";
import {
  acquireLeaseMemoryCleanupCredentials,
  type ScopedCredentials,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/scoped-credentials.js";

const LTM_DELETE_BATCH_SIZE = 100;
const LIST_PAGE_SIZE = 100;

export interface CleanupLeaseMemoryProps {
  stsClient: STSClient;
  bedrockClientFactory: (creds: ScopedCredentials) => BedrockAgentCoreClient;
  memoryAccessRoleArn: string;
  userMemoryArn: string;
  leaseId: string;
}

interface CleanupLeaseMemoryCounts {
  ltmDeleted: number;
  /** LTM records still present after the delete pass. */
  ltmResidual: number;
}

export interface CleanupLeaseMemoryCompleteResult extends CleanupLeaseMemoryCounts {
  status: "complete";
}

export interface CleanupLeaseMemoryFailedResult extends CleanupLeaseMemoryCounts {
  status: "failed";
}

export type CleanupLeaseMemoryResult =
  CleanupLeaseMemoryCompleteResult | CleanupLeaseMemoryFailedResult;

export async function cleanupLeaseMemory(
  props: CleanupLeaseMemoryProps,
): Promise<CleanupLeaseMemoryCompleteResult> {
  const {
    stsClient,
    bedrockClientFactory,
    memoryAccessRoleArn,
    userMemoryArn,
    leaseId,
  } = props;

  const memoryId = memoryIdFromArn(userMemoryArn);
  const leaseNamespace = leaseMemoryNamespace(leaseId);

  const creds = await acquireLeaseMemoryCleanupCredentials({
    stsClient,
    memoryAccessRoleArn,
    memoryResourceArn: userMemoryArn,
    leaseId,
  }).catch((error: unknown) => fail("credentials", errorDetails(error)));

  if (!creds) {
    return fail("credentials", {
      errorMessage: "Failed to acquire scoped memory credentials for cleanup.",
    });
  }

  const client = bedrockClientFactory(creds);

  const deletedIds = await deleteLtmRecords(
    client,
    memoryId,
    leaseNamespace,
  ).catch((error: unknown) => fail("delete", errorDetails(error)));
  const ltmDeleted = deletedIds.size;

  // Verify: re-list; nothing may remain except records this pass just deleted,
  // which the list keeps returning for a while after the delete succeeds.
  // Residual LTM is usually late extraction writing records after the delete
  // pass. LTM has no expiry, so it fails the cleanup and the retry sweeps it;
  // the queue's delivery delay makes this rare.
  const ltmResidual = await countLtmRecords(
    client,
    memoryId,
    leaseNamespace,
    deletedIds,
  ).catch((error: unknown) =>
    fail("verify", { ...errorDetails(error), ltmDeleted }),
  );

  if (ltmResidual > 0) {
    return fail("verify", {
      ltmResidual,
      ltmDeleted,
      errorMessage: `Verification found ${ltmResidual} residual LTM records.`,
    });
  }

  return { ltmDeleted, ltmResidual, status: "complete" };
}

export type CleanupPhase = "credentials" | "delete" | "verify";

/**
 * Raised on any cleanup failure so the caller can retry. Carries what the
 * caller needs to log it: the failing phase and the underlying error's name.
 */
export class MemoryCleanupError extends Error {
  constructor(
    message: string,
    readonly phase: CleanupPhase,
    readonly result: CleanupLeaseMemoryFailedResult,
    readonly causeName?: string,
  ) {
    super(message);
    this.name = "MemoryCleanupError";
  }
}

function errorDetails(error: unknown) {
  return {
    errorName: error instanceof Error ? error.name : undefined,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
}

function describeError(error: unknown): string {
  const { errorName, errorMessage } = errorDetails(error);
  return errorName ? `${errorName}: ${errorMessage}` : errorMessage;
}

interface FailureDetails {
  ltmResidual?: number;
  ltmDeleted?: number;
  errorName?: string;
  errorMessage?: string;
}

function fail(phase: CleanupPhase, extra: FailureDetails): never {
  throw new MemoryCleanupError(
    extra.errorMessage ?? `Memory cleanup failed in ${phase} phase.`,
    phase,
    {
      ltmDeleted: extra.ltmDeleted ?? 0,
      ltmResidual: extra.ltmResidual ?? 0,
      status: "failed",
    },
    extra.errorName,
  );
}

/**
 * Deletes every actor's LTM records under the lease.
 *
 * Returns the ids that are gone: deleted now, or already deleted. A retry can
 * list a record an earlier attempt deleted (the list is eventually consistent)
 * and then get 404 for it, which is the outcome cleanup wants, not a failure.
 */
async function deleteLtmRecords(
  client: BedrockAgentCoreClient,
  memoryId: string,
  leaseNamespace: string,
): Promise<Set<string>> {
  const records = await listLeaseRecords(client, memoryId, leaseNamespace);

  const deletedMemoryRecords = new Set<string>();
  let failed = 0;
  let firstFailure: string | undefined;
  let firstCallError: unknown;
  for (const batch of chunk(records, LTM_DELETE_BATCH_SIZE)) {
    const outcome = await deleteBatch(client, memoryId, batch);
    outcome.deletedMemoryRecords.forEach((id) => deletedMemoryRecords.add(id));
    failed += outcome.failed;
    firstFailure ??= outcome.failure;
    firstCallError ??= outcome.callError;
  }

  if (failed > 0) {
    throw new Error(
      `BatchDeleteMemoryRecords failed for ${failed} of ${records.length} record(s); first failure ${firstFailure}`,
      { cause: firstCallError },
    );
  }

  return deletedMemoryRecords;
}

interface LeaseRecord {
  memoryRecordId: string;
  namespace: string;
}

async function listLeaseRecords(
  client: BedrockAgentCoreClient,
  memoryId: string,
  leaseNamespace: string,
): Promise<LeaseRecord[]> {
  const records: LeaseRecord[] = [];
  for await (const page of paginateListMemoryRecords(
    { client, pageSize: LIST_PAGE_SIZE },
    { memoryId, namespacePath: leaseNamespace },
  )) {
    for (const record of page.memoryRecordSummaries ?? []) {
      const namespace = record.namespaces?.find((candidate) =>
        candidate.startsWith(leaseNamespace),
      );
      if (record.memoryRecordId && namespace) {
        records.push({ memoryRecordId: record.memoryRecordId, namespace });
      }
    }
  }
  return records;
}

interface BatchOutcome {
  deletedMemoryRecords: string[];
  failed: number;
  failure?: string;
  /** Set when the call itself failed, rather than individual records. */
  callError?: unknown;
}

async function deleteBatch(
  client: BedrockAgentCoreClient,
  memoryId: string,
  batch: LeaseRecord[],
): Promise<BatchOutcome> {
  let result;
  try {
    result = await client.send(
      new BatchDeleteMemoryRecordsCommand({ memoryId, records: batch }),
    );
  } catch (error) {
    return {
      deletedMemoryRecords: [],
      failed: batch.length,
      failure: describeError(error),
      callError: error,
    };
  }
  const deletedMemoryRecords = (result.successfulRecords ?? []).flatMap(
    (record) => (record.memoryRecordId ? [record.memoryRecordId] : []),
  );
  const rejected = [];
  for (const record of result.failedRecords ?? []) {
    if (record.errorCode === 404 && record.memoryRecordId) {
      deletedMemoryRecords.push(record.memoryRecordId);
    } else {
      rejected.push(record);
    }
  }
  const first = rejected[0];
  return {
    deletedMemoryRecords,
    failed: rejected.length,
    failure: first
      ? `${first.errorCode ?? "unknown"}: ${first.errorMessage ?? "no message"}`
      : undefined,
  };
}

async function countLtmRecords(
  client: BedrockAgentCoreClient,
  memoryId: string,
  leaseNamespace: string,
  deletedIds: ReadonlySet<string>,
): Promise<number> {
  let residual = 0;
  for await (const page of paginateListMemoryRecords(
    { client, pageSize: LIST_PAGE_SIZE },
    { memoryId, namespacePath: leaseNamespace },
  )) {
    residual += (page.memoryRecordSummaries ?? []).filter(
      (record) =>
        !record.memoryRecordId || !deletedIds.has(record.memoryRecordId),
    ).length;
  }
  return residual;
}

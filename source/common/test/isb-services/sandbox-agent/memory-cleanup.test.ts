// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BatchDeleteMemoryRecordsCommand,
  BedrockAgentCoreClient,
  ListMemoryRecordsCommand,
  type MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  cleanupLeaseMemory,
  MemoryCleanupError,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/memory-cleanup.js";

const USER_MEMORY_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/MEM123";
const MEMORY_ACCESS_ROLE_ARN =
  "arn:aws:iam::123456789012:role/MemoryAccessRole";
// Only names a user namespace in the fixtures: cleanup itself takes no actor.
const ACTOR_ID = "alice-at-example-d-com";
const LEASE_ID = "11111111-2222-4333-8444-555555555555";

const stsClient = new STSClient({});
const mockSts = mockClient(stsClient);
const bedrockClient = new BedrockAgentCoreClient({});
const mockBedrock = mockClient(bedrockClient);

/** What BatchDeleteMemoryRecords returns when every record is deleted. */
async function deleteSucceeds(input: {
  records?: { memoryRecordId?: string }[];
}) {
  return {
    successfulRecords: (input.records ?? []).map((record) => ({
      memoryRecordId: record.memoryRecordId,
      status: "SUCCEEDED" as const,
    })),
    failedRecords: [],
  };
}

function makeProps(
  overrides: Partial<Parameters<typeof cleanupLeaseMemory>[0]> = {},
) {
  return {
    stsClient,
    bedrockClientFactory: () => bedrockClient,
    memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
    userMemoryArn: USER_MEMORY_ARN,
    leaseId: LEASE_ID,
    ...overrides,
  };
}

async function runCleanup(
  overrides: Partial<Parameters<typeof cleanupLeaseMemory>[0]> = {},
) {
  return cleanupLeaseMemory(makeProps(overrides));
}

const LEASE_NAMESPACE = `/lease/${LEASE_ID}/`;
const OWNER_NAMESPACE = `${LEASE_NAMESPACE}user/${ACTOR_ID}/`;

/**
 * N memory records with distinct ids, namespaced under one actor on the lease.
 * The namespace matters: cleanup deletes each record with its OWN namespace, so
 * a record without one cannot be deleted.
 */
const records = (
  n: number,
  prefix = "r",
  namespace = OWNER_NAMESPACE,
): MemoryRecordSummary[] =>
  Array.from(
    { length: n },
    (_, i) =>
      ({
        memoryRecordId: `${prefix}-${i}`,
        namespaces: [namespace],
      }) as MemoryRecordSummary,
  );

beforeEach(() => {
  mockSts.reset();
  mockBedrock.reset();
  mockSts.on(AssumeRoleCommand).resolves({
    Credentials: {
      AccessKeyId: "AKIA",
      SecretAccessKey: "secret",
      SessionToken: "token",
      Expiration: new Date(),
    },
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("cleanupLeaseMemory", () => {
  it("empty lease: completes with zero deletions", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolves({ memoryRecordSummaries: [] });

    const result = await runCleanup();

    expect(result).toEqual({
      status: "complete",
      ltmDeleted: 0,
      ltmResidual: 0,
    });
  });

  it("150 LTM records delete across 2 BatchDelete batches", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(100), nextToken: "p2" })
      .resolvesOnce({ memoryRecordSummaries: records(50, "r2") })
      .resolves({ memoryRecordSummaries: [] }); // verify re-list
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).callsFake(deleteSucceeds);

    const result = await runCleanup();

    expect(result.ltmDeleted).toBe(150);
    const batches = mockBedrock.commandCalls(BatchDeleteMemoryRecordsCommand);
    expect(batches).toHaveLength(2);
    expect(batches[0]!.args[0].input.records).toHaveLength(100);
    expect(batches[1]!.args[0].input.records).toHaveLength(50);
  });

  it("attempts every LTM batch before failing when one fails", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(100), nextToken: "p2" })
      .resolvesOnce({ memoryRecordSummaries: records(50, "r2") })
      .resolves({ memoryRecordSummaries: [] });
    mockBedrock
      .on(BatchDeleteMemoryRecordsCommand)
      .rejectsOnce(new Error("persistent failure"))
      .callsFake(deleteSucceeds);

    await expect(runCleanup()).rejects.toThrow(
      "BatchDeleteMemoryRecords failed for 100 of 150 record(s); first failure Error: persistent failure",
    );
    expect(
      mockBedrock.commandCalls(BatchDeleteMemoryRecordsCommand),
    ).toHaveLength(2);
  });

  it("deletes every user's LTM records on a shared lease in one sweep", async () => {
    // The point of the lease-first namespace: cleanup never learns who chatted,
    // so a shared lease must be swept without naming each participant.
    const otherNamespace = `${LEASE_NAMESPACE}user/bob-at-example-d-com/`;
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({
        memoryRecordSummaries: [
          ...records(2, "owner"),
          ...records(3, "bob", otherNamespace),
        ],
      })
      .resolves({ memoryRecordSummaries: [] }); // verify re-list
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).callsFake(deleteSucceeds);

    const result = await runCleanup();

    expect(result.ltmDeleted).toBe(5);
    const sent = mockBedrock.commandCalls(BatchDeleteMemoryRecordsCommand)[0]!
      .args[0].input.records;
    // Each record carries its OWN namespace — the lease path would be rejected
    // by the session policy's per-record condition.
    expect(sent).toEqual([
      { memoryRecordId: "owner-0", namespace: OWNER_NAMESPACE },
      { memoryRecordId: "owner-1", namespace: OWNER_NAMESPACE },
      { memoryRecordId: "bob-0", namespace: otherNamespace },
      { memoryRecordId: "bob-1", namespace: otherNamespace },
      { memoryRecordId: "bob-2", namespace: otherNamespace },
    ]);
  });

  it("lists LTM by namespacePath, so the lease's whole hierarchy is swept", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolves({ memoryRecordSummaries: [] });

    await runCleanup();

    // `namespace` is an exact match and would find nothing at the lease level;
    // `namespacePath` matches the hierarchy under it.
    for (const call of mockBedrock.commandCalls(ListMemoryRecordsCommand)) {
      expect(call.args[0].input.namespacePath).toBe(LEASE_NAMESPACE);
      expect(call.args[0].input.namespace).toBeUndefined();
    }
  });

  it("requests only lease-wide LTM credentials, with no STM access", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolves({ memoryRecordSummaries: [] });

    await runCleanup();

    const policies = mockSts
      .commandCalls(AssumeRoleCommand)
      .map((call) => JSON.stringify(JSON.parse(call.args[0].input.Policy!)));
    expect(policies).toHaveLength(1);
    // Lease-wide reads are listing only, and each record's delete is
    // authorized against its own namespace, so another lease's record fails.
    expect(policies[0]).toContain("namespacePath");
    expect(policies[0]).toContain('"bedrock-agentcore:namespace"');
    // STM is left to the memory's 30-day expiry: no event access at all.
    expect(policies[0]).not.toContain("ListEvents");
    expect(policies[0]).not.toContain("DeleteEvent");
    expect(policies[0]).not.toContain("RetrieveMemoryRecords");
  });

  it("throws MemoryCleanupError when an LTM batch delete fails", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(5) })
      .resolves({ memoryRecordSummaries: [] });
    mockBedrock
      .on(BatchDeleteMemoryRecordsCommand)
      .rejects(new Error("persistent failure"));

    await expect(runCleanup()).rejects.toBeInstanceOf(MemoryCleanupError);
  });

  it("throws MemoryCleanupError when BatchDelete reports failed records", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(5) })
      .resolves({ memoryRecordSummaries: [] });
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).resolves({
      failedRecords: [{ memoryRecordId: "r-0", status: "FAILED" }],
    });

    await expect(runCleanup()).rejects.toThrow(
      "BatchDeleteMemoryRecords failed for 1 of 5 record(s)",
    );
  });

  it("includes the failed call's error so a denied delete is diagnosable", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(3) })
      .resolves({ memoryRecordSummaries: [] });
    const denied = new Error("User is not authorized to perform ...");
    denied.name = "AccessDeniedException";
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).rejects(denied);

    await expect(runCleanup()).rejects.toThrow(
      "failed for 3 of 3 record(s); first failure AccessDeniedException: User is not authorized to perform ...",
    );
  });

  it("includes the first record's failure reason so a denied delete is diagnosable", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(2) })
      .resolves({ memoryRecordSummaries: [] });
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).resolves({
      failedRecords: [
        {
          memoryRecordId: "r-0",
          status: "FAILED",
          errorCode: 403,
          errorMessage: "Not authorized for namespace",
        },
        { memoryRecordId: "r-1", status: "FAILED" },
      ],
    });

    await expect(runCleanup()).rejects.toThrow(
      "failed for 2 of 2 record(s); first failure 403: Not authorized for namespace",
    );
  });

  it("throws MemoryCleanupError when a verify list call fails", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: [] }) // delete pass
      .rejects(new Error("list failed")); // verify

    await expect(runCleanup()).rejects.toBeInstanceOf(MemoryCleanupError);
  });

  it("finds a late record on a later verify page, behind a full page of just-deleted ones", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      // delete pass: 100 records on one page
      .resolvesOnce({ memoryRecordSummaries: records(100) })
      // verify page 1: all 100 just deleted, still listed
      .resolvesOnce({ memoryRecordSummaries: records(100), nextToken: "p2" })
      // verify page 2: a record extracted after the delete pass
      .resolvesOnce({ memoryRecordSummaries: records(1, "late") });
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).callsFake(deleteSucceeds);

    const error = await runCleanup().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MemoryCleanupError);
    expect((error as MemoryCleanupError).result).toMatchObject({
      ltmDeleted: 100,
      ltmResidual: 1,
    });
  });

  it("passes verification while the list still returns records it just deleted", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(3) }) // delete pass
      .resolves({ memoryRecordSummaries: records(3) }); // verify: list not caught up yet
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).callsFake(deleteSucceeds);

    expect(await runCleanup()).toEqual({
      ltmDeleted: 3,
      ltmResidual: 0,
      status: "complete",
    });
  });

  it("treats a record already deleted by an earlier attempt (404) as deleted, not failed", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(2) }) // retry lists stale records
      .resolves({ memoryRecordSummaries: [] });
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).resolves({
      successfulRecords: [],
      failedRecords: [0, 1].map((i) => ({
        memoryRecordId: `r-${i}`,
        status: "FAILED" as const,
        errorCode: 404,
        errorMessage: "Memory record not found",
      })),
    });

    expect(await runCleanup()).toMatchObject({
      ltmDeleted: 2,
      status: "complete",
    });
  });

  it("fails verification when LTM records remain (late extraction), so the retry sweeps them", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: records(3) }) // delete pass
      .resolves({ memoryRecordSummaries: records(2, "late") }); // verify: 2 late records
    mockBedrock.on(BatchDeleteMemoryRecordsCommand).callsFake(deleteSucceeds);

    const error = await runCleanup().catch((e: unknown) => e);

    expect(error).toBeInstanceOf(MemoryCleanupError);
    expect((error as MemoryCleanupError).result).toMatchObject({
      status: "failed",
      ltmDeleted: 3,
      ltmResidual: 2,
    });
  });

  it("fails when scoped credentials cannot be acquired", async () => {
    mockSts.reset();
    mockSts.on(AssumeRoleCommand).resolves({});

    await expect(runCleanup()).rejects.toBeInstanceOf(MemoryCleanupError);
  });

  it("raises a credentials failure carrying its phase and cause", async () => {
    mockSts.reset();
    mockSts.on(AssumeRoleCommand).rejects(new Error("AccessDenied"));

    const error = await runCleanup().catch((e: unknown) => e);

    // The handler logs from these fields; cleanup itself does not log.
    expect(error).toBeInstanceOf(MemoryCleanupError);
    expect(error).toMatchObject({
      phase: "credentials",
      causeName: "Error",
      message: "AccessDenied",
    });
  });

  it("raises a verify failure carrying its phase", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: [] }) // delete pass
      .resolves({ memoryRecordSummaries: records(1, "late") }); // verify

    const error = await runCleanup().catch((e: unknown) => e);

    expect(error).toMatchObject({ phase: "verify" });
  });
});

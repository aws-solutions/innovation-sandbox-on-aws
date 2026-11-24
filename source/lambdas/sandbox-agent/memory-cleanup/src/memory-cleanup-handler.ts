// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SQSEvent } from "aws-lambda";

import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  cleanupLeaseMemory,
  MemoryCleanupError,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  SandboxAgentMemoryCleanupLambdaEnvironment,
  SandboxAgentMemoryCleanupLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-memory-cleanup-lambda-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";

const serviceName = "SandboxAgentMemoryCleanup";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: SandboxAgentMemoryCleanupLambdaEnvironmentSchema,
  moduleName: "sandbox-agent-memory-cleanup",
}).handler(handleLeaseTerminated);

/**
 * Deletes a terminated lease's LTM records for every user on the lease. Runs off
 * its own queue rather than the ordered account-lifecycle queue, so a retry
 * never holds up unrelated lifecycle events.
 */
async function handleLeaseTerminated(
  sqsEvent: SQSEvent,
  context: IsbLambdaContext<SandboxAgentMemoryCleanupLambdaEnvironment>,
) {
  if (sqsEvent.Records.length > 1) {
    throw new Error(
      "Only one event is supported per invocation, please check your event source mapping.",
    );
  }
  const record = sqsEvent.Records[0]!;
  const event = JSON.parse(record.body);
  // Lease-scoped: cleanup sweeps every user's records under the lease, so it
  // needs no actor identity (and no owner email to encode one from).
  const { uuid: leaseId } = LeaseTerminatedEvent.parse(event.detail).Detail
    .leaseId;

  const attempt = receiveCount(record.attributes.ApproximateReceiveCount);
  // An unknown receive count is treated as final, so a failure is reported
  // rather than dropped.
  const isFinalAttempt =
    attempt === undefined || attempt >= Number(context.env.MAX_RECEIVE_COUNT);

  // Rethrows on failure so SQS retries this idempotent cleanup.
  const { ltmDeleted } = await cleanupLeaseMemory({
    stsClient: IsbClients.sts(context.env),
    bedrockClientFactory: (creds) =>
      IsbClients.bedrockAgentCore(context.env, creds),
    memoryAccessRoleArn: context.env.MEMORY_ACCESS_ROLE_ARN,
    userMemoryArn: context.env.USER_MEMORY_ARN,
    leaseId,
  }).catch((error: unknown) => {
    logCleanupFailure(error, { leaseId, attempt, isFinalAttempt });
    throw error;
  });

  logger.info("Memory cleanup complete", {
    logDetailType: "MemoryCleanupComplete",
    leaseId,
    ltmDeleted,
    attempt,
  } satisfies SubscribableLog);
}

/**
 * Only the final failed attempt is logged as `MemoryCleanupFailed`, the
 * solution metric: that is the one that reaches the DLQ. Earlier failures are
 * retries and log as warnings.
 */
function logCleanupFailure(
  error: unknown,
  context: { leaseId: string; attempt?: number; isFinalAttempt: boolean },
): void {
  const { leaseId, attempt, isFinalAttempt } = context;
  const cleanupError = error instanceof MemoryCleanupError ? error : undefined;
  const details = {
    leaseId,
    attempt,
    errorName: cleanupError?.causeName,
    errorMessage: error instanceof Error ? error.message : String(error),
  };
  if (!isFinalAttempt) {
    logger.warn("Memory cleanup attempt failed; SQS will retry", {
      ...details,
      phase: cleanupError?.phase,
    });
    return;
  }
  if (cleanupError) {
    logger.error("Memory cleanup failed", {
      logDetailType: "MemoryCleanupFailed",
      ...details,
      phase: cleanupError.phase,
    } satisfies SubscribableLog);
    return;
  }
  // Not a cleanup phase failure (e.g. an unexpected throw): log, not a metric.
  logger.error("Memory cleanup failed unexpectedly", details);
}

/** SQS's receive count as a positive integer; undefined if absent or malformed. */
function receiveCount(value: string | undefined): number | undefined {
  const count = Number(value);
  return Number.isInteger(count) && count > 0 ? count : undefined;
}

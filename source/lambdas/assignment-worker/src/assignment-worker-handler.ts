// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import {
  SendTaskFailureCommand,
  SendTaskSuccessCommand,
} from "@aws-sdk/client-sfn";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import pThrottle from "p-throttle";
import { z } from "zod";

import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  processAssignment,
  ProcessAssignmentServices,
  resolveAssignmentAction,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import {
  AssignmentWorkerEnvironment,
  AssignmentWorkerEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-worker-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import {
  addCorrelationContext,
  searchableAssignmentProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { LeaseLockIntentSchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { PermissionSetArnSchema } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import { PrincipalTypeSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";

const serviceName = "AssignmentWorker";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

// IDC enforces a collective 20 TPS limit across all Identity Center APIs.
// Throttle each worker instance to 1 IDC operation per second; combined with
// the Lambda's reserved concurrency of 5 this caps global IDC writes at ~5 TPS,
// leaving headroom for the read APIs used elsewhere in ISB. Declared at module
// scope so the rate window persists across warm invocations of the same
// instance rather than resetting on every handler call.
const throttle1PerSec = pThrottle({ limit: 1, interval: 1000 });
const throttledProcessAssignment = throttle1PerSec(processAssignment);

type WorkerContext = IsbLambdaContext<AssignmentWorkerEnvironment>;

/** Schema for the SQS message body sent by the Step Function Map state. */
const AssignmentMessageSchema = z.object({
  leaseId: z.string(),
  intent: LeaseLockIntentSchema,
  executionArn: z.string(),
  requestedBy: z.email(),
  requestedAt: z.string(),
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
  accountId: z.string(),
  permissionSetArn: PermissionSetArnSchema,
  leaseOwnerEmail: z.email(),
  email: z.string().optional(),
  displayName: z.string().optional(),
  taskToken: z.string(),
});

type AssignmentMessage = z.infer<typeof AssignmentMessageSchema>;

class SystemPermissionSetGrantError extends Error {
  constructor(permissionSetArn: string) {
    super(`Refusing to grant ISB system permission set ${permissionSetArn}`);
    this.name = "SystemPermissionSetGrantDenied";
  }
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AssignmentWorkerEnvironmentSchema,
  moduleName: "assignment-worker",
}).handler(handleAssignmentWorker);

/**
 * Assignment Worker Lambda — SQS consumer (reserved concurrency: 5).
 *
 * For each message it:
 * 1. Parses the SQS message
 * 2. Computes the action via a JIT diff (lease desired state + current record + intent)
 * 3. Performs the IDC GRANT/REVOKE (or skips on NO_OP) via processAssignment()
 * 4. Reports the result to the Step Function via SendTaskSuccess
 *
 * On failure, the message is returned in batchItemFailures so SQS retries it.
 * On the final attempt (ApproximateReceiveCount >= maxReceiveCount) the worker
 * also calls SendTaskFailure so the Map branch unblocks immediately rather than
 * waiting for the task heartbeat timeout, before the message lands in the DLQ.
 */
async function handleAssignmentWorker(
  event: SQSEvent,
  context: WorkerContext,
): Promise<SQSBatchResponse> {
  const batchItemFailures: { itemIdentifier: string }[] = [];

  for (const record of event.Records) {
    await processRecord(record, context).catch((error: unknown) => {
      logger.error("Unrecoverable error processing assignment message", {
        messageId: record.messageId,
        error: error instanceof Error ? error.message : String(error),
      });
      batchItemFailures.push({ itemIdentifier: record.messageId });
    });
  }

  return { batchItemFailures };
}

async function processRecord(
  record: SQSRecord,
  context: WorkerContext,
): Promise<void> {
  const { env } = context;

  // 1. Parse and validate SQS message
  const message = parseMessage(record.body);
  if (!message) {
    logger.error("Invalid SQS message", { messageId: record.messageId });
    const taskToken = extractTaskToken(record.body);
    if (taskToken) {
      await sendTaskFailure(
        env,
        taskToken,
        "InvalidMessage",
        "SQS message body failed validation",
      );
    }
    throw new Error("SQS message failed validation");
  }

  addCorrelationContext(
    logger,
    searchableAssignmentProperties({
      leaseId: message.leaseId,
      principalId: message.principalId,
      principalType: message.principalType,
      intent: message.intent,
      accountId: message.accountId,
    }),
  );

  logger.info("Resolving assignment action");

  let outcome: Record<string, unknown>;
  try {
    // 2. JIT diff — decide the action at execution time
    const principalStore = IsbServices.principalStore(env);
    const idcStackConfigStore = IsbServices.idcStackConfigStore(env);
    const idcConfig = await idcStackConfigStore.get();

    const action = await resolveAssignmentAction(
      {
        leaseId: message.leaseId,
        leaseOwnerEmail: message.leaseOwnerEmail,
        principalId: message.principalId,
        principalType: message.principalType,
        intent: message.intent,
        permissionSetArn: message.permissionSetArn,
        defaultPermissionSetArn: idcConfig.userPermissionSetArn,
        builtInPermissionSetArn: idcConfig.userPermissionSetArn,
      },
      {
        principalStore,
        leaseStore: IsbServices.leaseStore(env),
        logger,
      },
    );

    if (action === "NO_OP") {
      // Nothing to do — no IDC call, no DDB mutation.
      outcome = {
        status: "SKIPPED",
        principalId: message.principalId,
        principalType: message.principalType,
        action,
      };
    } else {
      if (
        action === "GRANT" &&
        (message.permissionSetArn === idcConfig.adminPermissionSetArn ||
          message.permissionSetArn === idcConfig.managerPermissionSetArn)
      ) {
        throw new SystemPermissionSetGrantError(message.permissionSetArn);
      }

      // 3. Perform the IDC operation (rate-limited to 1/sec per instance)
      const credentials = fromTemporaryIsbIdcCredentials(env);
      const serviceContext: ProcessAssignmentServices = {
        principalStore,
        ssoAdminClient: IsbClients.ssoAdmin(env, credentials),
        idcStackConfigStore,
        logger,
      };

      outcome = {
        ...(await throttledProcessAssignment(
          {
            leaseId: message.leaseId,
            action,
            principalId: message.principalId,
            principalType: message.principalType,
            accountId: message.accountId,
            permissionSetArn: message.permissionSetArn,
            leaseOwnerEmail: message.leaseOwnerEmail,
            email: message.email,
            displayName: message.displayName,
            requestedBy: message.requestedBy,
          },
          serviceContext,
        )),
      };
    }
  } catch (error: unknown) {
    return handleAssignmentFailure(error, record, message, env);
  }

  await sendTaskSuccess(env, message.taskToken, outcome);
  logger.info("Assignment processed successfully", {
    action: outcome.action,
    status: outcome.status,
  });
}

async function handleAssignmentFailure(
  error: unknown,
  record: SQSRecord,
  message: AssignmentMessage,
  env: AssignmentWorkerEnvironment,
): Promise<void> {
  const errorMessage = error instanceof Error ? error.message : String(error);
  const errorName = error instanceof Error ? error.name : "UnknownError";

  if (
    error instanceof SystemPermissionSetGrantError ||
    error instanceof ValidationException
  ) {
    logger.error("Assignment processing rejected", {
      errorName,
      errorMessage,
    });
    await sendTaskFailure(env, message.taskToken, errorName, errorMessage);
    return;
  }

  const receiveCount = Number(record.attributes.ApproximateReceiveCount);
  const isLastAttempt =
    receiveCount >= Number(env.ASSIGNMENT_MAX_RECEIVE_COUNT);

  logger.error("Assignment processing failed", {
    errorName,
    errorMessage,
    receiveCount,
    isLastAttempt,
  });

  // Final attempt: fail the task so the Map branch unblocks immediately
  // rather than waiting for the heartbeat timeout. Earlier attempts stay
  // pending for SQS to retry.
  if (isLastAttempt) {
    await sendTaskFailure(env, message.taskToken, errorName, errorMessage);
  }

  // Rethrow so SQS retries, then DLQ at maxReceiveCount.
  throw error;
}

function parseMessage(body: string): AssignmentMessage | null {
  try {
    const parsed: unknown = JSON.parse(body);
    const result = AssignmentMessageSchema.safeParse(parsed);
    if (!result.success) return null;
    return result.data;
  } catch {
    return null;
  }
}

function extractTaskToken(body: string): string | undefined {
  try {
    const parsed = JSON.parse(body);
    return typeof parsed?.taskToken === "string" ? parsed.taskToken : undefined;
  } catch {
    return undefined;
  }
}

async function sendTaskSuccess(
  env: AssignmentWorkerEnvironment,
  taskToken: string,
  output: Record<string, unknown>,
): Promise<void> {
  const sfnClient = IsbClients.stepFunctions(env);
  await sfnClient.send(
    new SendTaskSuccessCommand({
      taskToken,
      output: JSON.stringify(output),
    }),
  );
}

async function sendTaskFailure(
  env: AssignmentWorkerEnvironment,
  taskToken: string,
  error: string,
  cause: string,
): Promise<void> {
  const sfnClient = IsbClients.stepFunctions(env);
  await sfnClient.send(
    new SendTaskFailureCommand({
      taskToken,
      // Step Functions limits error and cause to 256 characters
      error: error.slice(0, 256),
      cause: cause.slice(0, 256),
    }),
  );
}

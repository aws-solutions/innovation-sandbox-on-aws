// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { PostToConnectionCommand } from "@aws-sdk/client-apigatewaymanagementapi";
import { InvokeAgentRuntimeCommand } from "@aws-sdk/client-bedrock-agentcore";
import type { SQSBatchResponse, SQSEvent, SQSRecord } from "aws-lambda";
import { backOff } from "exponential-backoff";

import { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import {
  currentMonthKey,
  roundSpend,
  SandboxSpacesTokenUsage,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import {
  DiscoveredModel,
  pickDiscoveredModel,
  pickModelPricing,
  priceDiscoveredModels,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  PolicyDocument,
  resolvePermissionSetPolicy,
  UnsupportedPermissionSetBoundaryError,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";
import {
  AGENT_PROTOCOL_VERSION,
  AgentError,
  AgentRequestSchema,
  CHARS_PER_TOKEN_ESTIMATE,
  ConnectionContext,
  FeatureDisabledError,
  LeaseNotActiveError,
  ModelNotAllowedError,
  RUNTIME_ERROR_CODES,
  RuntimeErrorFrameSchema,
  RuntimeInvokePayloadSchema,
  type RuntimeStreamEvent,
  RuntimeStreamEventSchema,
  sendError,
  sendToConnection,
  type TerminalSpendFields,
  validateAndRoute,
  ValidateAndRouteResult,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  getCallerSandboxSpacesEstimatedTokenCost,
  ModelTokenRates,
  priceTurn,
  recordSandboxSpacesTurnUsage,
  RecordSandboxSpacesTurnUsageProps,
  SandboxSpacesUsageServices,
  sumTokenTypes,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-spaces-usage/index.js";
import {
  AgentWorkerLambdaEnvironment,
  AgentWorkerLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/agent-worker-lambda-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbIdcCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { parseLeaseKey } from "@amzn/innovation-sandbox-commons/utils/lease-key.js";
import {
  AgentConfig,
  AgentConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { type LeaseKey } from "@amzn/innovation-sandbox-shared/types/lease.js";

const tracer = new Tracer({ serviceName: "AgentWorker" });
const logger = new Logger({ serviceName: "AgentWorker" });

const SQSMessageBodySchema = AgentRequestSchema;

const REMAINING_TIME_THRESHOLD_MS = 30_000;

const WORKER_ERRORS = {
  modelPricingUnavailable: {
    code: "INVALID_REQUEST",
    message:
      "This model isn't ready to use because its pricing isn't configured. Choose a different model.",
    retryable: false,
  },
  modelNotSupported: {
    code: "INVALID_REQUEST",
    message: "This model can't be used for chat. Choose a different model.",
    retryable: false,
  },
  modelUnavailable: {
    code: "INVALID_REQUEST",
    message:
      "This model isn't available in this account (it may be retired). Choose a different model.",
    retryable: false,
  },
  modelNotAllowed: {
    code: "INVALID_REQUEST",
    message:
      "The selected model isn't available for this Sandbox Space. Choose another model and try again.",
    retryable: false,
  },
  permissionProfileMissing: {
    code: "UNKNOWN_ERROR",
    message:
      "No permissions are assigned to you for this Sandbox Space, so the agent can't run commands. Contact your administrator.",
    retryable: false,
  },
  permissionProfileBoundaryUnsupported: {
    code: "UNKNOWN_ERROR",
    message:
      "Sandbox Spaces can't use your assigned permission set because it has a permissions boundary. Contact your administrator to assign you a permission set without a permissions boundary.",
    retryable: false,
  },
  permissionProfileUnavailable: {
    code: "UNKNOWN_ERROR",
    message:
      "Sandbox Spaces couldn't determine your permissions for this Sandbox Space. Try again, or contact your administrator if this continues.",
    retryable: true,
  },
  featureDisabled: {
    code: "FEATURE_DISABLED",
    message: "Sandbox Spaces is not available for this lease.",
    retryable: false,
  },
  invalidRequest: {
    code: "INVALID_REQUEST",
    message: "The request could not be processed. Try again.",
    retryable: false,
  },
  leaseNotActive: {
    code: "LEASE_NOT_ACTIVE",
    message: "This Sandbox Space is no longer active.",
    retryable: false,
  },
  runtimeError: {
    code: "RUNTIME_ERROR",
    message:
      "The agent could not process your message. Try again, or rephrase your message.",
    retryable: true,
  },
  modelStreamEnded: {
    code: "MODEL_STREAM_ENDED",
    message:
      "The model stopped responding before it finished its reply. Try again.",
    retryable: true,
  },
  contentFiltered: {
    code: "CONTENT_FILTERED",
    message:
      "The model's content filter stopped this reply. Choose a different model and try again.",
    // Resending the same message usually meets the same filter.
    retryable: false,
  },
  modelThrottled: {
    code: "MODEL_THROTTLED",
    message:
      "The model is receiving too many requests right now. Wait a minute, then try again.",
    retryable: true,
  },
  modelTimedOut: {
    code: "MODEL_TIMED_OUT",
    message: "The model took too long to respond. Try again.",
    retryable: true,
  },
  modelServiceUnavailable: {
    code: "MODEL_SERVICE_UNAVAILABLE",
    message:
      "The model service is temporarily unavailable. Try again in a few minutes.",
    retryable: true,
  },
  inputBlocked: {
    code: "INPUT_BLOCKED",
    message:
      "The safety filter blocked this message. Rephrase it as a plain request and try again.",
    retryable: false,
  },
  runtimeErrorAfterTool: {
    code: "RUNTIME_ERROR",
    message:
      "The agent could not finish your request, and some commands may already have run. Check their results before trying again.",
    retryable: false,
  },
  modelStreamEndedAfterTool: {
    code: "MODEL_STREAM_ENDED",
    message:
      "The model stopped responding before it finished its reply, and some commands may already have run. Check their results before trying again.",
    retryable: false,
  },
  contentFilteredAfterTool: {
    code: "CONTENT_FILTERED",
    message:
      "The model's content filter stopped this reply, and some commands may already have run. Check their results, then choose a different model and try again.",
    retryable: false,
  },
  modelThrottledAfterTool: {
    code: "MODEL_THROTTLED",
    message:
      "The model is receiving too many requests right now, and some commands may already have run. Check their results before trying again.",
    retryable: false,
  },
  modelTimedOutAfterTool: {
    code: "MODEL_TIMED_OUT",
    message:
      "The model took too long to respond, and some commands may already have run. Check their results before trying again.",
    retryable: false,
  },
  modelServiceUnavailableAfterTool: {
    code: "MODEL_SERVICE_UNAVAILABLE",
    message:
      "The model service is temporarily unavailable, and some commands may already have run. Check their results before trying again.",
    retryable: false,
  },
  turnInProgress: {
    code: "TURN_IN_PROGRESS",
    message:
      "The agent is already working on a request for this Sandbox Space, possibly from another session. We recommend using a single session.",
    retryable: true,
  },
  timeLimit: {
    code: "TIME_LIMIT",
    message: "The response is taking longer than expected. Try again.",
    retryable: true,
  },
  runtimeTimeLimit: {
    code: "TIME_LIMIT",
    message:
      "The request reached its processing time limit before the response finished. Some requested actions may have completed or may still be in progress. Check their status before trying again.",
    retryable: false,
  },
  responseNotFullyDelivered: {
    code: "UNKNOWN_ERROR",
    message:
      "The agent started working on your request, but the full response wasn't delivered. Check the conversation history before sending it again, because some actions may already be complete.",
    retryable: false,
  },
  completionNotDelivered: {
    code: "UNKNOWN_ERROR",
    message:
      "The response finished, but its completion notice wasn't delivered. Refresh the page if the reply looks incomplete.",
    retryable: false,
  },
} as const;

type WorkerContext = IsbLambdaContext<AgentWorkerLambdaEnvironment>;
type SendFn = (connId: string, data: string) => Promise<void>;

/** Wraps a thrown value in an Error so the logger records its name, message and stack. */
function toError(err: unknown): Error {
  return err instanceof Error ? err : new Error(String(err));
}

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  moduleName: "agent-worker",
  environmentSchema: AgentWorkerLambdaEnvironmentSchema,
}).handler(workerHandler);

async function workerHandler(
  event: SQSEvent,
  context: WorkerContext,
): Promise<SQSBatchResponse> {
  // Sequential processing is safe here because batchSize is fixed at 1 in CDK.
  // If batchSize ever increases, switch to Promise.allSettled for parallel processing.
  for (const record of event.Records) {
    await processRecord(record, context).catch(async (err: unknown) => {
      logger.error("Failed to process SQS record — not redelivering", {
        messageId: record.messageId,
        error: toError(err),
      });
      await notifyProcessingFailure(record, context);
    });
  }

  // Never report a failed record: redelivery would replay the turn and its tools.
  return { batchItemFailures: [] };
}

async function notifyProcessingFailure(
  record: SQSRecord,
  context: WorkerContext,
): Promise<void> {
  const connectionId = record.messageAttributes?.["connectionId"]?.stringValue;
  if (!connectionId) return;
  logger.appendKeys({ messageId: record.messageId });
  await notifyRuntimeError(connectionId, buildSender(context.env));
}

async function processRecord(
  record: SQSRecord,
  context: WorkerContext,
): Promise<void> {
  const env = context.env;

  const connectionId = record.messageAttributes?.["connectionId"]?.stringValue;
  if (!connectionId) {
    logger.warn("SQS record missing connectionId attribute", {
      messageId: record.messageId,
    });
    return;
  }

  const send = buildSender(env);

  if (context.getRemainingTimeInMillis() < REMAINING_TIME_THRESHOLD_MS) {
    await sendError(connectionId, WORKER_ERRORS.timeLimit, send, logger);
    return;
  }

  const request = await parseRequestBody(record, connectionId, send);
  if (!request) return;
  const { message, leaseId, leaseUuid, userId, modelId } = request;
  logger.appendKeys({
    connectionId,
    messageId: record.messageId,
    leaseId,
    modelId,
  });

  const leaseKey = parseLeaseKey(leaseId);
  if (!leaseKey) {
    logger.warn("Invalid lease key in SQS message body", { connectionId });
    await sendError(connectionId, WORKER_ERRORS.invalidRequest, send, logger);
    return;
  }

  const connection = await resolveConnection(connectionId, env);
  if (!connection) return;

  // `leaseUuid` and `userId` are client-declared, so only accept a turn whose
  // ids match the lease key and the user authenticated at $connect.
  if (leaseUuid !== leaseKey.uuid || userId !== connection.userId) {
    logger.warn("SQS message group ids do not match lease key or connection", {
      connectionId,
    });
    await sendError(connectionId, WORKER_ERRORS.invalidRequest, send, logger);
    return;
  }

  const configStore = IsbServices.configStore(env);
  const agentConfigSection = await configStore.getSection("agent");
  const agentConfig = agentConfigSection ?? AgentConfigSchema.parse({});

  // One fresh read of the requested model's row: gates the model and prices the turn.
  const requestedModel = await configStore.getAgentModel(modelId);

  const accountPoolConfig =
    await IsbServices.accountPoolStackConfigStore(env).get();
  const managedRegions = accountPoolConfig.isbManagedRegions;

  const routeResult = await routeMessage(
    {
      connection,
      leaseKey,
      requestedModelId: modelId,
      requestedModel,
      agentConfig,
      connectionId,
    },
    { env, send },
  );
  if (!routeResult) return;

  const { runtimeSessionId, accountId, leaseCurrentSpend } = routeResult;
  const usageServices: SandboxSpacesUsageServices = {
    sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(env),
    logger,
  };

  // Checked before invoke so an unpriced model is never run or charged; fixed for this turn.
  const rates = await readTokenRates(requestedModel, env);
  if (!rates) {
    logger.error("No stored pricing for model — rejecting turn", {
      accountId,
      actorId: connection.actorId,
    });
    await sendError(
      connectionId,
      WORKER_ERRORS.modelPricingUnavailable,
      send,
      logger,
    );
    return;
  }

  const permissionProfileResult = await resolvePermissionProfilePolicy(
    connection,
    env,
    connectionId,
    leaseKey.uuid,
    accountId,
  );

  // Rejected before the runtime is invoked, so the turn is not billed.
  if (!permissionProfileResult.ok) {
    await sendError(
      connectionId,
      PERMISSION_PROFILE_ERRORS[permissionProfileResult.reason],
      send,
      logger,
    );
    return;
  }
  const permissionProfile = permissionProfileResult.profile;

  if (context.getRemainingTimeInMillis() < REMAINING_TIME_THRESHOLD_MS) {
    await sendError(connectionId, WORKER_ERRORS.timeLimit, send, logger);
    return;
  }

  const callerEstimatedTokenCostBefore =
    await getCallerSandboxSpacesEstimatedTokenCost(
      { leaseId: leaseKey.uuid, userId: connection.userId },
      usageServices,
    ).catch((error: unknown) =>
      omitEstimatedTokenCostOnReadFailure(leaseKey.uuid, error),
    );

  const turn = await invokeRuntimeAndStream(
    {
      connection,
      message,
      modelId,
      leaseKey: leaseId,
      routeResult,
      managedRegions,
      permissionProfilePolicy: permissionProfile.sessionPolicy,
      permissionProfileManagedPolicyArns: permissionProfile.managedPolicyArns,
    },
    {
      send,
      env,
      timeoutMs:
        context.getRemainingTimeInMillis() - REMAINING_TIME_THRESHOLD_MS,
    },
  );

  if (turn.status === "failed") {
    return;
  }
  const { tokens, meteringFailed } = turn;

  // Sent from the priced turn, not the record result, so the client never waits on the write.
  const turnEstimatedTokenCost = priceTurn(tokens, rates);
  const terminalSpendFields = {
    ...(callerEstimatedTokenCostBefore !== undefined && {
      callerSandboxSpacesEstimatedTokenCostAccrued: roundSpend(
        callerEstimatedTokenCostBefore + turnEstimatedTokenCost,
      ),
    }),
    leaseCurrentSpend,
  } satisfies TerminalSpendFields;
  if (turn.status === "ok") {
    await sendCompleteFrame(
      {
        connectionId,
        messageId: record.messageId,
        runtimeSessionId,
        terminalSpendFields,
      },
      send,
    );
  } else {
    await notifyRuntimeError(
      connectionId,
      send,
      turn.error,
      terminalSpendFields,
    );
  }

  // Priced with the model submitted for this turn, never a later selection.
  await recordUsageWithRetry(
    {
      leaseId: leaseKey.uuid,
      userId: connection.userId,
      userEmail: connection.email,
      messageId: record.messageId,
      month: currentMonthKey(),
      modelId,
      tokens,
      sandboxSpacesEstimatedTokenCostAccrued: turnEstimatedTokenCost,
      sessionId: runtimeSessionId,
    },
    usageServices,
  );

  logMeteringFailure({ meteringFailed, modelId, tokens });

  logTurnOutcome(turn.status, {
    connectionId,
    ...tokens,
    meteringFailed,
    sandboxSpacesEstimatedTokenCostAccrued: turnEstimatedTokenCost,
  });
}

/** Sends the complete frame for a fully streamed turn, retrying 3 times; a persistent failure is logged and followed by a terminal error frame. */
async function sendCompleteFrame(
  props: {
    connectionId: string;
    messageId: string;
    runtimeSessionId: string;
    terminalSpendFields: TerminalSpendFields;
  },
  send: SendFn,
): Promise<void> {
  const { connectionId, messageId, runtimeSessionId, terminalSpendFields } =
    props;
  await backOff(
    () =>
      sendToConnection(
        connectionId,
        {
          version: AGENT_PROTOCOL_VERSION,
          type: "complete",
          conversationId: runtimeSessionId,
          messageId,
          ...terminalSpendFields,
        },
        send,
        logger,
      ),
    { numOfAttempts: 3, startingDelay: 200, maxDelay: 800 },
  ).catch(async (error: unknown) => {
    logger.error("Failed to send completed agent turn", {
      connectionId,
      messageId,
      error: toError(error),
    });
    // Without a terminal frame the chat input stays locked until the user reloads.
    await notifyRuntimeError(
      connectionId,
      send,
      WORKER_ERRORS.completionNotDelivered,
      terminalSpendFields,
    );
  });
}

/** Logs a success for a completed turn and a warning for one that ended early. */
function logTurnOutcome(
  status: "ok" | "billedError",
  outcome: Record<string, unknown>,
): void {
  if (status === "ok") {
    logger.info("Worker completed successfully", outcome);
  } else {
    logger.warn("Worker recorded a turn that ended early", outcome);
  }
}

/** Logs the record the metering-failure alarm counts. */
function logMeteringFailure(props: {
  meteringFailed: boolean;
  modelId: string;
  tokens: SandboxSpacesTokenUsage;
}): void {
  const { meteringFailed, modelId, tokens } = props;
  if (!meteringFailed) return;
  logger.error("Agent turn usage missing — recorded estimate", {
    logDetailType: "AgentTurnMeteringFailed",
    modelId,
    estimatedInputTokens: tokens.inputTokens,
  } satisfies SubscribableLog);
}

type SQSMessageBody = ReturnType<typeof SQSMessageBodySchema.parse>;

/**
 * Parses the SQS record body. Returns undefined after telling the client when
 * the body is malformed; the message is dropped, not retried.
 */
async function parseRequestBody(
  record: SQSRecord,
  connectionId: string,
  send: SendFn,
): Promise<SQSMessageBody | undefined> {
  let body: unknown;
  try {
    body = JSON.parse(record.body);
  } catch (err: unknown) {
    logger.warn(
      "Malformed SQS message body (non-JSON) — dropping, not retrying",
      {
        connectionId,
        error: toError(err),
      },
    );
    await sendError(connectionId, WORKER_ERRORS.invalidRequest, send, logger);
    return undefined;
  }
  const parsed = SQSMessageBodySchema.safeParse(body);
  if (!parsed.success) {
    logger.warn("Invalid SQS message body", {
      connectionId,
      error: parsed.error.message,
    });
    await sendError(connectionId, WORKER_ERRORS.invalidRequest, send, logger);
    return undefined;
  }
  return parsed.data;
}

/**
 * Rates a turn is priced at, from the Bedrock regional price table for this
 * Lambda's region. A price that is missing or over 24 hours old is fetched from
 * the pricing APIs and saved. If the fetch finds no price, the stored one is
 * used even when it is stale. Undefined when the model has no price at all.
 */
async function readTokenRates(
  model: PersistedAgentModelCatalogRow | undefined,
  env: AgentWorkerLambdaEnvironment,
): Promise<ModelTokenRates | undefined> {
  if (!model) {
    return undefined;
  }
  const region = process.env["AWS_REGION"];
  if (!region) {
    throw new Error("AWS_REGION is not set");
  }
  const prices = await priceDiscoveredModels([toDiscoveredModel(model)], {
    priceCache: IsbServices.bedrockPriceCache(env),
    pricingServices: {
      bedrockClient: IsbClients.bedrock(env),
      pricingClient: IsbClients.pricing(env),
      region,
      logger,
    },
  });
  const price = prices.get(model.modelId);
  if (!price) {
    return undefined;
  }
  return pickModelPricing(price);
}

/** A catalog row as the model details a price is fetched with. */
function toDiscoveredModel(
  row: PersistedAgentModelCatalogRow,
): DiscoveredModel {
  return pickDiscoveredModel({
    ...row,
    // Rows created before these fields existed lack them.
    modelType: row.modelType ?? "foundation-model",
    foundationModelId: row.foundationModelId ?? row.modelId,
    foundationModelName: row.foundationModelName ?? row.displayName,
  });
}

/** Logs a failed display-only caller usage read; terminal frames omit the caller total. */
function omitEstimatedTokenCostOnReadFailure(
  leaseId: string,
  error: unknown,
): undefined {
  logger.warn("Sandbox Spaces usage read failed — omitting it from the reply", {
    scope: "caller",
    leaseId,
    error: toError(error),
  });
  return undefined;
}

function buildSender(env: AgentWorkerLambdaEnvironment): SendFn {
  const mgmtClient = IsbClients.apiGatewayManagement(env);
  return async (connId: string, data: string): Promise<void> => {
    await mgmtClient.send(
      new PostToConnectionCommand({
        ConnectionId: connId,
        Data: Buffer.from(data),
      }),
    );
  };
}

/** Reads connection context from DDB. Returns null if not found (caller should return early). */
async function resolveConnection(
  connectionId: string,
  env: AgentWorkerLambdaEnvironment,
): Promise<ConnectionContext | null> {
  const connRecord = await IsbServices.connectionStore(env)
    .get(connectionId)
    .catch((err: unknown) => {
      logger.error("Failed to read connection context from DDB", {
        connectionId,
        error: toError(err),
      });
      throw err;
    });

  if (!connRecord) {
    logger.warn("Connection context not found — likely expired", {
      connectionId,
    });
    return null;
  }

  return {
    connectionId,
    actorId: connRecord.actorId,
    role: connRecord.role,
    email: connRecord.email,
    userId: connRecord.userId,
    protocolVersion: connRecord.protocolVersion ?? 1,
  };
}

interface RouteMessageProps {
  connection: ConnectionContext;
  leaseKey: LeaseKey;
  requestedModelId: string;
  requestedModel: PersistedAgentModelCatalogRow | undefined;
  agentConfig: AgentConfig;
  connectionId: string;
}

interface RouteMessageServices {
  env: AgentWorkerLambdaEnvironment;
  send: SendFn;
}

/** Validates message and routes to a lease-bound execution context. Returns null if a user-facing error was sent. */
async function routeMessage(
  props: RouteMessageProps,
  services: RouteMessageServices,
): Promise<ValidateAndRouteResult | null> {
  const {
    connection,
    leaseKey,
    requestedModelId,
    requestedModel,
    agentConfig,
    connectionId,
  } = props;
  const { env, send } = services;
  try {
    return await validateAndRoute(
      { connection, leaseKey, agentConfig, requestedModelId, requestedModel },
      { leaseStore: IsbServices.leaseStore(env), logger },
    );
  } catch (err) {
    if (
      err instanceof FeatureDisabledError ||
      err instanceof LeaseNotActiveError ||
      err instanceof ModelNotAllowedError
    ) {
      logger.warn("Request rejected — sending error to client", {
        connectionId,
        errorName: err.name,
        errorMessage: err.message,
      });
      await sendError(connectionId, toRouteError(err), send, logger);
      return null;
    }
    throw err; // Infrastructure error — workerHandler tells the client to resend
  }
}

function toRouteError(
  error: FeatureDisabledError | LeaseNotActiveError | ModelNotAllowedError,
) {
  if (error instanceof FeatureDisabledError) {
    return WORKER_ERRORS.featureDisabled;
  }
  if (error instanceof ModelNotAllowedError) {
    return WORKER_ERRORS.modelNotAllowed;
  }
  return WORKER_ERRORS.leaseNotActive;
}

/**
 * The subset of the resolved permission set that flows into the runtime's
 * invoke payload: the inline session policy (optional — permission sets can
 * carry only managed policies) and the managed policy ARNs (always present,
 * possibly empty). Both are needed downstream: the inline policy becomes the
 * final AssumeRole's `Policy`, and the managed ARNs become its `PolicyArns`.
 * Returning both preserves parity with the human portal path.
 */
interface ResolvedPermissionProfile {
  sessionPolicy?: PolicyDocument;
  managedPolicyArns: string[];
}

/** Permission-profile rejection categories used to select the client response. */
type PermissionProfileFailureReason =
  "NO_PERMISSION_PROFILE" | "UNSUPPORTED_BOUNDARY" | "RESOLUTION_FAILED";

const PERMISSION_PROFILE_ERRORS: Record<
  PermissionProfileFailureReason,
  AgentError
> = {
  NO_PERMISSION_PROFILE: WORKER_ERRORS.permissionProfileMissing,
  UNSUPPORTED_BOUNDARY: WORKER_ERRORS.permissionProfileBoundaryUnsupported,
  RESOLUTION_FAILED: WORKER_ERRORS.permissionProfileUnavailable,
};

const RUNTIME_FRAME_ERRORS: Partial<Record<string, AgentError>> = {
  [RUNTIME_ERROR_CODES.modelNotSupported]: WORKER_ERRORS.modelNotSupported,
  [RUNTIME_ERROR_CODES.modelUnavailable]: WORKER_ERRORS.modelUnavailable,
  [RUNTIME_ERROR_CODES.modelStreamEnded]: WORKER_ERRORS.modelStreamEnded,
  [RUNTIME_ERROR_CODES.contentFiltered]: WORKER_ERRORS.contentFiltered,
  [RUNTIME_ERROR_CODES.modelThrottled]: WORKER_ERRORS.modelThrottled,
  [RUNTIME_ERROR_CODES.modelTimedOut]: WORKER_ERRORS.modelTimedOut,
  [RUNTIME_ERROR_CODES.modelServiceUnavailable]:
    WORKER_ERRORS.modelServiceUnavailable,
  [RUNTIME_ERROR_CODES.inputBlocked]: WORKER_ERRORS.inputBlocked,
};

/** Not retryable, because the commands may already have taken effect. */
const RUNTIME_FRAME_ERRORS_AFTER_TOOL: Partial<Record<string, AgentError>> = {
  [RUNTIME_ERROR_CODES.modelStreamEnded]:
    WORKER_ERRORS.modelStreamEndedAfterTool,
  [RUNTIME_ERROR_CODES.contentFiltered]: WORKER_ERRORS.contentFilteredAfterTool,
  [RUNTIME_ERROR_CODES.modelThrottled]: WORKER_ERRORS.modelThrottledAfterTool,
  [RUNTIME_ERROR_CODES.modelTimedOut]: WORKER_ERRORS.modelTimedOutAfterTool,
  [RUNTIME_ERROR_CODES.modelServiceUnavailable]:
    WORKER_ERRORS.modelServiceUnavailableAfterTool,
};

function runtimeFrameError(
  code: string | undefined,
  toolRan: boolean,
): AgentError {
  const [errors, fallback] = toolRan
    ? [RUNTIME_FRAME_ERRORS_AFTER_TOOL, WORKER_ERRORS.runtimeErrorAfterTool]
    : [RUNTIME_FRAME_ERRORS, WORKER_ERRORS.runtimeError];
  return (code === undefined ? undefined : errors[code]) ?? fallback;
}

type PermissionProfileResult =
  | { ok: true; profile: ResolvedPermissionProfile }
  | { ok: false; reason: PermissionProfileFailureReason };

/**
 * Resolves the assigned permission-set policy before runtime invocation.
 *
 * Credential chain: Worker Lambda → IntermediateRole → IdcRole → SSO Admin APIs.
 */
async function resolvePermissionProfilePolicy(
  connection: ConnectionContext,
  env: AgentWorkerLambdaEnvironment,
  connectionId: string,
  leaseUuid: string,
  sandboxAccountId: string | undefined,
): Promise<PermissionProfileResult> {
  if (!sandboxAccountId) {
    // validateAndRoute fills this from the lease, so a miss is a routing or
    // data fault, not a missing assignment.
    logger.error(
      "No accountId on route result — cannot resolve permission set policy",
      { connectionId },
    );
    return { ok: false, reason: "RESOLUTION_FAILED" };
  }

  let permissionSetArn: string | undefined;
  try {
    const assignments = await IsbServices.principalStore(
      env,
    ).getAssignmentsForPrincipalAndLease({
      principalId: connection.userId,
      principalType: "USER",
      leaseId: leaseUuid,
    });
    permissionSetArn = assignments.find(
      (assignment) => assignment.permissionSetArn !== undefined,
    )?.permissionSetArn;
  } catch (err: unknown) {
    logger.error(
      "Failed to look up lease assignments for permission set resolution",
      { connectionId, error: toError(err) },
    );
    return { ok: false, reason: "RESOLUTION_FAILED" };
  }

  if (!permissionSetArn) {
    logger.warn("No permission set ARN found for user assignment", {
      connectionId,
      actorId: connection.actorId,
    });
    return { ok: false, reason: "NO_PERMISSION_PROFILE" };
  }

  // Two-hop credential chain (Worker → IntermediateRole → IdcRole).
  // Everything downstream of the assignment lookup — the IDC config read
  // (DDB/SSM), the SSO Admin client build, and the resolver call — sits
  // inside a single try/catch so any transient failure becomes a retryable
  // RESOLUTION_FAILED result with its own user-facing error.
  let resolved: Awaited<ReturnType<typeof resolvePermissionSetPolicy>>;
  try {
    const idcCredentials = fromTemporaryIsbIdcCredentials(env);
    const idcConfig = await IsbServices.idcStackConfigStore(env).get();
    const ssoAdminClient = IsbClients.ssoAdmin(env, idcCredentials);

    resolved = await resolvePermissionSetPolicy(
      {
        permissionSetArn,
        ssoInstanceArn: idcConfig.ssoInstanceArn,
        sandboxAccountId,
      },
      { ssoAdminClient },
    );
  } catch (err: unknown) {
    if (err instanceof UnsupportedPermissionSetBoundaryError) {
      logger.warn(
        "Permission set uses a permissions boundary that Sandbox Spaces does not support",
        {
          connectionId,
          permissionSetArn,
          actorId: connection.actorId,
        },
      );
      return { ok: false, reason: "UNSUPPORTED_BOUNDARY" };
    }
    logger.error("Failed to resolve permission set policy", {
      connectionId,
      permissionSetArn,
      actorId: connection.actorId,
      error: toError(err),
    });
    return { ok: false, reason: "RESOLUTION_FAILED" };
  }

  // An empty permission set resolves without error but grants nothing, so
  // treat it as having no profile.
  if (!resolved.sessionPolicy && resolved.managedPolicyArns.length === 0) {
    logger.warn("Permission set has no policies", {
      connectionId,
      permissionSetArn,
    });
    return { ok: false, reason: "NO_PERMISSION_PROFILE" };
  }

  logger.info("Permission set policy resolved", {
    connectionId,
    permissionSetArn,
    managedPolicyCount: resolved.managedPolicyArns.length,
    // sessionPolicy is optional — the permission set may carry only managed
    // policies and no inline policy document.
    statementCount: resolved.sessionPolicy?.Statement.length ?? 0,
  });

  return {
    ok: true,
    profile: {
      sessionPolicy: resolved.sessionPolicy,
      managedPolicyArns: resolved.managedPolicyArns,
    },
  };
}

/**
 * Outcome of one runtime invocation. `failed`: the runtime failed the turn before the model ran (rejected invoke,
 * no body, `TURN_IN_PROGRESS`, or an error frame with no streamed text or usage), so it is not billed.
 * `billedError`: the model ran but the turn ended early (unreadable stream, failed chunk send, or an error frame after
 * streaming); it is billed and carries the terminal error to send after pricing.
 * `ok`: the model ran and the complete frame follows. `meteringFailed` means usage was missing and `tokens` is an estimate.
 */
type RuntimeTurnResult =
  | { status: "failed" }
  | {
      status: "ok";
      tokens: SandboxSpacesTokenUsage;
      meteringFailed: boolean;
    }
  | {
      status: "billedError";
      tokens: SandboxSpacesTokenUsage;
      meteringFailed: boolean;
      error: AgentError;
    };

/** Invokes the agent runtime via InvokeAgentRuntime, streams SSE response chunks to the WebSocket client, and returns token counts. */
async function invokeRuntimeAndStream(
  props: {
    connection: ConnectionContext;
    message: string;
    modelId: string;
    leaseKey: string;
    routeResult: ValidateAndRouteResult;
    managedRegions: string[];
    permissionProfilePolicy: PolicyDocument | undefined;
    permissionProfileManagedPolicyArns: string[];
  },
  services: {
    send: SendFn;
    env: AgentWorkerLambdaEnvironment;
    /** Time allowed for the runtime call and stream read, so a long turn ends before the Lambda deadline. */
    timeoutMs: number;
  },
): Promise<RuntimeTurnResult> {
  const {
    connection,
    message,
    modelId,
    leaseKey,
    routeResult,
    managedRegions,
    permissionProfilePolicy,
    permissionProfileManagedPolicyArns,
  } = props;
  const { accountId, runtimeSessionId } = routeResult;
  const { send, env, timeoutMs } = services;

  const invokePayload = RuntimeInvokePayloadSchema.parse({
    messages: [{ role: "user", content: message }],
    actorId: connection.actorId,
    userId: connection.userId,
    modelId,
    accountId,
    leaseKey,
    regions: managedRegions,
    permissionProfilePolicy,
    permissionProfileManagedPolicyArns,
  });

  const runtimeClient = IsbClients.bedrockAgentCore(env);

  logger.info("Invoking agent runtime", {
    connectionId: connection.connectionId,
    runtimeSessionId,
  });

  await sendToConnection(
    connection.connectionId,
    { version: AGENT_PROTOCOL_VERSION, type: "chunk", data: "##PROCESSING##" },
    send,
    logger,
  );

  // Charged only when usage is missing — a non-zero lower bound, never zero.
  let tokens: SandboxSpacesTokenUsage = {
    inputTokens: Math.ceil(message.length / CHARS_PER_TOKEN_ESTIMATE),
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  };
  let meteringFailed = true;

  const runtimeDeadlineSignal = AbortSignal.timeout(Math.max(timeoutMs, 0));
  const response = await runtimeClient
    .send(
      new InvokeAgentRuntimeCommand({
        agentRuntimeArn: env.AGENT_RUNTIME_ARN,
        runtimeSessionId,
        payload: new TextEncoder().encode(JSON.stringify(invokePayload)),
        contentType: "application/json",
        accept: "text/event-stream",
      }),
      // Aborting also errors the response stream, so a late turn ends as a handled failure and not a Lambda timeout.
      { abortSignal: runtimeDeadlineSignal },
    )
    .catch(async (error: unknown) => {
      const deadlineExceeded = runtimeDeadlineSignal.aborted;
      logger.error("Agent runtime invocation failed", {
        connectionId: connection.connectionId,
        runtimeSessionId,
        deadlineExceeded,
        error: toError(error),
      });
      await notifyRuntimeError(
        connection.connectionId,
        send,
        deadlineExceeded
          ? WORKER_ERRORS.runtimeTimeLimit
          : WORKER_ERRORS.runtimeError,
      );
      return undefined;
    });

  // Rejected before the runtime produced anything, so the turn is not billed.
  if (!response) {
    return { status: "failed" };
  }

  if (!response.response) {
    logger.error("Agent runtime returned no response body", {
      connectionId: connection.connectionId,
      runtimeSessionId,
    });
    await notifyRuntimeError(connection.connectionId, send);
    return { status: "failed" };
  }

  let responseReadDeadlineExceeded = false;
  const sseText = await response.response
    .transformToString("utf-8")
    .catch((error: unknown) => {
      responseReadDeadlineExceeded = runtimeDeadlineSignal.aborted;
      logger.error("Failed to read agent runtime response", {
        connectionId: connection.connectionId,
        runtimeSessionId,
        deadlineExceeded: responseReadDeadlineExceeded,
        error: toError(error),
      });
      return undefined;
    });

  // The runtime accepted the turn, so the model ran but its usage is unreadable: the caller charges the estimate.
  if (sseText === undefined) {
    return {
      status: "billedError",
      tokens,
      meteringFailed,
      error: responseReadDeadlineExceeded
        ? WORKER_ERRORS.runtimeTimeLimit
        : WORKER_ERRORS.responseNotFullyDelivered,
    };
  }

  const result = await processSseResponse(
    sseText,
    connection.connectionId,
    send,
  );

  if (result.usage) {
    tokens = measuredRuntimeTokens(
      result.usage,
      connection.connectionId,
      modelId,
    );
    meteringFailed = false;
  }

  if (result.runtimeError !== undefined) {
    const turnInProgress =
      result.runtimeErrorCode === RUNTIME_ERROR_CODES.turnInProgress;
    // An error frame with no streamed text and no usage means the runtime failed before the model ran.
    const modelRan =
      result.assistantResponse !== "" || result.usage !== undefined;
    if (turnInProgress || !modelRan) {
      // Only a failure after streamed text or reported usage is billed below; `toolRan` changes the retry guidance, not billing.
      await notifyRuntimeError(
        connection.connectionId,
        send,
        turnInProgress
          ? WORKER_ERRORS.turnInProgress
          : runtimeFrameError(
              result.runtimeErrorCode,
              result.runtimeErrorToolRan,
            ),
      );
      return { status: "failed" };
    }
    // The agent already ran, so a retryable error would offer to repeat its actions.
    return {
      status: "billedError",
      tokens,
      meteringFailed,
      error:
        result.runtimeErrorCode === undefined
          ? WORKER_ERRORS.responseNotFullyDelivered
          : {
              ...runtimeFrameError(
                result.runtimeErrorCode,
                result.runtimeErrorToolRan,
              ),
              retryable: false,
            },
    };
  }

  // The model ran and its usage was read, but the reply did not reach the client in full.
  if (result.streamFailed) {
    return {
      status: "billedError",
      tokens,
      meteringFailed,
      error: WORKER_ERRORS.responseNotFullyDelivered,
    };
  }

  return { status: "ok", tokens, meteringFailed };
}

function measuredRuntimeTokens(
  usage: SandboxSpacesTokenUsage & { totalTokens?: number },
  connectionId: string,
  modelId: string,
): SandboxSpacesTokenUsage {
  const { totalTokens, ...tokens } = usage;
  if (totalTokens !== undefined && totalTokens !== sumTokenTypes(tokens)) {
    logger.error("Agent token total mismatch", {
      connectionId,
      modelId,
      reportedTotalTokens: totalTokens,
      summedTokens: sumTokenTypes(tokens),
      ...tokens,
    });
  }
  return tokens;
}

/** Sends a runtime error frame; a failed send is logged and swallowed so the turn can still be billed. */
async function notifyRuntimeError(
  connectionId: string,
  send: SendFn,
  agentError: AgentError = WORKER_ERRORS.runtimeError,
  terminalSpendFields: TerminalSpendFields = {},
): Promise<void> {
  await sendError(
    connectionId,
    agentError,
    send,
    logger,
    terminalSpendFields,
  ).catch((error: unknown) => {
    logger.error("Failed to send runtime error to client", {
      connectionId,
      error: toError(error),
    });
  });
}

type SseFrame =
  | { kind: "skip" }
  | { kind: "error"; error: string; code?: string; toolRan: boolean }
  | { kind: "event"; event: RuntimeStreamEvent };

/** Classifies one SSE line. Lines that are not usable frames are logged where relevant and skipped. */
function parseSseLine(line: string, connectionId: string): SseFrame {
  if (!line.startsWith("data: ")) return { kind: "skip" };
  const jsonStr = line.slice(6).trim();
  if (!jsonStr || jsonStr === "[DONE]") return { kind: "skip" };

  let rawEvent: unknown;
  try {
    rawEvent = JSON.parse(jsonStr);
  } catch {
    logger.warn("Failed to parse SSE line as JSON — skipping", {
      connectionId,
      jsonLength: jsonStr.length,
    });
    return { kind: "skip" };
  }

  const errorFrame = RuntimeErrorFrameSchema.safeParse(rawEvent);
  if (errorFrame.success) {
    logger.error("Agent runtime reported an error", {
      connectionId,
      runtimeError: errorFrame.data.error,
      runtimeErrorCode: errorFrame.data.code,
      runtimeErrorToolRan: errorFrame.data.toolRan,
    });
    return {
      kind: "error",
      error: errorFrame.data.error,
      code: errorFrame.data.code,
      toolRan: errorFrame.data.toolRan ?? false,
    };
  }

  const parsed = RuntimeStreamEventSchema.safeParse(rawEvent);
  if (!parsed.success) {
    logger.warn("Failed to parse SSE event", {
      connectionId,
      jsonLength: jsonStr.length,
      error: parsed.error.message,
    });
    return { kind: "skip" };
  }
  return { kind: "event", event: parsed.data };
}

/** Sends one chunk to the client. Returns false, after logging, when the send fails. */
async function trySendChunk(
  connectionId: string,
  content: string,
  send: SendFn,
): Promise<boolean> {
  try {
    await sendToConnection(
      connectionId,
      { version: AGENT_PROTOCOL_VERSION, type: "chunk", data: content },
      send,
      logger,
    );
    return true;
  } catch (error: unknown) {
    logger.error("Failed to stream chunk — skipping the rest", {
      connectionId,
      error: toError(error),
    });
    return false;
  }
}

/**
 * Parses an SSE response body, streams chunks to the WebSocket client, and returns
 * the accumulated assistant response text and token counts from the complete event.
 */
async function processSseResponse(
  sseText: string,
  connectionId: string,
  send: SendFn,
): Promise<{
  assistantResponse: string;
  usage?: SandboxSpacesTokenUsage & { totalTokens?: number };
  runtimeError?: string;
  runtimeErrorCode?: string;
  runtimeErrorToolRan: boolean;
  /** A chunk could not be sent; later chunks were skipped but usage was still read. */
  streamFailed: boolean;
}> {
  let assistantResponse = "";
  let streamFailed = false;
  let usage: (SandboxSpacesTokenUsage & { totalTokens?: number }) | undefined;
  let runtimeError: string | undefined;
  let runtimeErrorCode: string | undefined;
  let runtimeErrorToolRan = false;

  for (const line of sseText.split("\n")) {
    const frame = parseSseLine(line, connectionId);
    if (frame.kind === "error") {
      runtimeError = frame.error;
      runtimeErrorCode = frame.code;
      runtimeErrorToolRan = frame.toolRan;
    } else if (frame.kind === "event") {
      const { event } = frame;
      if (event.type === "chunk") {
        assistantResponse += event.content;
        if (!streamFailed) {
          streamFailed = !(await trySendChunk(
            connectionId,
            event.content,
            send,
          ));
        }
      } else if (event.type === "complete") {
        usage = event.usage;
      }
    }
  }

  return {
    assistantResponse,
    usage,
    runtimeError,
    runtimeErrorCode,
    runtimeErrorToolRan,
    streamFailed,
  };
}

/** Records with 3 backoff attempts. */
async function recordUsageWithRetry(
  props: RecordSandboxSpacesTurnUsageProps,
  services: SandboxSpacesUsageServices,
): Promise<void> {
  await backOff(() => recordSandboxSpacesTurnUsage(props, services), {
    numOfAttempts: 3,
    startingDelay: 200,
    maxDelay: 800,
  }).catch((err: unknown) => {
    const failure = {
      logDetailType: "SandboxSpacesUsageRecordingFailed",
      leaseId: props.leaseId,
      messageId: props.messageId,
      modelId: props.modelId,
    } satisfies SubscribableLog;
    logger.error("Failed to record Sandbox Spaces usage", {
      ...failure,
      error: toError(err),
    });
  });
}

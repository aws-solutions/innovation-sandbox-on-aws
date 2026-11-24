// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { ListEventsCommand } from "@aws-sdk/client-bedrock-agentcore";

import type { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { fetchAgentModelsWithPricing } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  acquireHistoryMemoryCredentials,
  mapMemoryEventsToHistoryMessages,
  memoryIdFromArn,
  resolveCallerLease,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { getLeaseSandboxSpacesUsageBreakdown } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-spaces-usage/index.js";
import { SandboxAgentApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-api-lambda-environment.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { withDelegatedErrors } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { IsbSmithyContext } from "@amzn/innovation-sandbox-commons/lambda/smithy/isb-smithy-context.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { parseLeaseKey } from "@amzn/innovation-sandbox-commons/utils/lease-key.js";
import {
  isActiveLease,
  type LeaseKey,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  isAdminOrManager,
  isIdcUser,
  type IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { isLeaseOwnerOrDirectAssignee } from "@amzn/innovation-sandbox-shared/utils/lease-access.js";

import type {
  AgentHistoryMessage,
  GetSandboxSpacesUsageServerInput,
  GetSandboxSpacesUsageServerOutput,
  ListAgentHistoryServerInput,
  ListAgentHistoryServerOutput,
  ListAgentModelsServerInput,
  ListAgentModelsServerOutput,
  SandboxAgentApiService,
} from "@amzn/innovation-sandbox-api-server/sandbox-agent";
import { JSendStatus } from "@amzn/innovation-sandbox-api-server/sandbox-agent";

export type SandboxAgentSmithyContext =
  IsbSmithyContext<SandboxAgentApiLambdaEnvironment>;

// ─── GET /sandboxAgent/history ───────────────────────────────────────────────

function listAgentHistory(logger: Logger) {
  return async (
    input: ListAgentHistoryServerInput,
    context: SandboxAgentSmithyContext,
  ): Promise<ListAgentHistoryServerOutput> => {
    const { env, user, globalConfig } = context.lambdaContext;
    const nextToken = input.nextToken ?? undefined;
    const maxResults = input.maxResults ?? undefined;

    requireSandboxSpacesEnabled(globalConfig);
    // `leaseId` is the base64url lease key (owner email + uuid). History is for
    // the owner or a direct assignee only — no group access, no Admin ownership
    // bypass — and stays per-actor.
    const leaseKey = requireLeaseKey(input.leaseId ?? undefined);
    const leaseUuid = leaseKey.uuid;

    // Memory is keyed by the caller's IDC user id; M2M callers get 404.
    const userId = requireIdcUserId(user);
    await resolveUserLease(userId, leaseKey, env, logger);

    const memorySessionId = leaseUuid;

    const creds = await acquireHistoryMemoryCredentials({
      stsClient: IsbClients.sts(env),
      memoryAccessRoleArn: env.MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: env.USER_MEMORY_ARN,
      actorId: userId,
      memorySessionId,
    });

    if (!creds) {
      logger.error("Failed to acquire scoped credentials for memory access", {
        userId,
      });
      throw createHttpJSendError({
        statusCode: 503,
        data: {
          errors: [
            {
              message:
                "Unable to acquire memory access credentials. Please retry.",
            },
          ],
        },
      });
    }

    const memoryId = memoryIdFromArn(env.USER_MEMORY_ARN);
    const messages = await listMemoryEvents({
      creds,
      memoryId,
      actorId: userId,
      sessionId: memorySessionId,
      nextToken,
      maxResults,
      env,
      logger,
    });

    const base = {
      messages: messages.items,
      ...(messages.nextToken ? { nextToken: messages.nextToken } : {}),
    };

    return {
      status: JSendStatus.SUCCESS,
      data: { leaseUuid, ...base },
    };
  };
}

function requireLeaseKey(leaseId: string | undefined): LeaseKey {
  if (!leaseId) {
    throw createHttpJSendError({
      statusCode: 400,
      data: { errors: [{ message: "leaseId query parameter is required." }] },
    });
  }
  const leaseKey = parseLeaseKey(leaseId);
  if (!leaseKey) {
    throw createHttpJSendError({
      statusCode: 400,
      data: { errors: [{ message: "Invalid leaseId format." }] },
    });
  }
  return leaseKey;
}

function requireSandboxSpacesEnabled(globalConfig: GlobalConfig): void {
  if (!globalConfig.agent.sandboxSpacesEnabled) {
    throw createHttpJSendError({
      statusCode: 403,
      data: { errors: [{ message: "Sandbox Spaces is not enabled." }] },
    });
  }
}

function requireIdcUserId(user: IsbUser): string {
  // M2M callers have no IDC user id, so they can never be a lease assignee.
  if (!isIdcUser(user)) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: "Lease not found." }] },
    });
  }
  return user.userId;
}

async function resolveUserLease(
  userId: string,
  leaseKey: LeaseKey,
  env: SandboxAgentApiLambdaEnvironment,
  logger: Logger,
) {
  const lease = await resolveCallerLease(
    { leaseKey, userId },
    { leaseStore: IsbServices.leaseStore(env), logger },
  );
  if (!lease) {
    throw createHttpJSendError({
      statusCode: 404,
      data: { errors: [{ message: "Lease not found." }] },
    });
  }

  if (!isActiveLease(lease) || !lease.sandboxSpacesEnabled) {
    throw createHttpJSendError({
      statusCode: 403,
      data: {
        errors: [{ message: "Sandbox Space is not available for this lease." }],
      },
    });
  }

  return lease;
}

/**
 * Same rule as `GET /leases/{leaseId}`, minus group assignees: this Lambda has
 * no principal table, and group assignees cannot use Sandbox Spaces.
 */
async function requireLeaseReadAccess(
  leaseKey: LeaseKey,
  user: IsbUser,
  env: SandboxAgentApiLambdaEnvironment,
  logger: Logger,
): Promise<void> {
  const isElevated = isAdminOrManager(user);

  const { result: lease, error } =
    await IsbServices.leaseStore(env).get(leaseKey);
  if (error) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: lease record unreadable for usage read`,
      { leaseId: leaseKey.uuid, error },
    );
  }

  if (lease && (isElevated || isLeaseOwnerOrDirectAssignee(user, lease))) {
    return;
  }

  throw createHttpJSendError({
    statusCode: isElevated ? 404 : 403,
    data: {
      errors: [
        {
          message: isElevated
            ? "Lease not found."
            : "Active user is not authorized to view Sandbox Spaces usage for this lease.",
        },
      ],
    },
  });
}

async function listMemoryEvents(props: {
  creds: { accessKeyId: string; secretAccessKey: string; sessionToken: string };
  memoryId: string;
  actorId: string;
  sessionId: string | undefined;
  nextToken: string | undefined;
  maxResults: number | undefined;
  env: SandboxAgentApiLambdaEnvironment;
  logger: Logger;
}): Promise<{ items: AgentHistoryMessage[]; nextToken?: string }> {
  const {
    creds,
    memoryId,
    actorId,
    sessionId,
    nextToken,
    maxResults,
    env,
    logger,
  } = props;

  const client = IsbClients.bedrockAgentCore(env, {
    accessKeyId: creds.accessKeyId,
    secretAccessKey: creds.secretAccessKey,
    sessionToken: creds.sessionToken,
  });

  let response;
  try {
    response = await client.send(
      new ListEventsCommand({
        memoryId,
        actorId,
        sessionId,
        includePayloads: true,
        ...(nextToken ? { nextToken } : {}),
        ...(maxResults === undefined ? {} : { maxResults }),
      }),
    );
    logger.info("ListEvents response", {
      memoryId,
      actorId,
      sessionId,
      eventCount: response.events?.length ?? 0,
      nextToken: response.nextToken,
    });
  } catch (err) {
    logger.warn("ListEvents failed — returning empty history", {
      memoryId,
      actorId,
      sessionId,
      error: String(err),
    });
    return { items: [] };
  }

  const items: AgentHistoryMessage[] = mapMemoryEventsToHistoryMessages(
    response.events ?? [],
  );

  return {
    items,
    ...(response.nextToken ? { nextToken: response.nextToken } : {}),
  };
}

// ─── GET /sandboxAgent/usage ─────────────────────────────────────────────────

function getSandboxSpacesUsage(logger: Logger) {
  return async (
    input: GetSandboxSpacesUsageServerInput,
    context: SandboxAgentSmithyContext,
  ): Promise<GetSandboxSpacesUsageServerOutput> => {
    const { env, user } = context.lambdaContext;
    const leaseKey = requireLeaseKey(input.leaseId ?? undefined);

    await requireLeaseReadAccess(leaseKey, user, env, logger);

    const data = await getLeaseSandboxSpacesUsageBreakdown(
      { leaseId: leaseKey.uuid, user },
      {
        sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(env),
        logger,
      },
    );

    return { status: JSendStatus.SUCCESS, data };
  };
}

function listAgentModels(logger: Logger) {
  return async (
    _input: ListAgentModelsServerInput,
    context: SandboxAgentSmithyContext,
  ): Promise<ListAgentModelsServerOutput> => {
    const { env } = context.lambdaContext;

    const { models } = await fetchAgentModelsWithPricing({
      priceCache: IsbServices.bedrockPriceCache(env),
      bedrockClient: IsbClients.bedrock(env),
      pricingClient: IsbClients.pricing(env),
      region: (() => {
        const r = process.env["AWS_REGION"];
        if (!r) throw new Error("AWS_REGION is not set");
        return r;
      })(),
      logger,
    });

    return {
      status: JSendStatus.SUCCESS,
      data: { models },
    };
  };
}

/**
 * The `SandboxAgentApi` service. Wrapped in `withDelegatedErrors` so errors
 * render through the shared Middy `httpErrorHandler`.
 */
export function sandboxAgentService(
  logger: Logger,
): SandboxAgentApiService<SandboxAgentSmithyContext> {
  return {
    ListAgentHistory: withDelegatedErrors(listAgentHistory(logger)),
    GetSandboxSpacesUsage: withDelegatedErrors(getSandboxSpacesUsage(logger)),
    ListAgentModels: withDelegatedErrors(listAgentModels(logger)),
  };
}

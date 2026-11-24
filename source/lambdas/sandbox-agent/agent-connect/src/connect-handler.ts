// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { MiddlewareObj } from "@middy/core";
import { CognitoJwtVerifier } from "aws-jwt-verify";
import {
  APIGatewayProxyResultV2,
  APIGatewayProxyWebsocketHandlerV2,
  Context,
} from "aws-lambda";
import { DateTime } from "luxon";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AGENT_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION_QUERY_PARAM,
  sanitizeActorId,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  AgentConnectLambdaEnvironmentSchema,
  ConnectLambdaEnvironment,
} from "@amzn/innovation-sandbox-commons/lambda/environments/connect-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { sanitizeApiGatewayEvent } from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";
import { IdcPrincipalIdSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import {
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  parseRolesClaim,
  resolveEmailFromClaims,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const tracer = new Tracer();
const logger = new Logger();

/** DynamoDB TTL for WebSocket connection records: 2 hours. */
const CONNECTION_TTL_SECONDS = 2 * 60 * 60;

/**
 * Thrown by each $connect validation step. The auth-error middleware maps it to
 * a single 401 response, so every rejection path is one throw rather than a
 * duplicated `{ statusCode: 401, body: "Unauthorized" }` object. The reason is
 * logged (not returned) to avoid leaking why authorization failed to the client.
 */
class ConnectUnauthorizedError extends Error {
  constructor(
    message: string,
    public readonly logContext?: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ConnectUnauthorizedError";
  }
}

/** Maps a ConnectUnauthorizedError to a 401 WebSocket response and logs the reason. */
function connectAuthErrorHandler(
  logger: Logger,
): MiddlewareObj<unknown, APIGatewayProxyResultV2, Error, Context> {
  return {
    onError: async (request) => {
      if (request.error instanceof ConnectUnauthorizedError) {
        logger.warn(request.error.message, request.error.logContext ?? {});
        request.response = { statusCode: 401, body: "Unauthorized" };
      }
    },
  };
}

// Cache the verifier across invocations to avoid re-fetching JWKS.
let _verifier: ReturnType<
  typeof CognitoJwtVerifier.create<{
    userPoolId: string;
    tokenUse: "id";
    clientId: string;
  }>
> | null = null;

function getVerifier(env: ConnectLambdaEnvironment) {
  if (_verifier) return _verifier;
  _verifier = CognitoJwtVerifier.create({
    userPoolId: env.COGNITO_USER_POOL_ID,
    tokenUse: "id",
    clientId: env.COGNITO_APP_CLIENT_ID,
  });
  return _verifier;
}

/** Extracts the first ISB role from the `custom:isb_roles` JWT claim. Admin > Manager > User. */
function extractRole(rolesClaim: unknown): "Admin" | "Manager" | "User" | null {
  const roles = parseRolesClaim(
    typeof rolesClaim === "string" ? rolesClaim : undefined,
  );
  for (const candidate of ["Admin", "Manager", "User"] as const) {
    if (roles.includes(candidate)) return candidate;
  }
  return null;
}

/** Returns a positive integer ≤ AGENT_PROTOCOL_VERSION, or 1 as default. */
function parseProtocolVersion(raw: string | undefined): number {
  if (raw === undefined || raw === "") return 1;
  const parsed = Number.parseInt(raw, 10);
  if (
    !Number.isInteger(parsed) ||
    parsed <= 0 ||
    parsed > AGENT_PROTOCOL_VERSION
  ) {
    return 1;
  }
  return parsed;
}

interface ConnectIdentity {
  email: string;
  role: "Admin" | "Manager" | "User";
  actorId: string;
  userId: string;
}

/**
 * Verifies the JWT from the x-isb-identity query parameter and extracts the
 * identity fields needed to build the connection record.
 */
async function verifyAndExtractIdentity(
  token: string,
  connectionId: string,
  env: ConnectLambdaEnvironment,
): Promise<ConnectIdentity> {
  const claims = (await getVerifier(env)
    .verify(token)
    .catch((err: unknown) => {
      throw new ConnectUnauthorizedError("JWT verification failed", {
        connectionId,
        error: String(err),
      });
    })) as Record<string, unknown>;

  const email = resolveEmailFromClaims(claims);
  if (!email) {
    throw new ConnectUnauthorizedError("JWT missing email claim", {
      connectionId,
    });
  }

  const sub = claims["sub"];
  if (typeof sub !== "string" || sub.length === 0) {
    throw new ConnectUnauthorizedError("JWT missing sub claim", {
      connectionId,
    });
  }

  const role = extractRole(claims[COGNITO_ISB_ROLES_CLAIM]);
  if (!role) {
    throw new ConnectUnauthorizedError(
      "JWT has no recognised ISB role in custom:isb_roles",
      { connectionId, rolesClaim: claims[COGNITO_ISB_ROLES_CLAIM] },
    );
  }

  const userId = IdcPrincipalIdSchema.safeParse(
    claims[COGNITO_IDC_USER_ID_CLAIM],
  );
  if (!userId.success) {
    throw new ConnectUnauthorizedError(
      "JWT missing or invalid custom:idc_user_id claim",
      { connectionId },
    );
  }

  return {
    email,
    role,
    actorId: sanitizeActorId(email),
    userId: userId.data,
  };
}

async function handleDisconnect(
  connectionId: string,
  env: ConnectLambdaEnvironment,
): Promise<APIGatewayProxyResultV2> {
  logger.info("WebSocket $disconnect", { connectionId });
  // Fail open — the connection is already gone at the API GW level.
  // The record will expire via 2h TTL if the delete fails.
  await IsbServices.connectionStore(env)
    .delete(connectionId)
    .catch((err: unknown) =>
      logger.warn("Failed to delete connection record on $disconnect", {
        connectionId,
        error: String(err),
      }),
    );
  return { statusCode: 200, body: "Disconnected" };
}

async function handleConnect(
  connectionId: string,
  queryParams: Record<string, string>,
  env: ConnectLambdaEnvironment,
): Promise<APIGatewayProxyResultV2> {
  const token = queryParams["x-isb-identity"];
  if (!token) {
    throw new ConnectUnauthorizedError(
      "Missing x-isb-identity query parameter",
      { connectionId },
    );
  }

  const { email, role, actorId, userId } = await verifyAndExtractIdentity(
    token,
    connectionId,
    env,
  );
  const protocolVersion = parseProtocolVersion(
    queryParams[AGENT_PROTOCOL_VERSION_QUERY_PARAM],
  );
  const ttl = DateTime.now()
    .plus({ seconds: CONNECTION_TTL_SECONDS })
    .toUnixInteger();

  await IsbServices.connectionStore(env)
    .save({ connectionId, actorId, role, email, userId, protocolVersion, ttl })
    .catch((err: unknown) => {
      logger.error("Failed to write connection record to DynamoDB", {
        connectionId,
        error: String(err),
      });
      throw err;
    });

  logger.info("WebSocket $connect established", {
    connectionId,
    actorId,
    role,
    protocolVersion,
  });
  return { statusCode: 200, body: "Connected" };
}

const connectHandler: APIGatewayProxyWebsocketHandlerV2 = async (
  event,
  context,
) => {
  const env = (context as unknown as { env: ConnectLambdaEnvironment }).env;
  const { connectionId, routeKey } = event.requestContext;

  if (routeKey === "$disconnect") {
    return handleDisconnect(connectionId, env);
  }

  if (routeKey === "$connect") {
    return handleConnect(
      connectionId,
      (event.queryStringParameters ?? {}) as Record<string, string>,
      env,
    );
  }

  logger.warn("Unexpected WebSocket route key", { routeKey, connectionId });
  return { statusCode: 400, body: "Unexpected route" };
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  eventLogSanitizer: (event) =>
    sanitizeApiGatewayEvent(event, {
      // Redact the ID token, SigV4 credentials, and any future query secrets.
      queryStringParameterAllowlist: [AGENT_PROTOCOL_VERSION_QUERY_PARAM],
    }),
  moduleName: "agent-connect",
  environmentSchema: AgentConnectLambdaEnvironmentSchema,
})
  .use(connectAuthErrorHandler(logger))
  .handler(connectHandler);

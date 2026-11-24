// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { isDeepStrictEqual } from "node:util";

import { Event as NormalizedEvent } from "@middy/http-event-normalizer";
import { Event as NormalizedHeaderEvent } from "@middy/http-header-normalizer";
import { DateTime } from "luxon";

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { ContextWithConfig } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { encodeTestToken } from "@amzn/innovation-sandbox-commons/test/lambdas/api-test-setup.js";
import { JSendErrorObject } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { buildM2mAssumedRoleArn } from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";
import {
  now,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  ConfigSchemas,
  ConfigSection,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  type IsbUser,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  COGNITO_USERNAME_CLAIM,
  IDENTITY_HEADER,
  isIdcUser,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import {
  APIGatewayEventIdentity,
  APIGatewayRequestAuthorizerEvent,
  CognitoIdentity,
} from "aws-lambda";
import { randomUUID } from "crypto";

/**
 * Builds the value API Gateway puts in
 * `event.requestContext.identity.cognitoAuthenticationProvider` for a
 * Cognito-authenticated request. Format documented at:
 * https://docs.aws.amazon.com/apigateway/latest/developerguide/api-gateway-mapping-template-reference.html#context-variable-reference
 */
export function buildCognitoAuthProvider(
  poolId: string,
  sub: string,
  region: string,
): string {
  const issuer = `cognito-idp.${region}.amazonaws.com/${poolId}`;
  return `${issuer},${issuer}:CognitoSignIn:${sub}`;
}

interface CreateAPIGatewayProxyEventProps {
  httpMethod: string;
  path: string;
  body?: string;
  /** Set alongside a base64 `body` to exercise the binary-payload path. */
  isBase64Encoded?: boolean;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  /**
   * Overrides the multi-value query map (which otherwise mirrors
   * `queryStringParameters`). Set it to exercise a repeated query key, which the
   * single-value map cannot represent.
   */
  multiValueQueryStringParameters?: { [key: string]: string[] };
  headers?: { [key: string]: string };
  identity?: Partial<APIGatewayEventIdentity>;
  /**
   * Convenience: when set, populates the SigV4 fields the new
   * `captureIsbUser` middleware reads — `x-isb-identity` header +
   * `cognitoAuthenticationProvider` for IDC users, `userArn` for M2M
   * — and registers matching mock claims with the shared
   * `aws-jwt-verify` mock from `api-test-setup.ts`.
   */
  isbUser?: IsbUser;
}

const FIXTURE_COGNITO_SUB = "abc12345-6789-4abc-9def-0123456789ab";

function userPropsToEventOverrides(user: IsbUser): {
  headers?: Record<string, string>;
  identity?: Partial<APIGatewayEventIdentity>;
} {
  if (isM2MUser(user)) {
    const namespace = process.env.ISB_NAMESPACE ?? "myisb";
    return {
      identity: {
        userArn: buildM2mAssumedRoleArn({
          namespace,
          roleTier: user.roles[0] ?? "User",
          clientName: user.clientId,
          accountId: process.env.HUB_ACCOUNT_ID ?? "123456789012",
        }),
      },
    };
  }
  const claims = { sub: FIXTURE_COGNITO_SUB, ...buildCognitoClaims(user) };
  return {
    headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
    identity: {
      cognitoAuthenticationProvider: buildCognitoAuthProvider(
        "us-east-1_TEST",
        FIXTURE_COGNITO_SUB,
        "us-east-1",
      ),
    },
  };
}

export function buildCognitoClaims(user: IsbUser): Record<string, string> {
  if (isIdcUser(user)) {
    return {
      email: user.email,
      [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(user.roles),
      [COGNITO_USERNAME_CLAIM]: user.userName ?? user.email,
      [COGNITO_IDC_USER_ID_CLAIM]: user.userId,
    };
  }
  return {
    client_id: user.clientId,
    [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(user.roles),
  };
}

export const createAPIGatewayProxyEvent = (
  props: CreateAPIGatewayProxyEventProps,
): NormalizedEvent & NormalizedHeaderEvent => {
  const { identity, isbUser, headers, queryStringParameters, ...eventProps } =
    props;

  const userOverrides = isbUser ? userPropsToEventOverrides(isbUser) : {};
  const mergedHeaders = { ...headers, ...userOverrides.headers };
  const mergedIdentity = { ...identity, ...userOverrides.identity };
  const query = queryStringParameters ?? {};

  // API Gateway's proxy integration always populates the multi-value maps
  // alongside the single-value ones, and `@smithy/server-apigateway`'s
  // `convertEvent` reads only the multi-value maps. Mirror that here so a mocked
  // event behaves like a real one for both the Middy routes (single-value) and
  // the Smithy-served routes (multi-value).
  const toMultiValue = (
    map: Record<string, string>,
  ): Record<string, string[]> =>
    Object.fromEntries(
      Object.entries(map).map(([key, value]) => [key, [value]]),
    );

  return {
    body: null,
    rawHeaders: {},
    multiValueHeaders: toMultiValue(mergedHeaders),
    pathParameters: {},
    stageVariables: null,
    isBase64Encoded: false,
    queryStringParameters: query,
    multiValueQueryStringParameters: toMultiValue(query),
    resource: "resource",
    headers: mergedHeaders,
    requestContext: {
      accountId: "000000000000",
      apiId: "apiId",
      authorizer: null,
      httpMethod: props.httpMethod,
      identity: {
        accessKey: null,
        accountId: null,
        caller: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "0.0.0.0",
        user: null,
        userAgent: null,
        userArn: null,
        clientCert: null,
        apiKey: null,
        apiKeyId: null,
        ...mergedIdentity,
      },
      protocol: "protocol",
      path: "path",
      stage: "stage",
      requestId: "requestId",
      requestTime: "requestTime",
      requestTimeEpoch: 1,
      resourceId: "resourceId",
      resourcePath: "resourcePath",
    },
    ...eventProps,
  };
};

export const responseHeaders = {
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Type": "application/json",
};

export const responseHeadersWithErrorType = (errorType: string) => ({
  ...responseHeaders,
  "x-amzn-errortype": errorType,
});

const isbUser: IsbUser = {
  type: "user",
  email: "test@example.com",
  userId: "testUserId",
  roles: ["Admin", "Manager", "User"],
};

export const isbAuthorizedUser = {
  user: isbUser,
  claims: buildCognitoClaims(isbUser),
};

const isbUserUserRoleOnly: IsbUser = {
  type: "user",
  email: "test@example.com",
  userId: "testUserId",
  roles: ["User"],
};

export const isbAuthorizedUserUserRoleOnly = {
  user: isbUserUserRoleOnly,
  claims: buildCognitoClaims(isbUserUserRoleOnly),
};

export function mockGlobalConfig(): GlobalConfig {
  const config = {} as GlobalConfig;
  for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
    (config as Record<ConfigSection, unknown>)[section] = ConfigSchemas[
      section
    ].parse({});
  }
  // Baseline represents a normally-operating, configured system. The schema
  // default for `maintenance.enabled` is fresh-install behavior; tests that
  // need maintenance mode opt into it explicitly.
  config.maintenance.enabled = false;
  // Gates open in the baseline so template tests may enable the features;
  // gate-off 400 tests override these explicitly.
  config.leases.allowPredictiveBudgetControls = true;
  config.leases.allowBedrockTokenMonitoring = true;
  return config;
}

// M2M callers authenticate via an assumed IAM role (no Cognito claims), so these
// are bare IsbUser objects — pass directly as `createAPIGatewayProxyEvent`'s
// `isbUser`, which renders them as a `userArn`.
export const m2mAdminUser: IsbUser = {
  type: "m2m",
  clientId: "automation-client",
  roles: ["Admin"],
};

export const m2mUserRoleOnlyUser: IsbUser = {
  type: "m2m",
  clientId: "some-client",
  roles: ["User"],
};

export function mockContext<T>(
  env: T,
  globalConfig?: GlobalConfig,
): ContextWithConfig & ValidatedEnvironment<T> {
  return {
    env,
    globalConfig: globalConfig ?? mockGlobalConfig(),
    functionName: "testFunc",
    awsRequestId: "",
    callbackWaitsForEmptyEventLoop: false,
    functionVersion: "test",
    invokedFunctionArn: "myFuncArn",
    logGroupName: "myLogGroup",
    logStreamName: "myLogStream",
    memoryLimitInMB: "200",
    done(_error?: Error, _result?: any): void {},
    fail(_error: Error | string): void {},
    getRemainingTimeInMillis(): number {
      return 100;
    },
    succeed(_message: any, _object?: any): void {},
  };
}

export function mockAuthorizedContext<T extends BaseApiLambdaEnvironment>(
  env: T,
  globalConfig?: GlobalConfig,
): IsbApiContext<T> & ContextWithConfig {
  return {
    ...mockContext(env, globalConfig),
    ...isbAuthorizedUser,
    accountId: "000000000000",
    apiId: "test-api-id",
    protocol: "HTTP/1.1",
    httpMethod: "GET",
    path: "/test-path",
    stage: "test-stage",
    requestId: "test-request-id",
    requestTimeEpoch: 0,
    resourceId: "test-resource-id",
    resourcePath: "/test-resource-path",
    authorizer: {} as APIGatewayRequestAuthorizerEvent,
    identity: {} as CognitoIdentity & APIGatewayEventIdentity,
  };
}

export function createFailureResponseBody(...errors: JSendErrorObject[]) {
  return JSON.stringify({
    status: "fail",
    data: {
      errors,
    },
  });
}

/**
 * Structural equivalent of `createFailureResponseBody` for a `fail` body the
 * generated Smithy serializer emits (a modeled `ValidationError`) rather than the
 * Middy `httpErrorHandler`: the serializer alphabetizes the envelope (`{data,
 * status}`), so an exact-string compare would spuriously fail on order. Compares
 * structurally instead. Business/framework errors still render status-first and
 * keep using `createFailureResponseBody`.
 */
export function jsendFailBodyLike(...errors: JSendErrorObject[]) {
  return serializedBodyLike({ status: "fail", data: { errors } });
}

export function createErrorResponseBody(message: string) {
  return JSON.stringify({
    status: "error",
    message,
  });
}

const persistenceOnlyResponseMembers = new Set([
  "defaultPermissionSetArn",
  "allowedPermissionSetArns",
]);

/**
 * Normalizes a value the way the generated `restJson1` serializer observably does:
 * it drops `null`/`undefined` members and persistence-only members (member order is
 * not normalized because the matchers below compare structurally). When
 * `canonicalizeDates` is set it also re-emits `date-time` strings in the serializer's
 * canonical form (millisecond precision, with a zero `.000` fraction collapsed to a
 * bare `Z`) — the behavior of a domain whose timestamps are modeled as `@timestamp`
 * (e.g. `/leaseTemplates`). Domains that model timestamps as raw `String` emit them
 * byte-faithfully, so they normalize with `canonicalizeDates: false`.
 */
function normalizeBody(value: unknown, canonicalizeDates: boolean): unknown {
  if (Array.isArray(value)) {
    return value.map((member) => normalizeBody(member, canonicalizeDates));
  }
  if (value !== null && typeof value === "object" && !(value instanceof Date)) {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      if (
        persistenceOnlyResponseMembers.has(key) ||
        member === null ||
        member === undefined
      ) {
        continue;
      }
      out[key] = normalizeBody(member, canonicalizeDates);
    }
    return out;
  }
  // Re-emit an ISO date-time in the serializer's canonical UTC form via luxon
  // (`suppressMilliseconds` collapses a zero fraction to a bare `Z`); any string
  // luxon cannot parse as a date-time — ids, emails, names — is returned as-is. The
  // `T` pre-check keeps date-only / time-only strings out of the parse.
  if (canonicalizeDates && typeof value === "string" && value.includes("T")) {
    const parsed = DateTime.fromISO(value, { zone: "utc" });
    if (parsed.isValid) {
      return parsed.toISO({ suppressMilliseconds: true }) ?? value;
    }
  }
  return value;
}

/** Asymmetric matcher: parse the actual JSON body and deep-equal the normalized expected. */
function bodyMatcher(label: string, expected: unknown) {
  return {
    asymmetricMatch(actual: unknown): boolean {
      if (typeof actual !== "string") {
        return false;
      }
      try {
        return isDeepStrictEqual(JSON.parse(actual), expected);
      } catch {
        return false;
      }
    },
    toString(): string {
      return `${label}(${JSON.stringify(expected)})`;
    },
  };
}

/**
 * An asymmetric matcher for a JSON response body produced by the generated Smithy
 * (`restJson1`) serializer. Unlike the pre-Smithy handwritten routes, the serializer
 * alphabetizes members, drops `null`s, and normalizes timestamps to milliseconds —
 * all accepted deviations (no consumer depends on them). So the body is compared
 * structurally after normalizing the expected value the same way (which also makes
 * member order irrelevant), rather than as an exact byte string.
 *
 * Use this for domains whose timestamps are modeled as `@timestamp` (e.g.
 * `/leaseTemplates`); use `rawBodyLike` for domains that model timestamps as raw
 * `String` and emit them byte-faithfully (e.g. `/accounts`).
 *
 * Not JSend-specific — it matches any body against its serialized form; `status`/
 * `data` in the example are just the shape these operations happen to return. Usage
 * is a drop-in for `JSON.stringify`: `body: serializedBodyLike({ status: "success", data })`.
 */
export function serializedBodyLike(body: unknown) {
  return bodyMatcher("serializedBodyLike", normalizeBody(body, true));
}

/**
 * Like `serializedBodyLike`, but does NOT canonicalize date-time strings — it only
 * drops `null`/`undefined` members. For domains that model timestamps as raw
 * `String` (not `@timestamp`), so the `restJson1` serializer emits them
 * byte-faithfully (e.g. `/accounts`, whose values pass through exactly as persisted
 * in DynamoDB). Canonicalizing here would rewrite the expected timestamp and diverge
 * from the raw actual body.
 */
export function rawBodyLike(body: unknown) {
  return bodyMatcher("rawBodyLike", normalizeBody(body, false));
}

export function createEventBridgeEvent(detailType: string, detail: object) {
  return {
    version: "0",
    id: randomUUID(),
    "detail-type": detailType,
    source: "InnovationSandbox-myisb",
    account: "123456789012",
    time: nowAsIsoDatetimeString(),
    region: "us-east-1",
    resources: [],
    detail: {
      ...detail,
    },
  };
}

/**
 * A lease-cost-history `ttl` 30 days ahead of the project's clock, in epoch
 * seconds. Derived at call time rather than fixed: the store refuses to write a
 * row whose ttl has already elapsed, and the schema caps how far ahead of now a
 * ttl may sit, so any literal drifts out of that window as the calendar moves.
 * Reads the same clock as both checks, so it also follows `vi.setSystemTime`.
 */
export function futureTtl(): number {
  return Math.floor(now().plus({ days: 30 }).valueOf() / 1000);
}

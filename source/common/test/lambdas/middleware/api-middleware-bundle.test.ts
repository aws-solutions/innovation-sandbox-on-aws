// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for API middleware bundle.
 * Covers SigV4 auth path selection, M2M role-ARN parsing, x-isb-identity
 * verification, and hybrid-request rejection.
 *
 * The shared `api-test-setup.ts` (registered as `setupFiles` in
 * `vitest.config.ts`) mocks `aws-jwt-verify` so any token built with
 * `encodeTestToken()` is decoded back into the original claims. Use the
 * `INVALID_TOKEN_SENTINEL` to exercise the JWKS-failure branch.
 */

import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { encodeTestToken } from "@amzn/innovation-sandbox-commons/test/lambdas/api-test-setup.js";
import {
  buildCognitoAuthProvider,
  createAPIGatewayProxyEvent,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { buildM2mAssumedRoleArn } from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";
import {
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  COGNITO_USERNAME_CLAIM,
  IDENTITY_HEADER,
  isM2MUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

const NAMESPACE = "isb";
const HUB_ACCOUNT_ID = "123456789012";
const testEnv = generateSchemaData(ConfigurationLambdaEnvironmentSchema, {
  HUB_ACCOUNT_ID,
  ISB_NAMESPACE: NAMESPACE,
  SES_IDENTITY_ARN: "",
});

let mockedGlobalConfig: GlobalConfig;

const SUB = "abc12345-6789-4abc-9def-0123456789ab";
const POOL_ID = "us-east-1_TEST";
const cognitoAuthenticationProvider = buildCognitoAuthProvider(
  POOL_ID,
  SUB,
  "us-east-1",
);

const m2mAdminArn = (clientName: string) =>
  buildM2mAssumedRoleArn({
    namespace: NAMESPACE,
    roleTier: "Admin",
    clientName,
    accountId: HUB_ACCOUNT_ID,
  });

describe("apiMiddlewareBundle", () => {
  let logger: Logger;
  let tracer: Tracer;

  beforeAll(() => {
    mockedGlobalConfig = mockGlobalConfig();
  });

  beforeEach(() => {
    logger = new Logger({ serviceName: "test" });
    tracer = new Tracer({ serviceName: "test" });
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockedGlobalConfig);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  const createHandler = (
    handlerFn: (event: any, context: any) => Promise<any>,
  ) => {
    return apiMiddlewareBundle({
      logger,
      tracer,
      environmentSchema: ConfigurationLambdaEnvironmentSchema,
    }).handler(handlerFn);
  };

  describe("User path (x-isb-identity header)", () => {
    it("attaches user identity from a verified ID token", async () => {
      const claims = {
        sub: SUB,
        email: "user@example.com",
        [COGNITO_IDC_USER_ID_CLAIM]: "user-id-1",
        [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(["Admin"]),
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async (_event, context) => {
        expect(context.user).toEqual({
          type: "user",
          email: "user@example.com",
          userId: "user-id-1",
          roles: ["Admin"],
        });
        return { statusCode: 200, body: "{}" };
      });

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(200);
    });

    it("extracts email from cognito:username when top-level email claim is absent (SAML federated)", async () => {
      const claims = {
        sub: SUB,
        [COGNITO_USERNAME_CLAIM]: "IAMIdentityCenter_user@example.com",
        [COGNITO_IDC_USER_ID_CLAIM]: "user-id-1",
        [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(["Admin"]),
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async (_event, context) => {
        expect(context.user.email).toBe("user@example.com");
        return { statusCode: 200, body: "{}" };
      });

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(200);
    });

    it("returns 401 when x-isb-identity header is absent and caller is not M2M", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(401);
    });

    it("returns 401 when JWKS verification fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: "not-an-encoded-token" },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(401);
    });

    it("returns 403 when token sub does not match the IAM principal sub", async () => {
      const claims = {
        sub: "different-sub",
        email: "user@example.com",
        [COGNITO_IDC_USER_ID_CLAIM]: "user-id-1",
        [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(["Admin"]),
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(403);
    });

    it("returns 401 when the verified token is missing required claims", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken({ sub: SUB }) },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(401);
    });

    it("returns 403 when the roles claim parses to an empty array", async () => {
      // Required claims present, but the roles JSON contains only invalid
      // values — parseRolesClaim filters them out, leaving an empty array.
      const claims = {
        sub: SUB,
        email: "user@example.com",
        [COGNITO_IDC_USER_ID_CLAIM]: "user-id-1",
        [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(["NotARealRole"]),
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
        identity: { cognitoAuthenticationProvider },
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(403);
    });
  });

  describe("M2M path (assumed-role IAM principal)", () => {
    it("parses a per-client admin role ARN into an M2M identity", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        identity: { userArn: m2mAdminArn("deploy-pipeline") },
      });

      const handler = createHandler(async (_event, context) => {
        expect(isM2MUser(context.user)).toBe(true);
        if (isM2MUser(context.user)) {
          expect(context.user.clientId).toBe("deploy-pipeline");
          expect(context.user.roles).toEqual(["Admin"]);
        }
        return { statusCode: 200, body: "{}" };
      });

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(200);
    });

    it("rejects look-alike role ARNs that do not match the namespace prefix (regex anchoring)", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        identity: {
          userArn:
            "arn:aws:sts::123456789012:assumed-role/evil-isb-m2m-admin-x/session-name",
        },
        // No x-isb-identity header → user-path verification fires and 401s.
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(401);
    });

    it("rejects a matching M2M role ARN from a different AWS account", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        identity: {
          userArn: buildM2mAssumedRoleArn({
            namespace: NAMESPACE,
            roleTier: "Admin",
            clientName: "foreign-client",
            accountId: "210987654321",
          }),
        },
      });
      const handlerFn = vi.fn(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await createHandler(handlerFn)(event, {} as any);

      expect(response.statusCode).toBe(401);
      expect(handlerFn).not.toHaveBeenCalled();
    });

    it("returns 400 when an M2M IAM principal also sends x-isb-identity (hybrid request)", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken({ sub: SUB }) },
        identity: { userArn: m2mAdminArn("deploy-pipeline") },
      });

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(400);
    });

    it("matches M2M role names case-insensitively", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        identity: {
          userArn: `arn:aws:sts::123456789012:assumed-role/${NAMESPACE}-isb-m2m-Admin-deploy-pipeline/session-name`,
        },
      });

      const handler = createHandler(async (_event, context) => {
        expect(isM2MUser(context.user)).toBe(true);
        return { statusCode: 200, body: "{}" };
      });

      const response = await handler(event, {} as any);
      expect(response.statusCode).toBe(200);
    });
  });

  describe("Logger context enrichment", () => {
    it("appends user, userGroups, and authType to logger context", async () => {
      const claims = {
        sub: SUB,
        email: "user@example.com",
        [COGNITO_IDC_USER_ID_CLAIM]: "user-id-1",
        [COGNITO_ISB_ROLES_CLAIM]: JSON.stringify(["Admin"]),
      };
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: { [IDENTITY_HEADER]: encodeTestToken(claims) },
        identity: { cognitoAuthenticationProvider },
      });

      const appendKeysSpy = vi.spyOn(logger, "appendKeys");

      const handler = createHandler(async () => ({
        statusCode: 200,
        body: "{}",
      }));

      await handler(event, {} as any);

      expect(appendKeysSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/accounts",
          httpMethod: "GET",
          user: "user@example.com",
          userGroups: ["Admin"],
          authType: "user",
        }),
      );
    });
  });
});

describe("BaseApiLambdaEnvironmentSchema validation", () => {
  it("rejects ISB_NAMESPACE values containing regex-special characters", async () => {
    const { BaseApiLambdaEnvironmentSchema } =
      await import("@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js");
    const baseInput = generateSchemaData(BaseApiLambdaEnvironmentSchema);
    expect(
      BaseApiLambdaEnvironmentSchema.safeParse({
        ...baseInput,
        ISB_NAMESPACE: "isb.*",
      }).success,
    ).toBe(false);
    expect(
      BaseApiLambdaEnvironmentSchema.safeParse({
        ...baseInput,
        ISB_NAMESPACE: "isb-x",
      }).success,
    ).toBe(false);
  });
});

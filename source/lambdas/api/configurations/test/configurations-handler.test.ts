// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  getGlobalConfigForUI,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ReportingConfigSchema } from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  isbAuthorizedUser,
  mockAuthorizedContext,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the account pool stack config store
vi.mock(
  "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config-store.js",
  () => ({
    getAccountPoolStackConfig: vi.fn(),
  }),
);

const secretsManagerMock = mockClient(SecretsManagerClient);
const testEnv = generateSchemaData(ConfigurationLambdaEnvironmentSchema);
const mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);
const mockedReportingConfig = generateSchemaData(ReportingConfigSchema);
let handler: typeof import("@amzn/innovation-sandbox-configurations/configurations-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import(
      "@amzn/innovation-sandbox-configurations/configurations-handler.js"
    )
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig, mockedReportingConfig);

  // Mock Secrets Manager to return JWT secret
  secretsManagerMock.on(GetSecretValueCommand).resolves({
    SecretString: "testSecret",
  });
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
  secretsManagerMock.reset();
});

describe("Configurations Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      headers: {
        Authorization: `Bearer ${isbAuthorizedUser.token}`,
      },
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  describe("GET /configurations", () => {
    it("should return 200 with all configurations", async () => {
      const mockIsbManagedRegions = ["us-east-1", "us-west-2"];
      const mockAccountPoolConfig = {
        sandboxOuId: "ou-123",
        availableOuId: "ou-456",
        activeOuId: "ou-789",
        frozenOuId: "ou-012",
        cleanupOuId: "ou-345",
        quarantineOuId: "ou-678",
        entryOuId: "ou-901",
        exitOuId: "ou-234",
        solutionVersion: "1.0.0",
        supportedSchemas: '["1"]',
        isbManagedRegions: mockIsbManagedRegions,
      };

      // Mock the SsmAccountPoolStackConfigStore to return the account pool config
      const { SsmAccountPoolStackConfigStore } = await import(
        "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js"
      );
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue(mockAccountPoolConfig);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        headers: {
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const context = mockAuthorizedContext(testEnv);
      const expectedGlobalConfig = getGlobalConfigForUI(
        mockedGlobalConfig,
        mockIsbManagedRegions,
      );
      const expectedReportingConfig = mockedReportingConfig;
      expect(await handler(event, context)).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            ...expectedGlobalConfig,
            ...expectedReportingConfig,
          },
        }),
        headers: responseHeaders,
      });
    });
  });
});

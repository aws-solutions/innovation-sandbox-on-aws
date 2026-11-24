// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DynamoBedrockPriceCache } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/dynamo-bedrock-price-cache.js";
import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  isbAuthorizedUser,
  mockAuthorizedContext,
  mockGlobalConfig,
  responseHeaders,
  responseHeadersWithErrorType,
  serializedBodyLike,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  ConfigSchemas,
  ConfigSection,
  type ConfigSectionWriteFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import {
  BedrockClient,
  FoundationModelLifecycleStatus,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
  InferenceType,
  ModelModality,
  ResourceNotFoundException,
  ThrottlingException,
} from "@aws-sdk/client-bedrock";
import {
  GetIdentityVerificationAttributesCommand,
  SESClient,
} from "@aws-sdk/client-ses";
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

// Use the real client shapes so Powertools can attach tracing middleware.
const bedrockMock = mockClient(BedrockClient);

/** An eligible foundation model, as GetFoundationModel describes it. */
const sonnetDetails = {
  modelId: "anthropic.claude-sonnet-4-6",
  modelArn:
    "arn:aws:bedrock:us-east-1::foundation-model/anthropic.claude-sonnet-4-6",
  modelName: "Claude Sonnet 4.6",
  providerName: "Anthropic",
  inputModalities: [ModelModality.TEXT],
  outputModalities: [ModelModality.TEXT],
  responseStreamingSupported: true,
  inferenceTypesSupported: [InferenceType.ON_DEMAND],
  modelLifecycle: { status: FoundationModelLifecycleStatus.ACTIVE },
};

function notFound() {
  return new ResourceNotFoundException({
    message: "The specified model is not found.",
    $metadata: {},
  });
}
const sesMock = mockClient(SESClient);

const testEnv = generateSchemaData(ConfigurationLambdaEnvironmentSchema, {
  CONFIG_TABLE_NAME: "test-config-table",
  BEDROCK_REGIONAL_PRICE_TABLE_NAME: "test-bedrock-prices",
  AWS_ACCESS_PORTAL_URL: "https://example.awsapps.com/start",
  // Empty means no delegated identity: the hub-account SES path is the default.
  SES_IDENTITY_ARN: "",
  AWS_REGION: "us-east-1",
});
const mockedGlobalConfig = mockGlobalConfig();
let handler: typeof import("@amzn/innovation-sandbox-configurations/configurations-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-configurations/configurations-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig);
  bedrockMock.reset();
  // Bedrock knows one foundation model and no inference profiles; any other
  // identifier is not found, as Bedrock answers.
  bedrockMock
    .on(GetFoundationModelCommand)
    .rejects(notFound())
    .on(GetFoundationModelCommand, {
      modelIdentifier: "anthropic.claude-sonnet-4-6",
    })
    .resolves({ modelDetails: sonnetDetails });
  bedrockMock.on(GetInferenceProfileCommand).rejects(notFound());
  sesMock.reset();
  // Unless a test says otherwise, no model has a stored price.
  vi.spyOn(DynamoBedrockPriceCache.prototype, "getPrices").mockResolvedValue(
    [],
  );
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

// The domain is now served by the generated Smithy `ConfigurationsApi` handler,
// so success responses go through the `restJson1` serializer: it adds a
// `content-length` header (headers are asserted by containment), drops `null`
// members (a never-saved section's `lastSavedBy: null` is absent), drops the
// unmodeled `meta.schemaVersion`, and normalizes `date-time` strings — all
// accepted deviations, matched with `serializedBodyLike`. Business/framework
// errors still render through the Middy `httpErrorHandler` (exact bytes).
describe("Configurations Handler", async () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  it("should return 500 when CONFIG_TABLE_NAME is not set", async () => {
    vi.stubEnv("CONFIG_TABLE_NAME", "");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  it("should return 500 when AWS_ACCESS_PORTAL_URL is not set", async () => {
    vi.stubEnv("AWS_ACCESS_PORTAL_URL", "");

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  it.each([
    "not-an-arn",
    "arn:aws:ses:us-west-2:123456789012:identity/example.com",
  ])("returns 500 for invalid SES identity configuration: %s", async (arn) => {
    vi.stubEnv("SES_IDENTITY_ARN", arn);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations",
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  describe("GET /configurations", () => {
    it("should return 200 with all configurations", async () => {
      const mockIsbManagedRegions = ["us-east-1", "us-west-2"];
      const mockAccountPoolConfig = {
        organizationId: "o-a1b2c3d4e5",
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
        bedrockInferenceProfilePatterns: "arn-pattern-a,arn-pattern-b",
      };

      // Mock the SsmAccountPoolStackConfigStore to return the account pool config
      const { SsmAccountPoolStackConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue(mockAccountPoolConfig);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        isbUser: isbAuthorizedUser.user,
      });
      const context = mockAuthorizedContext(testEnv);

      const response = await handler(event, context);

      expect(response.statusCode).toBe(200);
      expect(response.headers).toEqual(
        expect.objectContaining(responseHeaders),
      );

      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
        // `lastSavedBy: null` and `meta.schemaVersion` are dropped by the
        // serializer / output mapper (accepted deviations).
        expect(body.data[section]).toEqual({
          ...mockedGlobalConfig[section],
          meta: {
            createdTime: expect.any(String),
            lastEditTime: expect.any(String),
          },
        });
      }
      expect(body.data.isbManagedRegions).toEqual(mockIsbManagedRegions);
      expect(body.data.awsAccessPortalUrl).toEqual(
        testEnv.AWS_ACCESS_PORTAL_URL,
      );
      expect(body.data.bedrockInferenceProfilePatterns).toEqual([
        "arn-pattern-a",
        "arn-pattern-b",
      ]);
    });

    it("trims patterns and drops empty entries", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getAllSections").mockResolvedValue(
        {},
      );

      const { SsmAccountPoolStackConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue({
        isbManagedRegions: ["us-east-1"],
        bedrockInferenceProfilePatterns: " a, ,b,",
      } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.bedrockInferenceProfilePatterns).toEqual(["a", "b"]);
    });

    it("returns code defaults with lastSavedBy null for sections absent from DynamoDB", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getAllSections").mockResolvedValue(
        {},
      );

      const { SsmAccountPoolStackConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
      vi.spyOn(
        SsmAccountPoolStackConfigStore.prototype,
        "get",
      ).mockResolvedValue({ isbManagedRegions: ["us-east-1"] } as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations",
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      for (const section of Object.keys(ConfigSchemas) as ConfigSection[]) {
        // A never-saved section: `lastSavedBy: null` is dropped and there is no meta.
        expect(body.data[section]).toEqual(ConfigSchemas[section].parse({}));
      }
      // The account-pool mock omits bedrockInferenceProfilePatterns, so the
      // handler coalesces the absent value to an empty list.
      expect(body.data.bedrockInferenceProfilePatterns).toEqual([]);
    });
  });

  describe("GET /configurations/{section}", () => {
    it("returns 200 with the stored section when present in DynamoDB", async () => {
      const storedSection = {
        ...mockedGlobalConfig.leases,
        lastSavedBy: "admin@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-02T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        storedSection as any,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/leases",
        pathParameters: { section: "leases" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      // `meta.schemaVersion` is dropped; the ISO strings pass through verbatim
      // (opaque `String` meta), so compare exactly rather than via the
      // timestamp-normalizing `serializedBodyLike`.
      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      const { schemaVersion: _v, ...meta } = storedSection.meta;
      expect(body.data).toEqual({ ...storedSection, meta });
    });

    it("returns 200 with code defaults and lastSavedBy null when section absent", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        null,
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/maintenance",
        pathParameters: { section: "maintenance" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      // A never-saved section: `lastSavedBy: null` is dropped, no meta.
      expect(response.body).toEqual(
        serializedBodyLike({
          status: "success",
          data: ConfigSchemas.maintenance.parse({}),
        }),
      );
    });

    it("passes meta timestamps through as opaque strings (byte-exact concurrency token)", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue({
        ...mockedGlobalConfig.maintenance,
        lastSavedBy: "admin@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-02T00:00:00.000Z",
          schemaVersion: 1,
        },
      } as any);

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/configurations/maintenance",
          pathParameters: { section: "maintenance" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv),
      );

      // meta is modeled as opaque String, so the stored ISO strings are returned
      // verbatim (millisecond fraction preserved) — the `lastEditTime` etag must
      // survive byte-for-byte — and `schemaVersion` is dropped.
      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      expect(body.data.meta).toEqual({
        createdTime: "2024-01-01T00:00:00.000Z",
        lastEditTime: "2024-01-02T00:00:00.000Z",
      });
    });

    it("returns 500 (not a silent success) when a read-path store call fails", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getAllSections").mockRejectedValue(
        new Error("DynamoDB throttled"),
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/configurations",
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("DynamoDB throttled");
    });

    // Guards the per-section service bindings (assembled through an `as any`
    // cast): a swap (e.g. GetCleanupConfiguration wired to the leases factory)
    // would compile, so assert the mux → operation → store routing per section.
    it.each(Object.keys(ConfigSchemas) as ConfigSection[])(
      "GET /configurations/%s dispatches to getSection('%s')",
      async (section) => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        const spy = vi
          .spyOn(DynamoConfigStore.prototype, "getSection")
          .mockResolvedValue(null);

        await handler(
          createAPIGatewayProxyEvent({
            httpMethod: "GET",
            path: `/configurations/${section}`,
            pathParameters: { section },
            isbUser: isbAuthorizedUser.user,
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(spy).toHaveBeenCalledWith(section);
      },
    );

    it("returns 404 for an unknown section", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/bogus",
        pathParameters: { section: "bogus" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(404);
    });

    it("returns 404 for a prototype-chain key", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/constructor",
        pathParameters: { section: "constructor" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(404);
    });

    it("GET /configurations/notification returns code defaults when unsaved", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        null,
      );

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/configurations/notification",
          pathParameters: { section: "notification" },
          isbUser: isbAuthorizedUser.user,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      // A never-saved section: code defaults (`emailFrom: ""`, `sesEnabled:
      // true`, `snsIntegrationTopicEnabled: false`), `lastSavedBy: null`
      // dropped, no meta.
      expect(response.body).toEqual(
        serializedBodyLike({
          status: "success",
          data: ConfigSchemas.notification.parse({}),
        }),
      );
    });
  });

  describe("PUT /configurations/{section}", () => {
    function createPutEvent(
      section: string,
      body: Record<string, unknown>,
      isbUser: IsbUser = isbAuthorizedUser.user,
    ) {
      return createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: `/configurations/${section}`,
        pathParameters: { section },
        body: JSON.stringify(body),
        headers: { "Content-Type": "application/json" },
        isbUser,
      });
    }

    // A complete `notification` write body. Every field is required on a
    // write, so tests override only the field they exercise.
    const notificationBody = (
      overrides: Partial<ConfigSectionWriteFields<"notification">> = {},
    ) => ({ ...ConfigSchemas.notification.parse({}), ...overrides });

    const savedMeta = {
      createdTime: "2024-01-01T00:00:00.000Z",
      lastEditTime: "2024-01-01T00:00:00.000Z",
      schemaVersion: 1,
    };

    it("returns 200 on first save (no expectedLastEditTime)", async () => {
      const savedSection = {
        ...mockedGlobalConfig.maintenance,
        lastSavedBy: "test@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue(savedSection as any);

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const { schemaVersion: _v, ...meta } = savedSection.meta;
      expect(body.data).toEqual({ ...savedSection, meta });
      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: false },
        "test@example.com",
        undefined,
      );
    });

    it("returns 200 on subsequent save and passes expectedLastEditTime", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue({
          ...mockedGlobalConfig.maintenance,
          lastSavedBy: "test@example.com",
          meta: {
            createdTime: "2024-01-01T00:00:00.000Z",
            lastEditTime: "2024-01-03T00:00:00.000Z",
            schemaVersion: 1,
          },
        } as any);

      const response = await handler(
        createPutEvent("maintenance", {
          enabled: true,
          meta: { lastEditTime: "2024-01-02T00:00:00.000Z" },
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: true },
        "test@example.com",
        "2024-01-02T00:00:00.000Z",
      );
    });

    it("strips client-supplied lastSavedBy from the request body", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue({
          ...mockedGlobalConfig.maintenance,
          lastSavedBy: "test@example.com",
          meta: {
            createdTime: "2024-01-01T00:00:00.000Z",
            lastEditTime: "2024-01-01T00:00:00.000Z",
            schemaVersion: 1,
          },
        } as any);

      await handler(
        createPutEvent("maintenance", {
          enabled: false,
          lastSavedBy: "attacker@example.com",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(putSpy).toHaveBeenCalledWith(
        "maintenance",
        { enabled: false },
        "test@example.com",
        undefined,
      );
    });

    it("returns 409 when the store reports a conflict", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "putSection").mockRejectedValue(
        new ConflictError("conflict"),
      );

      const response = await handler(
        createPutEvent("maintenance", {
          enabled: false,
          meta: { lastEditTime: "2024-01-02T00:00:00.000Z" },
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(409);
    });

    it("returns 500 when putSection throws an unexpected error", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "putSection").mockRejectedValue(
        new Error("DynamoDB timeout"),
      );

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(500);
      expect(response.body).not.toContain("DynamoDB timeout");
    });

    it("returns 400 when the body fails schema validation", async () => {
      const response = await handler(
        createPutEvent("maintenance", { enabled: "yes" }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
    });

    it("returns 400 rejecting unknown fields without echoing the submitted value", async () => {
      const response = await handler(
        createPutEvent("maintenance", {
          enabled: false,
          unknownField: "secret-value",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("secret-value");
    });

    it("returns 200 for a valid leases section and strips the envelope before putSection", async () => {
      const savedSection = {
        ...mockedGlobalConfig.leases,
        lastSavedBy: "test@example.com",
        meta: {
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-01-01T00:00:00.000Z",
          schemaVersion: 1,
        },
      };
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const putSpy = vi
        .spyOn(DynamoConfigStore.prototype, "putSection")
        .mockResolvedValue(savedSection as any);

      const response = await handler(
        createPutEvent("leases", { ...mockedGlobalConfig.leases }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
      const body = JSON.parse(response.body);
      const { schemaVersion: _v, ...meta } = savedSection.meta;
      expect(body.data).toEqual({ ...savedSection, meta });
      expect(putSpy).toHaveBeenCalledWith(
        "leases",
        { ...mockedGlobalConfig.leases },
        "test@example.com",
        undefined,
      );
    });

    it("rejects a leases update that omits group assignment mode", async () => {
      const {
        groupAssignmentMode: _groupAssignmentMode,
        ...leasesWithoutMode
      } = mockedGlobalConfig.leases;

      const response = await handler(
        createPutEvent("leases", leasesWithoutMode),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
    });

    it("rejects a model-range violation via generated validation + the JSend customizer", async () => {
      // Canary that the validation customizer is wired (disableDefaultValidation
      // spans two domains): `maxBudget` beyond the model `@range` max is rejected
      // by generated deserialization/validation BEFORE the operation's Zod, and
      // the customizer must render it as a JSend 400 rather than a raw framework
      // `SerializationException`.
      const response = await handler(
        createPutEvent("leases", {
          ...mockedGlobalConfig.leases,
          maxBudget: 2_000_000_000,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors.length).toBeGreaterThan(0);
      // The customizer must fully replace the framework exception, not sit
      // alongside it: no raw `__type` / `SerializationException` may leak.
      expect(body.__type).toBeUndefined();
      expect(response.body).not.toContain("SerializationException");
      expect(response.body).not.toContain("ValidationException");
    });

    it("returns 400 when the leases cross-field refinement is violated", async () => {
      const response = await handler(
        createPutEvent("leases", {
          ...mockedGlobalConfig.leases,
          ttl: 1,
          leaseRequestWindowHours: 168,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
      expect(response.body).not.toContain("days =");
    });

    it("returns 400 rejecting unknown fields in the leases section", async () => {
      const response = await handler(
        createPutEvent("leases", {
          ...mockedGlobalConfig.leases,
          unknownField: "secret-value",
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(400);
    });

    it("returns 404 for an unknown section", async () => {
      const response = await handler(
        createPutEvent("bogus", { enabled: false }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(404);
    });

    // Guards the write bindings (assembled through `as any`): a swapped binding
    // would write one section's payload into another's record and still compile.
    it.each(Object.keys(ConfigSchemas) as ConfigSection[])(
      "PUT /configurations/%s dispatches to putSection('%s')",
      async (section) => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        const putSpy = vi
          .spyOn(DynamoConfigStore.prototype, "putSection")
          .mockResolvedValue({
            ...mockedGlobalConfig[section],
            lastSavedBy: "test@example.com",
            meta: {
              createdTime: "2024-01-01T00:00:00.000Z",
              lastEditTime: "2024-01-01T00:00:00.000Z",
              schemaVersion: 1,
            },
          } as any);

        // `notification` would trigger the SES check; an empty `emailFrom`
        // (notifications disabled) is a valid body that skips it.
        const body =
          section === "notification"
            ? { ...mockedGlobalConfig.notification, emailFrom: "" }
            : { ...mockedGlobalConfig[section] };

        const response = await handler(
          createPutEvent(section, body),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        expect(putSpy).toHaveBeenCalledTimes(1);
        // First arg is the store section — a mis-wired binding writes elsewhere.
        expect(putSpy).toHaveBeenCalledWith(
          section,
          expect.any(Object),
          "test@example.com",
          undefined,
        );
      },
    );

    it("returns 403 for an M2M caller", async () => {
      const m2mUser: IsbUser = {
        type: "m2m",
        clientId: "automation-client",
        roles: ["Admin"],
      };

      const response = await handler(
        createPutEvent("maintenance", { enabled: false }, m2mUser),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(403);
    });

    it("rejects an M2M write BEFORE model validation (middleware-order regression guard)", async () => {
      // A model-invalid body from an M2M caller: only the pre-pipeline middleware
      // yields 403 here; a removed middleware would let validation run first and
      // return 400. So 403 proves authorization precedes validation.
      const m2mUser: IsbUser = {
        type: "m2m",
        clientId: "automation-client",
        roles: ["Admin"],
      };

      const response = await handler(
        createPutEvent(
          "leases",
          { ...mockedGlobalConfig.leases, maxBudget: 2_000_000_000 },
          m2mUser,
        ),
        mockAuthorizedContext(testEnv),
      );

      // 403 (not 400) is the load-bearing assertion; the message is the authz copy
      // and no validation field detail leaked.
      expect(response.statusCode).toBe(403);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain("not authorized");
      expect(response.body).not.toContain("maxBudget");
    });

    it("allows an M2M GET (the write block is scoped to non-GET methods)", async () => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
        null,
      );
      const m2mUser: IsbUser = {
        type: "m2m",
        clientId: "automation-client",
        roles: ["Admin"],
      };

      const response = await handler(
        createAPIGatewayProxyEvent({
          httpMethod: "GET",
          path: "/configurations/maintenance",
          pathParameters: { section: "maintenance" },
          isbUser: m2mUser,
        }),
        mockAuthorizedContext(testEnv),
      );

      expect(response.statusCode).toBe(200);
    });

    // Focused persistence and validation coverage for the notification section
    // (sender plus channel toggles).
    describe("notification section", () => {
      it("PUT /configurations/notification persists the sender and both toggles", async () => {
        const written = notificationBody({
          sesEnabled: false,
          snsIntegrationTopicEnabled: true,
        });
        const savedSection = {
          ...written,
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        };
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        const putSpy = vi
          .spyOn(DynamoConfigStore.prototype, "putSection")
          .mockResolvedValue(savedSection as any);

        const response = await handler(
          createPutEvent("notification", written),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        const body = JSON.parse(response.body);
        const { schemaVersion: _v, ...meta } = savedSection.meta;
        expect(body.data).toEqual({ ...savedSection, meta });
        expect(putSpy).toHaveBeenCalledWith(
          "notification",
          written,
          "test@example.com",
          undefined,
        );
      });

      it("returns 400 rejecting an unrecognized key (.strict())", async () => {
        const response = await handler(
          createPutEvent("notification", {
            ...notificationBody(),
            unknownField: "secret-value",
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        expect(response.body).not.toContain("secret-value");
      });

      it.each(["emailFrom", "sesEnabled", "snsIntegrationTopicEnabled"])(
        "returns 400 when %s is missing",
        async (field) => {
          const { [field]: _omitted, ...body } = notificationBody() as Record<
            string,
            unknown
          >;
          const response = await handler(
            createPutEvent("notification", body),
            mockAuthorizedContext(testEnv),
          );

          expect(response.statusCode).toBe(400);
        },
      );

      it("returns 409 when the store reports a conflict on a stale meta.lastEditTime", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        const putSpy = vi
          .spyOn(DynamoConfigStore.prototype, "putSection")
          .mockRejectedValue(new ConflictError("conflict"));

        const response = await handler(
          createPutEvent("notification", {
            ...notificationBody(),
            meta: { lastEditTime: "2024-01-02T00:00:00.000Z" },
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(409);
        expect(putSpy).toHaveBeenCalledWith(
          "notification",
          notificationBody(),
          "test@example.com",
          "2024-01-02T00:00:00.000Z",
        );
      });
    });

    describe("agent section", () => {
      const validAgentBody = {
        sandboxSpacesEnabled: true,
      };

      async function mockManagedRegions(regions: string[]) {
        const { SsmAccountPoolStackConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js");
        vi.spyOn(
          SsmAccountPoolStackConfigStore.prototype,
          "get",
        ).mockResolvedValue({ isbManagedRegions: regions } as any);
      }

      async function mockCatalogModels(enabledFlags: boolean[]) {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(
          DynamoConfigStore.prototype,
          "getAgentModels",
        ).mockResolvedValue(
          enabledFlags.map((enabled, i) => ({
            modelId: `model-${i}`,
            enabled,
          })) as any,
        );
      }

      it("returns 200 with valid agent config body", async () => {
        // testEnv.AWS_REGION is "us-east-1"; it must be a managed region to enable.
        await mockManagedRegions(["us-east-1", "us-west-2"]);
        await mockCatalogModels([true]);
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...validAgentBody,
          lastSavedBy: "admin@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        const response = await handler(
          createPutEvent("agent", validAgentBody),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 400 when enabling from an unmanaged hub home region", async () => {
        await mockManagedRegions(["eu-west-1"]); // testEnv region us-east-1 not included

        const response = await handler(
          createPutEvent("agent", validAgentBody),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("sandboxSpacesEnabled");
        expect(body.data.errors[0].message).toContain("us-east-1");
        expect(body.data.errors[0].message).toContain("ISB-managed regions");
      });

      it("returns 400 when enabling with no enabled catalog models", async () => {
        await mockManagedRegions(["us-east-1"]);
        await mockCatalogModels([false]);
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        const putSpy = vi.spyOn(DynamoConfigStore.prototype, "putSection");

        const response = await handler(
          createPutEvent("agent", validAgentBody),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("sandboxSpacesEnabled");
        expect(body.data.errors[0].message).toContain(
          "Enable at least one model in the Model Catalog",
        );
        expect(putSpy).not.toHaveBeenCalled();
      });

      it("checks for an enabled model with a strongly consistent read", async () => {
        await mockManagedRegions(["us-east-1"]);
        await mockCatalogModels([false]);
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");

        await handler(
          createPutEvent("agent", validAgentBody),
          mockAuthorizedContext(testEnv),
        );

        expect(DynamoConfigStore.prototype.getAgentModels).toHaveBeenCalledWith(
          { consistentRead: true },
        );
      });

      it("allows disabling regardless of whether the hub home region is managed", async () => {
        await mockManagedRegions(["eu-west-1"]); // us-east-1 not managed
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          sandboxSpacesEnabled: false,
          lastSavedBy: "admin@example.com",
          meta: { createdTime: "t", lastEditTime: "t", schemaVersion: 1 },
        } as any);

        const response = await handler(
          createPutEvent("agent", { sandboxSpacesEnabled: false }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("returns 400 when the required sandboxSpacesEnabled field is missing", async () => {
        const response = await handler(
          createPutEvent("agent", {}),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 when sandboxSpacesEnabled is a string", async () => {
        const response = await handler(
          createPutEvent("agent", { sandboxSpacesEnabled: "ENABLED" }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 rejecting the removed per-principal budget fields", async () => {
        const response = await handler(
          createPutEvent("agent", {
            ...validAgentBody,
            maxTokensPerMonth: 100_000,
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
      });

      it("returns 400 rejecting unknown fields", async () => {
        const response = await handler(
          createPutEvent("agent", {
            ...validAgentBody,
            unknownField: "value",
          }),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
      });
    });

    describe("SES email-from validation", () => {
      it("rejects an unverified email address with a field error", async () => {
        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "nobody@example.com": { VerificationStatus: "Pending" },
            "example.com": { VerificationStatus: "NotStarted" },
          },
        });

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "nobody@example.com" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("emailFrom");
        expect(body.data.errors[0].message).toContain(
          "not a verified SES identity",
        );
        // The message must NOT echo the user-supplied address (reflected input
        // is a pentest finding); the copy is static regardless of the input.
        expect(body.data.errors[0].message).not.toContain("nobody@example.com");
      });

      it("allows an email whose exact address is verified", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom: "verified@example.com" }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);

        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "verified@example.com": { VerificationStatus: "Success" },
            "example.com": { VerificationStatus: "NotStarted" },
          },
        });

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "verified@example.com" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("allows a plus label on a verified email identity", async () => {
        const emailFrom = "verified+alerts@example.com";
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);

        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "verified@example.com": { VerificationStatus: "Success" },
          },
        });

        const response = await handler(
          createPutEvent("notification", notificationBody({ emailFrom })),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        expect(
          sesMock.commandCalls(GetIdentityVerificationAttributesCommand)[0]
            ?.args[0].input.Identities,
        ).toContain("verified@example.com");
      });

      it("allows an email whose domain is verified", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom: "anyone@verified-domain.com" }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);

        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "anyone@verified-domain.com": { VerificationStatus: "NotStarted" },
            "verified-domain.com": { VerificationStatus: "Success" },
          },
        });

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "anyone@verified-domain.com" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("allows an email whose parent domain is verified (subdomain)", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom: "user@mail.corp.example.com" }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);

        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "user@mail.corp.example.com": { VerificationStatus: "NotStarted" },
            "mail.corp.example.com": { VerificationStatus: "NotStarted" },
            "corp.example.com": { VerificationStatus: "NotStarted" },
            "example.com": { VerificationStatus: "Success" },
          },
        });

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "user@mail.corp.example.com" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        const calls = sesMock.commandCalls(
          GetIdentityVerificationAttributesCommand,
        );
        expect(calls).toHaveLength(1);
        expect(calls[0]?.args[0].input).toEqual({
          Identities: [
            "user@mail.corp.example.com",
            "mail.corp.example.com",
            "corp.example.com",
            "example.com",
          ],
        });
      });

      it("rejects the save when SES returns an error (fail-closed)", async () => {
        sesMock
          .on(GetIdentityVerificationAttributesCommand)
          .rejects(new Error("SES throttled"));

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "user@example.com" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].field).toBe("emailFrom");
        expect(body.data.errors[0].message).toContain(
          "Unable to verify this email against SES",
        );
      });

      it("skips validation when emailFrom is empty (notifications disabled)", async () => {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom: "" }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);

        const response = await handler(
          createPutEvent("notification", notificationBody({ emailFrom: "" })),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
        expect(
          sesMock.commandCalls(GetIdentityVerificationAttributesCommand),
        ).toHaveLength(0);
      });
    });

    describe("delegated SES identity save-time validation", () => {
      const delegatedIdentityArn =
        "arn:aws:ses:us-east-1:210987654321:identity/delegated.example.com";

      async function mockPutSection(emailFrom: string) {
        const { DynamoConfigStore } =
          await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
        vi.spyOn(DynamoConfigStore.prototype, "putSection").mockResolvedValue({
          ...notificationBody({ emailFrom }),
          lastSavedBy: "test@example.com",
          meta: savedMeta,
        } as any);
      }

      beforeEach(() => {
        vi.stubEnv("SES_IDENTITY_ARN", delegatedIdentityArn);
        // Any SES call here means the hub-account path ran by mistake.
        sesMock
          .on(GetIdentityVerificationAttributesCommand)
          .rejects(new Error("SES must not be called"));
      });

      it.each([
        "noreply@delegated.example.com",
        "noreply@mail.delegated.example.com",
      ])(
        "saves %s as covered by the delegated identity without calling SES",
        async (emailFrom) => {
          await mockPutSection(emailFrom);

          const response = await handler(
            createPutEvent("notification", notificationBody({ emailFrom })),
            mockAuthorizedContext(testEnv),
          );

          expect(response.statusCode).toBe(200);
          expect(
            sesMock.commandCalls(GetIdentityVerificationAttributesCommand),
          ).toHaveLength(0);
        },
      );

      it.each([
        {
          identityType: "domain",
          identityArn: delegatedIdentityArn,
          emailFrom: "noreply@other.example.org",
          guidance: "identity's domain or one of its subdomains",
        },
        {
          identityType: "email",
          identityArn:
            "arn:aws:ses:us-east-1:210987654321:identity/allowed@example.com",
          emailFrom: "other@example.com",
          guidance: "delegated identity's exact address",
        },
      ])(
        "returns accurate static guidance for a delegated $identityType identity",
        async ({ identityArn, emailFrom, guidance }) => {
          vi.stubEnv("SES_IDENTITY_ARN", identityArn);

          const response = await handler(
            createPutEvent("notification", notificationBody({ emailFrom })),
            mockAuthorizedContext(testEnv),
          );

          expect(response.statusCode).toBe(400);
          const body = JSON.parse(response.body);
          expect(body.data.errors[0].field).toBe("emailFrom");
          expect(body.data.errors[0].message).toContain(guidance);
          // Static copy never echoes the submitted address or identity ARN.
          expect(body.data.errors[0].message).not.toContain(emailFrom);
          expect(body.data.errors[0].message).not.toContain(identityArn);
          expect(
            sesMock.commandCalls(GetIdentityVerificationAttributesCommand),
          ).toHaveLength(0);
        },
      );

      it("skips the check when emailFrom is empty", async () => {
        await mockPutSection("");

        const response = await handler(
          createPutEvent("notification", notificationBody({ emailFrom: "" })),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(200);
      });

      it("falls back to the hub-account SES check when no delegated identity is configured", async () => {
        vi.stubEnv("SES_IDENTITY_ARN", "");
        sesMock.on(GetIdentityVerificationAttributesCommand).resolves({
          VerificationAttributes: {
            "noreply@other.example.org": { VerificationStatus: "NotStarted" },
            "other.example.org": { VerificationStatus: "NotStarted" },
            "example.org": { VerificationStatus: "NotStarted" },
          },
        });

        const response = await handler(
          createPutEvent(
            "notification",
            notificationBody({ emailFrom: "noreply@other.example.org" }),
          ),
          mockAuthorizedContext(testEnv),
        );

        expect(response.statusCode).toBe(400);
        const body = JSON.parse(response.body);
        expect(body.data.errors[0].message).toContain(
          "not a verified SES identity",
        );
        expect(
          sesMock.commandCalls(GetIdentityVerificationAttributesCommand),
        ).toHaveLength(1);
      });
    });
  });
});

// ─── Agent Model Catalog ─────────────────────────────────────────────────────

const adminUser: IsbUser = {
  ...isbAuthorizedUser.user,
  roles: ["Admin"],
};
const m2mUser: IsbUser = {
  type: "m2m",
  clientId: "test-client-id",
  roles: ["Admin"],
};

const catalogRow = {
  modelId: "anthropic.claude-sonnet-4-6",
  displayName: "Claude Sonnet 4.6",
  provider: "Anthropic",
  availability: "global",
  enabled: false,
  addedAt: "2026-09-01T00:00:00.000Z",
  lastSavedBy: "admin@example.com",
  meta: {
    createdTime: "2026-09-01T00:00:00.000Z",
    lastEditTime: "2026-09-01T00:00:00.000Z",
    schemaVersion: 1,
  },
};

describe("GET /configurations/agent/models", () => {
  it("returns 200 with all catalog rows", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModelsPaginated",
    ).mockResolvedValue({
      rows: [catalogRow] as any,
      nextPageIdentifier: null,
    });

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations/agent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0].modelId).toBe("anthropic.claude-sonnet-4-6");
  });

  it("adds each model's stored price from the price table, and none for a model with no stored price", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModelsPaginated",
    ).mockResolvedValue({
      rows: [catalogRow, { ...catalogRow, modelId: "unpriced.model" }] as any,
      nextPageIdentifier: null,
    });
    const getPrices = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "getPrices")
      .mockResolvedValue([
        {
          modelId: "anthropic.claude-sonnet-4-6",
          region: "us-east-1",
          inputPricePer1KTokens: 0.003,
          outputPricePer1KTokens: 0.015,
          cacheReadPricePer1KTokens: 0.0003,
          cacheWritePricePer1KTokens: 0.00375,
          pricingSource: "price-list",
          pricingRefreshedAt: "2026-09-10T12:00:00.000Z",
        },
      ]);
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations/agent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    expect(getPrices).toHaveBeenCalledWith([
      { modelId: "anthropic.claude-sonnet-4-6", region: "us-east-1" },
      { modelId: "unpriced.model", region: "us-east-1" },
    ]);
    const [priced, unpriced] = JSON.parse(result.body).data.models;
    expect(priced).toMatchObject({
      pricingSource: "price-list",
      pricingRefreshedAt: "2026-09-10T12:00:00.000Z",
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
      cacheReadPricePer1KTokens: 0.0003,
      cacheWritePricePer1KTokens: 0.00375,
    });
    expect(unpriced).not.toHaveProperty("inputPricePer1KTokens");
    expect(unpriced).not.toHaveProperty("pricingSource");
  });
  it("returns 200 with empty models array when catalog is empty", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModelsPaginated",
    ).mockResolvedValue({
      rows: [],
      nextPageIdentifier: null,
    });

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations/agent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.models).toEqual([]);
  });

  it("fails the request when the Lambda's region is not set", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModelsPaginated",
    ).mockResolvedValue({
      rows: [catalogRow] as any,
      nextPageIdentifier: null,
    });
    vi.stubEnv("AWS_REGION", "");
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/configurations/agent/models",
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(500);
  });
  it.each(["User", "Manager", "Admin"] as const)(
    "returns 200 for a %s caller",
    async (role) => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      vi.spyOn(
        DynamoConfigStore.prototype,
        "getAgentModelsPaginated",
      ).mockResolvedValue({
        rows: [catalogRow] as any,
        nextPageIdentifier: null,
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/configurations/agent/models",
        isbUser: { ...isbAuthorizedUser.user, roles: [role] },
      });
      const result = await handler(event, mockAuthorizedContext(testEnv));
      expect(result.statusCode).toBe(200);
      expect(JSON.parse(result.body).data.models).toHaveLength(1);
    },
  );
});

describe("PUT /configurations/agent/models/{modelId} — create (first call)", () => {
  it("resolves canonical Bedrock metadata and creates a new row", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const putSpy = vi
      .spyOn(DynamoConfigStore.prototype, "putModelRow")
      .mockResolvedValue(catalogRow as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({ enabled: false, modelType: "foundation-model" }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    expect(putSpy).toHaveBeenCalledWith(
      {
        modelId: "anthropic.claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "Anthropic",
        availability: "global",
        modelType: "foundation-model",
        foundationModelId: "anthropic.claude-sonnet-4-6",
        foundationModelName: "Claude Sonnet 4.6",
        enabled: false,
      },
      "test@example.com",
    );
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.modelId).toBe("anthropic.claude-sonnet-4-6");
  });

  it("returns 403 for M2M caller", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        displayName: "Claude Sonnet 4.6",
        provider: "Anthropic",
        availability: "global",
        enabled: false,
      }),
      isbUser: m2mUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(403);
  });

  // Each body is otherwise valid for its path, so the unknown key is the only
  // reason it can be rejected.
  it.each([
    ["create", { enabled: false, modelType: "foundation-model" }],
    [
      "update",
      { enabled: false, expectedLastEditTime: "2026-09-01T00:00:00.000Z" },
    ],
  ])(
    "rejects client-supplied model metadata on %s, and writes nothing",
    async (_path, validBody) => {
      const { DynamoConfigStore } =
        await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
      const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");
      const update = vi.spyOn(
        DynamoConfigStore.prototype,
        "updateModelAdminFields",
      );

      const event = createAPIGatewayProxyEvent({
        httpMethod: "PUT",
        path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
        pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
        body: JSON.stringify({
          ...validBody,
          displayName: "Attacker-controlled model name",
        }),
        isbUser: adminUser,
      });

      const result = await handler(event, mockAuthorizedContext(testEnv));

      expect(result.statusCode).toBe(400);
      expect(JSON.parse(result.body).data.errors).toEqual([
        { field: "input", message: 'Unrecognized key: "displayName"' },
      ]);
      expect(put).not.toHaveBeenCalled();
      expect(update).not.toHaveBeenCalled();
      expect(bedrockMock.calls()).toHaveLength(0);
      expect(result.body).not.toContain("Attacker-controlled model name");
    },
  );

  /** A create request for the given path model ID and body. */
  function createEvent(modelId: string, body: Record<string, unknown>) {
    return createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: `/configurations/agent/models/${modelId}`,
      pathParameters: { modelId },
      body: JSON.stringify(body),
      isbUser: adminUser,
    });
  }

  it("rejects a model that Bedrock does not recognize", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");

    const result = await handler(
      createEvent("unknown-model", {
        enabled: false,
        modelType: "foundation-model",
      }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).data.errors).toEqual([
      {
        field: "modelId",
        message: "The selected model is not available for Sandbox Spaces.",
      },
    ]);
    expect(put).not.toHaveBeenCalled();
    expect(result.body).not.toContain("unknown-model");
  });

  it("looks the model up only as the type the request names", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");

    const result = await handler(
      createEvent("anthropic.claude-sonnet-4-6", {
        enabled: false,
        modelType: "inference-profile",
      }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(400);
    expect(put).not.toHaveBeenCalled();
    expect(bedrockMock.commandCalls(GetFoundationModelCommand)).toHaveLength(0);
    expect(bedrockMock.commandCalls(GetInferenceProfileCommand)).toHaveLength(
      1,
    );
  });

  it("creates an inference profile from Bedrock's profile and routed model", async () => {
    const profileId = "us.anthropic.claude-sonnet-4-6";
    bedrockMock
      .on(GetInferenceProfileCommand, { inferenceProfileIdentifier: profileId })
      .resolves({
        inferenceProfileId: profileId,
        inferenceProfileName: "US Claude Sonnet 4.6",
        inferenceProfileArn: `arn:aws:bedrock:us-east-1:123456789012:inference-profile/${profileId}`,
        description: "Routes requests to Claude Sonnet 4.6 in US Regions.",
        status: "ACTIVE",
        type: "SYSTEM_DEFINED",
        models: [
          { modelArn: sonnetDetails.modelArn },
          {
            modelArn:
              "arn:aws:bedrock:us-west-2::foundation-model/anthropic.claude-sonnet-4-6",
          },
        ],
      });
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi
      .spyOn(DynamoConfigStore.prototype, "putModelRow")
      .mockResolvedValue({ ...catalogRow, modelId: profileId } as any);

    const result = await handler(
      createEvent(profileId, {
        enabled: false,
        modelType: "inference-profile",
      }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(200);
    expect(put).toHaveBeenCalledWith(
      {
        modelId: profileId,
        displayName: "US Claude Sonnet 4.6",
        provider: "Anthropic",
        availability: "us",
        description: "Routes requests to Claude Sonnet 4.6 in US Regions.",
        modelType: "inference-profile",
        foundationModelId: "anthropic.claude-sonnet-4-6",
        foundationModelName: "Claude Sonnet 4.6",
        enabled: false,
      },
      "test@example.com",
    );
    // Both routes name the same foundation model, so it is described once.
    expect(bedrockMock.commandCalls(GetFoundationModelCommand)).toHaveLength(1);
  });

  it("returns 400 and calls no Bedrock API when modelType is missing", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");

    const result = await handler(
      createEvent("anthropic.claude-sonnet-4-6", { enabled: false }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).data.errors[0]).toMatchObject({
      field: "modelType",
    });
    expect(put).not.toHaveBeenCalled();
    expect(bedrockMock.calls()).toHaveLength(0);
  });

  it("returns 429 on Bedrock throttling instead of reporting the model unavailable", async () => {
    bedrockMock
      .on(GetFoundationModelCommand)
      .rejects(
        new ThrottlingException({ message: "Rate exceeded", $metadata: {} }),
      );
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");

    const result = await handler(
      createEvent("anthropic.claude-sonnet-4-6", {
        enabled: false,
        modelType: "foundation-model",
      }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(429);
    expect(put).not.toHaveBeenCalled();
  });

  it("returns 409 when enabling a new model with no stored price, and writes nothing", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const put = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");

    const result = await handler(
      createEvent("anthropic.claude-sonnet-4-6", {
        enabled: true,
        modelType: "foundation-model",
      }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).data.errors[0].message).toContain(
      "Pricing is not available",
    );
    expect(put).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid body", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({ enabled: "false" }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(400);
  });
});

describe("PUT /configurations/agent/models/{modelId} — toggle update", () => {
  const updatedRow = { ...catalogRow, enabled: true };
  /** The price table holds a price for the model in this region. */
  const hasStoredPrice = () =>
    vi.spyOn(DynamoBedrockPriceCache.prototype, "getPrices").mockResolvedValue([
      {
        modelId: "anthropic.claude-sonnet-4-6",
        region: "us-east-1",
        inputPricePer1KTokens: 0.003,
        outputPricePer1KTokens: 0.015,
        cacheReadPricePer1KTokens: 0.0003,
        cacheWritePricePer1KTokens: 0.00375,
        pricingSource: "price-list",
        pricingRefreshedAt: "2026-09-10T12:00:00.000Z",
      },
    ]);

  it("returns 200 enabling an existing model with OCC token", async () => {
    hasStoredPrice();
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const updateSpy = vi
      .spyOn(DynamoConfigStore.prototype, "updateModelAdminFields")
      .mockResolvedValue(updatedRow as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: true,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
      }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    expect(updateSpy).toHaveBeenCalledWith(
      "anthropic.claude-sonnet-4-6",
      { enabled: true },
      "test@example.com",
      "2026-09-01T00:00:00.000Z",
    );
    const body = JSON.parse(result.body);
    expect(body.data.enabled).toBe(true);
  });

  it("returns 409 when enabling a model with no stored price, and writes nothing", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const update = vi.spyOn(
      DynamoConfigStore.prototype,
      "updateModelAdminFields",
    );
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: true,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
      }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(409);
    expect(JSON.parse(result.body).data.errors[0].message).toContain(
      "Pricing is not available",
    );
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 200 disabling a model that has no stored price", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue([
      { ...catalogRow, enabled: true },
      { ...catalogRow, modelId: "amazon.nova-pro-v1:0", enabled: true },
    ]);
    vi.spyOn(
      DynamoConfigStore.prototype,
      "updateModelAdminFields",
    ).mockResolvedValue({ ...catalogRow, enabled: false } as any);
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: false,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
      }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.enabled).toBe(false);
  });

  it("returns 400 when disabling the only enabled model while Sandbox Spaces is on, and writes nothing", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue({
      ...mockedGlobalConfig.agent,
      sandboxSpacesEnabled: true,
      lastSavedBy: "admin@example.com",
      meta: catalogRow.meta,
    });
    vi.spyOn(DynamoConfigStore.prototype, "getAgentModels").mockResolvedValue([
      { ...catalogRow, enabled: true },
      { ...catalogRow, modelId: "amazon.nova-pro-v1:0", enabled: false },
    ]);
    const update = vi.spyOn(
      DynamoConfigStore.prototype,
      "updateModelAdminFields",
    );
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: false,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
      }),
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).data.errors).toEqual([
      {
        field: "enabled",
        message:
          "Keep at least one model enabled while Sandbox Spaces is turned on.",
      },
    ]);
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 400 when an update sends modelType, and writes nothing", async () => {
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    const update = vi.spyOn(
      DynamoConfigStore.prototype,
      "updateModelAdminFields",
    );
    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: false,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
        modelType: "foundation-model",
      }),
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(400);
    expect(JSON.parse(result.body).data.errors[0]).toMatchObject({
      field: "modelType",
    });
    expect(update).not.toHaveBeenCalled();
  });

  it("returns 409 when OCC token is stale", async () => {
    hasStoredPrice();
    const { DynamoConfigStore } =
      await import("@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js");
    vi.spyOn(
      DynamoConfigStore.prototype,
      "updateModelAdminFields",
    ).mockRejectedValue(
      new ConflictError("Agent model row was modified by another process."),
    );

    const event = createAPIGatewayProxyEvent({
      httpMethod: "PUT",
      path: "/configurations/agent/models/anthropic.claude-sonnet-4-6",
      pathParameters: { modelId: "anthropic.claude-sonnet-4-6" },
      body: JSON.stringify({
        enabled: true,
        expectedLastEditTime: "2026-01-01T00:00:00.000Z",
      }),
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(409);
  });
});

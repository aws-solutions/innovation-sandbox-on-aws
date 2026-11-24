// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MalformedSandboxSpacesUsageRecordError } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import type { TerminalSpendFields } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { AgentWorkerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/agent-worker-lambda-environment.js";
import {
  AgentTurnMeteringFailedLogSchema,
  SandboxSpacesUsageRecordingFailedLogSchema,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import type { SQSEvent } from "aws-lambda";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockConnectionGet = vi.fn();
const mockConfigGetSection = vi.fn();
const mockConfigGetAgentModels = vi.fn();
const mockConfigGetAgentModel = vi.fn();
const mockPriceDiscoveredModels = vi.fn();
const mockRecordTurnUsage = vi.fn();
const mockGetLeaseUserUsage = vi.fn();
const mockValidateAndRoute = vi.fn();
const mockSendError = vi.fn();
const mockSendToConnection = vi.fn();
const mockStsSend = vi.fn();
const mockGetAssignmentsForPrincipalAndLease = vi.fn();
const mockResolvePermissionSetPolicy = vi.fn();

const mockRuntimeSend = vi.fn();

vi.mock("@aws-sdk/client-bedrock-agentcore", () => {
  return {
    BedrockAgentCoreClient: class {
      send(command: unknown) {
        return mockRuntimeSend(command);
      }
    },
    InvokeAgentRuntimeCommand: class {
      constructor(public input: unknown) {}
    },
  };
});
vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => {
  return {
    IsbServices: {
      // Use getter functions that always reference the current mock fns —
      // this survives vi.clearAllMocks() since the factory is not re-evaluated.
      connectionStore: () => ({ get: mockConnectionGet }),
      configStore: () => ({
        getSection: mockConfigGetSection,
        getAgentModels: mockConfigGetAgentModels,
        getAgentModel: mockConfigGetAgentModel,
      }),
      bedrockPriceCache: () => ({}),
      sandboxSpacesUsageStore: () => ({
        recordTurnUsage: mockRecordTurnUsage,
        getLeaseUserUsage: mockGetLeaseUserUsage,
      }),
      leaseStore: () => ({ get: vi.fn() }),
      accountPoolStackConfigStore: () => ({
        get: vi.fn().mockResolvedValue({ isbManagedRegions: ["us-east-1"] }),
      }),
      principalStore: () => ({
        getAssignmentsForPrincipalAndLease:
          mockGetAssignmentsForPrincipalAndLease,
      }),
      idcStackConfigStore: () => ({
        get: vi
          .fn()
          .mockResolvedValue({ ssoInstanceArn: "arn:aws:sso:::instance/test" }),
      }),
    },
  };
});

// Pricing a turn goes through the price table and, for a price that is missing
// or stale, the pricing APIs. That logic is tested with priceDiscoveredModels.
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js")
    >()),
    priceDiscoveredModels: mockPriceDiscoveredModels,
  }),
);
vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: {
    // apiGatewayManagement — not called directly; sendError/sendToConnection are mocked
    apiGatewayManagement: vi
      .fn()
      .mockReturnValue({ send: vi.fn().mockResolvedValue({}) }),
    sts: vi.fn().mockReturnValue({ send: mockStsSend }),
    bedrock: vi.fn().mockReturnValue({}),
    pricing: vi.fn().mockReturnValue({}),
    bedrockAgentCore: vi.fn().mockReturnValue({ send: mockRuntimeSend }),
    // ssoAdmin is built and passed into resolvePermissionSetPolicy — the
    // resolver itself is mocked (see permission-policy/index.js mock below),
    // so any inert client stub suffices here.
    ssoAdmin: vi.fn().mockReturnValue({ send: vi.fn() }),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js",
  async (importOriginal) => {
    const actual = await importOriginal<Record<string, unknown>>();
    return {
      ...actual,
      validateAndRoute: mockValidateAndRoute,
      sendError: mockSendError,
      sendToConnection: mockSendToConnection,
    };
  },
);

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js")
      >();
    return {
      ...actual,
      resolvePermissionSetPolicy: mockResolvePermissionSetPolicy,
    };
  },
);

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
  }),
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const testEnv = generateSchemaData(AgentWorkerLambdaEnvironmentSchema, {
  CONNECTIONS_TABLE_NAME: "test-connections",
  LEASE_TABLE_NAME: "test-leases",
  PRINCIPAL_TABLE_NAME: "test-principals",
  SANDBOX_SPACES_USAGE_TABLE_NAME: "test-usage",
  CONFIG_TABLE_NAME: "test-config",
  ACCOUNT_POOL_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/test-account-pool-config",
  IDC_ROLE_ARN:
    "arn:aws:iam::123456789012:role/InnovationSandbox-myisb-IdcRole",
  IDC_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/test-idc-config",
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::123456789012:role/InnovationSandbox-myisb-IntermediateRole",
  WEBSOCKET_API_ENDPOINT:
    "https://test.execute-api.us-east-1.amazonaws.com/prod",
  AGENT_RUNTIME_ARN: "placeholder",
  COGNITO_USER_POOL_ID: "us-east-1_testpool",
  COGNITO_APP_CLIENT_ID: "test-client-id",
  ISB_NAMESPACE: "testns",
});

const defaultConnection = {
  connectionId: "conn-123",
  actorId: "alice-at-example-d-com",
  role: "User" as const,
  email: "alice@example.com",
  userId: "22222222-2222-4222-8222-222222222222",
  protocolVersion: 1,
  ttl: Math.floor(Date.now() / 1000) + 7200,
};

const defaultAgentConfig = {
  sandboxSpacesEnabled: true,
};

const LEASE_UUID = "11111111-1111-4111-8111-111111111111";
const LEASE_KEY = { userEmail: "owner@example.com", uuid: LEASE_UUID };
// What the client sends as `leaseId`: the base64url owner-keyed lease key.
const LEASE_ID = Buffer.from(JSON.stringify(LEASE_KEY)).toString("base64url");
// The identifiers every valid request carries; the Worker checks `leaseUuid`
// and `userId` against the lease key and the connection.
const REQUEST_IDS = {
  leaseId: LEASE_ID,
  leaseUuid: LEASE_UUID,
  userId: defaultConnection.userId,
};
function callerUsageItem(
  sandboxSpacesEstimatedTokenCostAccrued: number,
  extra: object = {},
) {
  return {
    leaseId: LEASE_UUID,
    sandboxSpacesEstimatedTokenCostAccrued,
    invocationCount: 1,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    firstSeenAt: "2026-09-01T00:00:00.000Z",
    lastSeenAt: "2026-09-01T00:00:00.000Z",
    ...extra,
  };
}

function terminalErrorResponseFields(): TerminalSpendFields {
  return (
    (mockSendError.mock.calls.at(-1)?.[4] as TerminalSpendFields | undefined) ??
    {}
  );
}

function terminalErrorCallerSpend(): number | undefined {
  return terminalErrorResponseFields()
    .callerSandboxSpacesEstimatedTokenCostAccrued;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockContext(overrides: { remainingMs?: number } = {}): any {
  return {
    env: testEnv,
    functionName: "test-worker",
    functionVersion: "$LATEST",
    invokedFunctionArn:
      "arn:aws:lambda:us-east-1:123456789012:function:test-worker",
    memoryLimitInMB: "512",
    awsRequestId: "test-request-id",
    logGroupName: "/aws/lambda/test-worker",
    logStreamName: "2024/01/01/[$LATEST]test",
    getRemainingTimeInMillis: () => overrides.remainingMs ?? 300_000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
    callbackWaitsForEmptyEventLoop: false,
  };
}

function buildSqsEvent(
  overrides: {
    connectionId?: string | null;
    body?: object | string;
    messageId?: string;
  } = {},
): SQSEvent {
  const connectionId =
    overrides.connectionId === undefined ? "conn-123" : overrides.connectionId;
  return {
    Records: [
      {
        messageId: overrides.messageId ?? "msg-001",
        receiptHandle: "receipt-001",
        body:
          typeof overrides.body === "string"
            ? overrides.body
            : JSON.stringify(
                overrides.body ?? {
                  action: "sendMessage",
                  message: "Hello agent",
                  ...REQUEST_IDS,
                  modelId: "model-a",
                },
              ),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890000",
          SenderId: "test",
          ApproximateFirstReceiveTimestamp: "1234567890000",
        },
        messageAttributes:
          connectionId !== null
            ? {
                connectionId: { stringValue: connectionId, dataType: "String" },
              }
            : {},
        md5OfBody: "test",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test-queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

// ─── Setup ────────────────────────────────────────────────────────────────────

let handler: (typeof import("@amzn/innovation-sandbox-agent-worker/worker-handler.js"))["handler"];

// Backing rows for the per-model getAgentModel lookup. A row's rates, if any,
// are served by the price table mock below.
let catalogRows: { modelId: string; [key: string]: unknown }[] = [];
function setCatalog(rows: typeof catalogRows) {
  catalogRows = rows;
}

beforeAll(async () => {
  bulkStubEnv(testEnv);
  vi.stubEnv("AWS_REGION", "us-east-1");
  ({ handler } =
    await import("@amzn/innovation-sandbox-agent-worker/worker-handler.js"));
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSendError.mockResolvedValue(undefined);
  mockSendToConnection.mockResolvedValue(undefined);
  mockStsSend.mockResolvedValue({
    Credentials: {
      AccessKeyId: "AK",
      SecretAccessKey: "SK",
      SessionToken: "ST",
    },
  });
  mockConnectionGet.mockResolvedValue(defaultConnection);
  mockConfigGetSection.mockResolvedValue(defaultAgentConfig);
  setCatalog([
    { modelId: "anthropic.claude-3-5-sonnet-20241022-v2:0", enabled: true },
    ...["model-a", "model-b"].map((modelId) => ({
      modelId,
      enabled: true,
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
      cacheReadPricePer1KTokens: 0.0003,
      cacheWritePricePer1KTokens: 0.00375,
      pricingSource: "agreement-offers",
    })),
  ]);
  mockConfigGetAgentModel.mockImplementation(async (modelId: string) =>
    catalogRows.find((row) => row.modelId === modelId),
  );
  // Prices are kept in the Bedrock regional price table, not on the catalog
  // rows. A fixture row carrying rates stands for a model with a price there.
  mockPriceDiscoveredModels.mockImplementation(
    async (models: { modelId: string }[]) =>
      new Map(
        models.flatMap(({ modelId }) => {
          const row = catalogRows.find(
            (candidate) => candidate.modelId === modelId,
          );
          return row?.inputPricePer1KTokens === undefined
            ? []
            : [
                [
                  modelId,
                  {
                    inputPricePer1KTokens: row.inputPricePer1KTokens,
                    outputPricePer1KTokens: row.outputPricePer1KTokens,
                    cacheReadPricePer1KTokens: row.cacheReadPricePer1KTokens,
                    cacheWritePricePer1KTokens: row.cacheWritePricePer1KTokens,
                    pricingSource: "price-list",
                    pricingRefreshedAt: "2026-09-10T12:00:00.000Z",
                  },
                ],
              ];
        }),
      ),
  );
  mockRecordTurnUsage.mockResolvedValue(undefined);
  mockGetLeaseUserUsage.mockResolvedValue(null);
  mockValidateAndRoute.mockResolvedValue({
    accountId: "123456789012",
    leaseCurrentSpend: 12.5,
    runtimeSessionId: "lease-abc",
  });
  // Default: the user has a permission set assignment that resolves to a
  // profile, so turns reach the runtime. Individual tests override this to
  // exercise the assignment-missing and SSO Admin failure branches, which
  // reject the turn.
  mockGetAssignmentsForPrincipalAndLease.mockResolvedValue([
    {
      principalType: "USER",
      permissionSetArn: "arn:aws:sso:::permissionSet/ins-abc/ps-alice-default",
    },
  ]);
  mockResolvePermissionSetPolicy.mockResolvedValue({
    sessionPolicy: {
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
    },
    managedPolicyArns: [],
  });
  // Mock runtime: return a valid SSE stream with one chunk + complete event
  const sseBody = [
    `data: ${JSON.stringify({ type: "chunk", content: "Hello from runtime" })}`,
    `data: ${JSON.stringify({ type: "complete", usage: { inputTokens: 3, outputTokens: 5 } })}`,
    "",
  ].join("\n");
  mockRuntimeSend.mockResolvedValue({
    response: { transformToString: async () => sseBody },
  });
});

afterAll(() => vi.restoreAllMocks());

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("workerHandler — guard clauses", () => {
  it("returns no failures when connectionId attribute is missing", async () => {
    const event = buildSqsEvent({ connectionId: null });
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockConnectionGet).not.toHaveBeenCalled();
  });

  it("returns no failures for invalid SQS message body", async () => {
    const event = buildSqsEvent({ body: { message: "missing action field" } });
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockConnectionGet).not.toHaveBeenCalled();
  });

  it.each([
    ["a bare lease uuid", LEASE_UUID],
    ["non-decodable text", "not-a-lease-key"],
    [
      "a key with an invalid uuid",
      Buffer.from(
        JSON.stringify({ userEmail: "owner@example.com", uuid: "lease-abc" }),
      ).toString("base64url"),
    ],
  ])(
    "rejects %s as leaseId with the invalid-request error before routing",
    async (_description, leaseId) => {
      const event = buildSqsEvent({
        body: {
          action: "sendMessage",
          message: "Hello agent",
          ...REQUEST_IDS,
          leaseId,
          modelId: "model-a",
        },
      });

      const result = await handler(event, mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockValidateAndRoute).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(
        "conn-123",
        expect.objectContaining({ code: "INVALID_REQUEST" }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it.each([
    [
      "a leaseUuid that differs from the lease key",
      { leaseUuid: "99999999-9999-4999-8999-999999999999" },
    ],
    [
      "a userId that is not the connection's user",
      { userId: "99999999-9999-4999-8999-999999999999" },
    ],
  ])(
    "rejects a message with %s before routing",
    async (_description, override) => {
      const event = buildSqsEvent({
        body: {
          action: "sendMessage",
          message: "Hello agent",
          ...REQUEST_IDS,
          ...override,
          modelId: "model-a",
        },
      });

      const result = await handler(event, mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockValidateAndRoute).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledWith(
        "conn-123",
        expect.objectContaining({ code: "INVALID_REQUEST" }),
        expect.anything(),
        expect.anything(),
      );
    },
  );

  it.each(["leaseUuid", "userId"])(
    "rejects a message without %s as an invalid request",
    async (field) => {
      const { [field as "leaseUuid" | "userId"]: _omitted, ...rest } =
        REQUEST_IDS;
      const event = buildSqsEvent({
        body: {
          action: "sendMessage",
          message: "Hello agent",
          ...rest,
          modelId: "model-a",
        },
      });

      const result = await handler(event, mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockValidateAndRoute).not.toHaveBeenCalled();
      expect(mockSendError).toHaveBeenCalledOnce();
    },
  );

  it("routes with the decoded lease key and the connection's user id", async () => {
    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockValidateAndRoute).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseKey: LEASE_KEY,
        connection: expect.objectContaining({
          userId: defaultConnection.userId,
        }),
      }),
      expect.anything(),
    );
  });

  it("returns no failures when connection record not found (expired)", async () => {
    mockConnectionGet.mockResolvedValue(null);
    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockValidateAndRoute).not.toHaveBeenCalled();
  });

  it("sends timeout error and returns no failures when remaining time is low", async () => {
    const event = buildSqsEvent();
    const result = await handler(
      event,
      mockContext({ remainingMs: 10_000 }),
      vi.fn(),
    );
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "TIME_LIMIT",
      retryable: true,
    });
  });
});

describe("workerHandler — routing errors", () => {
  it("sends feature-disabled error to client", async () => {
    const { FeatureDisabledError } =
      await import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js");
    mockValidateAndRoute.mockRejectedValue(
      new FeatureDisabledError("Feature disabled for users."),
    );

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "FEATURE_DISABLED",
      retryable: false,
    });
  });

  it("tells the client to resend, without redelivery, for unexpected infrastructure exceptions", async () => {
    mockValidateAndRoute.mockRejectedValue(new Error("Unexpected DB error"));

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
      retryable: true,
    });
    expect(mockRuntimeSend).not.toHaveBeenCalled();
  });

  it("does not redeliver when the failure notice cannot be sent", async () => {
    mockValidateAndRoute.mockRejectedValue(new Error("Unexpected DB error"));
    mockSendError.mockRejectedValue(new Error("connection gone"));

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
  });
});

describe("workerHandler — happy path", () => {
  it("sends complete event on successful invocation", async () => {
    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    const completeCalls = mockSendToConnection.mock.calls.filter(
      (c) => (c[1] as { type?: string })?.type === "complete",
    );
    expect(completeCalls).toHaveLength(1);
  });

  it("tells the client to resend, without redelivery, when DDB connection lookup throws", async () => {
    mockConnectionGet.mockRejectedValue(new Error("DynamoDB unavailable"));
    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
    });
  });

  it("uses character-estimate token counts when runtime returns no complete event", async () => {
    // SSE body has only chunks, no complete event — token counts fall back to heuristic
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "Hi" })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    // Settles a non-zero estimate rather than zero spend.
    expect(mockRecordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: expect.objectContaining({
          inputTokens: Math.ceil("Hello agent".length / 4),
        }),
      }),
    );
    expect(
      mockRecordTurnUsage.mock.calls[0]![0]
        .sandboxSpacesEstimatedTokenCostAccrued,
    ).toBeGreaterThan(0);
  });

  it("treats an absent runtime response body as a platform failure: error sent, not billed, not alarmed", async () => {
    // response.response is undefined — no SSE to process
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRuntimeSend.mockResolvedValue({ response: undefined });

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    // Not an SQS failure: the message is not retried, the user is told.
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
      retryable: true,
    });
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("treats a rejected runtime invocation as a platform failure: error sent, not billed, not alarmed", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRuntimeSend.mockRejectedValue(new Error("AgentCore unavailable"));

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
      retryable: true,
    });
    expect(terminalErrorCallerSpend()).toBeUndefined();
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("passes an abort signal that has not fired on a normal turn", async () => {
    await handler(buildSqsEvent(), mockContext(), vi.fn());

    const options = mockRuntimeSend.mock.calls[0]![1] as {
      abortSignal: AbortSignal;
    };
    expect(options.abortSignal.aborted).toBe(false);
  });

  it("sends a non-retryable time-limit error when the deadline aborts a pending runtime call", async () => {
    mockRuntimeSend.mockImplementation(
      (_command: unknown, options: { abortSignal: AbortSignal }) =>
        new Promise((_resolve, reject) => {
          options.abortSignal.addEventListener("abort", () =>
            reject(new Error("Request aborted")),
          );
        }),
    );

    // 50ms of budget remain after the 30s reserve.
    const result = await handler(
      buildSqsEvent(),
      mockContext({ remainingMs: 30_050 }),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toEqual({
      code: "TIME_LIMIT",
      message:
        "The request reached its processing time limit before the response finished. Some requested actions may have completed or may still be in progress. Check their status before trying again.",
      retryable: false,
    });
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("sends a non-retryable time-limit error when the deadline aborts the response stream", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRuntimeSend.mockImplementation(
      (_command: unknown, options: { abortSignal: AbortSignal }) =>
        Promise.resolve({
          response: {
            transformToString: () =>
              new Promise((_resolve, reject) => {
                options.abortSignal.addEventListener("abort", () =>
                  reject(new Error("aborted")),
                );
              }),
          },
        }),
    );

    const result = await handler(
      buildSqsEvent(),
      mockContext({ remainingMs: 30_050 }),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toEqual({
      code: "TIME_LIMIT",
      message:
        "The request reached its processing time limit before the response finished. Some requested actions may have completed or may still be in progress. Check their status before trying again.",
      retryable: false,
    });
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("bills the character estimate and alarms when the response stream cannot be read", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    const infoSpy = vi.spyOn(Logger.prototype, "info");
    mockGetLeaseUserUsage.mockResolvedValue(
      callerUsageItem(0.5, { userId: defaultConnection.userId }),
    );
    mockRuntimeSend.mockResolvedValue({
      response: {
        transformToString: async () => {
          throw new Error("stream reset");
        },
      },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    // The client is told to retry and gets no complete frame.
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
    });
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    // The model ran, so the estimate is recorded and the alarm record is logged.
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(mockRecordTurnUsage.mock.calls[0]![0]).toMatchObject({
      tokens: expect.objectContaining({
        inputTokens: Math.ceil("Hello agent".length / 4),
        outputTokens: 0,
      }),
    });
    expect(terminalErrorCallerSpend()).toBe(0.500009);
    expect(terminalErrorResponseFields().leaseCurrentSpend).toBe(12.5);
    expect(mockSendError.mock.invocationCallOrder[0]!).toBeLessThan(
      mockRecordTurnUsage.mock.invocationCallOrder[0]!,
    );
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    // The turn ended early, so it is not logged as a success.
    expect(warnSpy).toHaveBeenCalledWith(
      "Worker recorded a turn that ended early",
      expect.objectContaining({ connectionId: "conn-123" }),
    );
    expect(infoSpy).not.toHaveBeenCalledWith(
      "Worker completed successfully",
      expect.anything(),
    );
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    infoSpy.mockRestore();
  });

  it("bills the reported usage when a chunk cannot be streamed to the client", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "one" })}`,
      `data: ${JSON.stringify({ type: "chunk", content: "two" })}`,
      `data: ${JSON.stringify({ type: "complete", usage: { inputTokens: 7, outputTokens: 9 } })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });
    mockSendToConnection.mockImplementation(async (_id, payload) => {
      if ((payload as { data?: string }).data === "one") {
        throw new Error("PostToConnection throttled");
      }
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    // Streaming stops after the first failure, and the client is told to retry.
    const chunks = mockSendToConnection.mock.calls
      .map((c) => c[1] as { type?: string; data?: string })
      .filter((p) => p.type === "chunk" && p.data !== "##PROCESSING##");
    expect(chunks.map((p) => p.data)).toEqual(["one"]);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
    });
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    // Exact usage was still read, so it is billed without the alarm.
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(mockRecordTurnUsage.mock.calls[0]![0]).toMatchObject({
      tokens: expect.objectContaining({ inputTokens: 7, outputTokens: 9 }),
    });
    expect(terminalErrorCallerSpend()).toBe(
      mockRecordTurnUsage.mock.calls[0]![0]
        .sandboxSpacesEstimatedTokenCostAccrued,
    );
    expect(terminalErrorResponseFields().leaseCurrentSpend).toBe(12.5);
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("skips malformed JSON SSE lines and continues processing", async () => {
    const sseBody = [
      "data: {bad json",
      `data: ${JSON.stringify({ type: "chunk", content: "ok" })}`,
      `data: ${JSON.stringify({ type: "complete", usage: { inputTokens: 1, outputTokens: 1 } })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());
    expect(result.batchItemFailures).toHaveLength(0);
    // chunk from valid line still streamed
    const chunkCalls = mockSendToConnection.mock.calls.filter(
      (c) =>
        (c[1] as { type?: string; data?: string })?.type === "chunk" &&
        (c[1] as { data?: string }).data === "ok",
    );
    expect(chunkCalls).toHaveLength(1);
  });

  it("surfaces a platform error frame instead of reporting an empty success", async () => {
    // What AgentCore actually sends when a turn fails outright (observed with a
    // guardrail the runtime role could not decrypt): `error` and no `type`, so it
    // is not a RuntimeStreamEvent. Previously this was logged as an unrecognised
    // event and skipped, and the client got `complete` with no content at all.
    const sseBody = [
      `data: ${JSON.stringify({
        error:
          "You do not have access to the guardrail's KMS key. Please ensure that kms:Decrypt permissions are correctly configured.",
      })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    // Not an SQS failure: the message is not retried, the user is told.
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
      retryable: true,
    });
    // The load-bearing assertion: a failed turn must not look like a successful
    // empty one, or the UI renders a blank reply and the operator sees success.
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    // And the user is not billed for a turn that failed before the model ran.
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("bills the estimate and alarms when an error frame follows streamed output", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "partial reply" })}`,
      `data: ${JSON.stringify({ error: "Throttled on a later model call" })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    // The partial reply was streamed, then the client is told to retry.
    const streamed = mockSendToConnection.mock.calls
      .map((c) => c[1] as { type?: string; data?: string })
      .filter((p) => p.type === "chunk" && p.data === "partial reply");
    expect(streamed).toHaveLength(1);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "UNKNOWN_ERROR",
      retryable: false,
    });
    const sent = mockSendToConnection.mock.calls.map(
      (c) => (c[1] as { type?: string }).type,
    );
    expect(sent).not.toContain("complete");
    // The model ran, so the character estimate is recorded and the alarm record is logged.
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(mockRecordTurnUsage.mock.calls[0]![0]).toMatchObject({
      tokens: expect.objectContaining({
        inputTokens: Math.ceil("Hello agent".length / 4),
        outputTokens: 0,
      }),
    });
    expect(terminalErrorCallerSpend()).toBe(
      mockRecordTurnUsage.mock.calls[0]![0]
        .sandboxSpacesEstimatedTokenCostAccrued,
    );
    expect(terminalErrorResponseFields().leaseCurrentSpend).toBe(12.5);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("tells the user a turn is in progress when the runtime flags the frame TURN_IN_PROGRESS", async () => {
    // The runtime yields this when another turn is still running on the session
    // (for example from a second browser window).
    const { RUNTIME_ERROR_CODES } =
      await import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js");
    mockRuntimeSend.mockResolvedValue({
      response: {
        transformToString: async () =>
          `data: ${JSON.stringify({
            error: "The agent is still processing a previous turn.",
            code: RUNTIME_ERROR_CODES.turnInProgress,
          })}\n`,
      },
    });
    const errorSpy = vi.spyOn(Logger.prototype, "error");

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(errorSpy).toHaveBeenCalledWith(
      "Agent runtime reported an error",
      expect.objectContaining({
        runtimeErrorCode: RUNTIME_ERROR_CODES.turnInProgress,
      }),
    );
    errorSpy.mockRestore();

    // Not retried, and not billed: the turn never reached the model.
    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "TURN_IN_PROGRESS",
      message: expect.stringContaining("already working on a request"),
      retryable: true,
    });
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it.each([
    {
      code: "MODEL_NOT_SUPPORTED",
      error:
        "This action doesn't support the model that you provided. Try again with a supported text or chat model.",
      message: "This model can't be used for chat. Choose a different model.",
    },
    {
      code: "MODEL_UNAVAILABLE",
      error:
        "Access denied. This Model is marked by provider as Legacy and you have not been actively using the model in the last 30 days.",
      message:
        "This model isn't available in this account (it may be retired). Choose a different model.",
    },
  ])(
    "tells the user to choose another model when the runtime flags the frame $code",
    async ({ code, error, message }) => {
      mockRuntimeSend.mockResolvedValue({
        response: {
          transformToString: async () =>
            `data: ${JSON.stringify({ error, code })}\n`,
        },
      });

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      // Not retried, and not billed: the model never ran.
      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toMatchObject({
        code: "INVALID_REQUEST",
        message,
        retryable: false,
      });
      expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      code: "MODEL_STREAM_ENDED",
      message:
        "The model stopped responding before it finished its reply. Try again.",
      retryable: true,
    },
    {
      code: "CONTENT_FILTERED",
      message:
        "The model's content filter stopped this reply. Choose a different model and try again.",
      retryable: false,
    },
    {
      code: "MODEL_THROTTLED",
      message:
        "The model is receiving too many requests right now. Wait a minute, then try again.",
      retryable: true,
    },
    {
      code: "MODEL_TIMED_OUT",
      message: "The model took too long to respond. Try again.",
      retryable: true,
    },
    {
      code: "MODEL_SERVICE_UNAVAILABLE",
      message:
        "The model service is temporarily unavailable. Try again in a few minutes.",
      retryable: true,
    },
    {
      code: "INPUT_BLOCKED",
      message:
        "The safety filter blocked this message. Rephrase it as a plain request and try again.",
      retryable: false,
    },
  ])(
    "tells the user what happened when the runtime flags the frame $code",
    async ({ code, message, retryable }) => {
      mockRuntimeSend.mockResolvedValue({
        response: {
          transformToString: async () =>
            `data: ${JSON.stringify({ error: "model call failed", code })}\n`,
        },
      });

      await handler(buildSqsEvent(), mockContext(), vi.fn());

      // Not billed: the frame came before any text or usage.
      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toEqual({
        code,
        message,
        retryable,
      });
      expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    },
  );

  it.each([
    {
      runtimeCode: "MODEL_STREAM_ENDED",
      code: "MODEL_STREAM_ENDED",
      message:
        "The model stopped responding before it finished its reply, and some commands may already have run. Check their results before trying again.",
    },
    {
      runtimeCode: "CONTENT_FILTERED",
      code: "CONTENT_FILTERED",
      message:
        "The model's content filter stopped this reply, and some commands may already have run. Check their results, then choose a different model and try again.",
    },
    {
      runtimeCode: "MODEL_THROTTLED",
      code: "MODEL_THROTTLED",
      message:
        "The model is receiving too many requests right now, and some commands may already have run. Check their results before trying again.",
    },
    {
      runtimeCode: "MODEL_TIMED_OUT",
      code: "MODEL_TIMED_OUT",
      message:
        "The model took too long to respond, and some commands may already have run. Check their results before trying again.",
    },
    {
      runtimeCode: "MODEL_SERVICE_UNAVAILABLE",
      code: "MODEL_SERVICE_UNAVAILABLE",
      message:
        "The model service is temporarily unavailable, and some commands may already have run. Check their results before trying again.",
    },
    {
      runtimeCode: undefined,
      code: "RUNTIME_ERROR",
      message:
        "The agent could not finish your request, and some commands may already have run. Check their results before trying again.",
    },
  ])(
    "offers no retry and asks the user to check command results when a tool ran before the $code failure",
    async ({ runtimeCode, code, message }) => {
      mockRuntimeSend.mockResolvedValue({
        response: {
          transformToString: async () =>
            `data: ${JSON.stringify({ error: "model call failed", code: runtimeCode, toolRan: true })}\n`,
        },
      });

      await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toEqual({
        code,
        message,
        retryable: false,
      });
      expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    },
  );

  it("bills a turn whose model error comes after an earlier cycle ran, and sends the model message without a retry", async () => {
    // A later cycle can fail after the model already ran (and may have run tools).
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "Listing your buckets" })}`,
      `data: ${JSON.stringify({ error: "This action doesn't support the model that you provided.", code: "MODEL_NOT_SUPPORTED" })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toEqual({
      code: "INVALID_REQUEST",
      message: "This model can't be used for chat. Choose a different model.",
      retryable: false,
    });
  });

  it.each([
    {
      toolRan: false,
      message: "The model took too long to respond. Try again.",
    },
    {
      toolRan: true,
      message:
        "The model took too long to respond, and some commands may already have run. Check their results before trying again.",
    },
  ])(
    "sends the MODEL_TIMED_OUT message without a retry, and bills the estimate, when it follows streamed text (toolRan: $toolRan)",
    async ({ toolRan, message }) => {
      const errorSpy = vi.spyOn(Logger.prototype, "error");
      const sseBody = [
        `data: ${JSON.stringify({ type: "chunk", content: "Checking your buckets." })}`,
        `data: ${JSON.stringify({ error: "Model timed out.", code: "MODEL_TIMED_OUT", toolRan })}`,
        "",
      ].join("\n");
      mockRuntimeSend.mockResolvedValue({
        response: { transformToString: async () => sseBody },
      });

      await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toEqual({
        code: "MODEL_TIMED_OUT",
        message,
        retryable: false,
      });
      expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
      expect(mockRecordTurnUsage.mock.calls[0]![0]).toMatchObject({
        tokens: {
          inputTokens: Math.ceil("Hello agent".length / 4),
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      });
      expect(errorSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
      );
      errorSpy.mockRestore();
    },
  );

  it("keeps the not-fully-delivered message when an error frame with no code follows streamed text", async () => {
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "Checking your buckets." })}`,
      `data: ${JSON.stringify({ error: "model exploded", toolRan: true })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toEqual({
      code: "UNKNOWN_ERROR",
      message:
        "The agent started working on your request, but the full response wasn't delivered. Check the conversation history before sending it again, because some actions may already be complete.",
      retryable: false,
    });
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
  });

  it("keeps the generic error for a runtime frame with an unrecognised code", async () => {
    mockRuntimeSend.mockResolvedValue({
      response: {
        transformToString: async () =>
          `data: ${JSON.stringify({ error: "boom", code: "SOMETHING_NEW" })}\n`,
      },
    });

    const errorSpy = vi.spyOn(Logger.prototype, "error");

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(errorSpy).toHaveBeenCalledWith(
      "Agent runtime reported an error",
      expect.objectContaining({ runtimeErrorCode: "SOMETHING_NEW" }),
    );
    errorSpy.mockRestore();
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "RUNTIME_ERROR",
      message:
        "The agent could not process your message. Try again, or rephrase your message.",
    });
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });
});

//
// The worker resolves each User's permission set policy on every message and
// forwards it into the invoke payload as `permissionProfilePolicy`. The
// resolver has four outcomes; without a usable profile the turn is rejected
// before the runtime is invoked and is not billed.
//   1. Match found → sessionPolicy and managed policy ARNs are forwarded to
//      the runtime.
//   2. No assignment, or a permission set with no policies → turn rejected
//      with a non-retryable error.
//   3. A permission set boundary is present → turn rejected with a specific
//      non-retryable unsupported-profile error.
//   4. Assignment lookup or SSO Admin call throws → turn rejected with a
//      retryable error.
//
// Read the invoke payload out of the InvokeAgentRuntimeCommand to assert what
// the runtime container actually sees.
function readInvokePayload(): Record<string, unknown> {
  const cmd = mockRuntimeSend.mock.calls[0]?.[0] as
    { input?: { payload?: Uint8Array } } | undefined;
  const bytes = cmd?.input?.payload;
  if (!bytes) {
    throw new Error("No invoke payload captured — did the runtime call fire?");
  }
  return JSON.parse(new TextDecoder().decode(bytes));
}

describe("workerHandler — permission profile policy resolution", () => {
  it("forwards the resolved sessionPolicy into the invoke payload when a matching assignment is found", async () => {
    const sessionPolicy = {
      Version: "2012-10-17",
      Statement: [
        {
          Effect: "Allow",
          Action: ["s3:ListAllMyBuckets"],
          Resource: "*",
        },
      ],
    };
    mockGetAssignmentsForPrincipalAndLease.mockResolvedValue([
      {
        principalType: "USER",
        permissionSetArn:
          "arn:aws:sso:::permissionSet/ins-abc/ps-alice-readonly",
      },
    ]);
    mockResolvePermissionSetPolicy.mockResolvedValue({
      sessionPolicy,
      managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
    });

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).toHaveBeenCalledOnce();
    // Assignments are read by the connection's userId and the lease uuid from the key.
    expect(mockGetAssignmentsForPrincipalAndLease).toHaveBeenCalledWith({
      principalId: defaultConnection.userId,
      principalType: "USER",
      leaseId: LEASE_UUID,
    });
    const payload = readInvokePayload();
    expect(payload.permissionProfilePolicy).toEqual(sessionPolicy);
    // Managed-policy ARNs from the resolver must also reach the runtime so
    // managed-policy-only permission sets work and mixed inline+managed sets
    // match the human portal path.
    expect(payload.permissionProfileManagedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  it("forwards managed-policy ARNs when the permission set has no inline policy", async () => {
    // Managed-policy-only permission set (e.g., AWS-managed ReadOnlyAccess).
    // sessionPolicy resolves to undefined in this case, but managedPolicyArns
    // must still land in the invoke payload — otherwise the runtime's
    // fail-closed check would refuse the CLI call despite a valid assignment.
    mockGetAssignmentsForPrincipalAndLease.mockResolvedValue([
      {
        principalType: "USER",
        permissionSetArn:
          "arn:aws:sso:::permissionSet/ins-abc/ps-alice-readonly",
      },
    ]);
    mockResolvePermissionSetPolicy.mockResolvedValue({
      sessionPolicy: undefined,
      managedPolicyArns: ["arn:aws:iam::aws:policy/ReadOnlyAccess"],
    });

    const event = buildSqsEvent();
    await handler(event, mockContext(), vi.fn());

    const payload = readInvokePayload();
    expect(payload.permissionProfilePolicy).toBeUndefined();
    expect(payload.permissionProfileManagedPolicyArns).toEqual([
      "arn:aws:iam::aws:policy/ReadOnlyAccess",
    ]);
  });

  function expectTurnRejected(expectedError: {
    message: string;
    retryable: boolean;
  }) {
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "UNKNOWN_ERROR",
      message: expect.stringContaining(expectedError.message),
      retryable: expectedError.retryable,
    });
  }

  // Permanent: an administrator has to assign or fix the permission set.
  const expectRejectedAsMissing = () =>
    expectTurnRejected({
      message: "No permissions are assigned to you",
      retryable: false,
    });

  // Transient: the lookup or SSO Admin call failed, so a retry may succeed.
  const expectRejectedAsUnavailable = () =>
    expectTurnRejected({
      message: "couldn't determine your permissions",
      retryable: true,
    });

  it("rejects the turn before invoking the runtime when the user has no assignment on the lease", async () => {
    mockGetAssignmentsForPrincipalAndLease.mockResolvedValue([]);

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).not.toHaveBeenCalled();
    expectRejectedAsMissing();
  });

  it("rejects the turn before invoking the runtime when the assignment lookup throws", async () => {
    mockGetAssignmentsForPrincipalAndLease.mockRejectedValue(
      new Error("DDB unavailable"),
    );

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).not.toHaveBeenCalled();
    expectRejectedAsUnavailable();
  });

  it("rejects the turn before invoking the runtime when the permission set has no policies", async () => {
    mockResolvePermissionSetPolicy.mockResolvedValue({
      sessionPolicy: undefined,
      managedPolicyArns: [],
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).toHaveBeenCalledOnce();
    expectRejectedAsMissing();
  });

  it("rejects the turn before invoking the runtime when resolvePermissionSetPolicy throws", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    // Assignment resolves, but the SSO Admin call inside
    // resolvePermissionSetPolicy fails — the turn is rejected rather than
    // run without a permission profile.
    mockGetAssignmentsForPrincipalAndLease.mockResolvedValue([
      {
        principalType: "USER",
        permissionSetArn:
          "arn:aws:sso:::permissionSet/ins-abc/ps-alice-readonly",
      },
    ]);
    mockResolvePermissionSetPolicy.mockRejectedValue(
      new Error("SSO Admin unavailable"),
    );

    const event = buildSqsEvent();
    const result = await handler(event, mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).toHaveBeenCalledOnce();
    expectRejectedAsUnavailable();
    const errorCalls = [...errorSpy.mock.calls];
    errorSpy.mockRestore();
    expect(errorCalls).toEqual([
      [
        "Failed to resolve permission set policy",
        expect.objectContaining({ actorId: defaultConnection.actorId }),
      ],
    ]);
  });

  it("rejects the turn permanently when the permission set has a permissions boundary", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    // Import after the permission-policy module mock is initialized.
    const { UnsupportedPermissionSetBoundaryError } =
      await import("@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js");
    mockResolvePermissionSetPolicy.mockRejectedValue(
      new UnsupportedPermissionSetBoundaryError(
        "INTERNAL-SENTINEL ps-alice-readonly has a boundary",
      ),
    );

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockResolvePermissionSetPolicy).toHaveBeenCalledOnce();
    expect(mockSendError).toHaveBeenCalledOnce();
    expectTurnRejected({
      message: "permissions boundary",
      retryable: false,
    });
    expect(mockSendError.mock.calls[0]![1].message).toBe(
      "Sandbox Spaces can't use your assigned permission set because it has a permissions boundary. Contact your administrator to assign you a permission set without a permissions boundary.",
    );
    // The resolver's internal message is logged, never sent to the client.
    expect(mockSendError.mock.calls[0]![1].message).not.toContain(
      "INTERNAL-SENTINEL",
    );
    const errorCallCount = errorSpy.mock.calls.length;
    const boundaryWarning = warnSpy.mock.calls.find(
      ([message]) =>
        message ===
        "Permission set uses a permissions boundary that Sandbox Spaces does not support",
    );
    errorSpy.mockRestore();
    warnSpy.mockRestore();
    expect(errorCallCount).toBe(0);
    expect(boundaryWarning?.[1]).toEqual(
      expect.objectContaining({ actorId: defaultConnection.actorId }),
    );
  });
});

describe("workerHandler — error and streaming contract", () => {
  it("maps malformed JSON to the safe invalid-request client error", async () => {
    const result = await handler(
      buildSqsEvent({ body: "{not valid JSON" }),
      mockContext(),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledWith(
      "conn-123",
      {
        code: "INVALID_REQUEST",
        message: "The request could not be processed. Try again.",
        retryable: false,
      },
      expect.any(Function),
      expect.anything(),
    );
  });

  it("maps an inactive lease to the safe lease-not-active client error", async () => {
    const { LeaseNotActiveError } =
      await import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js");
    mockValidateAndRoute.mockRejectedValue(
      new LeaseNotActiveError("lease-abc is no longer active"),
    );

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledWith(
      "conn-123",
      {
        code: "LEASE_NOT_ACTIVE",
        message: "This Sandbox Space is no longer active.",
        retryable: false,
      },
      expect.any(Function),
      expect.anything(),
    );
  });

  it("maps runtime error details to the generic retryable client error", async () => {
    mockRuntimeSend.mockResolvedValue({
      response: {
        transformToString: async () =>
          `data: ${JSON.stringify({
            error: "Internal runtime configuration details",
          })}\n`,
      },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledWith(
      "conn-123",
      {
        code: "RUNTIME_ERROR",
        message:
          "The agent could not process your message. Try again, or rephrase your message.",
        retryable: true,
      },
      expect.any(Function),
      expect.anything(),
      {},
    );
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("ignores SSE control frames while streaming chunks and recording declared usage", async () => {
    const sseBody = [
      "event: message",
      ": keepalive",
      "data: [DONE]",
      `data: ${JSON.stringify({ type: "chunk", content: "streamed" })}`,
      `data: ${JSON.stringify({
        type: "complete",
        usage: { inputTokens: 13, outputTokens: 8 },
      })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendToConnection).toHaveBeenCalledWith(
      "conn-123",
      expect.objectContaining({ type: "chunk", data: "streamed" }),
      expect.any(Function),
      expect.anything(),
    );
    expect(mockSendToConnection).toHaveBeenCalledWith(
      "conn-123",
      expect.objectContaining({ type: "complete" }),
      expect.any(Function),
      expect.anything(),
    );
    expect(mockRecordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: {
          inputTokens: 13,
          outputTokens: 8,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
        },
      }),
    );
  });
});

describe("workerHandler — Sandbox Spaces usage metering and recording", () => {
  const pricedModelA = {
    modelId: "model-a",
    enabled: true,
    inputPricePer1KTokens: 0.003,
    outputPricePer1KTokens: 0.015,
    cacheReadPricePer1KTokens: 0.0003,
    cacheWritePricePer1KTokens: 0.00375,
    pricingSource: "agreement-offers",
  };

  function completeWithUsage(usage: Record<string, number> | undefined) {
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "ok" })}`,
      `data: ${JSON.stringify({ type: "complete", ...(usage ? { usage } : {}) })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });
  }

  it("runs reject-early routing before reading spend", async () => {
    const { ModelNotAllowedError } =
      await import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js");
    mockValidateAndRoute.mockRejectedValue(new ModelNotAllowedError("no"));

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
    expect(mockRuntimeSend).not.toHaveBeenCalled();
  });

  it("runs and records the turn even when recorded Sandbox Spaces usage is high", async () => {
    mockGetLeaseUserUsage.mockResolvedValue(
      callerUsageItem(1_000, { userId: defaultConnection.userId }),
    );

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).not.toHaveBeenCalled();
    expect(mockRuntimeSend).toHaveBeenCalledOnce();
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
  });

  it("logs the alarm record and still records an estimate when the complete event carries no usage", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    completeWithUsage(undefined);

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    const record = errorSpy.mock.calls
      .map((call) => call[1])
      .find(
        (details) =>
          (details as { logDetailType?: string } | undefined)?.logDetailType ===
          "AgentTurnMeteringFailed",
      );
    // The record must satisfy the schema the log subscriber parses it with.
    expect(AgentTurnMeteringFailedLogSchema.safeParse(record).success).toBe(
      true,
    );
    expect(
      mockRecordTurnUsage.mock.calls[0]![0]
        .sandboxSpacesEstimatedTokenCostAccrued,
    ).toBeGreaterThan(0);
    errorSpy.mockRestore();
  });

  it("does not log the metering alarm record when usage is reported", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    completeWithUsage({ inputTokens: 10, outputTokens: 5 });

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });

  it("records all four token types at the submitted model's catalog rate", async () => {
    setCatalog([pricedModelA]);
    completeWithUsage({
      inputTokens: 1_000,
      outputTokens: 2_000,
      cacheReadTokens: 10_000,
      cacheWriteTokens: 400,
      totalTokens: 13_400,
    });

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockRecordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: LEASE_UUID,
        userId: defaultConnection.userId,
        userEmail: defaultConnection.email,
        tokens: {
          inputTokens: 1_000,
          outputTokens: 2_000,
          cacheReadTokens: 10_000,
          cacheWriteTokens: 400,
        },
        sandboxSpacesEstimatedTokenCostAccrued: 0.0375,
      }),
    );
  });

  it("rejects the turn before invoke when the model has no stored pricing", async () => {
    setCatalog([{ modelId: "model-a", enabled: true }]);

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "INVALID_REQUEST",
      message: expect.stringContaining("Choose a different model"),
      retryable: false,
    });
  });

  it("prices the turn from the price lookup for the requested model in this region", async () => {
    setCatalog([pricedModelA]);
    completeWithUsage({ inputTokens: 1_000, outputTokens: 1_000 });
    await handler(buildSqsEvent(), mockContext(), vi.fn());
    expect(mockPriceDiscoveredModels).toHaveBeenCalledOnce();
    const [models, services] = mockPriceDiscoveredModels.mock.calls[0]!;
    expect(models).toEqual([
      expect.objectContaining({
        modelId: "model-a",
        modelType: "foundation-model",
        foundationModelId: "model-a",
      }),
    ]);
    expect(services.pricingServices.region).toBe("us-east-1");
    expect(
      mockRecordTurnUsage.mock.calls[0]![0]
        .sandboxSpacesEstimatedTokenCostAccrued,
    ).toBe(0.018);
  });

  it("reads only the requested model's catalog row, fresh on every turn", async () => {
    await handler(buildSqsEvent(), mockContext(), vi.fn());
    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockConfigGetAgentModel).toHaveBeenCalledTimes(2);
    expect(mockConfigGetAgentModel).toHaveBeenCalledWith("model-a");
    expect(mockConfigGetAgentModels).not.toHaveBeenCalled();
  });

  it("reads the caller's spend once per turn for display", async () => {
    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    expect(mockGetLeaseUserUsage).toHaveBeenCalledOnce();
  });

  it("retries when recording keeps failing", async () => {
    mockRecordTurnUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockRecordTurnUsage).toHaveBeenCalledTimes(3);
    expect(mockRuntimeSend).toHaveBeenCalledOnce();
  });

  it("logs a structured alarm record when every recording attempt fails", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRecordTurnUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    await handler(buildSqsEvent(), mockContext(), vi.fn());

    const record = errorSpy.mock.calls
      .map((call) => call[1] as { logDetailType?: string } | undefined)
      .find(
        (details) =>
          details?.logDetailType === "SandboxSpacesUsageRecordingFailed",
      );
    expect(record).toMatchObject({ messageId: "msg-001", modelId: "model-a" });
    // The record must satisfy the schema the log subscriber parses it with.
    expect(
      SandboxSpacesUsageRecordingFailedLogSchema.safeParse(record).success,
    ).toBe(true);
    errorSpy.mockRestore();
  });

  it("retries a transient recording failure without re-invoking the runtime", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRecordTurnUsage
      .mockRejectedValueOnce(new Error("DynamoDB throttled"))
      .mockResolvedValueOnce(undefined);

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockRecordTurnUsage).toHaveBeenCalledTimes(2);
    expect(mockRuntimeSend).toHaveBeenCalledOnce();
    expect(errorSpy).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        logDetailType: "SandboxSpacesUsageRecordingFailed",
      }),
    );
    errorSpy.mockRestore();
  });

  describe("complete frame spend", () => {
    const completeFrame = () =>
      mockSendToConnection.mock.calls
        .map((call) => call[1] as { type?: string } & TerminalSpendFields)
        .find((frame) => frame.type === "complete");
    const callerSpendItem = (sandboxSpacesEstimatedTokenCostAccrued: number) =>
      callerUsageItem(sandboxSpacesEstimatedTokenCostAccrued, {
        userId: defaultConnection.userId,
      });

    beforeEach(() => {
      setCatalog([pricedModelA]);
      // 1,000 input + 2,000 output tokens price to $0.033.
      completeWithUsage({ inputTokens: 1_000, outputTokens: 2_000 });
      mockGetLeaseUserUsage.mockResolvedValue(callerSpendItem(0.5));
    });

    it("reports caller spend including this turn and the lease total at turn start", async () => {
      await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(
        LEASE_UUID,
        defaultConnection.userId,
      );
      expect(
        completeFrame()?.callerSandboxSpacesEstimatedTokenCostAccrued,
      ).toBe(0.533);
      expect(completeFrame()?.leaseCurrentSpend).toBe(12.5);
    });

    it("reports only this turn for a caller with no earlier spend", async () => {
      mockGetLeaseUserUsage.mockResolvedValue(null);

      await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(
        completeFrame()?.callerSandboxSpacesEstimatedTokenCostAccrued,
      ).toBe(0.033);
    });

    it("omits the caller's spend, but still runs the turn, when their record is unreadable", async () => {
      mockGetLeaseUserUsage.mockRejectedValue(
        new MalformedSandboxSpacesUsageRecordError("bad row"),
      );

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockRuntimeSend).toHaveBeenCalledOnce();
      expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
      expect(completeFrame()).not.toHaveProperty(
        "callerSandboxSpacesEstimatedTokenCostAccrued",
      );
    });

    it("runs the turn, and omits the caller's spend, when reading it fails", async () => {
      mockGetLeaseUserUsage.mockRejectedValue(new Error("DynamoDB throttled"));
      const warn = vi.spyOn(Logger.prototype, "warn");

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockRuntimeSend).toHaveBeenCalledOnce();
      expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
      expect(completeFrame()).not.toHaveProperty(
        "callerSandboxSpacesEstimatedTokenCostAccrued",
      );
      expect(warn).toHaveBeenCalledWith(
        "Sandbox Spaces usage read failed — omitting it from the reply",
        expect.objectContaining({ scope: "caller", leaseId: LEASE_UUID }),
      );
      warn.mockRestore();
    });

    it("reads the caller's spend before the runtime is invoked", async () => {
      await handler(buildSqsEvent(), mockContext(), vi.fn());

      const runtimeOrder = mockRuntimeSend.mock.invocationCallOrder[0]!;
      expect(mockGetLeaseUserUsage.mock.invocationCallOrder[0]!).toBeLessThan(
        runtimeOrder,
      );
    });

    it("sends the frame before the turn is recorded", async () => {
      await handler(buildSqsEvent(), mockContext(), vi.fn());

      const completeIndex = mockSendToConnection.mock.calls.findIndex(
        (call) => (call[1] as { type?: string }).type === "complete",
      );
      expect(
        mockSendToConnection.mock.invocationCallOrder[completeIndex]!,
      ).toBeLessThan(mockRecordTurnUsage.mock.invocationCallOrder[0]!);
    });

    it("still delivers the frame when recording keeps failing", async () => {
      mockRecordTurnUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

      await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(
        completeFrame()?.callerSandboxSpacesEstimatedTokenCostAccrued,
      ).toBe(0.533);
    });

    it("delivers the complete frame on retry after a transient send failure", async () => {
      let completeAttempts = 0;
      mockSendToConnection.mockImplementation(async (_id, payload) => {
        if ((payload as { type?: string }).type === "complete") {
          completeAttempts += 1;
          if (completeAttempts === 1) {
            throw new Error("PostToConnection throttled");
          }
        }
      });

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(completeAttempts).toBe(2);
      expect(mockSendError).not.toHaveBeenCalled();
      expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
    });

    it("sends a non-retryable terminal error and still records usage when the complete frame cannot be sent", async () => {
      const errorSpy = vi.spyOn(Logger.prototype, "error");
      let completeAttempts = 0;
      mockSendToConnection.mockImplementation(async (_id, payload) => {
        if ((payload as { type?: string }).type === "complete") {
          completeAttempts += 1;
          throw new Error("PostToConnection throttled");
        }
      });

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockRuntimeSend).toHaveBeenCalledOnce();
      expect(completeAttempts).toBe(3);
      // The chat input unlocks on the terminal error; the turn finished, so it is not retryable.
      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toMatchObject({
        code: "UNKNOWN_ERROR",
        retryable: false,
      });
      expect(errorSpy).toHaveBeenCalledWith(
        "Failed to send completed agent turn",
        expect.objectContaining({ messageId: "msg-001" }),
      );
      expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
      expect(mockRecordTurnUsage.mock.calls[0]![0]).toMatchObject({
        tokens: expect.objectContaining({
          inputTokens: 1000,
          outputTokens: 2000,
        }),
      });
      expect(terminalErrorCallerSpend()).toBe(0.533);
      expect(terminalErrorResponseFields().leaseCurrentSpend).toBe(12.5);
      errorSpy.mockRestore();
    });
  });

  it("still logs the metering alarm record when recording failed", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    mockRuntimeSend.mockResolvedValue({
      response: {
        transformToString: async () =>
          `data: ${JSON.stringify({ type: "complete" })}\n`,
      },
    });
    mockRecordTurnUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "AgentTurnMeteringFailed" }),
    );
    errorSpy.mockRestore();
  });
});

describe("workerHandler — legacy monthly token/cost budget is not enforced", () => {
  it("invokes the runtime even when legacy ceilings and monthly usage would have rejected the turn", async () => {
    mockConfigGetSection.mockResolvedValue({
      ...defaultAgentConfig,
      maxTokensPerMonth: 1,
      maxCostCentsPerMonth: 1,
      softLimitPercent: 1,
    });
    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).not.toHaveBeenCalled();
    expect(mockRuntimeSend).toHaveBeenCalledOnce();
    expect(mockSendToConnection).toHaveBeenCalledWith(
      "conn-123",
      expect.objectContaining({ type: "complete" }),
      expect.any(Function),
      expect.anything(),
    );
  });
});

describe("workerHandler — caller role is not forwarded to the runtime", () => {
  // role stays at the authenticated app boundary; the runtime derives its
  // execution context from the verified session/lease.
  it.each(["Admin", "Manager", "User"] as const)(
    "omits role from the invoke payload for connection.role %s",
    async (role) => {
      mockConnectionGet.mockResolvedValue({ ...defaultConnection, role });

      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(result.batchItemFailures).toHaveLength(0);
      const payload = readInvokePayload();
      expect(payload).not.toHaveProperty("role");
      expect(payload).not.toHaveProperty("persona");
      expect(payload.actorId).toBe(defaultConnection.actorId);
    },
  );

  it("forwards the owner-keyed lease key in the invoke payload", async () => {
    await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(readInvokePayload().leaseKey).toBe(LEASE_ID);
  });

  it("sends the user id as the memory actor and the email-derived actorId for CloudTrail", async () => {
    await handler(buildSqsEvent(), mockContext(), vi.fn());

    const payload = readInvokePayload();
    expect(payload.userId).toBe(defaultConnection.userId);
    expect(payload.actorId).toBe(defaultConnection.actorId);
  });
});

describe("workerHandler — per-turn model selection contract", () => {
  it.each(["model-a", "model-b"])(
    "forwards the submitted modelId %s to the runtime invoke payload unchanged",
    async (modelId) => {
      const result = await handler(
        buildSqsEvent({
          body: {
            action: "sendMessage",
            message: "Hello agent",
            ...REQUEST_IDS,
            modelId,
          },
        }),
        mockContext(),
        vi.fn(),
      );

      expect(result.batchItemFailures).toHaveLength(0);
      expect(readInvokePayload().modelId).toBe(modelId);
    },
  );

  it("rejects a server-side-disallowed model before invoking the runtime", async () => {
    // A crafted request can carry a disabled or lease-disallowed model even
    // though the UI would not offer it. validateAndRoute rejects it, and the
    // Worker must surface a client error WITHOUT invoking the runtime or billing
    // the turn.
    const { ModelNotAllowedError } =
      await import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js");
    mockValidateAndRoute.mockRejectedValue(
      new ModelNotAllowedError(
        "The requested model is not available for this Sandbox Space.",
      ),
    );

    const result = await handler(
      buildSqsEvent({
        body: {
          action: "sendMessage",
          message: "Hello agent",
          ...REQUEST_IDS,
          modelId: "model-disabled",
        },
      }),
      mockContext(),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toEqual({
      code: "INVALID_REQUEST",
      message:
        "The selected model isn't available for this Sandbox Space. Choose another model and try again.",
      retryable: false,
    });
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("rejects a request that omits modelId before routing or invoking the runtime", async () => {
    const result = await handler(
      buildSqsEvent({
        body: {
          action: "sendMessage",
          message: "Hello agent",
          ...REQUEST_IDS,
        },
      }),
      mockContext(),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockSendError.mock.calls[0]![1]).toMatchObject({
      code: "INVALID_REQUEST",
      retryable: false,
    });
    // The required-field violation is caught at parse time, before routing.
    expect(mockValidateAndRoute).not.toHaveBeenCalled();
    expect(mockRuntimeSend).not.toHaveBeenCalled();
  });
});

describe("workerHandler — turn preconditions and stream edge cases", () => {
  it("refuses a turn with too little time left, before invoking the runtime", async () => {
    const result = await handler(
      buildSqsEvent(),
      mockContext({ remainingMs: 1_000 }),
      vi.fn(),
    );

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("refuses a turn whose time runs short while its permissions are resolved", async () => {
    const context = mockContext();
    // The first check, at the start of the turn, has time. The second, after the
    // permission profile is resolved, does not.
    context.getRemainingTimeInMillis = vi
      .fn()
      .mockReturnValueOnce(300_000)
      .mockReturnValue(1_000);

    const result = await handler(buildSqsEvent(), context, vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("rejects the turn when the route result has no account ID", async () => {
    mockValidateAndRoute.mockResolvedValue({
      leaseCurrentSpend: 0,
      runtimeSessionId: "lease-abc",
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(mockSendError).toHaveBeenCalledOnce();
    expect(mockRuntimeSend).not.toHaveBeenCalled();
    expect(mockRecordTurnUsage).not.toHaveBeenCalled();
  });

  it("skips a stream event it cannot parse and still records the turn", async () => {
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    const sseBody = [
      `data: ${JSON.stringify({ type: "not-a-known-event" })}`,
      `data: ${JSON.stringify({ type: "chunk", content: "Hi" })}`,
      `data: ${JSON.stringify({ type: "complete", usage: { inputTokens: 3, outputTokens: 5 } })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(warnSpy).toHaveBeenCalledWith(
      "Failed to parse SSE event",
      expect.objectContaining({ connectionId: expect.any(String) }),
    );
    expect(mockRecordTurnUsage).toHaveBeenCalledOnce();
  });

  it("logs a token total that does not match the measured tokens and records the measured tokens", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const sseBody = [
      `data: ${JSON.stringify({ type: "chunk", content: "Hi" })}`,
      `data: ${JSON.stringify({ type: "complete", usage: { inputTokens: 3, outputTokens: 5, totalTokens: 99 } })}`,
      "",
    ].join("\n");
    mockRuntimeSend.mockResolvedValue({
      response: { transformToString: async () => sseBody },
    });

    const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

    expect(result.batchItemFailures).toHaveLength(0);
    expect(errorSpy).toHaveBeenCalledWith(
      "Agent token total mismatch",
      expect.objectContaining({ reportedTotalTokens: 99 }),
    );
    expect(mockRecordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        tokens: expect.objectContaining({ inputTokens: 3, outputTokens: 5 }),
      }),
    );
  });

  it("does not price a turn when the Lambda's region is not set", async () => {
    vi.stubEnv("AWS_REGION", "");
    try {
      const result = await handler(buildSqsEvent(), mockContext(), vi.fn());

      expect(mockRuntimeSend).not.toHaveBeenCalled();
      expect(mockRecordTurnUsage).not.toHaveBeenCalled();
      expect(result.batchItemFailures).toHaveLength(0);
      expect(mockSendError).toHaveBeenCalledOnce();
      expect(mockSendError.mock.calls[0]![1]).toMatchObject({
        code: "RUNTIME_ERROR",
      });
    } finally {
      vi.stubEnv("AWS_REGION", "us-east-1");
    }
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { GetSandboxSpacesUsageServerOutput } from "@amzn/innovation-sandbox-api-server/sandbox-agent";
import type { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { PersistedMonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { MalformedSandboxSpacesUsageRecordError } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { SandboxAgentApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-api-lambda-environment.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  mockAuthorizedContext,
  mockGlobalConfig,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockLeaseGet = vi.fn();
const mockConfigGetSection = vi.fn();
const mockConfigGetAllSections = vi.fn();
const mockListLeaseUserUsage = vi.fn();
const mockGetLeaseUserUsage = vi.fn();
const mockStsSend = vi.fn();
const mockAcquireCreds = vi.fn();
const mockFetchAgentModels = vi.fn();

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    leaseStore: () => ({ get: mockLeaseGet }),
    configStore: () => ({
      getSection: mockConfigGetSection,
      getAllSections: mockConfigGetAllSections,
    }),
    sandboxSpacesUsageStore: () => ({
      listLeaseUserUsage: mockListLeaseUserUsage,
      getLeaseUserUsage: mockGetLeaseUserUsage,
    }),
    bedrockPriceCache: () => ({ getPrices: vi.fn(), putPrices: vi.fn() }),
  },
}));

vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: {
    sts: vi.fn(() => ({ send: mockStsSend })),
    bedrock: vi.fn(() => ({})),
    pricing: vi.fn(() => ({})),
    bedrockAgentCore: vi.fn(() => ({
      send: vi.fn().mockResolvedValue({ events: [], nextToken: undefined }),
    })),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-commons/isb-services/agent-models/index.js")
      >();
    return {
      ...actual,
      fetchAgentModelsWithPricing: mockFetchAgentModels,
    };
  },
);

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js")
      >();
    return {
      ...actual,
      acquireHistoryMemoryCredentials: mockAcquireCreds,
    };
  },
);

// ─── Fixtures ─────────────────────────────────────────────────────────────────

const testEnv = generateSchemaData(SandboxAgentApiLambdaEnvironmentSchema, {
  LEASE_TABLE_NAME: "test-leases",
  SANDBOX_SPACES_USAGE_TABLE_NAME: "test-usage",
  CONFIG_TABLE_NAME: "test-config",
  BEDROCK_REGIONAL_PRICE_TABLE_NAME: "test-bedrock-prices",
  MEMORY_ACCESS_ROLE_ARN: "arn:aws:iam::123456789012:role/MemoryAccessRole",
  USER_MEMORY_ARN:
    "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/user-memory-id",
  COGNITO_USER_POOL_ID: "us-east-1_testpool",
  COGNITO_APP_CLIENT_ID: "test-client-id",
  COGNITO_MCP_CLIENT_ID: "test-mcp-client-id",
  ISB_NAMESPACE: "testns",
});

// Enabled so the lease-scoped tests hit the lease gate, not the kill switch.
const mockedGlobalConfig = {
  ...mockGlobalConfig(),
  agent: { ...mockGlobalConfig().agent, sandboxSpacesEnabled: true },
};

const globallyDisabledConfig = {
  ...mockedGlobalConfig,
  agent: { ...mockedGlobalConfig.agent, sandboxSpacesEnabled: false },
};

const ADMIN_ID = "22222222-2222-4222-8222-222222222222";
const ALICE_ID = "11111111-1111-4111-8111-111111111111";
const BOB_ID = "44444444-4444-4444-8444-444444444444";

const adminUser: IsbUser = {
  type: "user",
  email: "admin@example.com",
  userId: ADMIN_ID,
  roles: ["Admin"],
};

const regularUser: IsbUser = {
  type: "user",
  email: "alice@example.com",
  userId: ALICE_ID,
  roles: ["User"],
};

const managerUser: IsbUser = {
  type: "user",
  email: "alice@example.com",
  userId: ALICE_ID,
  roles: ["User", "Manager"],
};

const LEASE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

/** The base64url lease key the client sends as `leaseId`. */
function leaseIdFor(uuid = LEASE_UUID, userEmail = "alice@example.com") {
  return Buffer.from(JSON.stringify({ userEmail, uuid })).toString("base64url");
}
const LEASE_ID = leaseIdFor();

function desiredUsers(...userIds: string[]) {
  return userIds.map((principalId) => ({
    principalId,
    principalType: "USER" as const,
  }));
}

const activeLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
  uuid: LEASE_UUID,
  userEmail: "alice@example.com",
  awsAccountId: "123456789012",
  sandboxSpacesEnabled: true,
  status: "Active",
  desiredAssignments: desiredUsers(ALICE_ID),
});

const defaultCreds = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
};

let handler: typeof import("@amzn/innovation-sandbox-agent-api/sandbox-agent-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  ({ handler } =
    await import("@amzn/innovation-sandbox-agent-api/sandbox-agent-handler.js"));
});

// Both mocks must agree: the middleware rebuilds `globalConfig` from
// `getAllSections()`, so those sections decide the kill switch under test.
function useGlobalConfig(config: GlobalConfig) {
  mockAppConfigMiddleware(config);
  const sections: Record<string, unknown> = {};
  for (const key of Object.keys(config)) {
    (sections as any)[key] = {
      ...(config as any)[key],
      lastSavedBy: null,
      meta: {
        createdTime: "2024-01-01T00:00:00.000Z",
        lastEditTime: "2024-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
    };
  }
  mockConfigGetAllSections.mockResolvedValue(sections);
}

beforeEach(() => {
  vi.clearAllMocks();
  useGlobalConfig(mockedGlobalConfig);
  mockLeaseGet.mockResolvedValue({ result: activeLease });
  mockConfigGetSection.mockResolvedValue({ sandboxSpacesEnabled: true });
  mockAcquireCreds.mockResolvedValue(defaultCreds);
  mockFetchAgentModels.mockResolvedValue({ models: [] });
});

afterAll(() => vi.restoreAllMocks());

// ─── GET /sandboxAgent/history ───────────────────────────────────────────────

describe("GET /sandboxAgent/history", () => {
  it("returns 400 when leaseId is missing for User role", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(400);
  });

  it("returns 404 when lease not found for User", async () => {
    mockLeaseGet.mockResolvedValue({ result: null });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: leaseIdFor("550e8400-e29b-41d4-a716-446655440001"),
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(404);
  });

  it.each([
    ["a bare lease uuid", LEASE_UUID],
    ["non-decodable text", "not-a-lease-key"],
    ["a key with an invalid uuid", leaseIdFor("lease-abc")],
  ])("returns 400 when leaseId is %s", async (_description, leaseId) => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: { leaseId },
      isbUser: regularUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(400);
    expect(mockLeaseGet).not.toHaveBeenCalled();
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns 404 when the caller is not in the lease's desiredAssignments", async () => {
    mockLeaseGet.mockResolvedValue({
      result: { ...activeLease, desiredAssignments: desiredUsers(BOB_ID) },
    });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: { leaseId: LEASE_ID },
      isbUser: regularUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(404);
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns 404 for an M2M caller, who has no IDC user id", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: { leaseId: LEASE_ID },
      isbUser: { type: "m2m", clientId: "client-1", roles: ["Admin"] },
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(404);
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  describe("shared lease", () => {
    const assignee: IsbUser = {
      type: "user",
      email: "bob@example.com",
      userId: BOB_ID,
      roles: ["User"],
    };

    function historyEventFor(user: IsbUser) {
      return createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/sandboxAgent/history",
        // The client sends the owner-keyed lease key, same for every user.
        queryStringParameters: { leaseId: LEASE_ID },
        isbUser: user,
      });
    }

    beforeEach(() => {
      mockLeaseGet.mockResolvedValue({
        result: {
          ...activeLease,
          desiredAssignments: desiredUsers(ALICE_ID, BOB_ID),
        },
      });
    });

    it("returns 200 for a direct assignee, reading memory as the assignee", async () => {
      const result = await handler(
        historyEventFor(assignee),
        mockAuthorizedContext(testEnv),
      );

      expect(result.statusCode).toBe(200);
      // One read, by the owner-keyed key the client supplied.
      expect(mockLeaseGet).toHaveBeenCalledTimes(1);
      expect(mockLeaseGet).toHaveBeenCalledWith(
        {
          userEmail: "alice@example.com",
          uuid: LEASE_UUID,
        },
        { consistentRead: true },
      );
      expect(mockAcquireCreds).toHaveBeenCalledWith(
        expect.objectContaining({
          actorId: BOB_ID,
          memorySessionId: LEASE_UUID,
        }),
      );
      expect(JSON.parse(result.body).data.leaseUuid).toBe(LEASE_UUID);
    });

    it("returns 404 when the assignee is no longer in desiredAssignments", async () => {
      mockLeaseGet.mockResolvedValue({
        result: { ...activeLease, desiredAssignments: desiredUsers(ALICE_ID) },
      });

      const result = await handler(
        historyEventFor(assignee),
        mockAuthorizedContext(testEnv),
      );

      expect(result.statusCode).toBe(404);
      expect(mockAcquireCreds).not.toHaveBeenCalled();
    });

    it("returns 404 for an Admin who is neither owner nor assignee", async () => {
      const result = await handler(
        historyEventFor(adminUser),
        mockAuthorizedContext(testEnv),
      );

      expect(result.statusCode).toBe(404);
      expect(mockAcquireCreds).not.toHaveBeenCalled();
    });

    it("returns 404 for a GROUP entry, even when its id equals the caller's user id", async () => {
      mockLeaseGet.mockResolvedValue({
        result: {
          ...activeLease,
          desiredAssignments: [
            ...desiredUsers(ALICE_ID),
            { principalId: BOB_ID, principalType: "GROUP" },
          ],
        },
      });

      const result = await handler(
        historyEventFor(assignee),
        mockAuthorizedContext(testEnv),
      );

      expect(result.statusCode).toBe(404);
      expect(mockAcquireCreds).not.toHaveBeenCalled();
    });
  });

  it.each([
    ["is inactive", { ...activeLease, status: "Frozen" }],
    [
      "has a disabled Sandbox Spaces snapshot",
      { ...activeLease, sandboxSpacesEnabled: false },
    ],
  ])("returns 403 when the owner lease %s", async (_description, lease) => {
    mockLeaseGet.mockResolvedValue({ result: lease });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(403);
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns error when scoped credentials are unavailable", async () => {
    mockAcquireCreds.mockResolvedValue(null);
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBeGreaterThanOrEqual(500);
  });

  it("returns 200 with empty messages for User with valid lease (Feature 2 stubbed)", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    expect(result.headers).toMatchObject(responseHeaders);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.messages).toEqual([]);
    expect(body.data.leaseUuid).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
  });

  it("returns 404 when Admin requests a lease they are not assigned to", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(404);
    expect(mockLeaseGet).toHaveBeenCalledWith(
      {
        userEmail: "alice@example.com",
        uuid: LEASE_UUID,
      },
      { consistentRead: true },
    );
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns lease-scoped history when Admin requests their own lease", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        ...activeLease,
        userEmail: adminUser.email,
        desiredAssignments: desiredUsers(ADMIN_ID),
      },
    });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: leaseIdFor(LEASE_UUID, adminUser.email),
      },
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.leaseUuid).toBe("6ba7b810-9dad-11d1-80b4-00c04fd430c8");
  });

  it("returns 403 and reads no lease when Sandbox Spaces is globally disabled", async () => {
    useGlobalConfig(globallyDisabledConfig);
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: { leaseId: LEASE_ID },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(403);
    expect(mockLeaseGet).not.toHaveBeenCalled();
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns lease-scoped history when a Manager requests their own lease", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: { leaseId: LEASE_ID },
      isbUser: managerUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    expect(mockLeaseGet).toHaveBeenCalledWith(
      {
        userEmail: managerUser.email,
        uuid: LEASE_UUID,
      },
      { consistentRead: true },
    );
  });

  it("returns 400 when leaseId is missing for Admin role", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      isbUser: adminUser,
    });

    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(400);
    expect(mockLeaseGet).not.toHaveBeenCalled();
    expect(mockAcquireCreds).not.toHaveBeenCalled();
  });

  it("returns identified messages and skips events without an event ID", async () => {
    const { IsbClients } =
      await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js");
    const mockSend = vi.fn().mockResolvedValue({
      events: [
        {
          eventTimestamp: new Date("2026-06-25T09:00:00Z"),
          payload: [
            {
              conversational: {
                role: "USER",
                content: { text: "message without an event id" },
              },
            },
          ],
        },
        {
          eventId: "1748942330123#a84f09",
          eventTimestamp: new Date("2026-06-25T10:00:00Z"),
          payload: [
            {
              json: {
                content: { type: "turn-start" },
              },
            },
            {
              conversational: {
                role: "USER",
                content: { text: "list s3 buckets" },
              },
            },
            {
              conversational: {
                role: "ASSISTANT",
                content: { text: "Here are your buckets..." },
              },
            },
          ],
        },
      ],
      nextToken: undefined,
    });
    vi.mocked(IsbClients.bedrockAgentCore).mockReturnValueOnce({
      send: mockSend,
    } as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.messages).toHaveLength(2);
    expect(body.data.messages[0]).toMatchObject({
      messageId: "1748942330123#a84f09:1",
      role: "user",
      content: "list s3 buckets",
      createdAt: "2026-06-25T10:00:00Z",
    });
    expect(body.data.messages[1]).toMatchObject({
      messageId: "1748942330123#a84f09:2",
      role: "assistant",
      content: "Here are your buckets...",
    });
  });

  it("returns 200 with empty messages when ListEvents throws (fail-open)", async () => {
    const { IsbClients } =
      await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js");
    vi.mocked(IsbClients.bedrockAgentCore).mockReturnValueOnce({
      send: vi.fn().mockRejectedValue(new Error("AccessDeniedException")),
    } as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.messages).toEqual([]);
  });

  it("forwards maxResults to AgentCore", async () => {
    const { IsbClients } =
      await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js");
    const mockSend = vi
      .fn()
      .mockResolvedValue({ events: [], nextToken: undefined });
    vi.mocked(IsbClients.bedrockAgentCore).mockReturnValueOnce({
      send: mockSend,
    } as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
        maxResults: "25",
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({ maxResults: 25 }),
      }),
    );
  });

  it("preserves AgentCore's default when maxResults is omitted", async () => {
    const { IsbClients } =
      await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js");
    const mockSend = vi
      .fn()
      .mockResolvedValue({ events: [], nextToken: undefined });
    vi.mocked(IsbClients.bedrockAgentCore).mockReturnValueOnce({
      send: mockSend,
    } as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));

    expect(result.statusCode).toBe(200);
    expect(mockSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.not.objectContaining({ maxResults: expect.anything() }),
      }),
    );
  });

  it.each(["0", "101", "1.5", "invalid"])(
    "returns 400 for invalid maxResults %s",
    async (maxResults) => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/sandboxAgent/history",
        queryStringParameters: {
          leaseId: LEASE_ID,
          maxResults,
        },
        isbUser: regularUser,
      });
      const result = await handler(event, mockAuthorizedContext(testEnv));

      expect(result.statusCode).toBe(400);
      expect(mockLeaseGet).not.toHaveBeenCalled();
      expect(mockStsSend).not.toHaveBeenCalled();
    },
  );

  it("passes nextToken through when ListEvents returns pagination token", async () => {
    const { IsbClients } =
      await import("@amzn/innovation-sandbox-commons/sdk-clients/index.js");
    vi.mocked(IsbClients.bedrockAgentCore).mockReturnValueOnce({
      send: vi
        .fn()
        .mockResolvedValue({ events: [], nextToken: "page-2-token" }),
    } as any);

    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/history",
      queryStringParameters: {
        leaseId: LEASE_ID,
      },
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.nextToken).toBe("page-2-token");
  });
});

// ─── GET /sandboxAgent/usage ─────────────────────────────────────────────────

describe("GET /sandboxAgent/usage", () => {
  const outsider: IsbUser = {
    type: "user",
    email: "bob@example.com",
    userId: BOB_ID,
    roles: ["User"],
  };

  function usageEventFor(
    user: IsbUser,
    queryStringParameters: Record<string, string> | undefined = {
      leaseId: LEASE_ID,
    },
  ) {
    return createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/usage",
      queryStringParameters,
      isbUser: user,
    });
  }

  const call = (user: IsbUser) =>
    handler(usageEventFor(user), mockAuthorizedContext(testEnv));

  const spendRow = (
    userId: string,
    sandboxSpacesEstimatedTokenCostAccrued: number,
  ) => ({
    leaseId: LEASE_UUID,
    userId,
    sandboxSpacesEstimatedTokenCostAccrued,
    invocationCount: 1,
    inputTokens: 1,
    outputTokens: 1,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
  });

  const expectNoSpendRead = () => {
    expect(mockListLeaseUserUsage).not.toHaveBeenCalled();
    expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
  };

  beforeEach(() => {
    mockListLeaseUserUsage.mockResolvedValue({
      usage: [spendRow(BOB_ID, 1.25), spendRow(ALICE_ID, 2.25)],
    });
    mockGetLeaseUserUsage.mockResolvedValue(null);
  });

  it("returns the breakdown the caller's role allows", async () => {
    mockGetLeaseUserUsage.mockResolvedValue(spendRow(ALICE_ID, 2.25));

    const asUser = await call(regularUser);
    const asAdmin = await call(adminUser);
    const asManager = await call(managerUser);

    expect(JSON.parse(asUser.body)).toEqual({
      status: "success",
      data: {
        spendByUsers: [
          { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 2.25 },
        ],
      },
    });
    expect(JSON.parse(asAdmin.body).data).toEqual({
      spendByUsers: [
        { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 2.25 },
        { userId: BOB_ID, sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
      ],
    });
    expect(JSON.parse(asManager.body).data.spendByUsers).toEqual(
      JSON.parse(asAdmin.body).data.spendByUsers,
    );
    expect(mockGetLeaseUserUsage).toHaveBeenCalledOnce();
    expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(LEASE_UUID, ALICE_ID);
    expect(mockListLeaseUserUsage).toHaveBeenCalledTimes(2);
  });

  it("returns 200 without the caller's entry when their record is unreadable", async () => {
    mockGetLeaseUserUsage.mockRejectedValue(
      new MalformedSandboxSpacesUsageRecordError("bad"),
    );

    const result = await call(regularUser);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toEqual({ spendByUsers: [] });
  });

  it("lets a direct assignee read the lease with only their own entry", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        ...activeLease,
        desiredAssignments: desiredUsers(ALICE_ID, BOB_ID),
      },
    });
    mockGetLeaseUserUsage.mockResolvedValue(spendRow(BOB_ID, 1.25));

    const result = await call(outsider);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data.spendByUsers).toEqual([
      { userId: BOB_ID, sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
    ]);
    expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(LEASE_UUID, BOB_ID);
    expect(mockListLeaseUserUsage).not.toHaveBeenCalled();
  });

  it("returns 403 for a user who is neither owner nor assignee", async () => {
    const result = await call(outsider);

    expect(result.statusCode).toBe(403);
    expectNoSpendRead();
  });

  it("does not honour group assignments", async () => {
    const groupId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
    mockLeaseGet.mockResolvedValue({
      result: {
        ...activeLease,
        desiredAssignments: [
          ...desiredUsers(ALICE_ID),
          { principalId: groupId, principalType: "GROUP" },
        ],
      },
    });

    const result = await call(outsider);

    expect(result.statusCode).toBe(403);
  });

  it("still authorizes a readable lease whose record also reported an error, and warns", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    mockLeaseGet.mockResolvedValue({
      result: activeLease,
      error: "1 item failed validation",
    });

    const result = await call(regularUser);

    expect(result.statusCode).toBe(200);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
      expect.objectContaining({ leaseId: LEASE_UUID }),
    );
    warn.mockRestore();
  });

  it("denies a lease that could not be read: 403 to a user, 404 to an Admin or Manager", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    mockLeaseGet.mockResolvedValue({ error: "record failed validation" });

    const asUser = await call(regularUser);
    const asAdmin = await call(adminUser);
    const asManager = await call(managerUser);

    expect(asUser.statusCode).toBe(403);
    expect(asAdmin.statusCode).toBe(404);
    expect(asManager.statusCode).toBe(404);
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
      expect.objectContaining({ leaseId: LEASE_UUID }),
    );
    expectNoSpendRead();
    warn.mockRestore();
  });

  it("does not route a request without leaseId", async () => {
    const result = await handler(
      usageEventFor(regularUser, {}),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(404);
    expectNoSpendRead();
  });

  it("returns 400 when leaseId is empty", async () => {
    const result = await handler(
      usageEventFor(regularUser, { leaseId: "" }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(400);
    expectNoSpendRead();
  });

  it("returns 400 when leaseId is not a lease key", async () => {
    const result = await handler(
      usageEventFor(regularUser, { leaseId: "not-a-lease-key" }),
      mockAuthorizedContext(testEnv),
    );

    expect(result.statusCode).toBe(400);
    expectNoSpendRead();
  });

  it("returns 403 to a user and 404 to an Admin or Manager when the lease does not exist", async () => {
    mockLeaseGet.mockResolvedValue({ result: undefined });

    const asUser = await call(regularUser);
    const asAdmin = await call(adminUser);
    const asManager = await call(managerUser);

    expect(asUser.statusCode).toBe(403);
    expect(asAdmin.statusCode).toBe(404);
    expect(asManager.statusCode).toBe(404);
    expectNoSpendRead();
  });

  it("serves spend for an ended lease while Sandbox Spaces is globally disabled", async () => {
    useGlobalConfig(globallyDisabledConfig);
    mockLeaseGet.mockResolvedValue({
      result: { ...activeLease, status: "Expired" },
    });

    const result = await call(regularUser);

    expect(result.statusCode).toBe(200);
    expect(JSON.parse(result.body).data).toEqual({
      spendByUsers: [
        { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 0 },
      ],
    });
  });

  it("exposes only per-user spend on the response type", () => {
    type UsageData = GetSandboxSpacesUsageServerOutput["data"];
    expectTypeOf<UsageData>().not.toHaveProperty(
      "sandboxSpacesEstimatedTokenCostAccrued",
    );
    expectTypeOf<UsageData>().toHaveProperty("spendByUsers");
    expectTypeOf<UsageData>().not.toHaveProperty("invocationCount");
    expectTypeOf<UsageData>().not.toHaveProperty("tokens");
  });
});

// ─── GET /sandboxAgent/models ────────────────────────────────────────────────

describe("GET /sandboxAgent/models", () => {
  beforeEach(() => {
    process.env["AWS_REGION"] = "us-east-1";
  });

  afterEach(() => {
    delete process.env["AWS_REGION"];
  });

  it("returns 403 for non-Admin caller", async () => {
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/models",
      isbUser: regularUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(403);
    expect(mockFetchAgentModels).not.toHaveBeenCalled();
  });

  it("returns 200 with empty models list when no eligible models exist", async () => {
    mockFetchAgentModels.mockResolvedValue({ models: [] });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.status).toBe("success");
    expect(body.data.models).toEqual([]);
  });

  it("returns 200 with model list when discovery succeeds", async () => {
    const mockModel = {
      modelId: "global.anthropic.claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6 Global",
      provider: "Anthropic",
      availability: "global",
      modelType: "inference-profile" as const,
      pricingSource: "price-list" as const,
      pricingRefreshedAt: new Date("2026-09-17T00:00:00.000Z"),
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
      cacheReadPricePer1KTokens: 0.0003,
      cacheWritePricePer1KTokens: 0.00375,
    };
    mockFetchAgentModels.mockResolvedValue({ models: [mockModel] });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const body = JSON.parse(result.body);
    expect(body.data.models).toHaveLength(1);
    expect(body.data.models[0].modelId).toBe(
      "global.anthropic.claude-sonnet-4-6",
    );
    expect(body.data.models[0].provider).toBe("Anthropic");
  });

  it("returns a model that has no price without any price fields", async () => {
    mockFetchAgentModels.mockResolvedValue({
      models: [
        {
          modelId: "global.anthropic.claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6 Global",
          provider: "Anthropic",
          availability: "global",
          modelType: "inference-profile" as const,
        },
      ],
    });
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(200);
    const [model] = JSON.parse(result.body).data.models;
    expect(model.modelId).toBe("global.anthropic.claude-sonnet-4-6");
    for (const field of [
      "pricingSource",
      "pricingRefreshedAt",
      "inputPricePer1KTokens",
      "outputPricePer1KTokens",
      "cacheReadPricePer1KTokens",
      "cacheWritePricePer1KTokens",
    ]) {
      expect(model).not.toHaveProperty(field);
    }
  });

  it("returns 500 when both discovery sources fail", async () => {
    mockFetchAgentModels.mockRejectedValue(
      new Error("both discovery sources failed"),
    );
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/sandboxAgent/models",
      isbUser: adminUser,
    });
    const result = await handler(event, mockAuthorizedContext(testEnv));
    expect(result.statusCode).toBe(500);
  });
});

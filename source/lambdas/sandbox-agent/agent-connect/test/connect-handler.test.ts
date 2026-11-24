// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AgentConnectLambdaEnvironmentSchema,
  ConnectLambdaEnvironment,
} from "@amzn/innovation-sandbox-commons/lambda/environments/connect-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { encodeTestToken } from "@amzn/innovation-sandbox-commons/test/lambdas/api-test-setup.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { APIGatewayProxyWebsocketEventV2 } from "aws-lambda";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// ─── ConnectionStore mock ─────────────────────────────────────────────────────
const mockSave = vi.fn();
const mockDelete = vi.fn();

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    connectionStore: vi.fn().mockReturnValue({
      save: mockSave,
      delete: mockDelete,
      get: vi.fn(),
    }),
  },
}));

// ─── Test fixtures ────────────────────────────────────────────────────────────
const testEnv = generateSchemaData(AgentConnectLambdaEnvironmentSchema, {
  CONNECTIONS_TABLE_NAME: "test-connections-table",
  COGNITO_USER_POOL_ID: "us-east-1_testpool",
  COGNITO_APP_CLIENT_ID: "test-client-id",
  ISB_NAMESPACE: "testns",
});

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function mockContext(env: ConnectLambdaEnvironment): any {
  return {
    env,
    functionName: "test-connect",
    functionVersion: "$LATEST",
    invokedFunctionArn:
      "arn:aws:lambda:us-east-1:123456789012:function:test-connect",
    memoryLimitInMB: "256",
    awsRequestId: "test-request-id",
    logGroupName: "/aws/lambda/test-connect",
    logStreamName: "2024/01/01/[$LATEST]test",
    getRemainingTimeInMillis: () => 30000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
    callbackWaitsForEmptyEventLoop: false,
  };
}

function buildConnectEvent(
  overrides: {
    connectionId?: string;
    queryParams?: Record<string, string>;
    routeKey?: string;
  } = {},
): APIGatewayProxyWebsocketEventV2 {
  return {
    requestContext: {
      connectionId: overrides.connectionId ?? "test-connection-id",
      routeKey: overrides.routeKey ?? "$connect",
      eventType: "CONNECT",
      extendedRequestId: "test-extended-id",
      requestTime: "01/Jan/2024:00:00:00 +0000",
      messageDirection: "IN",
      stage: "prod",
      connectedAt: Date.now(),
      requestTimeEpoch: Date.now(),
      requestId: "test-request-id",
      domainName: "test.execute-api.us-east-1.amazonaws.com",
      apiId: "test-api-id",
    },
    queryStringParameters: overrides.queryParams ?? {},
    headers: {},
    multiValueHeaders: {},
    isBase64Encoded: false,
    body: null,
  } as unknown as APIGatewayProxyWebsocketEventV2;
}

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

function makeValidToken(overrides: Record<string, unknown> = {}) {
  return encodeTestToken({
    sub: "user-sub-123",
    email: "alice@example.com",
    "custom:isb_roles": JSON.stringify(["User"]),
    "custom:idc_user_id": TEST_USER_ID,
    ...overrides,
  });
}

// ─── Tests ────────────────────────────────────────────────────────────────────

let handler: (typeof import("@amzn/innovation-sandbox-agent-connect/connect-handler.js"))["handler"];

beforeAll(async () => {
  bulkStubEnv(testEnv);
  ({ handler } =
    await import("@amzn/innovation-sandbox-agent-connect/connect-handler.js"));
});

beforeEach(() => {
  mockSave.mockClear();
  mockDelete.mockClear();
  mockSave.mockResolvedValue(undefined);
  mockDelete.mockResolvedValue(undefined);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("$connect handler", () => {
  it("returns 200 and stores connection for valid token with User role", async () => {
    const token = makeValidToken();
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });

    const result = await handler(event, mockContext(testEnv), vi.fn());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockSave).toHaveBeenCalledOnce();
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
      connectionId: "test-connection-id",
      email: "alice@example.com",
      role: "User",
      actorId: "alice-at-example-d-com",
      userId: TEST_USER_ID,
      protocolVersion: 1,
      ttl: expect.any(Number),
    });
  });

  it("returns 200 for Admin role", async () => {
    const token = makeValidToken({
      "custom:isb_roles": JSON.stringify(["Admin"]),
    });
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });

    const result = await handler(event, mockContext(testEnv), vi.fn());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({ role: "Admin" });
  });

  it("returns 401 when x-isb-identity is missing", async () => {
    const event = buildConnectEvent({ queryParams: {} });
    const result = await handler(event, mockContext(testEnv), vi.fn());
    expect(result).toMatchObject({ statusCode: 401 });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns 401 for expired/malformed token", async () => {
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": "invalid.token.here" },
    });
    const result = await handler(event, mockContext(testEnv), vi.fn());
    expect(result).toMatchObject({ statusCode: 401 });
    expect(mockSave).not.toHaveBeenCalled();
  });

  it("returns 401 when email claim is missing", async () => {
    const token = encodeTestToken({
      sub: "user-sub-123",
      "custom:isb_roles": JSON.stringify(["User"]),
    });
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });
    const result = await handler(event, mockContext(testEnv), vi.fn());
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it.each([
    ["missing", undefined],
    ["not an IDC principal id", "not-a-principal-id"],
  ])(
    "returns 401 when custom:idc_user_id is %s",
    async (_description, claim) => {
      const token = makeValidToken({ "custom:idc_user_id": claim });
      const event = buildConnectEvent({
        queryParams: { "x-isb-identity": token },
      });

      const result = await handler(event, mockContext(testEnv), vi.fn());

      expect(result).toMatchObject({ statusCode: 401 });
      expect(mockSave).not.toHaveBeenCalled();
    },
  );

  it("returns 401 when custom:isb_roles has no ISB role", async () => {
    const token = makeValidToken({ "custom:isb_roles": JSON.stringify([]) });
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });
    const result = await handler(event, mockContext(testEnv), vi.fn());
    expect(result).toMatchObject({ statusCode: 401 });
  });

  it("stores protocolVersion from x-isb-protocol-version query param", async () => {
    const token = makeValidToken();
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token, "x-isb-protocol-version": "1" },
    });
    await handler(event, mockContext(testEnv), vi.fn());
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({ protocolVersion: 1 });
  });

  it("defaults protocolVersion to 1 when param is missing", async () => {
    const token = makeValidToken();
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });
    await handler(event, mockContext(testEnv), vi.fn());
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({ protocolVersion: 1 });
  });

  it("defaults protocolVersion to 1 for invalid (out-of-range) value", async () => {
    const token = makeValidToken();
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token, "x-isb-protocol-version": "99" },
    });
    await handler(event, mockContext(testEnv), vi.fn());
    expect(mockSave.mock.calls[0]?.[0]).toMatchObject({ protocolVersion: 1 });
  });

  describe("actorId sanitization", () => {
    it("encodes @ and . in email", async () => {
      const token = makeValidToken({ email: "alice@example.com" });
      const event = buildConnectEvent({
        queryParams: { "x-isb-identity": token },
      });
      await handler(event, mockContext(testEnv), vi.fn());
      expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
        actorId: "alice-at-example-d-com",
      });
    });

    it("escapes existing hyphens for collision-free encoding", async () => {
      const token = makeValidToken({ email: "bob-jones@corp.co" });
      const event = buildConnectEvent({
        queryParams: { "x-isb-identity": token },
      });
      await handler(event, mockContext(testEnv), vi.fn());
      expect(mockSave.mock.calls[0]?.[0]).toMatchObject({
        actorId: "bob--jones-at-corp-d-co",
      });
    });
  });
});

describe("$disconnect handler", () => {
  it("deletes connection record and returns 200", async () => {
    const event = buildConnectEvent({
      connectionId: "conn-to-delete",
      routeKey: "$disconnect",
    });

    const result = await handler(event, mockContext(testEnv), vi.fn());

    expect(result).toMatchObject({ statusCode: 200 });
    expect(mockDelete).toHaveBeenCalledOnce();
    expect(mockDelete.mock.calls[0]?.[0]).toBe("conn-to-delete");
  });
});

describe("error handling", () => {
  it("propagates DynamoDB write failure on $connect", async () => {
    mockSave.mockRejectedValueOnce(new Error("Throttled"));
    const token = makeValidToken();
    const event = buildConnectEvent({
      queryParams: { "x-isb-identity": token },
    });
    await expect(handler(event, mockContext(testEnv), vi.fn())).rejects.toThrow(
      "Throttled",
    );
  });

  it("returns 200 on DynamoDB delete failure during $disconnect (fail open)", async () => {
    mockDelete.mockRejectedValueOnce(new Error("Throttled"));
    const event = buildConnectEvent({
      connectionId: "conn-failing",
      routeKey: "$disconnect",
    });
    const result = await handler(event, mockContext(testEnv), vi.fn());
    expect(result).toMatchObject({ statusCode: 200 });
  });
});

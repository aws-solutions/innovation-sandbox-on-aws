// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxAccountView,
  UnregisteredAccountView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import {
  createAccountClient,
  SmithyAccountClient,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/smithy-client";
import { CleanupReportView } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { ConfigData } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  MOCK_ID_TOKEN,
  mockCognitoCredentials,
} from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

const mockGetIdToken = vi.fn();
const mockGetCredentials = vi.fn();

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getIdToken: (...args: unknown[]) => mockGetIdToken(...args),
    getCredentials: (...args: unknown[]) => mockGetCredentials(...args),
  },
}));

const config: ConfigData = {
  ApiUrl: "http://localhost/api",
  CognitoUserPoolId: "us-east-1_TestPool",
  CognitoAppClientId: "test-client-id",
  CognitoIdentityPoolId: "us-east-1:00000000-0000-0000-0000-000000000000",
  CognitoDomain: "test-isb",
  Region: "us-east-1",
  AwsAccessPortalUrl: "https://test.awsapps.com/start",
  ApiGatewayHost: "test1234.execute-api.us-east-1.amazonaws.com",
  ApiGatewayStage: "prod",
  SandboxAgentWebSocketUrl:
    "wss://test5678.execute-api.us-east-1.amazonaws.com/prod",
  SandboxAgentMcpGatewayUrl:
    "https://test5678.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
};

// The wire shape the server projects: no `meta.schemaVersion`, `resourceLock`
// present (raw ISO strings). The adapter must pass this through untouched.
const account: SandboxAccountView = {
  awsAccountId: "000000000000",
  status: "Available",
  meta: {
    createdTime: "2026-08-01T12:00:00.824Z",
    lastEditTime: "2026-08-02T13:30:00.512Z",
  },
  resourceLock: {
    ownerId: "cleanup-owner",
    acquiredAt: "2026-08-10T00:00:00.000Z",
    expiresAt: "2026-08-10T00:15:00.000Z",
  },
};

const unregistered: UnregisteredAccountView = {
  Id: "111111111111",
  Email: "unregistered@example.com",
  Name: "Entry OU account",
};

const cleanupReport: CleanupReportView = {
  accountId: "000000000000",
  durableExecutionArn: "arn:aws:lambda:us-east-1:000000000000:function:x",
  status: "COMPLETED",
  cleanupStatus: "SUCCESS",
  startedAt: "2026-08-10T00:00:00.000Z",
  reasonForCleanup: "MANUALLY_INITIATED",
  steps: [],
};

function successResponse(data: unknown, status = 200): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    status,
    headers: { "content-type": "application/json" },
  });
}

function fetchedRequest(callIndex = 0): Request {
  return vi.mocked(fetch).mock.calls[callIndex]![0] as Request;
}

function signedHeaders(request: Request): string[] {
  const authorization = request.headers.get("authorization") ?? "";
  return (authorization.match(/SignedHeaders=([^,]+)/)?.[1] ?? "").split(";");
}

function createSmithyClient(): SmithyAccountClient {
  return new SmithyAccountClient(createAccountClient(config));
}

describe("generated Account client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue({
      ...mockCognitoCredentials,
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    });
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() =>
        Promise.resolve(
          successResponse({ result: [account], nextPageIdentifier: null }),
        ),
      );
  });

  it("signs the API Gateway stage and fetches accounts through same-origin CloudFront", async () => {
    const page = await createSmithyClient().listAccounts();
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost/api/accounts");
    expect(request.headers.get(IDENTITY_HEADER)).toBe(MOCK_ID_TOKEN);
    expect(signedHeaders(request)).toEqual(
      expect.arrayContaining(["host", IDENTITY_HEADER]),
    );
    expect(page).toEqual({ result: [account], nextPageIdentifier: null });
  });

  it("passes resourceLock through untouched (isCleanupLockActive depends on it)", async () => {
    const page = await createSmithyClient().listAccounts();
    expect(page.result[0]!.resourceLock).toEqual(account.resourceLock);
  });

  it("filters an account response missing a required member", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [{ status: "Available" }],
        nextPageIdentifier: null,
      }),
    );

    await expect(createSmithyClient().listAccounts()).resolves.toEqual({
      result: [],
      nextPageIdentifier: null,
    });
  });

  it("returns valid accounts while filtering malformed accounts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [account, { ...account, email: "not-an-email" }],
        nextPageIdentifier: null,
      }),
    );

    await expect(createSmithyClient().listAccounts()).resolves.toEqual({
      result: [account],
      nextPageIdentifier: null,
    });
  });

  it("throws on a success envelope with no data (never returns an empty page)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(createSmithyClient().listAccounts()).rejects.toThrow(
      "Accounts list response did not contain data",
    );
  });

  it("throws when the required result list is absent (does not coalesce to [])", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(createSmithyClient().listAccounts()).rejects.toThrow(
      "Accounts list response did not contain data",
    );
  });

  it("normalizes modeled JSend field errors into ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ field: "awsAccountId", message: "is required" }] },
        }),
        {
          status: 400,
          headers: {
            "content-type": "application/json",
            "x-amzn-errortype": "ValidationError",
          },
        },
      ),
    );

    const error = await createSmithyClient()
      .listAccounts()
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "awsAccountId: is required",
      statusCode: 400,
    });
  });

  it("normalizes message-only conflicts and generic HTTP failures like ApiProxy", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "fail",
            data: { errors: [{ message: "Account is already quarantined." }] },
          }),
          {
            status: 409,
            headers: {
              "content-type": "application/json",
              "x-amzn-errortype": "ConflictError",
            },
          },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ message: "Forbidden" }), {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-amzn-errortype": "AccessDeniedError",
          },
        }),
      );
    const client = createSmithyClient();

    await expect(
      client.quarantineAccount("000000000000"),
    ).rejects.toMatchObject({
      message: "Account is already quarantined.",
      statusCode: 409,
    });
    await expect(client.listAccounts()).rejects.toMatchObject({
      message: "HTTP error 403",
      statusCode: 403,
    });
  });

  it("fails before fetch when the human session has no credentials", async () => {
    mockGetCredentials.mockResolvedValue(null);
    await expect(createSmithyClient().listAccounts()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails before fetch when the human session has no ID token", async () => {
    mockGetIdToken.mockResolvedValue(null);
    await expect(createSmithyClient().listAccounts()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("gets an account by id through a signed GET", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(account));
    const result = await createSmithyClient().getAccount("000000000000");
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost/api/accounts/000000000000");
    expect(result).toEqual(account);
  });

  it("rejects a single account response that fails runtime validation", async () => {
    const accountWithUnconstrainedEmail = {
      ...account,
      email: "internal-address",
    };
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(accountWithUnconstrainedEmail));

    await expect(
      createSmithyClient().getAccount("000000000000"),
    ).rejects.toThrow("Invalid email address");
  });

  it("propagates a 404 for a missing account as ApiError, like pre-Smithy", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message: "Account not found." }] },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createSmithyClient().getAccount("000000000000"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("lists unregistered accounts through a signed GET", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        successResponse({ result: [unregistered], nextPageIdentifier: null }),
      );
    const page = await createSmithyClient().listUnregisteredAccounts();

    expect(fetchedRequest().url).toBe(
      "http://localhost/api/accounts/unregistered",
    );
    expect(page).toEqual({ result: [unregistered], nextPageIdentifier: null });
  });

  it("returns valid unregistered accounts while filtering malformed accounts", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [unregistered, { Email: "unregistered@example.com" }],
        nextPageIdentifier: null,
      }),
    );

    await expect(
      createSmithyClient().listUnregisteredAccounts(),
    ).resolves.toEqual({
      result: [unregistered],
      nextPageIdentifier: null,
    });
  });

  it("requests a single cleanup report when maxResults is 1", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        successResponse({ result: [cleanupReport], nextPageIdentifier: null }),
      );
    const page = await createSmithyClient().listCleanupReports(
      "000000000000",
      undefined,
      1,
    );

    const request = fetchedRequest();
    expect(request.url).toBe(
      "http://localhost/api/accounts/000000000000/cleanup-reports?maxResults=1",
    );
    expect(page).toEqual({
      result: [cleanupReport],
      nextPageIdentifier: null,
    });
  });

  it("returns valid cleanup reports while filtering malformed reports", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [
          cleanupReport,
          {
            ...cleanupReport,
            steps: [{ startedAt: "2026-08-10T00:00:00.000Z" }],
          },
        ],
        nextPageIdentifier: null,
      }),
    );

    await expect(
      createSmithyClient().listCleanupReports("000000000000"),
    ).resolves.toEqual({
      result: [cleanupReport],
      nextPageIdentifier: null,
    });
  });

  it("registers an account through a signed POST carrying only awsAccountId", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(account, 201));
    await createSmithyClient().registerAccount("000000000000");

    const request = fetchedRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/accounts");
    await expect(request.clone().json()).resolves.toEqual({
      awsAccountId: "000000000000",
    });
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
  });

  it("URL-encodes an opaque continuation token in the query", async () => {
    // pageIdentifier is base64 of a DynamoDB key, so it can contain +, /, =. The
    // generated client must percent-encode it (the pre-Smithy /accounts path did
    // not, which would corrupt such a token). Round-tripping through URL decoding
    // proves the value was encoded, not sent raw.
    const token = "a+b/c==";
    await createSmithyClient().listAccounts(token);

    const url = new URL(fetchedRequest().url);
    expect(url.searchParams.get("pageIdentifier")).toBe(token);
    expect(url.search).not.toContain("a+b/c==");
  });

  it("throws when the unregistered response omits the required result list", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(
      createSmithyClient().listUnregisteredAccounts(),
    ).rejects.toThrow("Unregistered accounts response did not contain data");
  });

  it("throws when the cleanup-reports response omits the required result list", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(
      createSmithyClient().listCleanupReports("000000000000"),
    ).rejects.toThrow("Cleanup reports response did not contain data");
  });

  it.each([
    ["ejectAccount", "eject"],
    ["retryCleanup", "retryCleanup"],
    ["quarantineAccount", "quarantine"],
    ["skipCooldown", "skipCooldown"],
  ] as const)(
    "%s issues a signed POST to the custom-action path",
    async (method, segment) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ message: "ok" }));
      await createSmithyClient()[method]("000000000000");

      const request = fetchedRequest();
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        `http://localhost/api/accounts/000000000000/${segment}`,
      );
      expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
    },
  );
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, expectTypeOf, it, vi } from "vitest";

import type { TokenSeriesRow as WireTokenSeriesRow } from "@amzn/innovation-sandbox-api-client";
import {
  createLeaseClient,
  reinjectNullMembers,
  SmithyLeaseClient,
} from "@amzn/innovation-sandbox-frontend/domains/leases/smithy-client";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { ConfigData } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createMockLeaseEndBreachCostHistory } from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";
import type { TokenSeriesRow } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { isMonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

import {
  MOCK_ID_TOKEN,
  mockCognitoCredentials,
} from "../../utils/cognitoFixtures";

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

const developerPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  availability: "AVAILABLE",
} as const;

// A lease as the server projects it on a read path: raw ISO string timestamps
// (no Date<->ISO conversion) and the handler-injected `leaseId`. The adapter
// must pass this through untouched.
const leaseWithId = {
  leaseId: "bGVhc2UtMQ",
  userEmail: "owner@example.com",
  uuid: "11111111-1111-4111-8111-111111111111",
  status: "Active",
  originalLeaseTemplateUuid: "22222222-2222-4222-8222-222222222222",
  originalLeaseTemplateName: "Basic",
  maxSpend: 50,
  awsAccountId: "111122223333",
  approvedBy: "approver@example.com",
  startDate: "2026-08-01T12:00:00.000Z",
  expirationDate: "2026-09-01T00:00:00.000Z",
  lastCheckedDate: "2026-08-03T09:00:00.000Z",
  totalCostAccrued: 10,
  sandboxSpacesEnabled: false,
  rateLimits: [
    { basis: "HOURLY", rate: 10, action: "ALERT" },
    { basis: "DAILY", rate: 200, action: "FREEZE_ACCOUNT" },
  ],
  selectableModels: [],
  defaultPermissionSet: developerPermissionSet,
  allowedPermissionSets: [developerPermissionSet],
  meta: {
    createdTime: "2026-08-01T12:00:00.000Z",
    lastEditTime: "2026-08-02T13:30:00.000Z",
  },
};

const sharedLease = {
  ...leaseWithId,
  accessType: "direct",
};

// List responses omit `selectableModels`; the mapper defaults it to `[]`.
const { selectableModels: _leaseListOmitted, ...leaseListItem } = leaseWithId;
const { selectableModels: _sharedListOmitted, ...sharedLeaseListItem } =
  sharedLease;

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

function createSmithyClient(): SmithyLeaseClient {
  return new SmithyLeaseClient(createLeaseClient(config));
}

describe("reinjectNullMembers", () => {
  it("adds cleared members as null to an empty or undefined body", () => {
    expect(reinjectNullMembers(undefined, ["maxSpend"])).toBe(
      '{"maxSpend":null}',
    );
    expect(reinjectNullMembers("", ["maxSpend"])).toBe('{"maxSpend":null}');
  });

  it("re-adds cleared members alongside the serializer's present members", () => {
    const body = reinjectNullMembers('{"allowOwnerToShareLease":false}', [
      "maxSpend",
      "expirationDate",
    ]);
    expect(JSON.parse(body)).toEqual({
      allowOwnerToShareLease: false,
      maxSpend: null,
      expirationDate: null,
    });
  });

  it("decodes a Uint8Array body (the @aws-sdk/core codec-v2 form) before re-adding", () => {
    const bytes = new TextEncoder().encode('{"allowOwnerToShareLease":false}');
    const body = reinjectNullMembers(bytes, ["maxSpend", "expirationDate"]);
    expect(JSON.parse(body)).toEqual({
      allowOwnerToShareLease: false,
      maxSpend: null,
      expirationDate: null,
    });
  });

  it("throws on an unsupported body type instead of dropping serialized members", () => {
    expect(() =>
      reinjectNullMembers({ notABody: true } as unknown, ["maxSpend"]),
    ).toThrow(/unsupported request body type/);
  });

  it("leaves the body untouched when nothing was cleared", () => {
    expect(reinjectNullMembers('{"maxSpend":5}', [])).toBe('{"maxSpend":5}');
  });
});

describe("generated Lease client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue({
      ...mockCognitoCredentials,
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    });
    globalThis.fetch = vi.fn().mockImplementation(() =>
      Promise.resolve(
        successResponse({
          result: [leaseListItem],
          nextPageIdentifier: null,
        }),
      ),
    );
  });

  it("signs the API Gateway stage and lists leases through same-origin CloudFront", async () => {
    const page = await createSmithyClient().listLeases();
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost/api/leases");
    expect(request.headers.get(IDENTITY_HEADER)).toBe(MOCK_ID_TOKEN);
    expect(signedHeaders(request)).toEqual(
      expect.arrayContaining(["host", IDENTITY_HEADER]),
    );
    expect(page).toEqual({ result: [leaseWithId], nextPageIdentifier: null });
  });

  it("keeps lease timestamps as raw strings (no Date<->ISO conversion)", async () => {
    const page = await createSmithyClient().listLeases();
    const lease = page.result[0]!;
    expect(isMonitoredLease(lease)).toBe(true);
    if (!isMonitoredLease(lease)) {
      throw new Error("Expected a monitored lease");
    }
    expect(lease.startDate).toBe("2026-08-01T12:00:00.000Z");
    expect(lease.meta?.createdTime).toBe("2026-08-01T12:00:00.000Z");
    expect(lease.leaseId).toBe("bGVhc2UtMQ");
  });

  it("preserves backend-hydrated lease permission-set references", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        ...leaseWithId,
        defaultPermissionSet: developerPermissionSet,
        allowedPermissionSets: [developerPermissionSet],
      }),
    );

    const lease = await createSmithyClient().getLease("bGVhc2UtMQ");

    expect(lease.defaultPermissionSet).toEqual(developerPermissionSet);
    expect(lease.allowedPermissionSets).toEqual([developerPermissionSet]);
    expect(lease).not.toHaveProperty("defaultPermissionSetArn");
  });

  it("filters malformed leases without dropping valid list entries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [{ ...leaseListItem, uuid: "not-a-uuid" }, leaseListItem],
        nextPageIdentifier: null,
      }),
    );

    await expect(createSmithyClient().listLeases()).resolves.toEqual({
      result: [leaseWithId],
      nextPageIdentifier: null,
    });
  });

  it("forwards the userEmail filter and URL-encodes the opaque page token", async () => {
    // pageIdentifier is base64 of a DynamoDB key, so it can contain +, /, =. The
    // generated client must percent-encode it (round-tripping through URL
    // decoding proves the value was encoded, not sent raw).
    const token = "a+b/c==";
    await createSmithyClient().listLeases(token, "user@example.com");

    const url = new URL(fetchedRequest().url);
    expect(url.pathname).toBe("/api/leases");
    expect(url.searchParams.get("pageIdentifier")).toBe(token);
    expect(url.searchParams.get("userEmail")).toBe("user@example.com");
    expect(url.search).not.toContain("a+b/c==");
  });

  it("throws on a success envelope with no data (never returns an empty page)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(createSmithyClient().listLeases()).rejects.toThrow(
      "Leases list response did not contain data",
    );
  });

  it("throws when the required result list is absent (does not coalesce to [])", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(createSmithyClient().listLeases()).rejects.toThrow(
      "Leases list response did not contain data",
    );
  });

  it("gets a lease by id through a signed GET and returns its data with the selectable models", async () => {
    const selectableModels = [
      {
        modelId: "global.anthropic.claude-sonnet-4-6",
        displayName: "Claude Sonnet 4.6",
        provider: "Anthropic",
      },
    ];
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ ...leaseWithId, selectableModels }));
    const result = await createSmithyClient().getLease("bGVhc2UtMQ");
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost/api/leases/bGVhc2UtMQ");
    expect(result).toEqual({ ...leaseWithId, selectableModels });
    expect(result.rateLimits).toEqual([
      { basis: "HOURLY", rate: 10, action: "ALERT" },
      { basis: "DAILY", rate: 200, action: "FREEZE_ACCOUNT" },
    ]);
  });

  it("returns an empty selectable-model list when the lease read omits the field", async () => {
    const { selectableModels: _omitted, ...leaseWithoutModels } = leaseWithId;
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(leaseWithoutModels));
    const result = await createSmithyClient().getLease("bGVhc2UtMQ");
    expect(result.selectableModels).toEqual([]);
  });

  it("rejects a malformed lease returned by the single-item read", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ ...leaseWithId, uuid: "bad" }));

    await expect(createSmithyClient().getLease("bGVhc2UtMQ")).rejects.toThrow();
  });

  it("propagates a 404 for a missing lease as ApiError, like pre-Smithy", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message: "Lease not found." }] },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createSmithyClient().getLease("bGVhc2UtMQ"),
    ).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("requests a new lease through a signed POST carrying the request body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(leaseWithId, 201));
    await createSmithyClient().requestLease({
      leaseTemplateUuid: "tmpl-1",
      comments: "please",
      assignments: [{ principalId: "p1", principalType: "GROUP" }],
    });

    const request = fetchedRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/leases");
    await expect(request.clone().json()).resolves.toEqual({
      leaseTemplateUuid: "tmpl-1",
      comments: "please",
      assignments: [{ principalId: "p1", principalType: "GROUP" }],
    });
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
  });

  it("normalizes a headerless 429 rate-limit response into an ApiError preserving data.retryAt", async () => {
    // The rate-limit 429 is an UNMODELED JSend error carrying `data.retryAt` (no
    // `x-amzn-errortype` header). The adapter must surface it via
    // `normalizeSmithyError` as an ApiError with statusCode 429, the server
    // message, and the `retryAt` preserved on `data` for the UI's retry countdown.
    const retryAt = "2026-08-23T12:34:56.000Z";
    const message =
      "You have reached the maximum number of lease requests allowed within the rolling window (10). Try again at 2026-08-23T12:34:56.000Z.";
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        // JSend `status` for a 4xx is `fail` (the production shape); `error` is
        // reserved for 5xx. `normalizeSmithyError` keys off the HTTP status, not
        // this field, but the fixture should match what the server actually sends.
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message }], retryAt },
        }),
        { status: 429, headers: { "content-type": "application/json" } },
      ),
    );

    const error = await createSmithyClient()
      .requestLease({ leaseTemplateUuid: "tmpl-1" })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(429);
    expect(error.message).toBe(message);
    expect(error.data?.retryAt).toBe(retryAt);
  });

  // `updateLease` goes through the generated `UpdateLeaseCommand` like every other
  // operation. Present members serialize normally; explicit-`null` clears (which
  // the restJson1 serializer drops) are re-injected into the serialized body by a
  // build-step middleware before signing, so the pre-Smithy wire is reproduced.
  it("updateLease sends the present members through a signed PATCH", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(leaseWithId));

    await createSmithyClient().updateLease({
      leaseId: "bGVhc2UtMQ",
      maxSpend: 100,
      allowOwnerToShareLease: true,
    });

    const request = fetchedRequest();
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe("http://localhost/api/leases/bGVhc2UtMQ");
    await expect(request.clone().json()).resolves.toEqual({
      maxSpend: 100,
      allowOwnerToShareLease: true,
    });
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
  });

  it("serializes hydrated permission-set references as generated PATCH ARN fields", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(leaseWithId));

    await createSmithyClient().updateLease({
      leaseId: "bGVhc2UtMQ",
      defaultPermissionSet: developerPermissionSet,
      allowedPermissionSets: [developerPermissionSet],
    });

    await expect(fetchedRequest().clone().json()).resolves.toEqual({
      defaultPermissionSetArn: developerPermissionSet.permissionSetArn,
      allowedPermissionSetArns: [developerPermissionSet.permissionSetArn],
    });
  });

  it("re-injects explicit-null clears into the PATCH body (null-to-clear reaches the wire)", async () => {
    // The edit forms send `null` to CLEAR maxSpend/expirationDate/costReportGroup;
    // the server reads a body `null` as clear vs absence as leave-unchanged. The
    // restJson1 serializer omits null members, so the build-step middleware re-adds
    // them to the serialized body before signing — the signature covers the
    // re-injected body and the clear signal reaches the server byte-faithfully.
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(leaseWithId));

    await createSmithyClient().updateLease({
      leaseId: "bGVhc2UtMQ",
      maxSpend: null,
      expirationDate: null,
      costReportGroup: null,
      allowOwnerToShareLease: false,
    });

    const request = fetchedRequest();
    expect(request.method).toBe("PATCH");
    expect(request.url).toBe("http://localhost/api/leases/bGVhc2UtMQ");
    await expect(request.clone().json()).resolves.toEqual({
      maxSpend: null,
      expirationDate: null,
      costReportGroup: null,
      allowOwnerToShareLease: false,
    });
  });

  it("reviews a lease with the mapped Approve/Deny action", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ message: "ok" }));
    await createSmithyClient().reviewLease("bGVhc2UtMQ", true);

    const request = fetchedRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/leases/bGVhc2UtMQ/review");
    await expect(request.clone().json()).resolves.toEqual({
      action: "Approve",
    });
  });

  it("maps approve=false to the Deny action", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ message: "ok" }));
    await createSmithyClient().reviewLease("bGVhc2UtMQ", false);
    await expect(fetchedRequest().clone().json()).resolves.toEqual({
      action: "Deny",
    });
  });

  it.each([
    ["terminateLease", "terminate"],
    ["freezeLease", "freeze"],
    ["unfreezeLease", "unfreeze"],
  ] as const)(
    "%s issues a signed POST to the custom-action path",
    async (method, segment) => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ message: "ok" }));
      await createSmithyClient()[method]("bGVhc2UtMQ");

      const request = fetchedRequest();
      expect(request.method).toBe("POST");
      expect(request.url).toBe(
        `http://localhost/api/leases/bGVhc2UtMQ/${segment}`,
      );
      expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
    },
  );

  it("gets lease assignments through a signed GET", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        assignments: [
          {
            principalId: "p1",
            principalType: "USER",
            displayName: "Alice",
            isOwner: true,
            isDesired: true,
            syncStatus: "active",
            permissionSet: developerPermissionSet,
          },
        ],
        operationInProgress: undefined,
      }),
    );
    const result = await createSmithyClient().getAssignments("bGVhc2UtMQ");

    expect(fetchedRequest().url).toBe(
      "http://localhost/api/leases/bGVhc2UtMQ/assignments",
    );
    expect(result.assignments).toHaveLength(1);
    expect(result.assignments[0]!.displayName).toBe("Alice");
  });

  it("accepts unconstrained assignment metadata strings from the Smithy contract", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        assignments: [
          {
            principalId: "p1",
            principalType: "USER",
            displayName: "Legacy user",
            assigneeEmail: "legacy-directory-value",
            addedBy: "legacy-actor",
            addedDate: "legacy-timestamp",
            isOwner: false,
            isDesired: true,
            syncStatus: "active",
            permissionSet: developerPermissionSet,
          },
        ],
      }),
    );

    await expect(
      createSmithyClient().getAssignments("bGVhc2UtMQ"),
    ).resolves.toMatchObject({
      assignments: [
        {
          assigneeEmail: "legacy-directory-value",
          addedBy: "legacy-actor",
          addedDate: "legacy-timestamp",
        },
      ],
    });
  });

  it("throws when the assignments response omits data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    await expect(
      createSmithyClient().getAssignments("bGVhc2UtMQ"),
    ).rejects.toThrow("Lease assignments response did not contain data");
  });

  it("updates assignments through a signed PUT and returns the desired count", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ desiredCount: 3 }, 202));
    const result = await createSmithyClient().updateAssignments("bGVhc2UtMQ", [
      {
        principalId: "p1",
        principalType: "USER",
        permissionSetArn: developerPermissionSet.permissionSetArn,
      },
      { principalId: "g1", principalType: "GROUP" },
    ]);

    const request = fetchedRequest();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      "http://localhost/api/leases/bGVhc2UtMQ/assignments",
    );
    await expect(request.clone().json()).resolves.toEqual({
      assignments: [
        {
          principalId: "p1",
          principalType: "USER",
          permissionSetArn: developerPermissionSet.permissionSetArn,
        },
        { principalId: "g1", principalType: "GROUP" },
      ],
    });
    expect(result).toEqual({ desiredCount: 3 });
  });

  it("lists shared leases with userId/accessType/maxResults in the query", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [sharedLeaseListItem],
        nextPageIdentifier: null,
      }),
    );
    const page = await createSmithyClient().listSharedLeases(
      "user-id-1",
      "direct",
      100,
    );

    const url = new URL(fetchedRequest().url);
    expect(url.pathname).toBe("/api/leases/shared");
    expect(url.searchParams.get("userId")).toBe("user-id-1");
    expect(url.searchParams.get("accessType")).toBe("direct");
    expect(url.searchParams.get("maxResults")).toBe("100");
    expect(page.result).toHaveLength(1);
    expect(page.nextPageIdentifier).toBeNull();
  });

  it("forwards the page identifier for a group-access query", async () => {
    // `accessType` is narrowed to the modeled `direct|group`: the adapter no
    // longer casts a wider frontend value onto the command input, and the server
    // only ever receives these two. Assert the cursor still round-trips.
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        successResponse({ result: [], nextPageIdentifier: null }),
      );
    await createSmithyClient().listSharedLeases(
      "user-id-1",
      "group",
      100,
      "cursor-2",
    );

    const url = new URL(fetchedRequest().url);
    expect(url.searchParams.get("accessType")).toBe("group");
    expect(url.searchParams.get("pageIdentifier")).toBe("cursor-2");
  });

  it("throws when the shared leases response omits the required result list", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(
      createSmithyClient().listSharedLeases("user-id-1", "direct", 100),
    ).rejects.toThrow("Shared leases response did not contain data");
  });

  it("normalizes modeled JSend field errors into ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ field: "userEmail", message: "is required" }] },
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
      .listLeases()
      .catch((cause) => cause);
    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "userEmail: is required",
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
            data: { errors: [{ message: "Lease is already frozen." }] },
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

    await expect(client.freezeLease("bGVhc2UtMQ")).rejects.toMatchObject({
      message: "Lease is already frozen.",
      statusCode: 409,
    });
    await expect(client.listLeases()).rejects.toMatchObject({
      message: "HTTP error 403",
      statusCode: 403,
    });
  });

  it("fails before fetch when the human session has no credentials", async () => {
    mockGetCredentials.mockResolvedValue(null);
    await expect(createSmithyClient().listLeases()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails before fetch when the human session has no ID token", async () => {
    mockGetIdToken.mockResolvedValue(null);
    await expect(createSmithyClient().listLeases()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  describe("getLeaseCostHistory", () => {
    // The mapper checks each member, and which are optional, against both types;
    // this also keeps their types equal. Checked by tsc in the build, not by vitest.
    it("types token rows as the API model does", () => {
      type Wire = {
        [K in keyof WireTokenSeriesRow]: NonNullable<WireTokenSeriesRow[K]>;
      };
      expectTypeOf<TokenSeriesRow>().toEqualTypeOf<Wire>();
    });

    const costHistoryData = {
      result: [
        { timestamp: "2026-08-11T08:00:00.000Z", billedCostAccrued: 60 },
      ],
    };

    it("sends the page window as maxResults and pageIdentifier query params", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse(costHistoryData));

      const result = await createSmithyClient().getLeaseCostHistory(
        "bGVhc2UtMQ",
        { maxResults: 25, pageIdentifier: "P2" },
      );
      const url = new URL(fetchedRequest().url);

      expect(url.pathname).toBe("/api/leases/bGVhc2UtMQ/costHistory");
      expect(url.searchParams.get("maxResults")).toBe("25");
      expect(url.searchParams.get("pageIdentifier")).toBe("P2");
      expect(url.searchParams.has("type")).toBe(false);
      expect(result).toEqual(costHistoryData);
    });

    it("sends no query params when no page window is given", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse(costHistoryData));

      await createSmithyClient().getLeaseCostHistory("bGVhc2UtMQ", {});
      const url = new URL(fetchedRequest().url);

      expect([...url.searchParams.keys()]).toEqual([]);
    });

    it("sends a one-sided range as the single bound it was given", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse(costHistoryData));

      await createSmithyClient().getLeaseCostHistory("bGVhc2UtMQ", {
        afterTimestamp: "2026-08-10T00:00:00.000Z",
      });
      const url = new URL(fetchedRequest().url);

      // The API fills the missing side, so a relative range keeps including
      // whatever lands next rather than freezing its upper edge here.
      expect(url.searchParams.get("afterTimestamp")).toBe(
        "2026-08-10T00:00:00.000Z",
      );
      expect(url.searchParams.has("beforeTimestamp")).toBe(false);
    });

    it("maps each reading, leaving an absent projection and breakdown undefined", async () => {
      const page = {
        result: [
          {
            timestamp: "2026-08-11T08:00:00.000Z",
            billedCostAccrued: 60,
            predictedCostAtRefresh: 46,
            serviceBreakdown: { "Amazon Bedrock": 52.1, "Amazon S3": 7.9 },
          },
          // Written before a rate existed, on a lease with no breakdown.
          { timestamp: "2026-08-10T08:00:00.000Z", billedCostAccrued: 8 },
        ],
        nextPageIdentifier: "P2",
      };
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse(page));

      const result = await createSmithyClient().getLeaseCostHistory(
        "bGVhc2UtMQ",
        {},
      );

      expect(result).toEqual(page);
      expect(result.result[1]!.predictedCostAtRefresh).toBeUndefined();
      expect(result.result[1]!.serviceBreakdown).toBeUndefined();
    });

    it("throws when the cost history response omits data", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "success" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        createSmithyClient().getLeaseCostHistory("bGVhc2UtMQ", {}),
      ).rejects.toThrow("Lease cost history response did not contain data");
    });

    it("throws when the readings are absent (does not hand a panel undefined)", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ nextPageIdentifier: "P2" }));

      await expect(
        createSmithyClient().getLeaseCostHistory("bGVhc2UtMQ", {}),
      ).rejects.toThrow("Lease cost history response did not contain data");
    });
  });

  describe("getLeaseCostSummary", () => {
    const current = {
      billedCostAccrued: 60,
      predictedCost: 60,
      latestPeriodStart: "2026-08-11",
      lastReportedAt: "2026-08-11T08:00:00.000Z",
      lastCheckedAt: "2026-08-11T11:00:00.000Z",
      services: [],
    };

    it("reads the lease's summary with no query params", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ current }));

      const result =
        await createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ");
      const url = new URL(fetchedRequest().url);

      expect(url.pathname).toBe("/api/leases/bGVhc2UtMQ/costSummary");
      expect([...url.searchParams.keys()]).toEqual([]);
      expect(result).toEqual({ current });
    });

    it("maps every figure and service, leaving a service's absent change undefined", async () => {
      const figures = {
        ...current,
        hourlyRate: 3.5,
        dailyRate: 52,
        hourlyRateWindowHours: 8,
        dailyRateWindowHours: 24,
        rateSource: "HOURLY",
        hoursToBudgetExhaustion: 11.4,
        services: [
          {
            service: "Amazon Bedrock",
            amount: 52.1,
            shareOfBilledCost: 0.87,
            changePercent: 112,
          },
          // First seen in the newest reading, so no change to report.
          { service: "Amazon S3", amount: 7.9, shareOfBilledCost: 0.13 },
        ],
      };
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ current: figures }));

      const result =
        await createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ");

      expect(result).toEqual({ current: figures });
      expect(result.current!.services[1]!.changePercent).toBeUndefined();
    });

    it("leaves the rates undefined in a first interval, which has none", async () => {
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ current }));

      const result =
        await createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ");

      expect(result.current!.hourlyRate).toBeUndefined();
      expect(result.current!.rateSource).toBeUndefined();
      expect(result.current!.services).toEqual([]);
    });

    it("reads an absent services list as empty", async () => {
      // JSON drops the undefined member, so the response carries no services.
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          successResponse({ current: { ...current, services: undefined } }),
        );

      const result =
        await createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ");

      expect(result.current!.services).toEqual([]);
    });

    it("passes through an absent current, which the contract permits", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse({}));

      const result =
        await createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ");

      expect(result.current).toBeUndefined();
    });

    it("throws when the summary response omits data", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response(JSON.stringify({ status: "success" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        }),
      );
      await expect(
        createSmithyClient().getLeaseCostSummary("bGVhc2UtMQ"),
      ).rejects.toThrow("Lease cost summary response did not contain data");
    });
  });

  describe("getLeaseBedrockTokenHistory", () => {
    it("reads one page of token rows, sending only the bounds and page size given", async () => {
      const result: TokenSeriesRow[] = [
        {
          timestamp: "2026-08-11T08:00:00.000Z",
          region: "us-east-1",
          modelId: "amazon.nova-pro-v1:0",
          input: 4000,
          output: 800,
          cacheRead: 0,
          cacheWrite: 0,
          monitoredBedrockTokenCost: 1.5,
        },
      ];
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(
          successResponse({ result, nextPageIdentifier: "P2" }),
        );

      const page = await createSmithyClient().getLeaseBedrockTokenHistory(
        "bGVhc2UtMQ",
        { beforeTimestamp: "2026-08-11T00:00:00.000Z", maxResults: 1 },
      );
      const url = new URL(fetchedRequest().url);

      expect(url.pathname).toBe("/api/leases/bGVhc2UtMQ/bedrockTokenHistory");
      expect(url.searchParams.get("beforeTimestamp")).toBe(
        "2026-08-11T00:00:00.000Z",
      );
      expect(url.searchParams.get("maxResults")).toBe("1");
      expect(url.searchParams.has("afterTimestamp")).toBe(false);
      expect(url.searchParams.has("pageIdentifier")).toBe(false);
      expect(page).toEqual({ result, nextPageIdentifier: "P2" });
    });

    it("maps each row and its counts, leaving an unpriced row's cost undefined", async () => {
      const result: TokenSeriesRow[] = [
        {
          timestamp: "2026-08-11T08:00:00.000Z",
          region: "us-east-1",
          modelId: "amazon.nova-pro-v1:0",
          input: 4000,
          output: 800,
          cacheRead: 120,
          cacheWrite: 60,
          monitoredBedrockTokenCost: 1.5,
        },
        // An older row, saved unpriced.
        {
          timestamp: "2026-08-11T07:00:00.000Z",
          region: "us-east-1",
          modelId: "unattributed",
          input: 1000,
          output: 200,
          cacheRead: 0,
          cacheWrite: 0,
        },
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse({ result }));

      const page = await createSmithyClient().getLeaseBedrockTokenHistory(
        "bGVhc2UtMQ",
        {},
      );

      expect(page).toEqual({ result });
      expect(page.result[1]!.monitoredBedrockTokenCost).toBeUndefined();
      expect(page.nextPageIdentifier).toBeUndefined();
    });

    it("throws when the token rows are absent", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse({}));

      await expect(
        createSmithyClient().getLeaseBedrockTokenHistory("bGVhc2UtMQ", {}),
      ).rejects.toThrow(
        "Lease Bedrock token history response did not contain data",
      );
    });
  });

  describe("getLeaseBreachHistory", () => {
    it("passes a page's duration and expiry breaches through as the API returns them", async () => {
      const { breaches } = createMockLeaseEndBreachCostHistory().data;
      globalThis.fetch = vi
        .fn()
        .mockResolvedValue(successResponse({ result: breaches }));

      const page = await createSmithyClient().getLeaseBreachHistory(
        "bGVhc2UtMQ",
        { maxResults: 100 },
      );

      expect(new URL(fetchedRequest().url).pathname).toBe(
        "/api/leases/bGVhc2UtMQ/breachHistory",
      );
      expect(page.result).toEqual(breaches);
    });

    it("maps each breach and its insight, leaving an absent member undefined", async () => {
      const result = [
        {
          timestamp: "2026-08-11T11:00:00.000Z",
          triggeredBy: "REPORTED",
          action: "FREEZE_ACCOUNT",
          thresholdDollars: 90,
          billedCostAtFire: 60,
          predictedCostAtFire: 70.5,
          rateAtFire: 3.5,
          rateSourceAtFire: "HOURLY",
          evaluatedBy: "TOKEN_POLL",
          evaluatedSpendAtFire: 91,
          monitoredBedrockTokenCostAtFire: 25,
          insight: {
            kind: "COMPOSITION",
            service: "Amazon Bedrock",
            amount: 52.1,
            shareOfComparedSpend: 0.87,
          },
        },
        {
          timestamp: "2026-08-11T00:00:00.000Z",
          triggeredBy: "RATE",
          action: "ALERT",
          thresholdRate: 12,
          thresholdRateBasis: "HOURLY",
          billedCostAtFire: 32,
          rateAtFire: 14,
          rateSourceAtFire: "HOURLY",
          evaluatedBy: "LEASE_MONITORING",
        },
      ];
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse({ result }));

      const page = await createSmithyClient().getLeaseBreachHistory(
        "bGVhc2UtMQ",
        {},
      );

      expect(page).toEqual({ result });
      expect(page.result[0]!.insight!.changePercent).toBeUndefined();
      expect(page.result[1]!.insight).toBeUndefined();
      expect(page.result[1]!.thresholdDollars).toBeUndefined();
    });

    it("throws when the breaches are absent", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse({}));

      await expect(
        createSmithyClient().getLeaseBreachHistory("bGVhc2UtMQ", {}),
      ).rejects.toThrow("Lease breach history response did not contain data");
    });
  });
});

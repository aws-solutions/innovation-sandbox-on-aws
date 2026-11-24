// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createBlueprintClient,
  SmithyBlueprintClient,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/smithy-client";
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

// A blueprint as the server projects it on the wire: the modeled members only
// (internal PK/SK/itemType dropped by the serializer), raw ISO string timestamps.
const blueprint = {
  blueprintId: "650e8400-e29b-41d4-a716-446655440001",
  name: "TestBlueprint",
  tags: {},
  createdBy: "admin@example.com",
  deploymentTimeoutMinutes: 60,
  regionConcurrencyType: "SEQUENTIAL",
  totalHealthMetrics: { totalDeploymentCount: 0, totalSuccessfulCount: 0 },
  meta: {
    schemaVersion: 1,
    createdTime: "2026-08-01T12:00:00.000Z",
    lastEditTime: "2026-08-02T13:30:00.000Z",
  },
};

const composite = { blueprint, stackSets: [], recentDeployments: [] };

const stackSet = {
  stackSetName: "self-managed-stackset",
  stackSetId: "self-managed-stackset:ss-123",
  description: "Test StackSet",
  status: "ACTIVE",
  permissionModel: "SELF_MANAGED",
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

function createSmithyClient(): SmithyBlueprintClient {
  return new SmithyBlueprintClient(createBlueprintClient(config));
}

describe("generated Blueprint client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue({
      ...mockCognitoCredentials,
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    });
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        successResponse({ blueprints: [composite], nextPageIdentifier: null }),
      );
  });

  it("lists blueprints through a signed GET, same-origin CloudFront", async () => {
    const page = await createSmithyClient().getBlueprints();
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe("http://localhost/api/blueprints");
    expect(request.headers.get(IDENTITY_HEADER)).toBe(MOCK_ID_TOKEN);
    expect(signedHeaders(request)).toEqual(
      expect.arrayContaining(["host", IDENTITY_HEADER]),
    );
    expect(page).toEqual({
      blueprints: [composite],
      nextPageIdentifier: undefined,
    });
  });

  it("returns valid blueprints while filtering malformed blueprints", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        blueprints: [
          composite,
          { ...composite, blueprint: { ...blueprint, createdBy: "invalid" } },
        ],
        nextPageIdentifier: null,
      }),
    );

    await expect(createSmithyClient().getBlueprints()).resolves.toEqual({
      blueprints: [composite],
      nextPageIdentifier: undefined,
    });
  });

  it("filters a blueprint missing required health metrics", async () => {
    const { totalHealthMetrics: _omitted, ...blueprintWithoutHealthMetrics } =
      blueprint;
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        blueprints: [
          composite,
          {
            ...composite,
            blueprint: blueprintWithoutHealthMetrics,
          },
        ],
        nextPageIdentifier: null,
      }),
    );

    await expect(createSmithyClient().getBlueprints()).resolves.toEqual({
      blueprints: [composite],
      nextPageIdentifier: undefined,
    });
  });

  it("throws when the list response omits the required blueprints member", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));
    await expect(createSmithyClient().getBlueprints()).rejects.toThrow(
      "Blueprints list response did not contain data",
    );
  });

  it("gets a blueprint by id and returns the composite untouched", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(composite));
    const result = await createSmithyClient().getBlueprintById(
      blueprint.blueprintId,
    );
    const request = fetchedRequest();

    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      `http://localhost/api/blueprints/${blueprint.blueprintId}`,
    );
    expect(result).toEqual(composite);
  });

  it("propagates a 404 for a missing blueprint as ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message: "Blueprint not found" }] },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    await expect(
      createSmithyClient().getBlueprintById(blueprint.blueprintId),
    ).rejects.toMatchObject({ statusCode: 404 });
  });

  it("registers a blueprint through a signed POST carrying every request member", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(blueprint, 201));
    const result = await createSmithyClient().registerBlueprint({
      name: "TestBlueprint",
      stackSetId: "self-managed-stackset:ss-123",
      regions: ["us-east-1", "eu-west-1"],
      tags: { Team: "sandbox" },
      deploymentTimeoutMinutes: 60,
      regionConcurrencyType: "PARALLEL",
      maxConcurrentPercentage: 50,
      failureTolerancePercentage: 20,
      concurrencyMode: "SOFT_FAILURE_TOLERANCE",
    });

    const request = fetchedRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/blueprints");
    // Every supported member must reach the wire — the adapter maps them by hand,
    // so an omitted field would still compile but silently never be sent.
    await expect(request.clone().json()).resolves.toEqual({
      name: "TestBlueprint",
      stackSetId: "self-managed-stackset:ss-123",
      regions: ["us-east-1", "eu-west-1"],
      tags: { Team: "sandbox" },
      deploymentTimeoutMinutes: 60,
      regionConcurrencyType: "PARALLEL",
      maxConcurrentPercentage: 50,
      failureTolerancePercentage: 20,
      concurrencyMode: "SOFT_FAILURE_TOLERANCE",
    });
    expect(result).toEqual(blueprint);
  });

  it("omits unset optional members from the register body", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(blueprint, 201));
    await createSmithyClient().registerBlueprint({
      name: "TestBlueprint",
      stackSetId: "self-managed-stackset:ss-123",
      regions: ["us-east-1"],
    });

    // With only the required members set, the wire body must contain exactly
    // those — an unset optional must not be injected. Together with the
    // every-member test above this brackets the hand-mapped adapter: present
    // fields reach the wire, omitted ones don't.
    await expect(fetchedRequest().clone().json()).resolves.toEqual({
      name: "TestBlueprint",
      stackSetId: "self-managed-stackset:ss-123",
      regions: ["us-east-1"],
    });
  });

  it("updates a blueprint through a signed PUT carrying every body member (incl. tags:{} to clear)", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(composite));
    const result = await createSmithyClient().updateBlueprint(
      blueprint.blueprintId,
      {
        name: "NewName",
        tags: {},
        deploymentTimeoutMinutes: 90,
        regionConcurrencyType: "SEQUENTIAL",
        maxConcurrentPercentage: 50,
        failureTolerancePercentage: 10,
        concurrencyMode: "SOFT_FAILURE_TOLERANCE",
      },
    );

    const request = fetchedRequest();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(
      `http://localhost/api/blueprints/${blueprint.blueprintId}`,
    );
    // Every body member reaches the wire; `tags: {}` (how the UI clears all tags)
    // must survive serialization, not be dropped as an empty map.
    await expect(request.clone().json()).resolves.toEqual({
      name: "NewName",
      tags: {},
      deploymentTimeoutMinutes: 90,
      regionConcurrencyType: "SEQUENTIAL",
      maxConcurrentPercentage: 50,
      failureTolerancePercentage: 10,
      concurrencyMode: "SOFT_FAILURE_TOLERANCE",
    });
    expect(result).toEqual(composite);
  });

  it("sends only the update fields provided — an omitted field is absent (unlike tags:{})", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(composite));
    await createSmithyClient().updateBlueprint(blueprint.blueprintId, {
      name: "NewName",
    });

    // The difference that matters for the UI: omitting `tags` leaves it OFF the
    // wire (clearing all tags requires an explicit `tags: {}`, proven above), and
    // no other optional is injected.
    await expect(fetchedRequest().clone().json()).resolves.toEqual({
      name: "NewName",
    });
  });

  it("reports malformed single-item responses with concise operation errors", async () => {
    const invalidBlueprint = { ...blueprint, createdBy: "not-an-email" };
    const invalidComposite = { ...composite, blueprint: invalidBlueprint };
    const cases: Array<{
      operation: string;
      response: unknown;
      invoke: (client: SmithyBlueprintClient) => Promise<unknown>;
    }> = [
      {
        operation: "GetBlueprint",
        response: invalidComposite,
        invoke: (client) => client.getBlueprintById(blueprint.blueprintId),
      },
      {
        operation: "RegisterBlueprint",
        response: invalidBlueprint,
        invoke: (client) =>
          client.registerBlueprint({
            name: "TestBlueprint",
            stackSetId: "self-managed-stackset:ss-123",
            regions: ["us-east-1"],
          }),
      },
      {
        operation: "UpdateBlueprint",
        response: invalidComposite,
        invoke: (client) =>
          client.updateBlueprint(blueprint.blueprintId, { name: "NewName" }),
      },
    ];

    for (const { operation, response, invoke } of cases) {
      globalThis.fetch = vi.fn().mockResolvedValue(successResponse(response));

      await expect(invoke(createSmithyClient())).rejects.toMatchObject({
        name: "InvalidBlueprintResponseError",
        message: "Invalid " + operation + " response",
        validationError: expect.anything(),
      });
    }
  });

  it("unregisters a blueprint through a signed DELETE", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        message: "Blueprint unregistered successfully",
        blueprintId: blueprint.blueprintId,
      }),
    );
    await createSmithyClient().unregisterBlueprint(blueprint.blueprintId);

    const request = fetchedRequest();
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      `http://localhost/api/blueprints/${blueprint.blueprintId}`,
    );
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
  });

  it("lists stacksets with pageIdentifier/maxResults in the query", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(
        successResponse({ result: [stackSet], nextPageIdentifier: "cursor-2" }),
      );
    const page = await createSmithyClient().listStackSets({
      pageIdentifier: "cursor-1",
      maxResults: 50,
    });

    const url = new URL(fetchedRequest().url);
    expect(url.pathname).toBe("/api/blueprints/stacksets");
    expect(url.searchParams.get("pageIdentifier")).toBe("cursor-1");
    expect(url.searchParams.get("maxResults")).toBe("50");
    expect(page.result).toEqual([stackSet]);
    expect(page.nextPageIdentifier).toBe("cursor-2");
  });

  it("returns valid StackSets while filtering malformed summaries", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [stackSet, { ...stackSet, status: "UNKNOWN" }],
      }),
    );

    await expect(createSmithyClient().listStackSets()).resolves.toEqual({
      result: [stackSet],
      nextPageIdentifier: undefined,
    });
  });

  it("normalizes a JSend 4xx error into ApiError with the server message", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: {
            errors: [
              { message: "StackSet uses unsupported permission model." },
            ],
          },
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
      .registerBlueprint({
        name: "TestBlueprint",
        stackSetId: "svc:ss-1",
        regions: ["us-east-1"],
      })
      .catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error.statusCode).toBe(400);
    expect(error.message).toBe("StackSet uses unsupported permission model.");
  });

  it("fails before fetch when the human session has no credentials", async () => {
    mockGetCredentials.mockResolvedValue(null);
    await expect(createSmithyClient().getBlueprints()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });
});

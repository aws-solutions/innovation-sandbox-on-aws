// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPermissionSetsClient,
  SmithyPermissionSetsClient,
} from "@amzn/innovation-sandbox-frontend/domains/permissionSets/smithy-client";
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

const permissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
  sessionDuration: "PT4H",
};

function successResponse(data: unknown): Response {
  return jsendResponse("success", data);
}

function jsendResponse(status: string, data: unknown): Response {
  return new Response(JSON.stringify({ status, data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchedRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as Request;
}

function createSmithyClient(): SmithyPermissionSetsClient {
  return new SmithyPermissionSetsClient(createPermissionSetsClient(config));
}

describe("generated Permission Sets client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue({
      ...mockCognitoCredentials,
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    });
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [permissionSet],
        nextPageIdentifier: "cursor-2",
      }),
    );
  });

  it("sends generated search and cursor parameters and maps the JSend page", async () => {
    const page = await createSmithyClient().listPermissionSets({
      q: "developer access",
      maxResults: 20,
      pageIdentifier: "cursor-1",
    });
    const request = fetchedRequest();
    const url = new URL(request.url);

    expect(request.method).toBe("GET");
    expect(url.origin + url.pathname).toBe(
      "http://localhost/api/permissionSets",
    );
    expect(url.searchParams.get("q")).toBe("developer access");
    expect(url.searchParams.get("maxResults")).toBe("20");
    expect(url.searchParams.get("pageIdentifier")).toBe("cursor-1");
    expect(request.headers.get(IDENTITY_HEADER)).toBe(MOCK_ID_TOKEN);
    expect(page).toEqual({
      result: [permissionSet],
      nextPageIdentifier: "cursor-2",
    });
  });

  it("omits unset optional query parameters", async () => {
    await createSmithyClient().listPermissionSets();
    const url = new URL(fetchedRequest().url);

    expect(url.search).toBe("");
  });

  it("propagates an abort signal to the generated request", async () => {
    const abortController = new AbortController();

    await createSmithyClient().listPermissionSets({}, abortController.signal);
    const request = fetchedRequest();
    abortController.abort();

    expect(request.signal.aborted).toBe(true);
  });

  it("rejects a successful response that omits the required page", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ nextPageIdentifier: null }));

    await expect(createSmithyClient().listPermissionSets()).rejects.toThrow(
      "Permission sets response did not contain data",
    );
  });

  it("rejects a 2xx response whose JSend status is not success", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(jsendResponse("error", { result: [permissionSet] }));

    await expect(createSmithyClient().listPermissionSets()).rejects.toThrow(
      "Permission sets response did not contain data",
    );
  });

  it("warns and omits summaries that violate the shared contract", async () => {
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [
          permissionSet,
          { ...permissionSet, permissionSetArn: null },
          {
            ...permissionSet,
            permissionSetId: "ps-1123456789abcdef",
          },
          { ...permissionSet, name: "" },
        ],
      }),
    );

    await expect(createSmithyClient().listPermissionSets()).resolves.toEqual({
      result: [permissionSet],
      nextPageIdentifier: undefined,
    });
    expect(warning).toHaveBeenCalledTimes(3);
  });
});

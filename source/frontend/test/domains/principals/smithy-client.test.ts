// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  createPrincipalClient,
  SmithyPrincipalClient,
} from "@amzn/innovation-sandbox-frontend/domains/principals/smithy-client";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import type { ConfigData } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  MOCK_ID_TOKEN,
  mockCognitoCredentials,
} from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";

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
  SandboxAgentWebSocketUrl: "wss://agent.example.com",
  SandboxAgentMcpGatewayUrl: "https://agent.example.com/mcp",
};

const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000001";

function successResponse(data: unknown): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function fetchedRequest(): Request {
  return vi.mocked(fetch).mock.calls[0]![0] as Request;
}

function createClient(): SmithyPrincipalClient {
  return new SmithyPrincipalClient(createPrincipalClient(config));
}

beforeEach(() => {
  mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
  mockGetCredentials.mockResolvedValue(mockCognitoCredentials);
});

describe("SmithyPrincipalClient", () => {
  it("omits an empty q and forwards type, limit, and exact", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ principals: [], totalMatches: 0 }));

    await createClient().searchPrincipals("users", "", 50, true);

    const url = new URL(fetchedRequest().url);
    expect(url.pathname).toBe("/api/principals/search");
    expect(url.searchParams.get("type")).toBe("users");
    expect(url.searchParams.get("limit")).toBe("50");
    expect(url.searchParams.get("exact")).toBe("true");
    expect(url.searchParams.has("q")).toBe(false);
  });

  it("maps the generated response and normalizes an absent displayName", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        principals: [{ principalId: PRINCIPAL_ID, principalType: "GROUP" }],
        totalMatches: 1,
      }),
    );

    const response = await createClient().searchPrincipals(
      "groups",
      "eng",
      20,
      false,
    );

    expect(new URL(fetchedRequest().url).searchParams.get("q")).toBe("eng");
    expect(response).toEqual({
      principals: [
        { principalId: PRINCIPAL_ID, principalType: "GROUP", displayName: "" },
      ],
      totalMatches: 1,
    });
  });

  it("accepts an email permitted by the unconstrained Smithy response", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        principals: [
          {
            principalId: PRINCIPAL_ID,
            principalType: "USER",
            email: "internal-address",
          },
        ],
        totalMatches: 1,
      }),
    );

    await expect(
      createClient().searchPrincipals("users", "internal-address", 20, true),
    ).resolves.toEqual({
      principals: [
        {
          principalId: PRINCIPAL_ID,
          principalType: "USER",
          displayName: "",
          email: "internal-address",
        },
      ],
      totalMatches: 1,
    });
  });

  it("ignores invalid principals while preserving valid search results", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        principals: [
          {
            principalId: PRINCIPAL_ID,
            principalType: "USER",
            displayName: "Valid user",
          },
          {
            principalId: "00000000-0000-4000-8000-000000000002",
            principalType: "SERVICE",
            displayName: "Invalid user",
          },
        ],
        totalMatches: 2,
      }),
    );

    await expect(
      createClient().searchPrincipals("users", "user", 20, false),
    ).resolves.toEqual({
      principals: [
        {
          principalId: PRINCIPAL_ID,
          principalType: "USER",
          displayName: "Valid user",
        },
      ],
      totalMatches: 2,
    });
  });

  it("throws when a success envelope omits required search data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse({}));

    await expect(
      createClient().searchPrincipals("all", "", 20, false),
    ).rejects.toThrow("Principal search response did not contain data");
  });

  it("normalizes JSend failures to ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message: "Principal search is not enabled." }] },
        }),
        {
          status: 403,
          headers: {
            "content-type": "application/json",
            "x-amzn-errortype": "AccessDeniedError",
          },
        },
      ),
    );

    const error = await createClient()
      .searchPrincipals("all", "", 20, false)
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({ statusCode: 403 });
  });
});

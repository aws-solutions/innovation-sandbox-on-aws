// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { HttpRequest } from "@smithy/core/protocols";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { LeaseTemplateView } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/model";
import {
  createLeaseTemplateClient,
  SmithyLeaseTemplateClient,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/smithy-client";
import { CreateLeaseTemplateRequest } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/types";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { ConfigData } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { CloudFrontFetchHttpHandler } from "@amzn/innovation-sandbox-frontend/helpers/isbApiClient";
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

const template: LeaseTemplateView = {
  uuid: "00000000-0000-4000-8000-000000000001",
  name: "Pilot template",
  requiresApproval: true,
  createdBy: "owner@example.com",
  visibility: "PRIVATE",
  allowOwnerToShareLease: false,
  predictiveBudgetEnabled: false,
  bedrockTokenMonitoringEnabled: false,
  sandboxSpacesEnabled: true,
  meta: {
    createdTime: "2026-08-01T12:00:00.000Z",
    lastEditTime: "2026-08-02T13:30:00.000Z",
    schemaVersion: 4,
  },
};

const completeTemplate: LeaseTemplateView = {
  ...template,
  description: "Generated pilot",
  maxSpend: 100,
  budgetThresholds: [
    { dollarsSpent: 50, action: "ALERT" },
    { dollarsSpent: 90, action: "ALERT", triggerOn: "PREDICTED" },
  ],
  leaseDurationInHours: 72.5,
  durationThresholds: [{ hoursRemaining: 12, action: "FREEZE_ACCOUNT" }],
  costReportGroup: "sandbox-team",
  blueprintId: "00000000-0000-4000-8000-000000000002",
  blueprintName: "Pilot blueprint",
  allowedModelIds: ["global.anthropic.claude-sonnet-4-6"],
  defaultModelId: "global.anthropic.claude-sonnet-4-6",
};

const defaultPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
  availability: "AVAILABLE" as const,
};

const additionalPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  name: "AuditorAccess",
  description: "Read-only sandbox access",
  availability: "AVAILABLE" as const,
};

const hydratedTemplate: LeaseTemplateView = {
  ...completeTemplate,
  defaultPermissionSet,
  allowedPermissionSets: [defaultPermissionSet, additionalPermissionSet],
};

const newTemplate: CreateLeaseTemplateRequest = {
  name: "Pilot template",
  requiresApproval: true,
  visibility: "PRIVATE",
  allowOwnerToShareLease: false,
  predictiveBudgetEnabled: false,
  bedrockTokenMonitoringEnabled: false,
  sandboxSpacesEnabled: true,
  defaultPermissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  allowedPermissionSetArns: [
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  ],
};

function successResponse(
  data: unknown = {
    result: [template],
    nextPageIdentifier: null,
  },
): Response {
  return new Response(JSON.stringify({ status: "success", data }), {
    status: 200,
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

function createSmithyClient(): SmithyLeaseTemplateClient {
  return new SmithyLeaseTemplateClient(createLeaseTemplateClient(config));
}

describe("generated Lease Template client", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetIdToken.mockResolvedValue(MOCK_ID_TOKEN);
    mockGetCredentials.mockResolvedValue({
      ...mockCognitoCredentials,
      expiration: new Date(Date.now() + 60 * 60 * 1000),
    });
    globalThis.fetch = vi
      .fn()
      .mockImplementation(() => Promise.resolve(successResponse()));
  });

  it("signs the API Gateway stage and fetches through same-origin CloudFront", async () => {
    const client = createSmithyClient();

    const page = await client.listLeaseTemplates();
    const request = fetchedRequest();

    expect(request.url).toBe("http://localhost/api/leaseTemplates");
    expect(request.headers.get(IDENTITY_HEADER)).toBe(MOCK_ID_TOKEN);
    expect(signedHeaders(request)).toEqual(
      expect.arrayContaining(["host", IDENTITY_HEADER]),
    );
    expect(page).toEqual({
      result: [template],
      nextPageIdentifier: null,
    });
  });

  it("canonicalizes null blueprint members to undefined", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [
          {
            ...template,
            blueprintId: null,
            blueprintName: null,
          },
        ],
      }),
    );
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).resolves.toEqual({
      result: [
        {
          ...template,
          blueprintId: undefined,
          blueprintName: undefined,
        },
      ],
      nextPageIdentifier: null,
    });
  });

  it("returns valid templates while filtering malformed templates", async () => {
    const { uuid: _, ...templateWithoutUuid } = template;
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [template, templateWithoutUuid],
      }),
    );
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).resolves.toEqual({
      result: [template],
      nextPageIdentifier: null,
    });
  });

  it("refreshes Cognito credentials that enter the expiry window", async () => {
    mockGetCredentials
      .mockResolvedValueOnce({
        ...mockCognitoCredentials,
        expiration: new Date(Date.now() + 1000),
      })
      .mockResolvedValueOnce({
        ...mockCognitoCredentials,
        accessKeyId: "refreshed-access-key",
        expiration: new Date(Date.now() + 60 * 60 * 1000),
      });
    const client = createSmithyClient();

    await client.listLeaseTemplates();
    await client.listLeaseTemplates();

    expect(mockGetCredentials).toHaveBeenCalledTimes(2);
    expect(fetchedRequest(1).headers.get("authorization")).toContain(
      "Credential=refreshed-access-key/",
    );
  });

  it("fails before fetch when the human session has no credentials", async () => {
    mockGetCredentials.mockResolvedValue(null);
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fails before fetch when the human session has no ID token", async () => {
    mockGetIdToken.mockResolvedValue(null);
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).rejects.toThrow(
      "No active session",
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("normalizes modeled JSend field errors into ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: {
            errors: [{ field: "name", message: "is required" }],
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
    const client = createSmithyClient();

    const error = await client.listLeaseTemplates().catch((cause) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      message: "name: is required",
      statusCode: 400,
      data: {
        errors: [{ field: "name", message: "is required" }],
      },
    });
  });

  it("normalizes message-only and generic HTTP failures like ApiProxy", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "fail",
            data: { errors: [{ message: "Template already exists" }] },
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
      client.createLeaseTemplate({
        ...newTemplate,
      }),
    ).rejects.toMatchObject({
      message: "Template already exists",
      statusCode: 409,
    });
    await expect(client.listLeaseTemplates()).rejects.toMatchObject({
      message: "HTTP error 403",
      statusCode: 403,
    });
  });

  it("throws on a success envelope that carries no data", async () => {
    // Per-member validation is gone, but the envelope check stays: pre-Smithy a
    // missing `data` made `response.result` throw — it never returned an empty
    // page. Restoring the throw keeps that contract.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success" }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).rejects.toThrow(
      "Lease Template list response did not contain data",
    );
  });

  it("throws when a success envelope omits the required result", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse({}));
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).rejects.toThrow(
      "Lease Template list response did not contain data",
    );
  });

  it("preserves the complete generated response at the domain boundary", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ result: [completeTemplate] }));
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).resolves.toEqual({
      result: [completeTemplate],
      nextPageIdentifier: null,
    });
  });

  it("preserves hydrated permission-set references at the domain boundary", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse({ result: [hydratedTemplate] }));
    const client = createSmithyClient();

    await expect(client.listLeaseTemplates()).resolves.toEqual({
      result: [hydratedTemplate],
      nextPageIdentifier: null,
    });
  });

  it("passes metadata through even when it omits the compatibility version", async () => {
    // The frontend metadata schema is intentionally partial, so validation
    // accepts an absent schemaVersion and preserves it as undefined.
    const responseTemplate = structuredClone(template) as Omit<
      LeaseTemplateView,
      "meta"
    > & {
      meta?: Partial<NonNullable<LeaseTemplateView["meta"]>>;
    };
    delete responseTemplate.meta!.schemaVersion;
    globalThis.fetch = vi.fn().mockResolvedValue(
      successResponse({
        result: [responseTemplate],
        nextPageIdentifier: null,
      }),
    );
    const client = createSmithyClient();

    const page = await client.listLeaseTemplates();
    expect(page.result[0]!.meta?.schemaVersion).toBeUndefined();
    expect(page.result[0]!.meta?.createdTime).toBe(template.meta!.createdTime);
  });

  it("sends every modeled create field in one signed POST", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: template }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createSmithyClient();

    await client.createLeaseTemplate({
      ...completeTemplate,
      defaultPermissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      allowedPermissionSetArns: [
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
      ],
    });

    const request = fetchedRequest();
    expect(request.method).toBe("POST");
    expect(request.url).toBe("http://localhost/api/leaseTemplates");
    await expect(request.clone().json()).resolves.toEqual({
      allowOwnerToShareLease: false,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: true,
      allowedModelIds: ["global.anthropic.claude-sonnet-4-6"],
      defaultModelId: "global.anthropic.claude-sonnet-4-6",
      blueprintId: "00000000-0000-4000-8000-000000000002",
      budgetThresholds: [
        { dollarsSpent: 50, action: "ALERT" },
        { dollarsSpent: 90, action: "ALERT", triggerOn: "PREDICTED" },
      ],
      costReportGroup: "sandbox-team",
      description: "Generated pilot",
      durationThresholds: [{ hoursRemaining: 12, action: "FREEZE_ACCOUNT" }],
      leaseDurationInHours: 72.5,
      maxSpend: 100,
      name: "Pilot template",
      requiresApproval: true,
      visibility: "PRIVATE",
      defaultPermissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      allowedPermissionSetArns: [
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
      ],
    });
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("omits absent optional fields from the create request", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: template }), {
        status: 201,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createSmithyClient();

    await client.createLeaseTemplate(newTemplate);

    const request = fetchedRequest();
    await expect(request.clone().json()).resolves.toEqual({
      allowOwnerToShareLease: false,
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      sandboxSpacesEnabled: true,
      name: "Pilot template",
      requiresApproval: true,
      visibility: "PRIVATE",
      defaultPermissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      allowedPermissionSetArns: [
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      ],
    });
  });

  it("does not retry when a create response is lost", async () => {
    const lostResponse = new TypeError("connection closed after write");
    globalThis.fetch = vi.fn().mockRejectedValue(lostResponse);
    const client = createSmithyClient();

    await expect(
      client.createLeaseTemplate({
        ...newTemplate,
      }),
    ).rejects.toBe(lostResponse);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("rejects a signed path outside the configured API Gateway stage", () => {
    const handler = new CloudFrontFetchHttpHandler(
      "http://localhost/api",
      "prod",
    );

    expect(() =>
      handler.handle(
        new HttpRequest({
          method: "GET",
          protocol: "https:",
          hostname: config.ApiGatewayHost,
          path: "/other/leaseTemplates",
          query: {},
          headers: {},
        }),
      ),
    ).toThrow(
      "Signed request path /other/leaseTemplates does not start with /prod",
    );
  });

  it("gets a template by id through a signed GET", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(completeTemplate));
    const client = createSmithyClient();

    const result = await client.getLeaseTemplate(template.uuid);

    const request = fetchedRequest();
    expect(request.method).toBe("GET");
    expect(request.url).toBe(
      `http://localhost/api/leaseTemplates/${template.uuid}`,
    );
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
    expect(result).toEqual(completeTemplate);
  });

  it("throws when a successful get omits the required data", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(successResponse(undefined));
    const client = createSmithyClient();

    await expect(client.getLeaseTemplate(template.uuid)).rejects.toThrow();
  });

  it("propagates a 404 for a missing template as ApiError, like pre-Smithy", async () => {
    // The handler returns 404 for a missing template; pre-Smithy `ApiProxy.get`
    // threw `ApiError` on that 404 (react-query surfaced an error), so the adapter
    // must not swallow it into `undefined`.
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: "fail",
          data: { errors: [{ message: "Lease template not found." }] },
        }),
        { status: 404, headers: { "content-type": "application/json" } },
      ),
    );
    const client = createSmithyClient();

    await expect(client.getLeaseTemplate(template.uuid)).rejects.toMatchObject({
      statusCode: 404,
    });
  });

  it("propagates a non-404 get failure as ApiError", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ message: "Forbidden" }), {
        status: 403,
        headers: {
          "content-type": "application/json",
          "x-amzn-errortype": "AccessDeniedError",
        },
      }),
    );
    const client = createSmithyClient();

    await expect(client.getLeaseTemplate(template.uuid)).rejects.toMatchObject({
      statusCode: 403,
    });
  });

  it("updates through a signed PUT that echoes meta as ISO strings", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(successResponse(hydratedTemplate));
    const client = createSmithyClient();
    // Server-owned members are dropped; everything else, including meta, is sent.
    const { uuid, blueprintName, createdBy, ...updateBody } = hydratedTemplate;

    await client.updateLeaseTemplate(uuid, updateBody);

    const request = fetchedRequest();
    expect(request.method).toBe("PUT");
    expect(request.url).toBe(`http://localhost/api/leaseTemplates/${uuid}`);
    expect(signedHeaders(request)).toContain(IDENTITY_HEADER);
    const sent = (await request.clone().json()) as Record<string, unknown>;
    expect(sent).not.toHaveProperty("uuid");
    expect(sent).not.toHaveProperty("createdBy");
    expect(sent).not.toHaveProperty("blueprintName");
    expect(sent.name).toBe("Pilot template");
    expect(sent.sandboxSpacesEnabled).toBe(true);
    expect(sent.defaultPermissionSetArn).toBe(
      defaultPermissionSet.permissionSetArn,
    );
    expect(sent.allowedPermissionSetArns).toEqual([
      defaultPermissionSet.permissionSetArn,
      additionalPermissionSet.permissionSetArn,
    ]);
    expect(sent).not.toHaveProperty("defaultPermissionSet");
    expect(sent).not.toHaveProperty("allowedPermissionSets");
    // Update replaces the whole template, so an omitted default would be erased.
    expect(sent.defaultModelId).toBe("global.anthropic.claude-sonnet-4-6");
    // The generated serializer normalizes the timestamp (drops the `.000`
    // fraction) on the way out, so the echoed meta is same-instant but not
    // byte-identical to the stored ISO string.
    expect(sent.meta).toEqual({
      createdTime: "2026-08-01T12:00:00Z",
      lastEditTime: "2026-08-02T13:30:00Z",
      schemaVersion: 4,
    });
  });

  it("deletes through a signed DELETE", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ status: "success", data: null }), {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
    );
    const client = createSmithyClient();

    await expect(
      client.deleteLeaseTemplate(template.uuid),
    ).resolves.toBeUndefined();
    const request = fetchedRequest();
    expect(request.method).toBe("DELETE");
    expect(request.url).toBe(
      `http://localhost/api/leaseTemplates/${template.uuid}`,
    );
  });
});

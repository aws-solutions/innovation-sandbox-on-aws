// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import { PreTokenGenerationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/pre-token-generation-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import type { PreTokenGenerationV2Event } from "@amzn/innovation-sandbox-pre-token-generation/types.js";
import {
  COGNITO_IDC_DISPLAY_NAME_CLAIM,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_IDC_USER_NAME_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  IdcIdentitySchema,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

// Mock IsbServices before importing handler
const mockGetUserFromEmail = vi.fn();
vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    idcService: vi.fn(() => ({
      getUserFromEmail: mockGetUserFromEmail,
    })),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: vi.fn(() => "mock-credentials"),
  }),
);

const testEnv = generateSchemaData(PreTokenGenerationEnvironmentSchema);
const testContext = mockContext(testEnv);
const NO_GROUPS_ERROR =
  "User is not assigned to any ISB groups. Please contact your administrator to request access.";
const USER_NOT_FOUND_ERROR =
  "User could not be found in IAM Identity Center. Please contact your administrator to request access.";
let handler: (typeof import("@amzn/innovation-sandbox-pre-token-generation/pre-token-generation-handler.js"))["handler"];

function createTestEvent(
  overrides: Partial<PreTokenGenerationV2Event> = {},
): PreTokenGenerationV2Event {
  return {
    version: "2",
    triggerSource: "TokenGeneration_HostedAuth",
    region: "us-east-1",
    userPoolId: "us-east-1_testPool",
    userName: "test-user-id",
    callerContext: {
      awsSdkVersion: "3.0.0",
      clientId: "test-client-id",
    },
    request: {
      userAttributes: {
        email: "testuser@example.com",
        sub: "test-sub-id",
      },
      groupConfiguration: {},
    },
    response: {
      claimsAndScopeOverrideDetails: {},
    },
    ...overrides,
  };
}

describe("Pre Token Generation Handler", () => {
  beforeAll(async () => {
    bulkStubEnv(testEnv);
    handler = (
      await import("@amzn/innovation-sandbox-pre-token-generation/pre-token-generation-handler.js")
    ).handler;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("should inject identity claims into the ID token", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "testuser@example.com",
        displayName: "Test User",
        userName: "testuser",
        userId: "test-idc-user-id",
        roles: ["Admin", "User"],
      }),
    );

    const event = createTestEvent();
    const result = await handler(event, testContext);

    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: {
        claimsToAddOrOverride: {
          [COGNITO_ISB_ROLES_CLAIM]: '["Admin","User"]',
          [COGNITO_IDC_USER_ID_CLAIM]: "test-idc-user-id",
          [COGNITO_IDC_DISPLAY_NAME_CLAIM]: "Test User",
          [COGNITO_IDC_USER_NAME_CLAIM]: "testuser",
        },
      },
    });
  });

  it("should throw error when user is not found", async () => {
    mockGetUserFromEmail.mockResolvedValue(undefined);

    const event = createTestEvent();

    await expect(handler(event, testContext)).rejects.toThrow(
      USER_NOT_FOUND_ERROR,
    );
  });

  it("should inject single role when user has only one ISB role", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "manager@example.com",
        displayName: "Manager User",
        userName: "manager",
        userId: "manager-idc-user-id",
        roles: ["Manager"],
      }),
    );

    const event = createTestEvent({
      request: {
        userAttributes: {
          email: "manager@example.com",
          sub: "manager-sub",
        },
        groupConfiguration: {},
      },
    });
    const result = await handler(event, testContext);

    expect(result.response.claimsAndScopeOverrideDetails).toEqual({
      idTokenGeneration: {
        claimsToAddOrOverride: {
          [COGNITO_ISB_ROLES_CLAIM]: '["Manager"]',
          [COGNITO_IDC_USER_ID_CLAIM]: "manager-idc-user-id",
          [COGNITO_IDC_DISPLAY_NAME_CLAIM]: "Manager User",
          [COGNITO_IDC_USER_NAME_CLAIM]: "manager",
        },
      },
    });
  });

  it.each([undefined, ""])(
    "injects the IDC user name separately when display name is %s",
    async (displayName) => {
      mockGetUserFromEmail.mockResolvedValue(
        generateSchemaData(IdcIdentitySchema, {
          email: "username@example.com",
          displayName,
          userName: "username",
          userId: "username-idc-user-id",
          roles: ["User"],
        }),
      );

      const result = await handler(
        createTestEvent({
          request: {
            userAttributes: {
              email: "username@example.com",
              sub: "username-sub",
            },
            groupConfiguration: {},
          },
        }),
        testContext,
      );

      expect(
        result.response.claimsAndScopeOverrideDetails.idTokenGeneration
          ?.claimsToAddOrOverride?.[COGNITO_IDC_DISPLAY_NAME_CLAIM],
      ).toBeUndefined();
      expect(
        result.response.claimsAndScopeOverrideDetails.idTokenGeneration
          ?.claimsToAddOrOverride?.[COGNITO_IDC_USER_NAME_CLAIM],
      ).toBe("username");
    },
  );

  it("should extract email from event.request.userAttributes.email", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "specific@example.com",
        userId: "specific-idc-user-id",
        roles: ["User"],
      }),
    );

    const event = createTestEvent({
      request: {
        userAttributes: {
          email: "specific@example.com",
          sub: "specific-sub",
        },
        groupConfiguration: {},
      },
    });
    await handler(event, testContext);

    expect(mockGetUserFromEmail).toHaveBeenCalledWith("specific@example.com");
  });

  it("should throw error when user has empty roles array", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "noroles@example.com",
        roles: [],
      }),
    );

    const event = createTestEvent({
      request: {
        userAttributes: {
          email: "noroles@example.com",
          sub: "noroles-sub",
        },
        groupConfiguration: {},
      },
    });

    await expect(handler(event, testContext)).rejects.toThrow(NO_GROUPS_ERROR);
  });

  it("should throw error when user exists but roles is undefined", async () => {
    mockGetUserFromEmail.mockResolvedValue({
      email: "noroles@example.com",
      displayName: "No Roles User",
      userName: "noroles",
      // roles intentionally omitted (undefined)
    });

    const event = createTestEvent({
      request: {
        userAttributes: {
          email: "noroles@example.com",
          sub: "noroles-sub",
        },
        groupConfiguration: {},
      },
    });

    await expect(handler(event, testContext)).rejects.toThrow(NO_GROUPS_ERROR);
  });

  it("should handle refresh token trigger source", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "testuser@example.com",
        displayName: "Test User",
        userId: "test-idc-user-id",
        roles: ["User"],
      }),
    );

    const event = createTestEvent({
      triggerSource: "TokenGeneration_RefreshTokens",
    });
    const result = await handler(event, testContext);

    expect(
      result.response.claimsAndScopeOverrideDetails.idTokenGeneration,
    ).toBeDefined();
    expect(
      result.response.claimsAndScopeOverrideDetails.accessTokenGeneration,
    ).toBeUndefined();
    expect(
      result.response.claimsAndScopeOverrideDetails.idTokenGeneration
        ?.claimsToAddOrOverride?.[COGNITO_IDC_DISPLAY_NAME_CLAIM],
    ).toBe("Test User");
  });

  it("should throw error when email cannot be resolved from attributes or userName", async () => {
    const event = createTestEvent({
      userName: "no-email-here",
      request: {
        userAttributes: {
          sub: "test-sub-id",
        },
        groupConfiguration: {},
      },
    });

    await expect(handler(event, testContext)).rejects.toThrow(
      "Email could not be resolved from Cognito trigger event",
    );
  });

  it("should extract email from userName when email attribute is missing", async () => {
    mockGetUserFromEmail.mockResolvedValue(
      generateSchemaData(IdcIdentitySchema, {
        email: "federated@example.com",
        userId: "federated-idc-user-id",
        roles: ["User"],
      }),
    );

    const event = createTestEvent({
      userName: "IAMIdentityCenter_federated@example.com",
      request: {
        userAttributes: {
          sub: "federated-sub",
        },
        groupConfiguration: {},
      },
    });
    const result = await handler(event, testContext);

    expect(mockGetUserFromEmail).toHaveBeenCalledWith("federated@example.com");
    expect(
      result.response.claimsAndScopeOverrideDetails.idTokenGeneration,
    ).toBeDefined();
  });
});

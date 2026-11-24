// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  fetchAuthSession,
  signInWithRedirect,
  signOut,
} from "aws-amplify/auth";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";

// aws-amplify/auth is mocked globally in setupTests.tsx.
// We override individual mocks per test below.

describe("CognitoAuthService", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe("getCurrentUser", () => {
    it("returns authenticated with user when session has all claims", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            payload: {
              email: "user@example.com",
              "custom:idc_user_id": "uid-123",
              "custom:idc_display_name": "User Name",
              "custom:idc_user_name": "user.name",
              "custom:isb_roles": '["Admin","User"]',
              sub: "sub-123",
              iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
              aud: "client-id",
              token_use: "id",
              auth_time: 1234567890,
              exp: 1234567890,
              iat: 1234567890,
            },
            toString: () => "mock-token",
          },
        },
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result).toEqual({
        status: "authenticated",
        user: {
          type: "user",
          email: "user@example.com",
          userId: "uid-123",
          roles: ["Admin", "User"],
          displayName: "User Name",
          userName: "user.name",
        },
      });
    });

    it("returns unauthenticated when no idToken in session", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: undefined,
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result).toEqual({ status: "unauthenticated" });
    });

    it("returns incomplete_claims when email is missing", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            payload: {
              "custom:idc_user_id": "uid-123",
              sub: "sub-123",
              iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
              aud: "client-id",
              token_use: "id",
              auth_time: 1234567890,
              exp: 1234567890,
              iat: 1234567890,
            },
            toString: () => "mock-token",
          },
        },
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result.status).toBe("incomplete_claims");
      if (result.status === "incomplete_claims") {
        expect(result.message).toContain("missing required claims");
      }
    });

    it("returns incomplete_claims when userId is missing", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            payload: {
              email: "user@example.com",
              sub: "sub-123",
              iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
              aud: "client-id",
              token_use: "id",
              auth_time: 1234567890,
              exp: 1234567890,
              iat: 1234567890,
            },
            toString: () => "mock-token",
          },
        },
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result.status).toBe("incomplete_claims");
    });

    it("falls back to cognito:username for email", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            payload: {
              "cognito:username": "IAMIdentityCenter_user@example.com",
              "custom:idc_user_id": "uid-123",
              "custom:isb_roles": '["User"]',
              sub: "sub-123",
              iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
              aud: "client-id",
              token_use: "id",
              auth_time: 1234567890,
              exp: 1234567890,
              iat: 1234567890,
            },
            toString: () => "mock-token",
          },
        },
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result).toEqual({
        status: "authenticated",
        user: {
          type: "user",
          email: "user@example.com",
          userId: "uid-123",
          roles: ["User"],
        },
      });
    });

    it("throws on transient errors (does not swallow)", async () => {
      vi.mocked(fetchAuthSession).mockRejectedValue(new Error("Network error"));

      await expect(CognitoAuthService.getCurrentUser()).rejects.toThrow(
        "Network error",
      );
    });

    it("returns empty roles when custom:isb_roles is missing", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            payload: {
              email: "user@example.com",
              "custom:idc_user_id": "uid-123",
              sub: "sub-123",
              iss: "https://cognito-idp.us-east-1.amazonaws.com/us-east-1_test",
              aud: "client-id",
              token_use: "id",
              auth_time: 1234567890,
              exp: 1234567890,
              iat: 1234567890,
            },
            toString: () => "mock-token",
          },
        },
      } as any);

      const result = await CognitoAuthService.getCurrentUser();

      expect(result.status).toBe("authenticated");
      if (result.status === "authenticated") {
        expect(result.user.roles).toEqual([]);
      }
    });
  });

  describe("getIdToken", () => {
    it("returns the ID token string", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {
          idToken: {
            toString: () => "my-id-token",
            payload: {},
          },
        },
      } as any);

      const token = await CognitoAuthService.getIdToken();

      expect(token).toBe("my-id-token");
    });

    it("returns null when no idToken in session", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        tokens: {},
      } as any);

      const token = await CognitoAuthService.getIdToken();

      expect(token).toBeNull();
    });

    it("propagates Amplify failures to the caller", async () => {
      vi.mocked(fetchAuthSession).mockRejectedValue(
        new Error("Session expired"),
      );

      await expect(CognitoAuthService.getIdToken()).rejects.toThrow(
        "Session expired",
      );
    });
  });

  describe("getCredentials", () => {
    it("returns Identity Pool credentials from the session", async () => {
      const expiration = new Date("2026-08-06T13:00:00.000Z");
      vi.mocked(fetchAuthSession).mockResolvedValue({
        credentials: {
          accessKeyId: "AKIA-TEST",
          secretAccessKey: "secret-test",
          sessionToken: "token-test",
          expiration,
        },
      } as any);

      const creds = await CognitoAuthService.getCredentials();

      expect(creds).toEqual({
        accessKeyId: "AKIA-TEST",
        secretAccessKey: "secret-test",
        sessionToken: "token-test",
        expiration,
      });
    });

    it("returns null when session has no credentials", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({} as any);

      const creds = await CognitoAuthService.getCredentials();

      expect(creds).toBeNull();
    });

    it("returns null when credentials lack accessKeyId or secretAccessKey", async () => {
      vi.mocked(fetchAuthSession).mockResolvedValue({
        credentials: { sessionToken: "token" },
      } as any);

      const creds = await CognitoAuthService.getCredentials();

      expect(creds).toBeNull();
    });

    it("propagates Amplify failures to the caller", async () => {
      vi.mocked(fetchAuthSession).mockRejectedValue(
        new Error("Identity Pool unreachable"),
      );

      await expect(CognitoAuthService.getCredentials()).rejects.toThrow(
        "Identity Pool unreachable",
      );
    });
  });

  describe("login", () => {
    it("calls signInWithRedirect with IAMIdentityCenter provider", () => {
      CognitoAuthService.login();

      expect(signInWithRedirect).toHaveBeenCalledWith({
        provider: { custom: "IAMIdentityCenter" },
      });
    });
  });

  describe("logout", () => {
    it("signs out through Cognito before redirecting to the access portal", async () => {
      await CognitoAuthService.logout();

      expect(signOut).toHaveBeenCalledWith({
        global: false,
        oauth: { redirectUrl: "https://test.awsapps.com/start" },
      });
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  authenticated,
  incompleteClaims,
} from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data";
import { IdcIdentitySchema } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

// vi.mock is hoisted above every import, so the factory body cannot close
// over `buildCognitoAuthServiceMock` directly. The dynamic import runs
// lazily — when Vitest first asks for the mocked module — by which point
// top-level imports have resolved.
vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const { buildCognitoAuthServiceMock } =
      await import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock");
    return { CognitoAuthService: buildCognitoAuthServiceMock() };
  },
);

describe("useUser", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns correct role flags for Admin role", async () => {
    const mockUser = generateSchemaData(IdcIdentitySchema, {
      email: "admin@example.com",
      roles: ["Admin"],
    });

    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(mockUser),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isAdmin).toBe(true);
      expect(result.current.isManager).toBe(false);
      expect(result.current.isUser).toBe(false);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.roles).toEqual(["Admin"]);
    });
  });

  it("returns correct role flags for Manager role", async () => {
    const mockUser = generateSchemaData(IdcIdentitySchema, {
      email: "manager@example.com",
      roles: ["Manager"],
    });

    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(mockUser),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isManager).toBe(true);
      expect(result.current.isUser).toBe(false);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.roles).toEqual(["Manager"]);
    });
  });

  it("returns correct role flags for User role", async () => {
    const mockUser = generateSchemaData(IdcIdentitySchema, {
      email: "user@example.com",
      roles: ["User"],
    });

    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(mockUser),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isManager).toBe(false);
      expect(result.current.isUser).toBe(true);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.roles).toEqual(["User"]);
    });
  });

  it("handles user with no roles", async () => {
    const mockUser = generateSchemaData(IdcIdentitySchema, {
      email: "user@example.com",
      roles: [],
    });

    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(mockUser),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.isAdmin).toBe(false);
      expect(result.current.isManager).toBe(false);
      expect(result.current.isUser).toBe(false);
      expect(result.current.user).toEqual(mockUser);
      expect(result.current.roles).toEqual([]);
    });
  });

  it("returns authError for incomplete claims", async () => {
    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      incompleteClaims("Missing required claims"),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(() => {
      expect(result.current.user).toBeUndefined();
      expect(result.current.authError).toBe("Missing required claims");
    });
  });

  it("handles loading and error states", async () => {
    vi.mocked(CognitoAuthService.getCurrentUser).mockImplementation(
      () => new Promise(() => {}),
    ); // Never resolves

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    expect(result.current.isLoading).toBe(true);
    expect(result.current.user).toBeUndefined();
    expect(result.current.roles).toEqual([]);
  });

  it("surfaces transient errors via React Query error state", async () => {
    vi.mocked(CognitoAuthService.getCurrentUser).mockRejectedValue(
      new Error("Network error"),
    );

    const { result } = renderHook(() => useUser(), {
      wrapper: createQueryClientWrapper(),
    });

    await vi.waitFor(
      () => {
        expect(result.current.isLoading).toBe(false);
        expect(result.current.error).toBeInstanceOf(Error);
        expect(result.current.error?.message).toBe("Network error");
        expect(result.current.user).toBeUndefined();
      },
      { timeout: 5000 },
    );
  });
});

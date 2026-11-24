// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  getAllowedRoles,
  isAllowedInMaintenanceMode,
  resolveAllowedRoles,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/rbac-authorizer.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  type IsbRole,
  IdcIdentitySchema,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

describe("getAllowedRoles", () => {
  it("should return roles for exact path and method", () => {
    expect(getAllowedRoles("/leases", "GET")).toEqual([
      "Manager",
      "Admin",
      "User",
    ]);
  });

  it("should return empty for unmapped path", () => {
    expect(getAllowedRoles("/nonexistent", "GET")).toEqual([]);
  });

  it("should return empty for unmapped method on valid path", () => {
    expect(getAllowedRoles("/leases", "DELETE")).toEqual([]);
  });

  it("should fall back to ALL method if specific method not mapped", () => {
    expect(getAllowedRoles("/configurations", "GET")).toEqual([
      "Manager",
      "Admin",
      "User",
    ]);
  });
});

describe("resolveAllowedRoles", () => {
  it("should resolve exact path", () => {
    expect(resolveAllowedRoles("/accounts", "GET")).toEqual(["Admin"]);
  });

  it("should resolve path with param at end", () => {
    expect(resolveAllowedRoles("/accounts/123456789012", "GET")).toEqual([
      "Admin",
    ]);
  });

  it("should resolve path with param in middle", () => {
    expect(resolveAllowedRoles("/accounts/123456789012/eject", "POST")).toEqual(
      ["Admin"],
    );
  });

  it("should return empty for completely unmapped path", () => {
    expect(resolveAllowedRoles("/unknown/path", "GET")).toEqual([]);
  });

  it("should return empty for single-segment path", () => {
    expect(resolveAllowedRoles("/x", "GET")).toEqual([]);
  });

  it("should resolve path with param in middle for sub-resource", () => {
    expect(resolveAllowedRoles("/leases/Lease101/review", "POST")).toEqual([
      "Manager",
      "Admin",
    ]);
  });

  it("should resolve 3-segment sub-resource path with param at position 2", () => {
    expect(
      resolveAllowedRoles("/accounts/123456789012/cleanup-reports", "GET"),
    ).toEqual(["Admin"]);
  });
});

// Tests each path defined in the authorization map
describe("per-path authorization", () => {
  function isAuthorized(path: string, method: string, role: IsbRole): boolean {
    const allowedRoles = resolveAllowedRoles(path, method as any);
    return allowedRoles.includes(role);
  }

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])("GET /leases for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/leases", "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])("POST /leases for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/leases", "POST", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])("GET /leases/{param} for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/leases/Lease101", "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "PATCH /leases/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leases/Lease101", "PATCH", role)).toBe(authorized);
    },
  );

  it.each([
    { role: "Admin" as const, authorized: false },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])("PUT /leases/{param} for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/leases/Lease101", "PUT", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "POST /leases/{param}/review for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leases/Lease101/review", "POST", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])(
    "POST /leases/{param}/terminate for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leases/Lease101/terminate", "POST", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "POST /leases/{param}/freeze for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leases/Lease101/freeze", "POST", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "POST /leases/{param}/unfreeze for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leases/Lease101/unfreeze", "POST", role)).toBe(
        authorized,
      );
    },
  );

  it.each(
    [
      "costSummary",
      "costHistory",
      "bedrockTokenHistory",
      "breachHistory",
    ].flatMap((route) =>
      (["Admin", "Manager", "User"] as const).map((role) => ({
        route,
        role,
        authorized: true,
      })),
    ),
  )(
    "GET /leases/{param}/$route for $role -> $authorized",
    ({ route, role, authorized }) => {
      expect(isAuthorized(`/leases/Lease101/${route}`, "GET", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])(
    "GET /leaseTemplates/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leaseTemplates/Template101", "GET", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "PUT /leaseTemplates/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leaseTemplates/Template101", "PUT", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "DELETE /leaseTemplates/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/leaseTemplates/Template101", "DELETE", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: true },
  ])("GET /configurations for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/configurations", "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])("GET /accounts for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/accounts", "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])("POST /accounts for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/accounts", "POST", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])(
    "POST /accounts/{param}/eject for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/accounts/123456789012/eject", "POST", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: false },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])(
    "PUT /accounts/{param}/eject for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/accounts/123456789012/eject", "PUT", role)).toBe(
        authorized,
      );
    },
  );

  // Cleanup report endpoints
  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])(
    "GET /accounts/{param}/cleanup-reports for $role -> $authorized",
    ({ role, authorized }) => {
      expect(
        isAuthorized("/accounts/123456789012/cleanup-reports", "GET", role),
      ).toBe(authorized);
    },
  );

  // Blueprint endpoints
  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])("GET /blueprints for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/blueprints", "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])("GET /permissionSets for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/permissionSets", "GET", role)).toBe(authorized);
  });

  it.each([
    { path: "/sandboxAgent/history", role: "Admin" as const, authorized: true },
    {
      path: "/sandboxAgent/history",
      role: "Manager" as const,
      authorized: true,
    },
    { path: "/sandboxAgent/history", role: "User" as const, authorized: true },
    { path: "/sandboxAgent/usage", role: "Admin" as const, authorized: true },
    {
      path: "/sandboxAgent/usage",
      role: "Manager" as const,
      authorized: true,
    },
    { path: "/sandboxAgent/usage", role: "User" as const, authorized: true },
    { path: "/sandboxAgent/models", role: "Admin" as const, authorized: true },
    {
      path: "/sandboxAgent/models",
      role: "Manager" as const,
      authorized: false,
    },
    { path: "/sandboxAgent/models", role: "User" as const, authorized: false },
  ])("GET $path for $role -> $authorized", ({ path, role, authorized }) => {
    expect(isAuthorized(path, "GET", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])("POST /blueprints for $role -> $authorized", ({ role, authorized }) => {
    expect(isAuthorized("/blueprints", "POST", role)).toBe(authorized);
  });

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "GET /blueprints/stacksets for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/blueprints/stacksets", "GET", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: true },
    { role: "User" as const, authorized: false },
  ])(
    "GET /blueprints/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/blueprints/Blueprint101", "GET", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])(
    "PUT /blueprints/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/blueprints/Blueprint101", "PUT", role)).toBe(
        authorized,
      );
    },
  );

  it.each([
    { role: "Admin" as const, authorized: true },
    { role: "Manager" as const, authorized: false },
    { role: "User" as const, authorized: false },
  ])(
    "DELETE /blueprints/{param} for $role -> $authorized",
    ({ role, authorized }) => {
      expect(isAuthorized("/blueprints/Blueprint101", "DELETE", role)).toBe(
        authorized,
      );
    },
  );
});

describe("isAllowedInMaintenanceMode", () => {
  const adminUser = generateSchemaData(IdcIdentitySchema, {
    email: "admin@example.com",
    roles: ["Admin"],
  });
  const regularUser = generateSchemaData(IdcIdentitySchema, {
    email: "user@example.com",
    roles: ["User"],
  });

  it("should allow Admin users on any path", () => {
    expect(isAllowedInMaintenanceMode(adminUser, "/leases", "POST")).toBe(true);
  });

  it("should allow GET /configurations for any user", () => {
    expect(
      isAllowedInMaintenanceMode(regularUser, "/configurations", "GET"),
    ).toBe(true);
  });

  it("should allow GET on a /configurations sub-path for any user", () => {
    expect(
      isAllowedInMaintenanceMode(regularUser, "/configurations/leases", "GET"),
    ).toBe(true);
  });

  it("should deny non-Admin on non-config paths", () => {
    expect(isAllowedInMaintenanceMode(regularUser, "/leases", "GET")).toBe(
      false,
    );
  });

  it("should deny non-Admin on POST /configurations", () => {
    expect(
      isAllowedInMaintenanceMode(regularUser, "/configurations", "POST"),
    ).toBe(false);
  });
});

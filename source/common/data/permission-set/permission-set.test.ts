// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  MANAGED_PERMISSION_SET_TAG_VALUE,
  PERMISSION_SET_CACHE_PK,
  PermissionSetSchemaVersion,
  PersistedPermissionSetCacheItemSchema,
  managedPermissionSetTagKey,
  permissionSetCacheSk,
  toPermissionSetSummary,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import {
  PermissionSetArnSchema,
  PermissionSetIdSchema,
  PermissionSetReferenceSchema,
  PermissionSetSummarySchema,
  permissionSetIdFromArn,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";
const PERMISSION_SET_ID = "ps-0123456789abcdef";
const PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-fedcba9876543210/ps-0123456789abcdef";
const NOW = "2026-09-10T12:00:00.000Z";

function validCacheItem(overrides: Record<string, unknown> = {}) {
  return {
    pk: PERMISSION_SET_CACHE_PK,
    sk: permissionSetCacheSk(PERMISSION_SET_ID),
    permissionSetArn: PERMISSION_SET_ARN,
    permissionSetId: PERMISSION_SET_ID,
    name: "SandboxDeveloper",
    description: "Developer access for sandbox leases",
    sessionDuration: "PT4H",
    syncedAt: NOW,
    meta: {
      schemaVersion: PermissionSetSchemaVersion,
      createdTime: NOW,
      lastEditTime: NOW,
    },
    ...overrides,
  };
}

describe("PermissionSetIdSchema", () => {
  it.each([PERMISSION_SET_ID, "ps-ABCdef01.-/23456"])(
    "accepts a publicly documented permission set ID: %s",
    (permissionSetId) => {
      expect(PermissionSetIdSchema.safeParse(permissionSetId).success).toBe(
        true,
      );
    },
  );

  it.each([
    "",
    "0123456789abcdef",
    "ps-0123456789abcde",
    "ps-0123456789abcdef0",
    "ps-0123456789abcde_",
    `prefix-${PERMISSION_SET_ID}`,
  ])("rejects malformed permission set ID: %s", (permissionSetId) => {
    expect(PermissionSetIdSchema.safeParse(permissionSetId).success).toBe(
      false,
    );
  });
});

describe("PermissionSetArnSchema", () => {
  it.each([
    PERMISSION_SET_ARN,
    "arn:aws-us-gov:sso:::permissionSet/ins-AbCd01.-23456789/ps-ABCdef01.-/23456",
    "arn:aws-cn:sso:::permissionSet/ssoins-0123456789abcdef/ps-fedcba9876543210",
  ])(
    "accepts a publicly documented permission set ARN: %s",
    (permissionSetArn) => {
      expect(PermissionSetArnSchema.safeParse(permissionSetArn).success).toBe(
        true,
      );
    },
  );

  it.each([
    "",
    PERMISSION_SET_ID,
    `garbage/${PERMISSION_SET_ID}`,
    "arn:custom:sso:::permissionSet/ssoins-fedcba9876543210/ps-0123456789abcdef",
    "arn:aws:sso:us-east-1::permissionSet/ssoins-fedcba9876543210/ps-0123456789abcdef",
    "arn:aws:sso:::permissionSet/ssoins-fedcba987654321/ps-0123456789abcdef",
    "arn:aws:sso:::permissionSet/ssoins-fedcba987654321_/ps-0123456789abcdef",
    "arn:aws:sso:::permissionSet/ssoins-fedcba9876543210/ps-0123456789abcde_",
    `${PERMISSION_SET_ARN}/extra`,
  ])("rejects malformed permission set ARN: %s", (permissionSetArn) => {
    expect(PermissionSetArnSchema.safeParse(permissionSetArn).success).toBe(
      false,
    );
  });
});

describe("permissionSetIdFromArn", () => {
  it("extracts the ID from a valid permission set ARN", () => {
    expect(permissionSetIdFromArn(PERMISSION_SET_ARN)).toBe(PERMISSION_SET_ID);
  });

  it.each([
    "",
    PERMISSION_SET_ID,
    `garbage/${PERMISSION_SET_ID}`,
    "arn:aws:sso:::permissionSet/not-an-instance/ps-0123456789abcdef",
    `${PERMISSION_SET_ARN}/extra`,
  ])("returns undefined without throwing for malformed input: %s", (value) => {
    expect(() => permissionSetIdFromArn(value)).not.toThrow();
    expect(permissionSetIdFromArn(value)).toBeUndefined();
  });
});

describe("permission set registration tag", () => {
  it("scopes the tag key by namespace", () => {
    const firstTagKey = managedPermissionSetTagKey("namespace-one");
    const secondTagKey = managedPermissionSetTagKey("namespace-two");

    expect(firstTagKey).toBe("ISB:namespace-one:ManagedPermissionSet");
    expect(secondTagKey).toBe("ISB:namespace-two:ManagedPermissionSet");
    expect(firstTagKey).not.toBe(secondTagKey);
    expect(MANAGED_PERMISSION_SET_TAG_VALUE).toBe("true");
  });
});

describe("PersistedPermissionSetCacheItemSchema", () => {
  it("round-trips a realistic permission set cache item", () => {
    const item = validCacheItem();

    expect(PersistedPermissionSetCacheItemSchema.parse(item)).toEqual(item);
  });

  it("accepts an item without optional fields", () => {
    const { description, sessionDuration, ...item } = validCacheItem();

    expect(description).toBeDefined();
    expect(sessionDuration).toBeDefined();
    expect(PersistedPermissionSetCacheItemSchema.safeParse(item).success).toBe(
      true,
    );
  });

  it.each([
    ["wrong pk", { pk: "principalCache" }],
    ["malformed sk", { sk: `ps#${PERMISSION_SET_ID}-extra` }],
    ["malformed ARN", { permissionSetArn: `garbage/${PERMISSION_SET_ID}` }],
    ["malformed ID", { permissionSetId: "ps-invalid" }],
    ["empty name", { name: "" }],
    ["name exceeding the IDC limit", { name: "a".repeat(33) }],
    ["empty description", { description: "" }],
    ["invalid session duration", { sessionDuration: "4 hours" }],
    ["invalid syncedAt", { syncedAt: "2026-09-10" }],
    ["unsupported schema version", { meta: { schemaVersion: 2 } }],
    ["extra field (strict mode)", { unexpectedField: "value" }],
  ])("rejects %s", (_label, overrides) => {
    expect(
      PersistedPermissionSetCacheItemSchema.safeParse(validCacheItem(overrides))
        .success,
    ).toBe(false);
  });

  it("rejects a sort key that does not match the permission set ID", () => {
    expect(
      PersistedPermissionSetCacheItemSchema.safeParse(
        validCacheItem({ sk: "ps#ps-fedcba9876543210" }),
      ).success,
    ).toBe(false);
  });

  it("rejects an ARN that does not match the permission set ID", () => {
    expect(
      PersistedPermissionSetCacheItemSchema.safeParse(
        validCacheItem({
          permissionSetArn:
            "arn:aws:sso:::permissionSet/ssoins-fedcba9876543210/ps-fedcba9876543210",
        }),
      ).success,
    ).toBe(false);
  });
});

describe("PermissionSetSummarySchema", () => {
  it("projects only fields exposed by the permission set catalog", () => {
    const summary = toPermissionSetSummary(
      PersistedPermissionSetCacheItemSchema.parse(validCacheItem()),
    );

    expect(summary).toEqual({
      permissionSetArn: PERMISSION_SET_ARN,
      permissionSetId: PERMISSION_SET_ID,
      name: "SandboxDeveloper",
      description: "Developer access for sandbox leases",
      sessionDuration: "PT4H",
    });
    expect(PermissionSetSummarySchema.safeParse(summary).success).toBe(true);
  });

  it("maps absent optional fields as undefined", () => {
    const { description, sessionDuration, ...item } = validCacheItem();
    const summary = toPermissionSetSummary(
      PersistedPermissionSetCacheItemSchema.parse(item),
    );

    expect(description).toBeDefined();
    expect(sessionDuration).toBeDefined();
    expect(summary).toStrictEqual({
      permissionSetArn: PERMISSION_SET_ARN,
      permissionSetId: PERMISSION_SET_ID,
      name: "SandboxDeveloper",
      description: undefined,
      sessionDuration: undefined,
    });
  });

  it("rejects persistence fields in strict mode", () => {
    expect(
      PermissionSetSummarySchema.safeParse({
        ...toPermissionSetSummary(
          PersistedPermissionSetCacheItemSchema.parse(validCacheItem()),
        ),
        syncedAt: NOW,
      }).success,
    ).toBe(false);
  });
});

describe("PermissionSetReferenceSchema", () => {
  it("accepts an available backend-hydrated reference", () => {
    expect(
      PermissionSetReferenceSchema.safeParse({
        permissionSetArn: PERMISSION_SET_ARN,
        permissionSetId: PERMISSION_SET_ID,
        name: "SandboxDeveloper",
        description: "Developer access for sandbox leases",
        sessionDuration: "PT4H",
        availability: "AVAILABLE",
      }).success,
    ).toBe(true);
  });

  it("preserves an unavailable reference without mutable cache metadata", () => {
    expect(
      PermissionSetReferenceSchema.safeParse({
        permissionSetArn: PERMISSION_SET_ARN,
        permissionSetId: PERMISSION_SET_ID,
        availability: "UNAVAILABLE",
      }).success,
    ).toBe(true);
  });

  it.each([
    [
      "missing availability",
      {
        permissionSetArn: PERMISSION_SET_ARN,
        permissionSetId: PERMISSION_SET_ID,
      },
    ],
    [
      "missing ID",
      { permissionSetArn: PERMISSION_SET_ARN, availability: "UNAVAILABLE" },
    ],
    [
      "ID that does not match the ARN",
      {
        permissionSetArn: PERMISSION_SET_ARN,
        permissionSetId: "ps-fedcba9876543210",
        availability: "AVAILABLE",
      },
    ],
    [
      "unexpected field",
      {
        permissionSetArn: PERMISSION_SET_ARN,
        permissionSetId: PERMISSION_SET_ID,
        availability: "AVAILABLE",
        unexpected: true,
      },
    ],
  ])("rejects %s", (_label, reference) => {
    expect(PermissionSetReferenceSchema.safeParse(reference).success).toBe(
      false,
    );
  });
});

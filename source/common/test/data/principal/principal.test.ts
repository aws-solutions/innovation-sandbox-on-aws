// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  PersistedAssignmentLeaseIndexKeySchema,
  PersistedGroupAssignmentSchema,
  PersistedGroupMembershipCacheSchema,
  PersistedPrincipalCacheItemSchema,
  PersistedUserAssignmentKeySchema,
  PersistedUserAssignmentSchema,
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  IdcPrincipalIdSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

const VALID_UUID = "00000000-0000-4000-8000-000000000001";
const VALID_UUID_2 = "00000000-0000-4000-8000-000000000002";
const VALID_IDC_ID_PREFIXED = "0000000000-00000000-0000-0000-0000-000000000002";
const VALID_PERMISSION_SET_ID = "ps-a1b2c3d4e5f60001";
const VALID_PERMISSION_SET_ARN = `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/${VALID_PERMISSION_SET_ID}`;
const NOW = new Date().toISOString();

const validMeta = {
  meta: {
    schemaVersion: PrincipalSchemaVersion,
    createdTime: NOW,
    lastEditTime: NOW,
  },
};

function validUserAssignment(overrides = {}) {
  return {
    pk: "user#" + VALID_UUID,
    sk: "lease#" + VALID_UUID,
    userId: VALID_UUID,
    principalType: "USER" as const,
    leaseId: VALID_UUID,
    assigneeEmail: "assignee@example.com",
    leaseOwnerEmail: "owner@example.com",
    permissionSetArn: VALID_PERMISSION_SET_ARN,
    addedBy: "admin@example.com",
    addedDate: NOW,
    ...validMeta,
    ...overrides,
  };
}

function validGroupAssignment(overrides = {}) {
  return {
    pk: "group#" + VALID_UUID,
    sk: "lease#" + VALID_UUID,
    leaseId: VALID_UUID,
    groupId: VALID_UUID,
    principalType: "GROUP" as const,
    displayName: "Engineering Team",
    leaseOwnerEmail: "owner@example.com",
    permissionSetArn: VALID_PERMISSION_SET_ARN,
    addedBy: "admin@example.com",
    addedDate: NOW,
    ...validMeta,
    ...overrides,
  };
}

function validGroupMembershipCache(overrides = {}) {
  return {
    pk: "user#" + VALID_UUID,
    sk: "groupMembership" as const,
    groupIds: [VALID_UUID, VALID_IDC_ID_PREFIXED],
    ttl: Math.floor(Date.now() / 1000) + 86400,
    ...validMeta,
    ...overrides,
  };
}

describe("Principal Validation", () => {
  describe("IdcPrincipalIdSchema", () => {
    it.each([VALID_UUID, VALID_IDC_ID_PREFIXED])(
      "should accept valid IDC ID: %s",
      (id) => {
        expect(IdcPrincipalIdSchema.safeParse(id).success).toBe(true);
      },
    );

    it.each([
      "",
      "not-a-valid-id",
      "000000000-00000000-0000-0000-0000-000000000001",
    ])("should reject invalid IDC ID: %s", (id) => {
      expect(IdcPrincipalIdSchema.safeParse(id).success).toBe(false);
    });
  });

  describe("PrincipalTypeSchema", () => {
    it.each(["USER", "GROUP"])("should accept %s", (type) => {
      expect(PrincipalTypeSchema.safeParse(type).success).toBe(true);
    });

    it("should reject invalid type", () => {
      expect(PrincipalTypeSchema.safeParse("INVALID").success).toBe(false);
    });
  });

  describe("PersistedUserAssignmentSchema", () => {
    it("should accept a valid user assignment", () => {
      expect(
        PersistedUserAssignmentSchema.safeParse(validUserAssignment()).success,
      ).toBe(true);
    });

    it("should accept with optional fields populated", () => {
      expect(
        PersistedUserAssignmentSchema.safeParse(
          validUserAssignment({
            accountId: "123456789012",
            permissionSetArn: VALID_PERMISSION_SET_ARN,
          }),
        ).success,
      ).toBe(true);
    });

    it("should accept with prefixed IDC ID in pk", () => {
      expect(
        PersistedUserAssignmentSchema.safeParse(
          validUserAssignment({
            pk: "user#" + VALID_IDC_ID_PREFIXED,
            userId: VALID_IDC_ID_PREFIXED,
          }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["pk without user# prefix", { pk: VALID_UUID }],
      ["pk with invalid IDC ID", { pk: "user#not-valid" }],
      ["sk without lease# prefix", { sk: VALID_UUID }],
      ["sk with non-UUID after lease#", { sk: "lease#not-a-uuid" }],
      ["invalid email", { assigneeEmail: "not-an-email" }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        PersistedUserAssignmentSchema.safeParse(validUserAssignment(overrides))
          .success,
      ).toBe(false);
    });
  });

  describe("PersistedUserAssignmentKeySchema", () => {
    it("should accept a valid direct-assignment key", () => {
      expect(
        PersistedUserAssignmentKeySchema.safeParse({
          pk: `user#${VALID_UUID}`,
          sk: `lease#${VALID_UUID}`,
        }).success,
      ).toBe(true);
    });

    it.each([
      ["invalid user partition key", { pk: `group#${VALID_UUID}` }],
      ["invalid assignment sort key", { sk: "groupMembership" }],
      ["extra fields", { leaseId: VALID_UUID }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        PersistedUserAssignmentKeySchema.safeParse({
          pk: `user#${VALID_UUID}`,
          sk: `lease#${VALID_UUID}`,
          ...overrides,
        }).success,
      ).toBe(false);
    });
  });

  describe("PersistedAssignmentLeaseIndexKeySchema", () => {
    it.each([`user#${VALID_UUID}`, `group#${VALID_UUID}`])(
      "accepts an assignment key for %s",
      (pk) => {
        expect(
          PersistedAssignmentLeaseIndexKeySchema.safeParse({
            pk,
            sk: `lease#${VALID_UUID}`,
            leaseId: VALID_UUID,
          }).success,
        ).toBe(true);
      },
    );

    it.each([
      ["invalid principal key", { pk: `principal#${VALID_UUID}` }],
      ["invalid assignment key", { sk: "groupMembership" }],
      ["invalid lease ID", { leaseId: "not-a-uuid" }],
      [
        "mismatched lease ID",
        {
          sk: `lease#${VALID_UUID_2}`,
          leaseId: VALID_UUID,
        },
      ],
      ["extra fields", { unexpected: true }],
    ])("rejects %s", (_label, overrides) => {
      expect(
        PersistedAssignmentLeaseIndexKeySchema.safeParse({
          pk: `user#${VALID_UUID}`,
          sk: `lease#${VALID_UUID}`,
          leaseId: VALID_UUID,
          ...overrides,
        }).success,
      ).toBe(false);
    });
  });

  describe("PersistedGroupAssignmentSchema", () => {
    it("should accept a valid group assignment", () => {
      expect(
        PersistedGroupAssignmentSchema.safeParse(validGroupAssignment())
          .success,
      ).toBe(true);
    });

    it("should accept with prefixed IDC ID in pk and groupId", () => {
      expect(
        PersistedGroupAssignmentSchema.safeParse(
          validGroupAssignment({
            pk: "group#" + VALID_IDC_ID_PREFIXED,
            groupId: VALID_IDC_ID_PREFIXED,
          }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["pk without group# prefix", { pk: "user#" + VALID_UUID }],
      ["invalid groupId", { groupId: "not-valid" }],
      ["empty group name", { displayName: "" }],
      ["group name exceeding 1024 chars", { displayName: "A".repeat(1025) }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        PersistedGroupAssignmentSchema.safeParse(
          validGroupAssignment(overrides),
        ).success,
      ).toBe(false);
    });
  });

  describe("PersistedGroupMembershipCacheSchema", () => {
    it("should accept a valid cache record", () => {
      expect(
        PersistedGroupMembershipCacheSchema.safeParse(
          validGroupMembershipCache(),
        ).success,
      ).toBe(true);
    });

    it("should accept empty groupIds array", () => {
      expect(
        PersistedGroupMembershipCacheSchema.safeParse(
          validGroupMembershipCache({ groupIds: [] }),
        ).success,
      ).toBe(true);
    });

    it.each([
      ["invalid groupIds entries", { groupIds: ["not-valid-id"] }],
      ["non-groupMembership sk", { sk: "lease#some-id" }],
      ["negative ttl", { ttl: -1 }],
      ["non-integer ttl", { ttl: 1234.56 }],
      ["pk without user# prefix", { pk: "group#" + VALID_UUID }],
      ["extra fields (strict)", { unexpectedField: "value" }],
    ])("should reject %s", (_label, overrides) => {
      expect(
        PersistedGroupMembershipCacheSchema.safeParse(
          validGroupMembershipCache(overrides),
        ).success,
      ).toBe(false);
    });
  });

  describe("PersistedPrincipalCacheItemSchema", () => {
    function createUserCacheItem(overrides = {}) {
      return {
        pk: PRINCIPAL_CACHE_PK,
        sk: `${PRINCIPAL_CACHE_USER_SK_PREFIX}${VALID_UUID}`,
        principalId: VALID_UUID,
        principalType: "USER",
        displayName: "Test User",
        email: "test@example.com",
        syncedAt: NOW,
        ttl: Math.floor(Date.now() / 1000) + 172800,
        ...overrides,
      };
    }

    function createGroupCacheItem(overrides = {}) {
      return {
        pk: PRINCIPAL_CACHE_PK,
        sk: `${PRINCIPAL_CACHE_GROUP_SK_PREFIX}${VALID_UUID}`,
        principalId: VALID_UUID,
        principalType: "GROUP",
        displayName: "Test Group",
        syncedAt: NOW,
        ttl: Math.floor(Date.now() / 1000) + 172800,
        ...overrides,
      };
    }

    it("should accept a valid USER cache item", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(createUserCacheItem())
          .success,
      ).toBe(true);
    });

    it("should accept a valid GROUP cache item", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(createGroupCacheItem())
          .success,
      ).toBe(true);
    });

    it("should reject wrong pk value", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ pk: "wrongValue" }),
        ).success,
      ).toBe(false);
    });

    it("should reject empty displayName", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ displayName: "" }),
        ).success,
      ).toBe(false);
    });

    it("should reject invalid email format", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ email: "not-an-email" }),
        ).success,
      ).toBe(false);
    });

    it("should reject missing required fields", () => {
      const { principalId, ...missing } = createUserCacheItem();
      expect(PersistedPrincipalCacheItemSchema.safeParse(missing).success).toBe(
        false,
      );
    });

    it("should reject extra fields (strict mode)", () => {
      expect(
        PersistedPrincipalCacheItemSchema.safeParse(
          createUserCacheItem({ unexpectedField: "value" }),
        ).success,
      ).toBe(false);
    });
  });
});

describe("Assignment schema compatibility", () => {
  const tupleSk = `lease#${VALID_UUID}#ps#${VALID_PERMISSION_SET_ID}`;
  const legacyMeta = {
    meta: {
      schemaVersion: 1,
      createdTime: NOW,
      lastEditTime: NOW,
    },
  };

  it("accepts an unchanged v1 user assignment", () => {
    const { permissionSetArn: _permissionSetArn, ...legacyAssignment } =
      validUserAssignment(legacyMeta);
    expect(
      PersistedUserAssignmentSchema.safeParse(legacyAssignment).success,
    ).toBe(true);
  });

  it("accepts an unchanged v1 group assignment", () => {
    const { permissionSetArn: _permissionSetArn, ...legacyAssignment } =
      validGroupAssignment(legacyMeta);
    expect(
      PersistedGroupAssignmentSchema.safeParse(legacyAssignment).success,
    ).toBe(true);
  });

  it("accepts a v2 tuple-keyed user assignment", () => {
    expect(
      PersistedUserAssignmentSchema.safeParse(
        validUserAssignment({
          sk: tupleSk,
          permissionSetArn: VALID_PERMISSION_SET_ARN,
        }),
      ).success,
    ).toBe(true);
  });

  it("accepts a v2 tuple-keyed group assignment", () => {
    expect(
      PersistedGroupAssignmentSchema.safeParse(
        validGroupAssignment({
          sk: tupleSk,
          permissionSetArn: VALID_PERMISSION_SET_ARN,
        }),
      ).success,
    ).toBe(true);
  });

  it.each([
    ["empty permission set ID", `lease#${VALID_UUID}#ps#`],
    [
      "missing permission set prefix",
      `lease#${VALID_UUID}#ps#a1b2c3d4e5f60001`,
    ],
    ["trailing segment", `${tupleSk}#extra`],
  ])("rejects a user assignment SK with %s", (_label, sk) => {
    expect(
      PersistedUserAssignmentSchema.safeParse(validUserAssignment({ sk }))
        .success,
    ).toBe(false);
  });

  it.each([
    [
      "a mismatched leaseId",
      () =>
        PersistedUserAssignmentSchema.safeParse(
          validUserAssignment({
            leaseId: "00000000-0000-4000-8000-000000000002",
          }),
        ).success,
    ],
    [
      "a tuple key whose permission set ID differs from permissionSetArn",
      () =>
        PersistedGroupAssignmentSchema.safeParse(
          validGroupAssignment({
            sk: tupleSk,
            permissionSetArn:
              "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-f9e8d7c6b5a40002",
          }),
        ).success,
    ],
  ])("rejects an assignment with %s", (_label, parse) => {
    expect(parse()).toBe(false);
  });

  it("rejects a redundant permissionSetId field", () => {
    expect(
      PersistedGroupAssignmentSchema.safeParse(
        validGroupAssignment({ permissionSetId: VALID_PERMISSION_SET_ID }),
      ).success,
    ).toBe(false);
  });

  it.each([
    [
      "user",
      PersistedUserAssignmentSchema,
      validUserAssignment({ sk: tupleSk }),
    ],
    [
      "group",
      PersistedGroupAssignmentSchema,
      validGroupAssignment({ sk: tupleSk }),
    ],
  ])(
    "rejects a tuple-keyed %s assignment without permissionSetArn",
    (_label, schema, record) => {
      const { permissionSetArn: _permissionSetArn, ...withoutArn } = record;
      expect(schema.safeParse(withoutArn).success).toBe(false);
    },
  );

  it("rejects a malformed permissionSetArn field", () => {
    expect(
      PersistedUserAssignmentSchema.safeParse(
        validUserAssignment({ permissionSetArn: "not-an-arn" }),
      ).success,
    ).toBe(false);
  });

  it("rejects a schema version newer than supported", () => {
    expect(
      PersistedUserAssignmentSchema.safeParse(
        validUserAssignment({
          meta: {
            schemaVersion: PrincipalSchemaVersion + 1,
            createdTime: NOW,
            lastEditTime: NOW,
          },
        }),
      ).success,
    ).toBe(false);
  });
});

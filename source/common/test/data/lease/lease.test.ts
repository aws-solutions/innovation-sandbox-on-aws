// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  LeaseSchemaVersion,
  newestCopyOfEachLease,
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLease,
  PersistedExpiredLeaseSchema,
  PersistedLeaseSchema,
  PersistedLeaseStatusIndexKeySchema,
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLease,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  AllLeaseStatusSchema,
  DesiredAssignmentSchema,
  isActiveLease,
  isApprovalDeniedLease,
  isExpiredLease,
  isFrozenLease,
  isMonitoredLease,
  isPendingLease,
  LeaseKeySchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  ResourceLockSchema,
  type ResourceLock,
} from "@amzn/innovation-sandbox-shared/types/resource-lock.js";

const baseMeta = {
  meta: { schemaVersion: 4, createdTime: "2024-01-01T00:00:00Z" },
};

const DEFAULT_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-0000000000000001";

const permissionSetArn = (index: number) =>
  `arn:aws:sso:::permissionSet/ins-1234567890abcdef/ps-${index.toString().padStart(16, "0")}`;

const basePendingLease: PersistedPendingLease = {
  userEmail: "user@example.com",
  uuid: "550e8400-e29b-41d4-a716-446655440000",
  status: "PendingApproval" as const,
  originalLeaseTemplateUuid: "660e8400-e29b-41d4-a716-446655440001",
  originalLeaseTemplateName: "Default Template",
  sandboxSpacesEnabled: false,
  ...baseMeta,
};

const baseMonitoredLease: PersistedMonitoredLease = {
  ...basePendingLease,
  status: "Active" as const,
  awsAccountId: "123456789012",
  approvedBy: "admin@example.com",
  startDate: "2024-01-01T00:00:00Z",
  lastCheckedDate: "2024-01-01T00:00:00Z",
  totalCostAccrued: 0,
};

const baseExpiredLease: PersistedExpiredLease = {
  ...baseMonitoredLease,
  status: "Expired" as const,
  endDate: "2024-02-01T00:00:00Z",
  ttl: 1706745600,
};

const validResourceLock: ResourceLock = {
  ownerId:
    "arn:aws:states:us-east-1:123456789012:execution:AssignmentProcessor:exec-123",
  acquiredAt: "2024-01-01T00:00:00Z",
  expiresAt: "2024-01-01T00:15:00Z",
  meta: { intent: "UPDATE" },
};

describe("Persisted lease key schemas", () => {
  const tableKey = {
    userEmail: basePendingLease.userEmail,
    uuid: basePendingLease.uuid,
  };

  it("accepts a valid table key", () => {
    expect(LeaseKeySchema.safeParse(tableKey).success).toBe(true);
  });

  it.each([
    { ...tableKey, userEmail: "not-an-email" },
    { ...tableKey, uuid: "not-a-uuid" },
  ])("rejects an invalid table key", (key) => {
    expect(LeaseKeySchema.safeParse(key).success).toBe(false);
  });

  it("strips unknown table-key fields", () => {
    expect(LeaseKeySchema.parse({ ...tableKey, unexpected: true })).toEqual(
      tableKey,
    );
  });

  it("accepts a valid StatusIndex key", () => {
    expect(
      PersistedLeaseStatusIndexKeySchema.safeParse({
        ...tableKey,
        status: basePendingLease.status,
        originalLeaseTemplateUuid: basePendingLease.originalLeaseTemplateUuid,
      }).success,
    ).toBe(true);
  });

  it.each([{ status: "Unknown" }, { originalLeaseTemplateUuid: "not-a-uuid" }])(
    "rejects an invalid StatusIndex key",
    (override) => {
      expect(
        PersistedLeaseStatusIndexKeySchema.safeParse({
          ...tableKey,
          status: basePendingLease.status,
          originalLeaseTemplateUuid: basePendingLease.originalLeaseTemplateUuid,
          ...override,
        }).success,
      ).toBe(false);
    },
  );
});

describe("PersistedPendingLeaseSchema", () => {
  it("should accept a minimal valid pending lease", () => {
    const result = PersistedPendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
  });

  it("should default legacy pending leases to false", () => {
    const { sandboxSpacesEnabled: _, ...legacyPendingLease } = basePendingLease;
    expect(
      PersistedPendingLeaseSchema.parse(legacyPendingLease)
        .sandboxSpacesEnabled,
    ).toBe(false);
  });

  it("should parse a pre-migration lease without allowedModelIds", () => {
    // allowedModelIds is optional so existing lease records (written before
    // Sandbox Spaces) parse with no migration; absent stays absent.
    const result = PersistedPendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    expect(result.data?.allowedModelIds).toBeUndefined();
  });

  it("should carry the allowedModelIds snapshot when present", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowedModelIds: ["global.anthropic.claude-sonnet-4-6"],
    });
    expect(result.success).toBe(true);
    expect(result.data?.allowedModelIds).toEqual([
      "global.anthropic.claude-sonnet-4-6",
    ]);
  });

  it("should carry the defaultModelId snapshot when present", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      defaultModelId: "global.anthropic.claude-sonnet-4-6",
    });
    expect(result.success).toBe(true);
    expect(result.data?.defaultModelId).toBe(
      "global.anthropic.claude-sonnet-4-6",
    );
  });

  it("should parse a lease without defaultModelId (no preselection)", () => {
    const result = PersistedPendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    expect(result.data?.defaultModelId).toBeUndefined();
  });

  it("should accept pending lease with all optional fields", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      comments: "Test comment",
      createdBy: "creator@example.com",
      maxSpend: 100,
      leaseDurationInHours: 24,
      budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
      durationThresholds: [{ hoursRemaining: 2, action: "ALERT" }],
      costReportGroup: "team-a",
      blueprintId: "770e8400-e29b-41d4-a716-446655440002",
      blueprintName: "TestBlueprint",
      allowOwnerToShareLease: true,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
  });

  it.each(["not-an-email", "", "missing-at-sign"])(
    "should reject invalid userEmail: %s",
    (userEmail) => {
      const result = PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        userEmail,
      });
      expect(result.success).toBe(false);
    },
  );

  it.each(["not-a-uuid", "", "12345"])(
    "should reject invalid uuid: %s",
    (uuid) => {
      const result = PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        uuid,
      });
      expect(result.success).toBe(false);
    },
  );

  it("should reject invalid status", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      status: "InvalidStatus",
    });
    expect(result.success).toBe(false);
  });

  it.each([1, 2, 3, 4, 5, LeaseSchemaVersion])(
    "should accept schema version %i",
    (version) => {
      const result = PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        meta: { schemaVersion: version },
      });
      expect(result.success).toBe(true);
    },
  );

  it.each([0, LeaseSchemaVersion + 1, -1])(
    "should reject schema version %i",
    (version) => {
      const result = PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        meta: { schemaVersion: version },
      });
      expect(result.success).toBe(false);
    },
  );
});

describe("Lease permission profile fields", () => {
  it("should accept a legacy v5 lease without permission profile fields", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      meta: { schemaVersion: 5, createdTime: "2024-01-01T00:00:00Z" },
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultPermissionSetArn).toBeUndefined();
      expect(result.data.allowedPermissionSetArns).toBeUndefined();
    }
  });

  it("should model only ARN configuration on persisted leases", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      defaultPermissionSetArn: DEFAULT_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [DEFAULT_PERMISSION_SET_ARN],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.defaultPermissionSetArn).toBe(
        DEFAULT_PERMISSION_SET_ARN,
      );
      expect(result.data.allowedPermissionSetArns).toEqual([
        DEFAULT_PERMISSION_SET_ARN,
      ]);
      expect(PersistedPendingLeaseSchema.shape).not.toHaveProperty(
        "defaultPermissionSet",
      );
      expect(PersistedPendingLeaseSchema.shape).not.toHaveProperty(
        "allowedPermissionSets",
      );
    }
  });

  it("should enforce the 20-item allowed permission set ARN cap", () => {
    const permissionSetArns = Array.from({ length: 21 }, (_, index) =>
      permissionSetArn(index),
    );

    expect(
      PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        allowedPermissionSetArns: permissionSetArns.slice(0, 20),
      }).success,
    ).toBe(true);
    expect(
      PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        allowedPermissionSetArns: permissionSetArns,
      }).success,
    ).toBe(false);
  });

  it("should reject malformed permission set ARNs", () => {
    expect(
      PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        defaultPermissionSetArn: "not-an-arn",
      }).success,
    ).toBe(false);
    expect(
      PersistedPendingLeaseSchema.safeParse({
        ...basePendingLease,
        allowedPermissionSetArns: ["not-an-arn"],
      }).success,
    ).toBe(false);
    expect(
      DesiredAssignmentSchema.safeParse({
        principalId: "9367e8a0-30e1-70dc-f4b7-1d4b6c8f1234",
        principalType: "USER",
        permissionSetArn: "not-an-arn",
      }).success,
    ).toBe(false);
  });

  it("should propagate persisted ARN configuration to monitored and expired leases", () => {
    const profileFields = {
      defaultPermissionSetArn: DEFAULT_PERMISSION_SET_ARN,
      allowedPermissionSetArns: [DEFAULT_PERMISSION_SET_ARN],
    };

    expect(
      PersistedMonitoredLeaseSchema.safeParse({
        ...baseMonitoredLease,
        ...profileFields,
      }).success,
    ).toBe(true);
    expect(
      PersistedExpiredLeaseSchema.safeParse({
        ...baseExpiredLease,
        ...profileFields,
      }).success,
    ).toBe(true);
  });

  it("should accept desired assignments with or without a permission set ARN", () => {
    const assignment = {
      principalId: "9367e8a0-30e1-70dc-f4b7-1d4b6c8f1234",
      principalType: "USER" as const,
    };

    expect(DesiredAssignmentSchema.safeParse(assignment).success).toBe(true);
    expect(
      DesiredAssignmentSchema.safeParse({
        ...assignment,
        permissionSetArn: DEFAULT_PERMISSION_SET_ARN,
      }).success,
    ).toBe(true);
  });
});

describe("Lease blueprintId validation", () => {
  it("should accept blueprintId=null", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId: null,
      blueprintName: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBeNull();
    }
  });

  it("should accept blueprintId=undefined (field absent from DynamoDB read)", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      // blueprintId intentionally omitted
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBeUndefined();
    }
  });

  it("should accept blueprintId as valid UUID", () => {
    const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId,
      blueprintName: "TestBlueprint",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.blueprintId).toBe(blueprintId);
    }
  });

  it("should reject blueprintId with invalid UUID format", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      blueprintId: "not-a-uuid",
    });
    expect(result.success).toBe(false);
  });
});

describe("Lease allowOwnerToShareLease validation", () => {
  it("should accept allowOwnerToShareLease=true", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(true);
    }
  });

  it("should accept allowOwnerToShareLease=false", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(false);
    }
  });

  it("should accept allowOwnerToShareLease=undefined (backward compatible)", () => {
    const result = PersistedPendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBeUndefined();
    }
  });

  it("should reject non-boolean value", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      allowOwnerToShareLease: "yes",
    });
    expect(result.success).toBe(false);
  });

  it("should propagate to PersistedMonitoredLeaseSchema", () => {
    const result = PersistedMonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      allowOwnerToShareLease: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(true);
    }
  });

  it("should propagate to PersistedExpiredLeaseSchema", () => {
    const result = PersistedExpiredLeaseSchema.safeParse({
      ...baseExpiredLease,
      allowOwnerToShareLease: false,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.allowOwnerToShareLease).toBe(false);
    }
  });
});

describe("ResourceLockSchema", () => {
  it("should accept valid resource lock", () => {
    const result = ResourceLockSchema.safeParse(validResourceLock);
    expect(result.success).toBe(true);
  });

  it("should accept lock without meta", () => {
    const { meta: _, ...withoutMeta } = validResourceLock;
    const result = ResourceLockSchema.safeParse(withoutMeta);
    expect(result.success).toBe(true);
  });

  it("should accept lock with arbitrary meta keys", () => {
    const result = ResourceLockSchema.safeParse({
      ...validResourceLock,
      meta: { type: "REVOKE", intent: "TERMINATE", reason: "lease-expired" },
    });
    expect(result.success).toBe(true);
  });

  it.each([
    ["empty ownerId", { ...validResourceLock, ownerId: "" }],
    ["invalid acquiredAt", { ...validResourceLock, acquiredAt: "not-a-date" }],
    ["invalid expiresAt", { ...validResourceLock, expiresAt: "not-a-date" }],
    [
      "extra fields (strict)",
      { ...validResourceLock, extraField: "should-fail" },
    ],
  ])("should reject %s", (_label, input) => {
    const result = ResourceLockSchema.safeParse(input);
    expect(result.success).toBe(false);
  });
});

describe("Lease resourceLock field validation", () => {
  it("should accept resourceLock with valid data", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toEqual(validResourceLock);
    }
  });

  it("should accept resourceLock=null (cleared after completion)", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: null,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeNull();
    }
  });

  it("should accept resourceLock=undefined (no lock ever acquired)", () => {
    const result = PersistedPendingLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeUndefined();
    }
  });

  it("should reject resourceLock with invalid nested data", () => {
    const result = PersistedPendingLeaseSchema.safeParse({
      ...basePendingLease,
      resourceLock: { ...validResourceLock, ownerId: "" },
    });
    expect(result.success).toBe(false);
  });

  it("should propagate to PersistedMonitoredLeaseSchema", () => {
    const result = PersistedMonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      resourceLock: validResourceLock,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toEqual(validResourceLock);
    }
  });
});

describe("PersistedApprovalDeniedLeaseSchema", () => {
  it("should accept valid denied lease", () => {
    const result = PersistedApprovalDeniedLeaseSchema.safeParse({
      ...basePendingLease,
      status: "ApprovalDenied",
      ttl: 1706745600,
    });
    expect(result.success).toBe(true);
  });

  it("should require ttl", () => {
    const result = PersistedApprovalDeniedLeaseSchema.safeParse({
      ...basePendingLease,
      status: "ApprovalDenied",
    });
    expect(result.success).toBe(false);
  });
});

describe("PersistedMonitoredLeaseSchema", () => {
  it.each(["Active", "Frozen", "Provisioning"])(
    "should accept %s status",
    (status) => {
      const result = PersistedMonitoredLeaseSchema.safeParse({
        ...baseMonitoredLease,
        status,
      });
      expect(result.success).toBe(true);
    },
  );

  it("should accept AUTO_APPROVED as approvedBy", () => {
    const result = PersistedMonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      approvedBy: "AUTO_APPROVED",
    });
    expect(result.success).toBe(true);
  });

  it("should require awsAccountId as 12-digit string", () => {
    const result = PersistedMonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      awsAccountId: "12345",
    });
    expect(result.success).toBe(false);
  });

  it("should accept optional expirationDate", () => {
    const result = PersistedMonitoredLeaseSchema.safeParse({
      ...baseMonitoredLease,
      expirationDate: "2024-02-01T00:00:00Z",
    });
    expect(result.success).toBe(true);
  });
});

describe("PersistedExpiredLeaseSchema", () => {
  it("should accept valid expired lease", () => {
    const result = PersistedExpiredLeaseSchema.safeParse(baseExpiredLease);
    expect(result.success).toBe(true);
  });

  it.each([
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ])("should accept %s status", (status) => {
    const result = PersistedExpiredLeaseSchema.safeParse({
      ...baseExpiredLease,
      status,
    });
    expect(result.success).toBe(true);
  });

  it("should require endDate", () => {
    const { endDate: _, ...withoutEndDate } = baseExpiredLease;
    const result = PersistedExpiredLeaseSchema.safeParse(withoutEndDate);
    expect(result.success).toBe(false);
  });

  it("should require ttl", () => {
    const { ttl: _, ...withoutTtl } = baseExpiredLease;
    const result = PersistedExpiredLeaseSchema.safeParse(withoutTtl);
    expect(result.success).toBe(false);
  });
});

describe("PersistedLeaseSchema (discriminated union)", () => {
  it("should parse PendingApproval as PersistedPendingLease", () => {
    const result = PersistedLeaseSchema.safeParse(basePendingLease);
    expect(result.success).toBe(true);
  });

  it("should parse Active as PersistedMonitoredLease", () => {
    const result = PersistedLeaseSchema.safeParse(baseMonitoredLease);
    expect(result.success).toBe(true);
  });

  it("should parse Expired as PersistedExpiredLease", () => {
    const result = PersistedLeaseSchema.safeParse(baseExpiredLease);
    expect(result.success).toBe(true);
  });

  it("should reject unknown status", () => {
    const result = PersistedLeaseSchema.safeParse({
      ...basePendingLease,
      status: "Unknown",
    });
    expect(result.success).toBe(false);
  });
});

describe("AllLeaseStatusSchema", () => {
  const allStatuses = [
    "PendingApproval",
    "ApprovalDenied",
    "Active",
    "Frozen",
    "Provisioning",
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ];

  it.each(allStatuses)("should accept %s", (status) => {
    expect(AllLeaseStatusSchema.safeParse(status).success).toBe(true);
  });

  it("should reject invalid status", () => {
    expect(AllLeaseStatusSchema.safeParse("Invalid").success).toBe(false);
  });
});

describe("Type guard functions", () => {
  it("isPendingLease identifies PendingApproval", () => {
    const lease = PersistedLeaseSchema.parse(basePendingLease);
    expect(isPendingLease(lease)).toBe(true);
    expect(isMonitoredLease(lease)).toBe(false);
    expect(isExpiredLease(lease)).toBe(false);
  });

  it("isApprovalDeniedLease identifies ApprovalDenied", () => {
    const lease = PersistedLeaseSchema.parse({
      ...basePendingLease,
      status: "ApprovalDenied",
      ttl: 1706745600,
    });
    expect(isApprovalDeniedLease(lease)).toBe(true);
    expect(isPendingLease(lease)).toBe(false);
  });

  it("isMonitoredLease identifies Active", () => {
    const lease = PersistedLeaseSchema.parse(baseMonitoredLease);
    expect(isMonitoredLease(lease)).toBe(true);
    expect(isActiveLease(lease)).toBe(true);
    expect(isFrozenLease(lease)).toBe(false);
  });

  it("isFrozenLease identifies Frozen", () => {
    const lease = PersistedLeaseSchema.parse({
      ...baseMonitoredLease,
      status: "Frozen",
    });
    expect(isFrozenLease(lease)).toBe(true);
    expect(isActiveLease(lease)).toBe(false);
    expect(isMonitoredLease(lease)).toBe(true);
  });

  it("isExpiredLease identifies Expired", () => {
    const lease = PersistedLeaseSchema.parse(baseExpiredLease);
    expect(isExpiredLease(lease)).toBe(true);
    expect(isMonitoredLease(lease)).toBe(false);
  });
});

describe("newestCopyOfEachLease", () => {
  const copy = (uuid: string, status: string, lastEditTime?: string) => ({
    uuid,
    status,
    meta: lastEditTime === undefined ? {} : { lastEditTime },
  });

  it("keeps the most recently edited copy of a lease, whichever comes first", () => {
    const older = copy("lease-1", "Active", "2026-10-20T00:00:00.000Z");
    const newer = copy("lease-1", "Frozen", "2026-10-20T00:00:01.000Z");
    const unstamped = copy("lease-1", "Active");

    expect(newestCopyOfEachLease([older, newer])).toEqual([newer]);
    expect(newestCopyOfEachLease([newer, older])).toEqual([newer]);
    expect(newestCopyOfEachLease([unstamped, older])).toEqual([older]);
    expect(newestCopyOfEachLease([older, unstamped])).toEqual([older]);
  });

  it("keeps the later copy in the list when the stamps tie or are both missing", () => {
    const active = copy("lease-1", "Active", "2026-10-20T00:00:00.000Z");
    const frozen = copy("lease-1", "Frozen", "2026-10-20T00:00:00.000Z");

    expect(newestCopyOfEachLease([active, frozen])).toEqual([frozen]);
    expect(newestCopyOfEachLease([frozen, active])).toEqual([active]);
    expect(
      newestCopyOfEachLease([
        copy("lease-1", "Active"),
        copy("lease-1", "Frozen"),
      ]),
    ).toEqual([copy("lease-1", "Frozen")]);
  });
});

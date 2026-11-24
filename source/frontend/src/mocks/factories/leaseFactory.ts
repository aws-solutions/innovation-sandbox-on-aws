// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ApprovalDeniedLeaseView,
  ApprovalDeniedLeaseViewSchema,
  ExpiredLeaseView,
  ExpiredLeaseViewSchema,
  LeaseView,
  LeaseViewSchema,
  MonitoredLeaseView,
  MonitoredLeaseViewSchema,
  PendingLeaseView,
  PendingLeaseViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { generateSchemaData } from "@amzn/innovation-sandbox-shared/test/generate-schema-data";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

export function createLeasePermissionProfile(): {
  defaultPermissionSet: PermissionSetReference;
  allowedPermissionSets: PermissionSetReference[];
} {
  const defaultPermissionSet: PermissionSetReference = {
    permissionSetArn:
      "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
    permissionSetId: "ps-0123456789abcdef",
    name: "DeveloperAccess",
    description: "Developer access for sandbox accounts",
    sessionDuration: "PT1H",
    availability: "AVAILABLE",
  };
  const auditorPermissionSet: PermissionSetReference = {
    permissionSetArn:
      "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
    permissionSetId: "ps-1123456789abcdef",
    name: "AuditorAccess",
    description: "Read-only access for sandbox accounts",
    sessionDuration: "PT1H",
    availability: "AVAILABLE",
  };

  return {
    defaultPermissionSet,
    allowedPermissionSets: [defaultPermissionSet, auditorPermissionSet],
  };
}

export function createLease(overrides?: Partial<LeaseView>): LeaseView {
  return generateSchemaData(LeaseViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    ...createLeasePermissionProfile(),
    resourceLock: undefined,
    ...overrides,
  });
}

/** Overrides the generated read-path ID when a test needs a stable route ID. */
export function withLeaseId<T extends LeaseView>(
  lease: T,
  leaseId: string,
): T & { leaseId: string } {
  return { ...lease, leaseId };
}

export function createActiveLease(
  overrides?: Partial<MonitoredLeaseView>,
): MonitoredLeaseView {
  return generateSchemaData(MonitoredLeaseViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    ...createLeasePermissionProfile(),
    status: "Active",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createPendingLease(
  overrides?: Partial<PendingLeaseView>,
): PendingLeaseView {
  return generateSchemaData(PendingLeaseViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    ...createLeasePermissionProfile(),
    status: "PendingApproval",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createApprovalDeniedLease(
  overrides?: Partial<ApprovalDeniedLeaseView>,
): ApprovalDeniedLeaseView {
  return generateSchemaData(ApprovalDeniedLeaseViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    ...createLeasePermissionProfile(),
    status: "ApprovalDenied",
    resourceLock: undefined,
    ...overrides,
  });
}

export function createExpiredLease(
  overrides?: Partial<ExpiredLeaseView>,
): ExpiredLeaseView {
  return generateSchemaData(ExpiredLeaseViewSchema, {
    rateLimits: undefined,
    predictiveBudgetEnabled: false,
    bedrockTokenMonitoringEnabled: false,
    ...createLeasePermissionProfile(),
    status: "Expired",
    resourceLock: undefined,
    ...overrides,
  });
}

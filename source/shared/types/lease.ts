// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  AwsAccountIdSchema,
  enumErrorMap,
  FreeTextSchema,
} from "../utils/zod.js";
import { LeaseTemplateWritableSchema } from "./lease-template.js";
import { PermissionSetArnSchema } from "./permission-set.js";
import { IdcPrincipalIdSchema, PrincipalTypeSchema } from "./principal.js";
import { ResourceLockSchema } from "./resource-lock.js";

// Neutral lease lifecycle values shared across persistence, API adapters, and
// the frontend. Storage version bounds and API-only IDs belong in layer projections.

export const CriticalLockIntents = ["TERMINATE", "FREEZE"] as const;
export const OverridableLockIntents = [
  "UPDATE",
  "PUBLISH",
  "UNFREEZE",
] as const;

export const LeaseLockIntentSchema = z.enum([
  ...CriticalLockIntents,
  ...OverridableLockIntents,
]);

export const LeaseLockMetaSchema = z
  .object({
    intent: LeaseLockIntentSchema,
  })
  .strict();

export type LeaseLockIntent = z.infer<typeof LeaseLockIntentSchema>;

export const BlockingLockIntents = {
  TERMINATE: ["TERMINATE"],
  FREEZE: ["TERMINATE", "FREEZE"],
} as const satisfies Record<
  (typeof CriticalLockIntents)[number],
  readonly LeaseLockIntent[]
>;

export const LeaseResourceLockSchema = ResourceLockSchema.omit({
  meta: true,
})
  .extend({
    meta: LeaseLockMetaSchema.optional(),
  })
  .strict();

export const DesiredAssignmentSchema = z.object({
  principalId: IdcPrincipalIdSchema,
  principalType: PrincipalTypeSchema,
  permissionSetArn: PermissionSetArnSchema.optional(),
});

export const MAX_ASSIGNMENTS = 20;
export const MAX_USER_MANAGED_ASSIGNMENTS = MAX_ASSIGNMENTS - 1;

export const DesiredAssignmentWithDisplaySchema =
  DesiredAssignmentSchema.extend({
    displayName: z.string().optional(),
    email: z.email().optional(),
  });

export const PendingLeaseStatusSchema = z.literal("PendingApproval");
export const ApprovalDeniedLeaseStatusSchema = z.literal("ApprovalDenied");
export const MonitoredLeaseStatusSchema = z.enum(
  ["Active", "Frozen", "Provisioning"],
  { error: enumErrorMap },
);
export const ExpiredLeaseStatusSchema = z.enum(
  [
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "UserTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ],
  { error: enumErrorMap },
);

export const AllLeaseStatusSchema = z.enum(
  [
    PendingLeaseStatusSchema.value,
    ApprovalDeniedLeaseStatusSchema.value,
    ...MonitoredLeaseStatusSchema.options,
    ...ExpiredLeaseStatusSchema.options,
  ],
  { error: enumErrorMap },
);

export const LeaseMetadataSchema = z.object({
  createdTime: z.iso.datetime().optional(),
  lastEditTime: z.iso.datetime().optional(),
});

export const LeaseKeySchema = z.object({
  userEmail: z.email(),
  uuid: z.uuid(),
});

export const PendingLeaseSchema = LeaseKeySchema.extend({
  status: PendingLeaseStatusSchema,
  originalLeaseTemplateUuid: z.uuid(),
  originalLeaseTemplateName: LeaseTemplateWritableSchema.shape.name,
  comments: FreeTextSchema.optional(),
  createdBy: z.email().optional(),
  blueprintId: z.uuid().nullable().optional(),
  blueprintName: z.string().nullable().optional(),
  allowOwnerToShareLease: z.boolean().optional(),
  predictiveBudgetEnabled: z.boolean().optional(),
  bedrockTokenMonitoringEnabled: z.boolean().optional(),
  sandboxSpacesEnabled: LeaseTemplateWritableSchema.shape.sandboxSpacesEnabled,
  allowedModelIds: LeaseTemplateWritableSchema.shape.allowedModelIds,
  defaultModelId: LeaseTemplateWritableSchema.shape.defaultModelId,
  desiredAssignments: z.array(DesiredAssignmentWithDisplaySchema).optional(),
  resourceLock: LeaseResourceLockSchema.nullable().optional(),
  ...LeaseTemplateWritableSchema.pick({
    maxSpend: true,
    leaseDurationInHours: true,
    budgetThresholds: true,
    durationThresholds: true,
    costReportGroup: true,
    rateLimits: true,
    defaultPermissionSetArn: true,
    allowedPermissionSetArns: true,
  }).shape,
  meta: LeaseMetadataSchema.optional(),
});

export const TtlSchema = z.number().int().nonnegative();

export const ApprovalDeniedLeaseSchema = PendingLeaseSchema.extend({
  status: ApprovalDeniedLeaseStatusSchema,
  ttl: TtlSchema,
});

export const ApprovedBySchema = z.union([
  z.email(),
  z.literal("AUTO_APPROVED"),
]);

/**
 * Written last by a lifecycle transition (terminate or freeze), once its
 * follow-up work is dispatched: assignment processing requested and the final
 * events (CleanAccountRequest, LeaseTerminated / LeaseFrozen) accepted. It does
 * not mean that work finished; each consumer tracks its own outcome. The status
 * write commits first, so only this marker proves the transition's own part is
 * done. The status write that starts a transition clears it.
 */
export const LeaseLifecycleDispatchSchema = z
  .object({
    intent: z.enum(["TERMINATE", "FREEZE"], { error: enumErrorMap }),
    dispatchedAt: z.iso.datetime(),
  })
  .strict();
export type LeaseLifecycleDispatch = z.infer<
  typeof LeaseLifecycleDispatchSchema
>;

export const MonitoredLeaseSchema = PendingLeaseSchema.extend({
  status: MonitoredLeaseStatusSchema,
  awsAccountId: AwsAccountIdSchema,
  approvedBy: ApprovedBySchema,
  startDate: z.iso.datetime(),
  expirationDate: z.iso.datetime().optional(),
  lastCheckedDate: z.iso.datetime(),
  totalCostAccrued: z.number(),
  // Written by lease monitoring: the last predicted spend is the billed total
  // while no rate exists; null only before the first run.
  lastPredictedSpend: z.number().nullable().optional(),
  lastEvaluatedSpend: z.number().nullable().optional(),
  lastEvaluatedHourlySpendRate: z.number().nullable().optional(),
  lastEvaluatedDailySpendRate: z.number().nullable().optional(),
  lifecycleDispatch: LeaseLifecycleDispatchSchema.nullable().optional(),
});

export const ExpiredLeaseSchema = MonitoredLeaseSchema.extend({
  status: ExpiredLeaseStatusSchema,
  endDate: z.iso.datetime(),
  ttl: TtlSchema,
});

export const LeaseSchema = z.discriminatedUnion("status", [
  PendingLeaseSchema,
  ApprovalDeniedLeaseSchema,
  MonitoredLeaseSchema,
  ExpiredLeaseSchema,
]);

export type LeaseLockMeta = z.infer<typeof LeaseLockMetaSchema>;
export type LeaseResourceLock = z.infer<typeof LeaseResourceLockSchema>;
export type DesiredAssignment = z.infer<typeof DesiredAssignmentSchema>;
export type DesiredAssignmentWithDisplay = z.infer<
  typeof DesiredAssignmentWithDisplaySchema
>;
export type LeaseStatus = z.infer<typeof AllLeaseStatusSchema>;
export type PendingLeaseStatus = z.infer<typeof PendingLeaseStatusSchema>;
export type ApprovalDeniedLeaseStatus = z.infer<
  typeof ApprovalDeniedLeaseStatusSchema
>;
export type MonitoredLeaseStatus = z.infer<typeof MonitoredLeaseStatusSchema>;
export type ExpiredLeaseStatus = z.infer<typeof ExpiredLeaseStatusSchema>;
export type Lease = z.infer<typeof LeaseSchema>;
export type PendingLease = z.infer<typeof PendingLeaseSchema>;
export type ApprovalDeniedLease = z.infer<typeof ApprovalDeniedLeaseSchema>;
export type MonitoredLease = z.infer<typeof MonitoredLeaseSchema>;
export type ExpiredLease = z.infer<typeof ExpiredLeaseSchema>;
export type LeaseKey = z.infer<typeof LeaseKeySchema>;

export function isPendingLease<T extends Lease>(
  lease: T,
): lease is T & PendingLease {
  return lease.status === "PendingApproval";
}

export function isApprovalDeniedLease<T extends Lease>(
  lease: T,
): lease is T & ApprovalDeniedLease {
  return lease.status === "ApprovalDenied";
}

export function isMonitoredLease<T extends Lease>(
  lease: T,
): lease is T & MonitoredLease {
  return MonitoredLeaseStatusSchema.safeParse(lease.status).success;
}

export function isActiveLease<T extends Lease>(
  lease: T,
): lease is T & MonitoredLease {
  return lease.status === "Active";
}

export function isFrozenLease<T extends Lease>(
  lease: T,
): lease is T & MonitoredLease {
  return lease.status === "Frozen";
}

export function isExpiredLease<T extends Lease>(
  lease: T,
): lease is T & ExpiredLease {
  return ExpiredLeaseStatusSchema.safeParse(lease.status).success;
}

/**
 * The lease's current spend. With Bedrock token monitoring on, the greater of
 * the billed `totalCostAccrued` and `lastEvaluatedSpend`, which uses
 * monitored Bedrock token spend in place of the billed token cost.
 * Separate runs write the two fields, so either one can be higher for a while.
 * With it off, `lastEvaluatedSpend` is only a copy of an earlier bill, so the
 * billed total is used.
 */
export function getCurrentLeaseSpend(
  lease: Pick<
    MonitoredLease,
    "totalCostAccrued" | "lastEvaluatedSpend" | "bedrockTokenMonitoringEnabled"
  >,
): number {
  if (!lease.bedrockTokenMonitoringEnabled) {
    return lease.totalCostAccrued;
  }
  return Math.max(lease.totalCostAccrued, lease.lastEvaluatedSpend ?? 0);
}

// Shared so the frontend can recognize this batch-review conflict without
// duplicating the message returned by the handler.
export const LEASE_NOT_PENDING_REVIEW_ERROR =
  "Only leases in a pending state can be approved/denied.";

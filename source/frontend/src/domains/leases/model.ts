// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseLockIntentSchema,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  PermissionSetReferenceSchema,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import { PrincipalTypeSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";

// Frontend read models add API-only identifiers and assignment projections to
// the neutral lease lifecycle types. Persistence version bounds stay backend-owned.
const LeaseIdSchema = z.string().min(1);
const LeasePermissionProfileViewFields = {
  defaultPermissionSet: PermissionSetReferenceSchema,
  allowedPermissionSets: z
    .array(PermissionSetReferenceSchema)
    .max(MAX_ALLOWED_PERMISSION_SETS),
};

export const SelectableModelViewSchema = z.strictObject({
  modelId: z.string().min(1),
  displayName: z.string().min(1),
  provider: z.string().min(1),
});
export const SelectableModelListSchema = z.array(SelectableModelViewSchema);

const LeaseViewFields = {
  leaseId: LeaseIdSchema,
  selectableModels: SelectableModelListSchema,
  ...LeasePermissionProfileViewFields,
};

type LeasePermissionProfilePersistenceShape = {
  defaultPermissionSetArn: z.ZodType;
  allowedPermissionSetArns: z.ZodType;
};

const toLeaseViewSchema = <
  T extends z.ZodRawShape & LeasePermissionProfilePersistenceShape,
>(
  schema: z.ZodObject<T>,
) => {
  const { defaultPermissionSetArn, allowedPermissionSetArns, ...viewShape } =
    schema.shape;

  return z.object({
    ...viewShape,
    ...LeaseViewFields,
  });
};

export const PendingLeaseViewSchema = toLeaseViewSchema(PendingLeaseSchema);
export const ApprovalDeniedLeaseViewSchema = toLeaseViewSchema(
  ApprovalDeniedLeaseSchema,
);
export const MonitoredLeaseViewSchema = toLeaseViewSchema(MonitoredLeaseSchema);
export const ExpiredLeaseViewSchema = toLeaseViewSchema(ExpiredLeaseSchema);

export const LeaseViewSchema = z.discriminatedUnion("status", [
  PendingLeaseViewSchema,
  ApprovalDeniedLeaseViewSchema,
  MonitoredLeaseViewSchema,
  ExpiredLeaseViewSchema,
]);

export const AssignmentSyncStatusSchema = z.enum([
  "active",
  "granting",
  "revoking",
  "suspended",
  "grantFailed",
  "revokeFailed",
]);

export const LeaseAssignmentViewSchema = z.strictObject({
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
  assigneeEmail: z.string().optional(),
  displayName: z.string(),
  addedBy: z.string().optional(),
  addedDate: z.string().optional(),
  isOwner: z.boolean(),
  isDesired: z.boolean(),
  syncStatus: AssignmentSyncStatusSchema,
  permissionSet: PermissionSetReferenceSchema,
});

export const GetLeaseAssignmentsResponseSchema = z.strictObject({
  assignments: z.array(LeaseAssignmentViewSchema),
  operationInProgress: LeaseLockIntentSchema.optional(),
});

export const UpdateLeaseAssignmentsResponseSchema = z.strictObject({
  desiredCount: z.number().int().nonnegative(),
});

export const SharedLeaseAccessTypeSchema = z.enum([
  "direct",
  "group",
  "owner",
  "global",
]);

const SharedLeaseFields = {
  accessType: SharedLeaseAccessTypeSchema,
  sourceGroupName: z.string().optional(),
};

export const SharedLeaseViewSchema = z.discriminatedUnion("status", [
  PendingLeaseViewSchema.extend(SharedLeaseFields),
  ApprovalDeniedLeaseViewSchema.extend(SharedLeaseFields),
  MonitoredLeaseViewSchema.extend(SharedLeaseFields),
  ExpiredLeaseViewSchema.extend(SharedLeaseFields),
]);

export type LeaseView = z.infer<typeof LeaseViewSchema>;
export type SelectableModelView = z.infer<typeof SelectableModelViewSchema>;
export type PendingLeaseView = z.infer<typeof PendingLeaseViewSchema>;
export type ApprovalDeniedLeaseView = z.infer<
  typeof ApprovalDeniedLeaseViewSchema
>;
export type MonitoredLeaseView = z.infer<typeof MonitoredLeaseViewSchema>;
export type ExpiredLeaseView = z.infer<typeof ExpiredLeaseViewSchema>;
export type LeaseAssignmentView = z.infer<typeof LeaseAssignmentViewSchema>;
export type AssignmentSyncStatus = z.infer<typeof AssignmentSyncStatusSchema>;
export type GetLeaseAssignmentsResponse = z.infer<
  typeof GetLeaseAssignmentsResponseSchema
>;
export type UpdateLeaseAssignmentsResponse = z.infer<
  typeof UpdateLeaseAssignmentsResponseSchema
>;
export type SharedLeaseAccessType = z.infer<typeof SharedLeaseAccessTypeSchema>;
export type SharedLeaseView = z.infer<typeof SharedLeaseViewSchema>;

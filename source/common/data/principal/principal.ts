// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  ASSIGNMENT_SK_PATTERN,
  parseAssignmentSk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  PermissionSetArnSchema,
  permissionSetIdFromArn,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import {
  IdcPrincipalIdSchema,
  IdcPrincipalSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

export const PrincipalSchemaVersion = 2;

const PrincipalSupportedVersionsSchema = createVersionRangeSchema(
  1,
  PrincipalSchemaVersion,
);

const PrincipalItemWithMetadataSchema = createItemWithMetadataSchema(
  PrincipalSupportedVersionsSchema,
);

const AssignmentSkSchema = z
  .string()
  .regex(
    ASSIGNMENT_SK_PATTERN,
    "sk must be 'lease#<leaseId>' with an optional '#ps#<permissionSetId>' suffix",
  );

// IDC principal ID: plain UUID (36 chars) or 10-char hex prefix + UUID (47 chars)
const IDC_PRINCIPAL_ID_PATTERN =
  "([0-9a-f]{10}-)?[A-Fa-f0-9]{8}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{4}-[A-Fa-f0-9]{12}";

const UserPkSchema = z
  .string()
  .regex(
    new RegExp(`^user#${IDC_PRINCIPAL_ID_PATTERN}$`),
    "pk must be 'user#' followed by a valid IDC user ID",
  );

const GroupPkSchema = z
  .string()
  .regex(
    new RegExp(`^group#${IDC_PRINCIPAL_ID_PATTERN}$`),
    "pk must be 'group#' followed by a valid IDC group ID",
  );

export const PersistedUserAssignmentKeySchema = z.strictObject({
  pk: UserPkSchema,
  sk: AssignmentSkSchema,
});

export const PersistedGroupAssignmentKeySchema = z.strictObject({
  pk: GroupPkSchema,
  sk: AssignmentSkSchema,
});

type AssignmentKeyFields = {
  sk: string;
  leaseId: string;
  permissionSetArn?: string;
};

function validateAssignmentKeyFields(
  assignment: AssignmentKeyFields,
  ctx: z.RefinementCtx,
): void {
  const parsedSk = parseAssignmentSk(assignment.sk);
  if (!parsedSk) {
    return;
  }

  if (parsedSk.leaseId !== assignment.leaseId) {
    ctx.addIssue({
      code: "custom",
      path: ["sk"],
      message: "Lease ID encoded in sk must match leaseId",
    });
  }

  if (parsedSk.permissionSetId !== undefined) {
    if (assignment.permissionSetArn === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["permissionSetArn"],
        message: "Tuple-keyed assignments must include permissionSetArn",
      });
    } else if (
      permissionSetIdFromArn(assignment.permissionSetArn) !==
      parsedSk.permissionSetId
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["sk"],
        message: "Permission set ID encoded in sk must match permissionSetArn",
      });
    }
  }
}

export const PersistedAssignmentLeaseIndexKeySchema = z
  .strictObject({
    pk: z.union([UserPkSchema, GroupPkSchema]),
    sk: AssignmentSkSchema,
    leaseId: z.uuid(),
  })
  .superRefine(({ sk, leaseId }, ctx) => {
    if (parseAssignmentSk(sk)?.leaseId !== leaseId) {
      ctx.addIssue({
        code: "custom",
        path: ["sk"],
        message: "Lease ID encoded in sk must match leaseId",
      });
    }
  });

/** Direct user-to-lease assignment record. */
const PersistedUserAssignmentBaseSchema = z.strictObject({
  ...PersistedUserAssignmentKeySchema.shape,
  userId: IdcPrincipalIdSchema,
  principalType: z.literal("USER"),
  leaseId: z.uuid(),
  displayName: z.string().min(1).optional(),
  assigneeEmail: z.email(),
  leaseOwnerEmail: z.email(),
  accountId: AwsAccountIdSchema.optional(),
  permissionSetArn: PermissionSetArnSchema.optional(),
  addedBy: z.email(),
  addedDate: z.iso.datetime(),
  ...PrincipalItemWithMetadataSchema.shape,
});

export const PersistedUserAssignmentSchema =
  PersistedUserAssignmentBaseSchema.superRefine(validateAssignmentKeyFields);

/** Group-to-lease assignment record. */
const PersistedGroupAssignmentBaseSchema = z.strictObject({
  ...PersistedGroupAssignmentKeySchema.shape,
  leaseId: z.uuid(),
  groupId: IdcPrincipalIdSchema,
  principalType: z.literal("GROUP"),
  displayName: z
    .string()
    .min(1)
    .max(1024)
    .regex(
      /^[\p{L}\p{M}\p{S}\p{N}\p{P}\t\n\r ]+$/u,
      "Must be a valid IDC group display name",
    ),
  leaseOwnerEmail: z.email(),
  accountId: AwsAccountIdSchema.optional(),
  permissionSetArn: PermissionSetArnSchema.optional(),
  addedBy: z.email(),
  addedDate: z.iso.datetime(),
  ...PrincipalItemWithMetadataSchema.shape,
});

export const PersistedGroupAssignmentSchema =
  PersistedGroupAssignmentBaseSchema.superRefine(validateAssignmentKeyFields);

/** Validates the KEYS_ONLY projection of group-assignment records on the `GroupIndex` GSI. */
export const PersistedGroupIndexProjectionSchema =
  PersistedGroupAssignmentBaseSchema.pick({
    pk: true,
    sk: true,
    groupId: true,
  });

/** Cached IDC group IDs for a user, refreshed lazily with 24h TTL. PK: `user#<userId>`, SK: `groupMembership`. */
export const PersistedGroupMembershipCacheKeySchema = z.strictObject({
  pk: UserPkSchema,
  sk: z.literal("groupMembership"),
});

export const PersistedGroupMembershipCacheSchema = z.strictObject({
  ...PersistedGroupMembershipCacheKeySchema.shape,
  groupIds: z.array(IdcPrincipalIdSchema),
  ttl: z.number().int().nonnegative(),
  ...PrincipalItemWithMetadataSchema.shape,
});

export type PersistedUserAssignment = z.infer<
  typeof PersistedUserAssignmentSchema
>;
export type PersistedGroupAssignment = z.infer<
  typeof PersistedGroupAssignmentSchema
>;
export type PersistedGroupMembershipCache = z.infer<
  typeof PersistedGroupMembershipCacheSchema
>;

/** Union of user and group assignment records, discriminated on principalType. */
export const PersistedAssignmentSchema = z.discriminatedUnion("principalType", [
  PersistedUserAssignmentSchema,
  PersistedGroupAssignmentSchema,
]);
export type PersistedAssignment = z.infer<typeof PersistedAssignmentSchema>;

/** Union of all principal table item types. */
export type PersistedPrincipalTableItem =
  | PersistedUserAssignment
  | PersistedGroupAssignment
  | PersistedGroupMembershipCache
  | PersistedPrincipalCacheItem;

/** Cached IDC principal for typeahead search. PK: `principalCache`, SK: `user#<userId>` or `group#<groupId>`. */
export const PRINCIPAL_CACHE_PK = "principalCache" as const;
export const PRINCIPAL_CACHE_USER_SK_PREFIX = "user#" as const;
export const PRINCIPAL_CACHE_GROUP_SK_PREFIX = "group#" as const;

/** Schema for cached principal records synced hourly from Identity Store. */
export const PersistedPrincipalCacheItemKeySchema = z.strictObject({
  pk: z.literal(PRINCIPAL_CACHE_PK),
  sk: z
    .string()
    .regex(
      new RegExp(
        `^(${PRINCIPAL_CACHE_USER_SK_PREFIX}|${PRINCIPAL_CACHE_GROUP_SK_PREFIX})${IDC_PRINCIPAL_ID_PATTERN}$`,
      ),
      "sk must be 'user#' or 'group#' followed by a valid IDC principal ID",
    ),
});

export const PersistedPrincipalCacheItemSchema = z.strictObject({
  ...PersistedPrincipalCacheItemKeySchema.shape,
  ...IdcPrincipalSchema.shape,
  syncedAt: z.iso.datetime(),
  ttl: z.number().int().nonnegative(),
  ...PrincipalItemWithMetadataSchema.shape,
});

export type PersistedPrincipalCacheItem = z.infer<
  typeof PersistedPrincipalCacheItemSchema
>;

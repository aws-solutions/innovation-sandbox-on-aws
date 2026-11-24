// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  PERMISSION_SET_ID_PATTERN,
  PermissionSetArnSchema,
  PermissionSetDescriptionSchema,
  PermissionSetIdSchema,
  PermissionSetNameSchema,
  PermissionSetSessionDurationSchema,
  type PermissionSetSummary,
  permissionSetIdFromArn,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const PermissionSetSchemaVersion = 1;

const PermissionSetSupportedVersionsSchema = createVersionRangeSchema(
  1,
  PermissionSetSchemaVersion,
);

const PermissionSetItemWithMetadataSchema = createItemWithMetadataSchema(
  PermissionSetSupportedVersionsSchema,
);

/** Tag key that registers a permission set with one ISB namespace. */
export function managedPermissionSetTagKey(namespace: string): string {
  return `ISB:${namespace}:ManagedPermissionSet`;
}

export const MANAGED_PERMISSION_SET_TAG_VALUE = "true";

export const PERMISSION_SET_CACHE_PK = "permissionSetCache" as const;
export const PERMISSION_SET_CACHE_SK_PREFIX = "ps#" as const;

export function permissionSetCacheSk(permissionSetId: string): string {
  return `${PERMISSION_SET_CACHE_SK_PREFIX}${permissionSetId}`;
}

/**
 * A registered permission set cached in the Principal Table.
 *
 * This item intentionally has no TTL. Reconciliation removes stale entries;
 * expiration could silently orphan templates and leases that reference them.
 */
export const PersistedPermissionSetCacheItemSchema = z
  .object({
    pk: z.literal(PERMISSION_SET_CACHE_PK),
    sk: z
      .string()
      .regex(
        new RegExp(
          `^${PERMISSION_SET_CACHE_SK_PREFIX}${PERMISSION_SET_ID_PATTERN}$`,
        ),
        "sk must be 'ps#' followed by a valid permission set ID",
      ),
    permissionSetArn: PermissionSetArnSchema,
    permissionSetId: PermissionSetIdSchema,
    name: PermissionSetNameSchema,
    description: PermissionSetDescriptionSchema.optional(),
    sessionDuration: PermissionSetSessionDurationSchema.optional(),
    syncedAt: z.iso.datetime(),
  })
  .extend(PermissionSetItemWithMetadataSchema.shape)
  .strict()
  .superRefine(({ sk, permissionSetArn, permissionSetId }, ctx) => {
    if (sk !== permissionSetCacheSk(permissionSetId)) {
      ctx.addIssue({
        code: "custom",
        path: ["sk"],
        message: "sk must match permissionSetId",
      });
    }
    if (permissionSetIdFromArn(permissionSetArn) !== permissionSetId) {
      ctx.addIssue({
        code: "custom",
        path: ["permissionSetId"],
        message: "permissionSetId must match permissionSetArn",
      });
    }
  });

export type PersistedPermissionSetCacheItem = z.infer<
  typeof PersistedPermissionSetCacheItemSchema
>;
export function toPermissionSetSummary(
  item: PersistedPermissionSetCacheItem,
): PermissionSetSummary {
  return {
    permissionSetArn: item.permissionSetArn,
    permissionSetId: item.permissionSetId,
    name: item.name,
    description: item.description,
    sessionDuration: item.sessionDuration,
  };
}

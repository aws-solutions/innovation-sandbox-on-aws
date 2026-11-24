// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { createVersionRangeSchema } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { parseDatetime } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  AllLeaseStatusSchema,
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseKeySchema,
  LeaseMetadataSchema,
  LeaseSchema,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

// IMPORTANT -- this value must be updated whenever the persisted schema changes.
export const LeaseSchemaVersion = 5; // Target: ISB v1.4.0

const LeaseSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseSchemaVersion,
);

export const PersistedLeaseMetadataSchema = LeaseMetadataSchema.extend({
  schemaVersion: LeaseSupportedVersionsSchema,
});

export const PersistedLeaseStatusIndexKeySchema = z.strictObject({
  ...LeaseKeySchema.shape,
  status: AllLeaseStatusSchema,
  originalLeaseTemplateUuid: PendingLeaseSchema.shape.originalLeaseTemplateUuid,
});

export const PersistedPendingLeaseSchema = PendingLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedApprovalDeniedLeaseSchema =
  ApprovalDeniedLeaseSchema.extend({
    meta: PersistedLeaseMetadataSchema.optional(),
  });

export const PersistedMonitoredLeaseSchema = MonitoredLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedExpiredLeaseSchema = ExpiredLeaseSchema.extend({
  meta: PersistedLeaseMetadataSchema.optional(),
});

export const PersistedLeaseSchema = z.discriminatedUnion("status", [
  PersistedPendingLeaseSchema,
  PersistedApprovalDeniedLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedExpiredLeaseSchema,
]) satisfies z.ZodType<z.infer<typeof LeaseSchema>>;

export type PersistedLease = z.infer<typeof PersistedLeaseSchema>;
export type PersistedPendingLease = z.infer<typeof PersistedPendingLeaseSchema>;
export type PersistedApprovalDeniedLease = z.infer<
  typeof PersistedApprovalDeniedLeaseSchema
>;
export type PersistedMonitoredLease = z.infer<
  typeof PersistedMonitoredLeaseSchema
>;
export type PersistedExpiredLease = z.infer<typeof PersistedExpiredLeaseSchema>;

/**
 * One copy of each lease: the one with the latest meta.lastEditTime. A lease
 * whose status changes between two status queries comes back from both. Every
 * status change rewrites meta.lastEditTime, so the latest copy is normally the
 * current one, but the stamp has millisecond precision and can be missing. On a
 * tie (equal stamps, or neither has one) the copy later in the list is kept, so
 * a caller lists the results of its later or preferred query last.
 */
export function newestCopyOfEachLease<
  T extends { uuid: string; meta?: { lastEditTime?: string } },
>(leases: T[]): T[] {
  const newest = new Map<string, T>();
  for (const lease of leases) {
    const kept = newest.get(lease.uuid);
    if (kept === undefined || lastEditMillis(lease) >= lastEditMillis(kept)) {
      newest.set(lease.uuid, lease);
    }
  }
  return [...newest.values()];
}

function lastEditMillis(lease: { meta?: { lastEditTime?: string } }): number {
  const lastEditTime = lease.meta?.lastEditTime;
  if (lastEditTime === undefined) {
    return Number.NEGATIVE_INFINITY;
  }
  return parseDatetime(lastEditTime).toMillis();
}

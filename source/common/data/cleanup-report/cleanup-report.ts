// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { CleanupReasonBackwardCompatibleSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  CleanupStatusSchema,
  CleanupValidationModeSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const CleanupReportSchemaVersion = 1;

// Define supported version range for backwards compatibility
const CleanupReportSupportedVersionsSchema = createVersionRangeSchema(
  1,
  CleanupReportSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const CleanupReportItemWithMetadataSchema = createItemWithMetadataSchema(
  CleanupReportSupportedVersionsSchema,
);

export const CleanupReportStatusSchema = z.enum([
  "IN_PROGRESS",
  "COMPLETED",
  "FAILED",
]);

/**
 * Base cleanup step entry. Required fields are `name` and `startedAt`.
 * Step-specific metadata (e.g., codeBuildExecutionArn, cooldownDurationHours)
 * is stored in the optional `meta` field.
 *
 * For most steps, duration is inferred from the gap between consecutive
 * `startedAt` values — this works because each report step represents a
 * logical phase that ends when the next phase begins.
 *
 * `completedAt` is used only for nuke-phase steps, which have a non-linear
 * lifecycle (start build → wait for callback → record outcome) and may fail
 * without ending the overall cleanup. Written via `updateStepAtIndex` after
 * the build completes.
 */
export const CleanupStepSchema = z.object({
  name: z.string().min(1),
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  meta: z.record(z.string(), z.unknown()).optional(),
});

/**
 * The steps array accepts step objects with required `name` + `startedAt`
 * and an optional `meta` record for step-specific data.
 */
export const CleanupReportStepSchema = CleanupStepSchema;

/**
 * The steps array: each entry includes a `name` field identifying the step
 * and a `startedAt` timestamp. Steps are append-only — the end time of each
 * step is inferred from the `startedAt` of the next step in the array.
 *
 * Example:
 * ```json
 * {
 *   "pk": "123456789012",
 *   "sk": "CleanupReport#2026-03-25T14:30:00.000Z",
 *   "accountId": "123456789012",
 *   "durableExecutionArn": "arn:aws:lambda:us-east-1:...:function:cleanup:exec-1",
 *   "status": "COMPLETED",
 *   "cleanupStatus": "COMPLETED",
 *   "startedAt": "2026-03-25T14:30:00.000Z",
 *   "completedAt": "2026-03-25T15:05:00.000Z",
 *   "reasonForCleanup": "LEASE_TERMINATION",
 *   "steps": [
 *     { "name": "initialize-cleanup", "startedAt": "2026-03-25T14:30:05.000Z" },
 *     { "name": "nuke-phase-1", "startedAt": "2026-03-25T14:30:10.000Z", "meta": { "codeBuildExecutionArn": "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123" } },
 *     { "name": "nuke-phase-2", "startedAt": "2026-03-25T14:50:10.000Z", "meta": { "codeBuildExecutionArn": "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:def-456" } },
 *     { "name": "cleanup-complete", "startedAt": "2026-03-25T15:05:00.000Z" }
 *   ],
 *   "ttl": 1774569000,
 *   "meta": { "schemaVersion": 1, "createdTime": "...", "lastEditTime": "..." }
 * }
 * ```
 */
export const CleanupReportStepsSchema = z.array(CleanupReportStepSchema);

export const ResourceSummaryByTypeSchema = z.record(
  z.string(),
  z.number().int().nonnegative(),
);

export const ResourceCountSchema = z.object({
  totalCount: z.number().int().nonnegative(),
  ignoredCount: z.number().int().nonnegative(),
  byType: ResourceSummaryByTypeSchema,
});

/**
 * Individual resource entry stored in the report for admin diagnostics.
 */
export const ResourceEntrySchema = z.object({
  arn: z.string(),
  resourceType: z.string(),
  region: z.string(),
});

export type ResourceEntry = z.infer<typeof ResourceEntrySchema>;

/**
 * Resource summary written after post-cleanup validation completes.
 * Written once as a single atomic update — `beforeCleanup` and `afterCooldown`
 * are optional because the report exists before validation runs.
 *
 * Example:
 * ```json
 * {
 *   "validationMode": "Quarantine",
 *   "beforeCleanup": { "totalCount": 42, "ignoredCount": 5, "byType": { "ec2:instance": 3, "s3:bucket": 2 } },
 *   "afterCooldown": { "totalCount": 0, "ignoredCount": 5, "byType": {} },
 *   "remainingTypes": [],
 *   "remainingResources": [],
 *   "remainingResourcesTotalCount": 0,
 *   "ignoredResources": []
 * }
 * ```
 */
export const ResourceSummarySchema = z.object({
  validationMode: CleanupValidationModeSchema.optional(),
  beforeCleanup: ResourceCountSchema.optional(),
  // afterCleanup = post-nuke, afterCooldown = post-cooldown; their diff is the
  // Resource Explorer staleness signal.
  afterCleanup: ResourceCountSchema.optional(),
  afterCooldown: ResourceCountSchema.optional(),
  remainingTypes: z.array(z.string()).optional(),
  remainingResources: z.array(ResourceEntrySchema).optional(),
  remainingResourcesTotalCount: z.number().int().nonnegative().optional(),
  ignoredResources: z.array(ResourceEntrySchema).optional(),
  ignoredResourcesTotalCount: z.number().int().nonnegative().optional(),
});

export const CleanupReportErrorSchema = z.object({
  step: z.string(),
  message: z.string(),
});

/**
 * Summary of IDC access cleanup performed before nuke.
 * Written by the cleanup-account-access step; read by finalize for the summary metric.
 */
export const AccessCleanupSummarySchema = z.object({
  assignmentsFound: z.number().int().nonnegative(),
  assignmentsDeleted: z.number().int().nonnegative(),
  principalRecordsFound: z.number().int().nonnegative(),
  principalRecordsDeleted: z.number().int().nonnegative(),
  failed: z.boolean(),
});

export type AccessCleanupSummary = z.infer<typeof AccessCleanupSummarySchema>;

export const PersistedCleanupReportKeySchema = z.strictObject({
  pk: AwsAccountIdSchema,
  sk: z
    .string()
    .regex(/^CleanupReport#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/),
});

export const PersistedCleanupReportSchema = z.object({
  ...PersistedCleanupReportKeySchema.shape,
  accountId: AwsAccountIdSchema,
  durableExecutionArn: z.string().min(1),
  status: CleanupReportStatusSchema,
  cleanupStatus: CleanupStatusSchema,
  startedAt: z.iso.datetime(),
  completedAt: z.iso.datetime().optional(),
  reasonForCleanup: CleanupReasonBackwardCompatibleSchema,
  // Identity that initiated the cleanup, when a specific actor is known
  // (e.g. the admin email for a manually-initiated cleanup). Omitted for
  // system-triggered cleanups.
  initiatedBy: z.string().optional(),
  resourceSummary: ResourceSummarySchema.optional(),
  accessCleanupSummary: AccessCleanupSummarySchema.optional(),
  steps: CleanupReportStepsSchema,
  error: CleanupReportErrorSchema.optional(),
  skipCooldownCallbackId: z.string().optional(),
  cooldownSkippedBy: z.string().optional(),
  ttl: z.number().int().nonnegative(),
  ...CleanupReportItemWithMetadataSchema.shape,
});

export type PersistedCleanupReport = z.infer<
  typeof PersistedCleanupReportSchema
>;
export type CleanupReportStatus = z.infer<typeof CleanupReportStatusSchema>;
export type CleanupStatusDetail = z.infer<typeof CleanupStatusSchema>;
export type { CleanupReason as ReasonForCleanup } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
export type CleanupStep = z.infer<typeof CleanupStepSchema>;
export type CleanupReportStep = z.infer<typeof CleanupReportStepSchema>;
export type ResourceSummary = z.infer<typeof ResourceSummarySchema>;
export type ResourceCount = z.infer<typeof ResourceCountSchema>;
export type CleanupReportError = z.infer<typeof CleanupReportErrorSchema>;

/**
 * Immutable identifier for a cleanup report record.
 * Encapsulates the DynamoDB PK (accountId) and SK (CleanupReport#<timestamp>)
 * so callers never need to know about the underlying key structure.
 *
 * Accepts any valid ISO 8601 datetime for `startedAt` and normalizes it
 * to the exact format required by the store (YYYY-MM-DDTHH:mm:ss.SSSZ).
 */
export class CleanupReportKey {
  public readonly accountId: string;
  public readonly startedAt: string;

  constructor(accountId: string, startedAt: string) {
    const parsed = DateTime.fromISO(startedAt, { zone: "utc" });
    if (!parsed.isValid) {
      throw new Error(
        `CleanupReportKey: startedAt must be a valid ISO datetime, got "${startedAt}"`,
      );
    }
    this.accountId = accountId;
    this.startedAt = parsed.toUTC().toISO({ includeOffset: false }) + "Z";
  }

  /** String representation for logging. */
  toString(): string {
    return `CleanupReportKey(${this.accountId}, ${this.startedAt})`;
  }
}

/**
 * Typed exception thrown when a report operation is attempted before createReport.
 */
export class CleanupReportNotCreatedError extends Error {
  constructor(message?: string) {
    super(
      message ?? "Report has not been created yet. Call createReport first.",
    );
    this.name = "CleanupReportNotCreatedError";
  }
}

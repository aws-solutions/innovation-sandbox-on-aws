// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Schema version stamped onto every configuration item written to DynamoDB.
 * Increment when the stored shape changes in a non-additive way.
 */
export const ConfigSchemaVersion = 1;

/**
 * Default Terms of Service shown on fresh installs before an administrator
 * saves their own copy. Carries over the Terms of Service that previously
 * shipped in the AppConfig GlobalConfig so the defaults-first runtime model
 * preserves existing behavior for new deployments.
 */
export const DEFAULT_TERMS_OF_SERVICE = `Users, who use a leased AWS account for their sandbox experiments, should NOT,

* Attempt to access data that they are not authorized to use or access.
* Use content for a sandbox use case that has not been approved by an admin.
* Perform any unauthorized changes or store unapproved company data within the leased AWS account.
* Provide static passwords, such as default or actual passwords.
* Change or modify quotas/limits out of band for accounts.
* Transfer data or software to any person or organization not authorized to use the leased AWS account.
* Use any material or information from the leased AWS accounts, including images, logos, or photographs in any manner that violates copyright, trademark, or intellectual property laws.`;

// Schemas in this file are suffixed `Config` to disambiguate from the lease
// record schemas (e.g. `LeaseSchema` in data/lease/lease.ts). These describe
// operator configuration sections, not domain records.

/**
 * Numeric/length bounds for the configuration fields, referenced by the schemas
 * below so the limits live in one place. `ReportingConfigSchema` in
 * data/reporting-config/reporting-config.ts imports these same bounds, so the
 * cost report group limits have a single source of truth.
 */
export const CONFIG_BOUNDS = {
  MAX_BUDGET: 1_000_000_000,
  MAX_DURATION_HOURS: 87_600,
  MIN_LEASES_PER_USER: 1,
  MIN_TTL_DAYS: 1,
  MIN_LEASE_REQUEST_WINDOW_HOURS: 1,
  MIN_LEASE_REQUESTS_PER_WINDOW: 1,
  MIN_CLEANUP_VALUE: 1,
  MIN_COOLDOWN_PERIOD_HOURS: 0,
  MAX_COOLDOWN_PERIOD_HOURS: 8640,
  MIN_REPORT_RETENTION_DAYS: 14,
  MAX_REPORT_RETENTION_DAYS: 3650,
  MAX_EMAIL_LENGTH: 254,
  MAX_TERMS_OF_SERVICE_LENGTH: 10_000,
  MAX_COST_REPORT_GROUPS: 250,
  MAX_COST_REPORT_GROUP_LENGTH: 50,
} as const;

// ---------------------------------------------------------------------------
// Leases section
// ---------------------------------------------------------------------------

/**
 * Field constraints for the `leases` section, defined once and shared between
 * the read schema (adds `.default()`) and the write schema (no defaults). Bounds
 * match the design doc Section 5.2 field validation table.
 */
const leasesBaseShape = {
  requireMaxBudget: z.boolean(),
  // `gte(0)` per design doc field reference table (budget is an input bound, not an operational floor).
  maxBudget: z.number().int().gte(0).lte(CONFIG_BOUNDS.MAX_BUDGET),
  requireMaxDuration: z.boolean(),
  // `gte(0)` per design doc field reference table.
  maxDurationHours: z
    .number()
    .int()
    .gte(0)
    .lte(CONFIG_BOUNDS.MAX_DURATION_HOURS),
  // `min(1)` — zero blocks all lease creation (`numActive >= 0` is always true).
  maxLeasesPerUser: z.number().int().min(CONFIG_BOUNDS.MIN_LEASES_PER_USER),
  // `min(1)` — zero causes immediate DynamoDB TTL deletion of terminated leases.
  ttl: z.number().int().min(CONFIG_BOUNDS.MIN_TTL_DAYS),
  allowUserLeaseTermination: z.boolean(),
  // Cross-field: must be <= ttl * 24 (enforced by leasesRefinement).
  leaseRequestWindowHours: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_LEASE_REQUEST_WINDOW_HOURS),
  maxLeaseRequestsPerWindow: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_LEASE_REQUESTS_PER_WINDOW),
  // Controlled by the Multi-User Leases feature; defaults to false here.
  leaseSharingEnabled: z.boolean(),
  // Controls availability of the GET /principals/search API.
  enablePrincipalSearch: z.boolean(),
} as const;

/** Base leases config schema: all fields required, no defaults, rejects unknown keys. */
export const LeasesConfigBaseSchema = z.object(leasesBaseShape).strict();

/** Input shape seen by {@link leasesRefinement} (all fields present). */
export type LeasesConfigInput = z.infer<typeof LeasesConfigBaseSchema>;

/**
 * Cross-field rule for the leases section: the rate-limit window must not exceed
 * the lease record TTL (expressed in hours). On the backend this is enforced via
 * `.superRefine()` on the write schema only (PUT body validation). The read
 * schema intentionally omits it so the leases handler's runtime cap can tolerate
 * stored/migrated config that violates the rule; rejecting it on read would make
 * that cap unreachable.
 */
export function leasesRefinement(
  data: LeasesConfigInput,
  ctx: z.RefinementCtx,
): void {
  if (data.leaseRequestWindowHours > data.ttl * 24) {
    ctx.addIssue({
      code: "custom",
      path: ["leaseRequestWindowHours"],
      message:
        "Rate limit window (hours) must not exceed the lease TTL (days × 24).",
    });
  }
}

/** Read schema: defaults applied for unconfigured fields. */
export const LeasesConfigSchema = z
  .object({
    requireMaxBudget: leasesBaseShape.requireMaxBudget.default(true),
    maxBudget: leasesBaseShape.maxBudget.default(50),
    requireMaxDuration: leasesBaseShape.requireMaxDuration.default(true),
    maxDurationHours: leasesBaseShape.maxDurationHours.default(168),
    maxLeasesPerUser: leasesBaseShape.maxLeasesPerUser.default(3),
    ttl: leasesBaseShape.ttl.default(30),
    allowUserLeaseTermination:
      leasesBaseShape.allowUserLeaseTermination.default(true),
    leaseRequestWindowHours:
      leasesBaseShape.leaseRequestWindowHours.default(168),
    maxLeaseRequestsPerWindow:
      leasesBaseShape.maxLeaseRequestsPerWindow.default(10),
    leaseSharingEnabled: leasesBaseShape.leaseSharingEnabled.default(false),
    enablePrincipalSearch: leasesBaseShape.enablePrincipalSearch.default(true),
  })
  .strict();

/** Write schema (PUT body): all fields required, no defaults, same cross-field rule. */
export const LeasesConfigWriteSchema =
  LeasesConfigBaseSchema.superRefine(leasesRefinement);

// ---------------------------------------------------------------------------
// Cleanup section
// ---------------------------------------------------------------------------

/**
 * Post-cleanup validation mode. Single source of truth shared by the cleanup
 * config `failureAction` field and the cleanup report's `validationMode`:
 *  - "Silent" (default): validation runs in the background but never warns
 *    the user or quarantines the account.
 *  - "Warn": surfaces remaining resources in reports/logs but still proceeds.
 *  - "Quarantine": a failed validation quarantines the account.
 */
export const CleanupValidationModeSchema = z.enum([
  "Quarantine",
  "Warn",
  "Silent",
]);

export type CleanupValidationMode = z.infer<typeof CleanupValidationModeSchema>;

const cleanupBaseShape = {
  numberOfFailedAttemptsToCancelCleanup: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_CLEANUP_VALUE),
  waitBeforeRetryFailedAttemptSeconds: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_CLEANUP_VALUE),
  numberOfSuccessfulAttemptsToFinishCleanup: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_CLEANUP_VALUE),
  waitBeforeRerunSuccessfulAttemptSeconds: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_CLEANUP_VALUE),
  // Post-cleanup Resource Explorer validation settings. Field names, bounds, and
  // defaults match the legacy `GlobalConfigSchema.cleanup.validation` so existing
  // installs migrate faithfully.
  validation: z.object({
    failureAction: CleanupValidationModeSchema,
  }),
  // `min(0)` — a cooldown of zero hours (no cooldown) is a valid configuration.
  cooldownPeriodHours: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_COOLDOWN_PERIOD_HOURS)
    .max(CONFIG_BOUNDS.MAX_COOLDOWN_PERIOD_HOURS),
  reportRetentionDays: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_REPORT_RETENTION_DAYS)
    .max(CONFIG_BOUNDS.MAX_REPORT_RETENTION_DAYS),
} as const;

export const CleanupConfigSchema = z
  .object({
    numberOfFailedAttemptsToCancelCleanup:
      cleanupBaseShape.numberOfFailedAttemptsToCancelCleanup.default(3),
    waitBeforeRetryFailedAttemptSeconds:
      cleanupBaseShape.waitBeforeRetryFailedAttemptSeconds.default(5),
    numberOfSuccessfulAttemptsToFinishCleanup:
      cleanupBaseShape.numberOfSuccessfulAttemptsToFinishCleanup.default(2),
    waitBeforeRerunSuccessfulAttemptSeconds:
      cleanupBaseShape.waitBeforeRerunSuccessfulAttemptSeconds.default(30),
    validation: z
      .object({
        failureAction: CleanupValidationModeSchema.default("Silent"),
      })
      .default({ failureAction: "Silent" }),
    cooldownPeriodHours: cleanupBaseShape.cooldownPeriodHours.default(24),
    reportRetentionDays: cleanupBaseShape.reportRetentionDays.default(730),
  })
  .strict();

export const CleanupConfigWriteSchema = z.object(cleanupBaseShape).strict();

// ---------------------------------------------------------------------------
// Notification section
// ---------------------------------------------------------------------------

const notificationBaseShape = {
  // Union with empty string allows disabling notifications. RFC 5321 max length.
  emailFrom: z.union([
    z.email().max(CONFIG_BOUNDS.MAX_EMAIL_LENGTH),
    z.literal(""),
  ]),
} as const;

export const NotificationConfigSchema = z
  .object({
    emailFrom: notificationBaseShape.emailFrom.default(""),
  })
  .strict();

export const NotificationConfigWriteSchema = z
  .object(notificationBaseShape)
  .strict();

// ---------------------------------------------------------------------------
// Maintenance section
// ---------------------------------------------------------------------------

const maintenanceBaseShape = {
  enabled: z.boolean(),
} as const;

export const MaintenanceConfigSchema = z
  .object({
    // Fresh installs start in maintenance mode: this shrinks the non-admin auth
    // surface during initial setup and is fail-closed — if DynamoDB is
    // unreachable or a stored record is unreadable, this code default locks out
    // non-admins rather than leaving the system open.
    enabled: maintenanceBaseShape.enabled.default(true),
  })
  .strict();

export const MaintenanceConfigWriteSchema = z
  .object(maintenanceBaseShape)
  .strict();

// ---------------------------------------------------------------------------
// Terms of Service section
// ---------------------------------------------------------------------------

const termsOfServiceBaseShape = {
  content: z.string().max(CONFIG_BOUNDS.MAX_TERMS_OF_SERVICE_LENGTH),
} as const;

export const TermsOfServiceConfigSchema = z
  .object({
    content: termsOfServiceBaseShape.content.default(DEFAULT_TERMS_OF_SERVICE),
  })
  .strict();

export const TermsOfServiceConfigWriteSchema = z
  .object(termsOfServiceBaseShape)
  .strict();

// ---------------------------------------------------------------------------
// Cost Reporting section
// ---------------------------------------------------------------------------

// Cost report group bounds share the single source of truth in CONFIG_BOUNDS,
// which is also imported by ReportingConfigSchema in
// source/common/data/reporting-config/reporting-config.ts.
const costReportingBaseShape = {
  costReportGroups: z
    .array(z.string().min(1).max(CONFIG_BOUNDS.MAX_COST_REPORT_GROUP_LENGTH))
    .max(CONFIG_BOUNDS.MAX_COST_REPORT_GROUPS),
  requireCostReportGroup: z.boolean(),
} as const;

export const CostReportingConfigSchema = z
  .object({
    costReportGroups: costReportingBaseShape.costReportGroups.default([]),
    requireCostReportGroup:
      costReportingBaseShape.requireCostReportGroup.default(false),
  })
  .strict();

export const CostReportingConfigWriteSchema = z
  .object(costReportingBaseShape)
  .strict();

/** Cost reporting section as consumed by `validateCostReportGroup`. */
export type CostReportingConfig = z.infer<typeof CostReportingConfigSchema>;

// ---------------------------------------------------------------------------
// Aggregate exports
// ---------------------------------------------------------------------------

/** Read schemas (defaults applied) keyed by section. Source of truth for code defaults. */
export const ConfigSchemas = {
  leases: LeasesConfigSchema,
  cleanup: CleanupConfigSchema,
  notification: NotificationConfigSchema,
  maintenance: MaintenanceConfigSchema,
  termsOfService: TermsOfServiceConfigSchema,
  costReporting: CostReportingConfigSchema,
} as const;

/** Write schemas (all fields required, no defaults) for PUT body validation. */
export const ConfigWriteSchemas = {
  leases: LeasesConfigWriteSchema,
  cleanup: CleanupConfigWriteSchema,
  notification: NotificationConfigWriteSchema,
  maintenance: MaintenanceConfigWriteSchema,
  termsOfService: TermsOfServiceConfigWriteSchema,
  costReporting: CostReportingConfigWriteSchema,
} as const;

/**
 * Request-only audit envelope accepted on a PUT body alongside the section
 * fields. `meta.lastEditTime` carries the optimistic-concurrency token; the
 * server ignores client `lastSavedBy` and derives the audit identity itself.
 * Mirrors the response audit envelope on {@link ConfigSectionResponse}.
 */
const requestAuditEnvelopeShape = {
  meta: z.object({ lastEditTime: z.string().optional() }).optional(),
  lastSavedBy: z.unknown().optional(),
} as const;

/**
 * PUT body schemas: each section's fields plus the request audit envelope,
 * keyed by section for the configurations handler's runtime lookup. Built from
 * the base field shapes (same `z.object(shape).strict()` idiom as the write
 * schemas above) so the envelope validates with the section and unknown keys
 * are still rejected. Leases re-applies `leasesRefinement` exactly as
 * {@link LeasesConfigWriteSchema} does.
 */
export const ConfigPutBodySchemas = {
  leases: z
    .object({ ...leasesBaseShape, ...requestAuditEnvelopeShape })
    .strict()
    .superRefine(leasesRefinement),
  cleanup: z
    .object({ ...cleanupBaseShape, ...requestAuditEnvelopeShape })
    .strict(),
  notification: z
    .object({ ...notificationBaseShape, ...requestAuditEnvelopeShape })
    .strict(),
  maintenance: z
    .object({ ...maintenanceBaseShape, ...requestAuditEnvelopeShape })
    .strict(),
  termsOfService: z
    .object({ ...termsOfServiceBaseShape, ...requestAuditEnvelopeShape })
    .strict(),
  costReporting: z
    .object({ ...costReportingBaseShape, ...requestAuditEnvelopeShape })
    .strict(),
} as const;

/** Union of valid configuration section keys. */
export type ConfigSection = keyof typeof ConfigSchemas;

/**
 * Audit identity stored on each section. Either a human email address or a
 * `system:` namespaced sentinel (e.g. `system:migration`) for system writers.
 */
export const LastSavedBySchema = z.union([
  z.email(),
  z.string().regex(/^system:[a-z][a-z0-9-]{0,49}$/),
]);

export type LastSavedBy = z.infer<typeof LastSavedBySchema>;

/** Per-item metadata for optimistic concurrency and schema versioning. */
export type ConfigMetadata = {
  createdTime: string;
  lastEditTime: string;
  schemaVersion: number;
};

/**
 * A stored configuration section: the section fields plus audit/metadata.
 * `lastSavedBy` is `null` when the section has never been saved to DynamoDB.
 */
export type ConfigSectionData<T extends ConfigSection> = z.infer<
  (typeof ConfigSchemas)[T]
> & {
  lastSavedBy: LastSavedBy | null;
  meta: ConfigMetadata;
};

// ---------------------------------------------------------------------------
// Configuration API response contract (shared between the Configuration API
// handler and the Admin Settings frontend)
// ---------------------------------------------------------------------------

/**
 * A single section as returned by the Configuration API. The section fields
 * (code defaults merged in) plus the audit envelope. Differs from the stored
 * {@link ConfigSectionData}: a section that has never been saved to DynamoDB is
 * returned with `lastSavedBy: null` and NO `meta`, so `meta` is optional here.
 */
export type ConfigSectionResponse<T extends ConfigSection> = z.infer<
  (typeof ConfigSchemas)[T]
> & {
  lastSavedBy: LastSavedBy | null;
  meta?: ConfigMetadata;
};

/**
 * Read-only deploy-time fields surfaced in the `GET /configurations` response.
 * Resolved at deploy time (not stored in the config table) and not writable via
 * PUT, so they live alongside the sections rather than inside one.
 */
export type DeployTimeConfigFields = {
  isbManagedRegions: string[];
  awsAccessPortalUrl: string;
};

/**
 * Full `GET /configurations` response: every section (each with its response
 * envelope) plus the read-only deploy-time fields.
 */
export type AdminConfig = {
  [Section in ConfigSection]: ConfigSectionResponse<Section>;
} & DeployTimeConfigFields;

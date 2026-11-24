// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { CleanupValidationModeSchema } from "./sandbox-account.js";

/** Default Terms of Service shown until an administrator saves a replacement. */
export const DEFAULT_TERMS_OF_SERVICE = `Users, who use a leased AWS account for their sandbox experiments, should NOT,

* Attempt to access data that they are not authorized to use or access.
* Use content for a sandbox use case that has not been approved by an admin.
* Perform any unauthorized changes or store unapproved company data within the leased AWS account.
* Provide static passwords, such as default or actual passwords.
* Change or modify quotas/limits out of band for accounts.
* Transfer data or software to any person or organization not authorized to use the leased AWS account.
* Use any material or information from the leased AWS accounts, including images, logos, or photographs in any manner that violates copyright, trademark, or intellectual property laws.`;

/**
 * Configuration field bounds. Smithy constraints are checked against these runtime
 * schemas by the API model parity tests.
 */
export const CONFIG_BOUNDS = {
  MAX_BUDGET: 1_000_000_000,
  MAX_DURATION_HOURS: 87_600,
  MIN_LEASES_PER_USER: 1,
  MIN_TTL_DAYS: 1,
  MAX_TTL_DAYS: 3650,
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

/**
 * Controls whether new IDC group-to-lease associations can be created.
 * `ALLOWLIST` will be added when per-group configuration is implemented.
 */
export const GroupAssignmentModeSchema = z.enum(["ALL", "NONE"]);

export const GroupAssignmentMode = GroupAssignmentModeSchema.enum;
export type GroupAssignmentMode = z.infer<typeof GroupAssignmentModeSchema>;
export const DEFAULT_GROUP_ASSIGNMENT_MODE = GroupAssignmentMode.NONE;

const leasesBaseShape = {
  requireMaxBudget: z.boolean(),
  maxBudget: z.number().int().gte(0).lte(CONFIG_BOUNDS.MAX_BUDGET),
  requireMaxDuration: z.boolean(),
  maxDurationHours: z
    .number()
    .int()
    .gte(0)
    .lte(CONFIG_BOUNDS.MAX_DURATION_HOURS),
  maxLeasesPerUser: z.number().int().min(CONFIG_BOUNDS.MIN_LEASES_PER_USER),
  ttl: z.number().int().min(CONFIG_BOUNDS.MIN_TTL_DAYS),
  allowUserLeaseTermination: z.boolean(),
  leaseRequestWindowHours: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_LEASE_REQUEST_WINDOW_HOURS),
  maxLeaseRequestsPerWindow: z
    .number()
    .int()
    .min(CONFIG_BOUNDS.MIN_LEASE_REQUESTS_PER_WINDOW),
  leaseSharingEnabled: z.boolean(),
  enablePrincipalSearch: z.boolean(),
  groupAssignmentMode: GroupAssignmentModeSchema,
  allowPredictiveBudgetControls: z.boolean(),
  serviceBreakdownEnabled: z.boolean(),
  allowBedrockTokenMonitoring: z.boolean(),
} as const;

const boundedTtl = leasesBaseShape.ttl.lte(CONFIG_BOUNDS.MAX_TTL_DAYS);

/** All leases fields, without defaults or cross-field validation. */
export const LeasesConfigBaseSchema = z
  .object({ ...leasesBaseShape, ttl: boundedTtl })
  .strict();

export type LeasesConfigInput = z.infer<typeof LeasesConfigBaseSchema>;

/** The request-rate window cannot outlive the lease record TTL. */
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

/** Read schema: defaults are applied to fields not yet configured. */
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
    groupAssignmentMode: leasesBaseShape.groupAssignmentMode.default(
      DEFAULT_GROUP_ASSIGNMENT_MODE,
    ),
    allowPredictiveBudgetControls:
      leasesBaseShape.allowPredictiveBudgetControls.default(false),
    serviceBreakdownEnabled:
      leasesBaseShape.serviceBreakdownEnabled.default(false),
    allowBedrockTokenMonitoring:
      leasesBaseShape.allowBedrockTokenMonitoring.default(false),
  })
  .strict();

/** Write schema: all fields are required and the cross-field rule is applied. */
export const LeasesConfigWriteSchema =
  LeasesConfigBaseSchema.superRefine(leasesRefinement);

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
  validation: z.object({
    failureAction: CleanupValidationModeSchema,
  }),
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

const notificationBaseShape = {
  emailFrom: z.union([
    z.email().max(CONFIG_BOUNDS.MAX_EMAIL_LENGTH),
    z.literal(""),
  ]),
  sesEnabled: z.boolean(),
  snsIntegrationTopicEnabled: z.boolean(),
} as const;

export const NotificationConfigSchema = z
  .object({
    emailFrom: notificationBaseShape.emailFrom.default(""),
    sesEnabled: notificationBaseShape.sesEnabled.default(true),
    snsIntegrationTopicEnabled:
      notificationBaseShape.snsIntegrationTopicEnabled.default(false),
  })
  .strict();

export const NotificationConfigWriteSchema = z
  .object(notificationBaseShape)
  .strict();

export function isSesNotificationEnabled({
  emailFrom,
  sesEnabled,
}: {
  emailFrom: string;
  sesEnabled: boolean;
}): boolean {
  return sesEnabled && emailFrom.trim().length > 0;
}

const maintenanceBaseShape = {
  enabled: z.boolean(),
} as const;

export const MaintenanceConfigSchema = z
  .object({
    enabled: maintenanceBaseShape.enabled.default(true),
  })
  .strict();

export const MaintenanceConfigWriteSchema = z
  .object(maintenanceBaseShape)
  .strict();

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
  .strict()
  .superRefine(costReportingRefinement);

// Keep this write-only so existing invalid settings can still load for repair.
function costReportingRefinement(
  data: CostReportingConfig,
  ctx: z.RefinementCtx,
): void {
  if (data.requireCostReportGroup && data.costReportGroups.length === 0) {
    ctx.addIssue({
      code: "custom",
      path: ["costReportGroups"],
      message:
        "Add at least one cost report group or turn off Require cost report group.",
    });
  }
}

/**
 * Resolves the effective Bedrock token-monitoring state of a lease or lease
 * template without changing its saved preference. A lease with Sandbox Spaces
 * is always monitored, so its agent spend is counted; otherwise the saved
 * preference applies. The two saved settings stay independent.
 */
export function resolveBedrockTokenMonitoringEnabled({
  configured,
  sandboxSpacesEnabled,
}: {
  configured: boolean | undefined;
  sandboxSpacesEnabled: boolean | undefined;
}): boolean {
  return configured === true || sandboxSpacesEnabled === true;
}

/**
 * Global Sandbox Spaces capability. `true` turns the feature on for every role
 * with an active lease (still subject to the enabled-model catalog gate);
 * `false` turns it off entirely. Opt-in per environment.
 */
const agentBaseShape = {
  sandboxSpacesEnabled: z.boolean(),
} as const;

/** Read schema: defaults are applied to fields not yet configured. */
export const AgentConfigSchema = z
  .object({
    sandboxSpacesEnabled: agentBaseShape.sandboxSpacesEnabled.default(false),
  })
  .strict();

/** Write schema: all agent fields are required. */
export const AgentConfigWriteSchema = z.object(agentBaseShape).strict();

/** Read schemas, including code defaults, keyed by configuration section. */
export const ConfigSchemas = {
  leases: LeasesConfigSchema,
  cleanup: CleanupConfigSchema,
  notification: NotificationConfigSchema,
  maintenance: MaintenanceConfigSchema,
  termsOfService: TermsOfServiceConfigSchema,
  costReporting: CostReportingConfigSchema,
  agent: AgentConfigSchema,
} as const;

/** Strict full-replacement schemas used by forms and persistence writes. */
export const ConfigWriteSchemas = {
  leases: LeasesConfigWriteSchema,
  cleanup: CleanupConfigWriteSchema,
  notification: NotificationConfigWriteSchema,
  maintenance: MaintenanceConfigWriteSchema,
  termsOfService: TermsOfServiceConfigWriteSchema,
  costReporting: CostReportingConfigWriteSchema,
  agent: AgentConfigWriteSchema,
} as const;

export type ConfigSection = keyof typeof ConfigSchemas;

/** The defaulted fields belonging to one configuration section. */
export type ConfigSectionFields<T extends ConfigSection> = z.infer<
  (typeof ConfigSchemas)[T]
>;

/** The required fields accepted when replacing one configuration section. */
export type ConfigSectionWriteFields<T extends ConfigSection> = z.infer<
  (typeof ConfigWriteSchemas)[T]
>;

export type CostReportingConfig = ConfigSectionFields<"costReporting">;
export type AgentConfig = ConfigSectionFields<"agent">;

/** Complete response metadata for a configuration section that has been saved. */
export type ConfigurationResponseMetadata = {
  createdTime: string;
  lastEditTime: string;
};

/**
 * Narrows boundary metadata only when both required response members are
 * present. Dropping `lastEditTime` would also drop the concurrency token.
 */
export function hasCompleteConfigurationResponseMetadata(
  meta: { createdTime?: string; lastEditTime?: string } | undefined,
): meta is ConfigurationResponseMetadata {
  return meta?.createdTime !== undefined && meta?.lastEditTime !== undefined;
}

const requestAuditEnvelopeShape = {
  meta: z.object({ lastEditTime: z.string().optional() }).optional(),
  lastSavedBy: z.unknown().optional(),
} as const;

/**
 * Raw PUT-body supplements. Smithy validates modeled fields first; these
 * schemas additionally reject unknown keys, enforce cross-field rules,
 * and accept the optimistic-concurrency envelope.
 */
export const ConfigPutBodySchemas = {
  leases: z
    .object({
      ...leasesBaseShape,
      ttl: boundedTtl,
      ...requestAuditEnvelopeShape,
    })
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
    .strict()
    .superRefine(costReportingRefinement),
  agent: z.object({ ...agentBaseShape, ...requestAuditEnvelopeShape }).strict(),
} as const;

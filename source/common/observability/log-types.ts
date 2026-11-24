// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupReasonSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { BudgetExceededDetectedBySchema } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseTerminatedReasonTypeSchema } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  BreachEvaluatedBySchema,
  DollarThresholdTriggeredBySchema,
  RateBasisSchema,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { ThresholdActionSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { CleanupValidationModeSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";
import z from "zod";

export const AccountDriftLogSchema = z.object({
  logDetailType: z.literal("AccountDrift"),
  accountId: AwsAccountIdSchema,
  expectedOu: z.string().optional(),
  actualOu: z.string().optional(),
});

export const LeasePublishedLogSchema = z.object({
  logDetailType: z.literal("LeasePublished"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  maxBudget: z.number().optional(),
  maxDurationHours: z.number().optional(),
  autoApproved: z.boolean(),
  creationMethod: z.enum(["REQUESTED", "ASSIGNED"], {
    error: enumErrorMap,
  }),
  hasBlueprint: z.boolean(),
  numDesiredAssignments: z.number().nonnegative().optional(),
});

export const LeaseTerminatedLogSchema = z.object({
  logDetailType: z.literal("LeaseTerminated"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  startDate: z.string(),
  terminationDate: z.string(),
  maxBudget: z.number().optional(),
  actualSpend: z.number(),
  maxDurationHours: z.number().optional(),
  actualDurationHours: z.number(),
  reasonForTermination: LeaseTerminatedReasonTypeSchema,
  agentSpend: z.number().nonnegative().optional(),
  budgetExceededBy: BudgetExceededDetectedBySchema.optional(),
  budgetTotalSpend: z.number().optional(),
});

export const LeaseUnfrozenLogSchema = z.object({
  logDetailType: z.literal("LeaseUnfrozen"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
});

export const LeaseResetLogSchema = z.object({
  logDetailType: z.literal("LeaseReset"),
  leaseId: z.string(),
  leaseTemplateId: z.string(),
  accountId: AwsAccountIdSchema,
  blueprintId: z.string().nullish(),
  blueprintName: z.string().optional(),
  reasonForReset: z.enum(["ProvisioningFailed"], {
    error: enumErrorMap,
  }),
});

export const DeploymentSummaryLogSchema = z.object({
  logDetailType: z.literal("DeploymentSummary"),
  numM2mClients: z.number().nonnegative(),
  numLeaseTemplates: z.number().nonnegative(),
  numLeaseTemplatesWithBlueprint: z.number().nonnegative(),
  numBlueprints: z.number().nonnegative(),
  blueprintServiceCounts: z
    .record(z.string(), z.number().nonnegative())
    .optional(),
  config: z.object({
    numCostReportGroups: z.number().nonnegative(),
    requireMaxBudget: z.boolean(),
    maxBudget: z.number().nonnegative(),
    requireMaxDuration: z.boolean(),
    maxDurationHours: z.number().nonnegative(),
    maxLeasesPerUser: z.number().nonnegative(),
    requireCostReportGroup: z.boolean(),
    numberOfFailedAttemptsToCancelCleanup: z.number().nonnegative(),
    waitBeforeRetryFailedAttemptSeconds: z.number().nonnegative(),
    numberOfSuccessfulAttemptsToFinishCleanup: z.number().nonnegative(),
    waitBeforeRerunSuccessfulAttemptSeconds: z.number().nonnegative(),
    isStableTaggingEnabled: z.boolean(),
    isMultiAccountDeployment: z.boolean(),
    allowUserLeaseTermination: z.boolean(),
    leaseRequestWindowHours: z.number().nonnegative(),
    maxLeaseRequestsPerWindow: z.number().nonnegative(),
    leaseSharingEnabled: z.boolean(),
    enablePrincipalSearch: z.boolean(),
    allowPredictiveBudgetControls: z.boolean(),
    serviceBreakdownEnabled: z.boolean(),
    allowBedrockTokenMonitoring: z.boolean(),
    sandboxSpacesEnabled: z.boolean(),
  }),
  accountPool: z.object({
    available: z.number().nonnegative(),
    active: z.number().nonnegative(),
    frozen: z.number().nonnegative(),
    cleanup: z.number().nonnegative(),
    quarantine: z.number().nonnegative(),
  }),
  additionalAllowedServicesList: z.array(z.string()).default([]),
  bedrockInferenceProfilePatternsList: z.array(z.string()).default([]),
  numTemplatesWithSharing: z.number().nonnegative(),
  numLeasesWithAssignments: z.number().nonnegative(),
  totalUserAssignments: z.number().nonnegative(),
  totalGroupAssignments: z.number().nonnegative(),
  avgAssignmentsPerLease: z.number().nonnegative(),
  maxAssignmentsPerLease: z.number().nonnegative(),
  dailyApiCallsByAuthType: z.object({
    m2m: z.number().nonnegative(),
    user: z.number().nonnegative(),
  }),
  predictiveBudget: z.object({
    enabledTemplates: z.number().nonnegative(),
    enabledActiveLeases: z.number().nonnegative(),
    rateLimitTemplates: z.number().nonnegative(),
    rateLimitActiveLeases: z.number().nonnegative(),
  }),
  bedrockTokenMonitoring: z.object({
    enabledTemplates: z.number().nonnegative(),
    enabledActiveLeases: z.number().nonnegative(),
  }),
  sandboxSpaces: z.object({
    enabledActiveLeases: z.number().nonnegative(),
  }),
  permissionProfiles: z.object({
    numTaggedPermissionSets: z.number().nonnegative(),
    numAssignmentsWithCustomPermissionSet: z.number().nonnegative(),
    numLeasesWithCustomPermissionSet: z.number().nonnegative(),
    maxUniquePermissionSetsPerLease: z.number().nonnegative(),
    avgUniquePermissionSetsPerLease: z.number().nonnegative(),
    maxAllowedPermissionSetsPerTemplate: z.number().nonnegative(),
    avgAllowedPermissionSetsPerTemplate: z.number().nonnegative(),
    maxAllowedPermissionSetsPerLease: z.number().nonnegative(),
    avgAllowedPermissionSetsPerLease: z.number().nonnegative(),
  }),
  notificationSesEnabled: z.boolean(),
  notificationSnsEnabled: z.boolean(),
  notificationUsingDelegatedSesIdentity: z.boolean(),
  notificationSnsSubscriptionCount: z.number().nonnegative(),
  notificationFailuresSes: z.number().nonnegative(),
  notificationFailuresSns: z.number().nonnegative(),
});

export const CostReportingLogSchema = z.object({
  logDetailType: z.literal("CostReporting"),
  startDate: z.string(),
  endDate: z.string(),
  sandboxAccountsCost: z.number(),
  solutionOperatingCost: z.number(),
  numAccounts: z.number(),
});

export const AccountCleanupCompletedStepSchema = z.object({
  name: z.string(),
  durationSeconds: z.number().int(),
  configuredHours: z.number().nonnegative().optional(),
  skipped: z.boolean().optional(),
});

export const AccountCleanupCompletedLogSchema = z.object({
  logDetailType: z.literal("AccountCleanupCompleted"),
  outcome: z.enum(["SUCCESS", "FAILED"], { error: enumErrorMap }),
  durationMinutes: z.number(),
  reason: CleanupReasonSchema,
  failedStep: z.string().nullable().optional(),
  validationMode: CleanupValidationModeSchema.optional(),
  totalResourcesBefore: z.number().nonnegative(),
  totalResourcesIgnored: z.number().nonnegative(),
  resourcesBefore: z.record(z.string(), z.number().nonnegative()),
  resourcesRemaining: z.record(z.string(), z.number().nonnegative()),
  resourcesClearedDuringCooldown: z.record(
    z.string(),
    z.number().nonnegative(),
  ),
  cooldownConfiguredHours: z.number().nonnegative(),
  cooldownActualSeconds: z.number().nonnegative(),
  cooldownSkipped: z.boolean(),
  steps: z.array(AccountCleanupCompletedStepSchema),
  idcAssignmentsFound: z.number().nonnegative(),
  idcAssignmentsDeleted: z.number().nonnegative(),
  principalRecordsFound: z.number().nonnegative(),
  principalRecordsDeleted: z.number().nonnegative(),
});

export const ReasonForQuarantineSchema = z.enum(
  ["MANUAL", "DRIFT", "CLEANUP_FAILED"],
  {
    error: enumErrorMap,
  },
);
export type ReasonForQuarantine = z.infer<typeof ReasonForQuarantineSchema>;

export const AccountQuarantinedLogSchema = z.object({
  logDetailType: z.literal("AccountQuarantined"),
  accountId: AwsAccountIdSchema,
  reasonForQuarantine: ReasonForQuarantineSchema,
});

export const TagResourceFailedLogSchema = z.object({
  logDetailType: z.literal("TagResourceFailed"),
  reason: z.enum(["TagSpaceExhausted", "ApiError"], { error: enumErrorMap }),
  accountId: AwsAccountIdSchema,
  tagKeys: z.array(z.string()),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const UntagResourceFailedLogSchema = z.object({
  logDetailType: z.literal("UntagResourceFailed"),
  accountId: AwsAccountIdSchema,
  tagKeys: z.array(z.string()),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const MemoryCleanupCompleteLogSchema = z.object({
  logDetailType: z.literal("MemoryCleanupComplete"),
  leaseId: z.uuid(),
  ltmDeleted: z.number().int().nonnegative(),
  attempt: z.number().int().positive().optional(),
});

export const MemoryCleanupFailedLogSchema = z.object({
  logDetailType: z.literal("MemoryCleanupFailed"),
  leaseId: z.uuid(),
  phase: z.enum(["credentials", "delete", "verify"], { error: enumErrorMap }),
  attempt: z.number().int().positive().optional(),
  errorName: z.string().optional(),
  errorMessage: z.string().optional(),
});

export const TagActivationCheckLogSchema = z.object({
  logDetailType: z.literal("TagActivationCheck"),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  tagsActive: z.array(z.string()),
  tagsInactive: z.array(z.string()),
  tagsMissing: z.array(z.string()),
});

export const TagActivationSucceededLogSchema = z.object({
  logDetailType: z.literal("TagActivationSucceeded"),
  attempt: z.number().int().nonnegative(),
  tagsActivated: z.array(z.string()),
});

export const TagActivationFailedLogSchema = z.object({
  logDetailType: z.literal("TagActivationFailed"),
  reason: z.enum(["MaxAttemptsReached"], { error: enumErrorMap }),
  attempt: z.number().int().nonnegative(),
  maxAttempts: z.number().int().positive(),
  tagsInactive: z.array(z.string()),
  tagsMissing: z.array(z.string()),
});

/**
 * A monitoring run could not find a lease in the tag-grouped Cost Explorer report
 * and re-summed its spend by account instead. Counted, not alarmed: every
 * deployment spends its first day here, because Cost Explorer will not activate a
 * cost allocation tag key until it has observed one, so this is expected traffic
 * whose *persistence* is the signal.
 *
 * A fallback-served lease gets no per-day figures and no service breakdown, and
 * its cumulative total carries an untagged prefix that no tagged bucket will ever
 * account for.
 */
export const LeaseCostFallbackLogSchema = z.object({
  logDetailType: z.literal("LeaseCostFallback"),
  /** Leases the tag report did not cover this run, and the fleet it ran over. */
  fallbackLeaseCount: z.number().int().positive(),
  monitoredLeaseCount: z.number().int().positive(),
});

/**
 * A Sandbox Spaces turn settled without reported token usage
 */
export const AgentTurnMeteringFailedLogSchema = z.object({
  logDetailType: z.literal("AgentTurnMeteringFailed"),
  modelId: z.string(),
  estimatedInputTokens: z.number().int().nonnegative(),
});

/**
 * A Sandbox Spaces turn's usage could not be recorded after every retry
 */
export const SandboxSpacesUsageRecordingFailedLogSchema = z.object({
  logDetailType: z.literal("SandboxSpacesUsageRecordingFailed"),
  leaseId: z.string(),
  messageId: z.string(),
  modelId: z.string(),
});

export const AssignmentExecutionCompletedLogSchema = z.object({
  logDetailType: z.literal("AssignmentExecutionCompleted"),
  leaseId: z.string(),
  accountId: AwsAccountIdSchema,
  intent: z.enum(["TERMINATE", "FREEZE", "UPDATE", "PUBLISH", "UNFREEZE"], {
    error: enumErrorMap,
  }),
  principalsProcessed: z.number().nonnegative(),
  succeeded: z.number().nonnegative(),
  failed: z.number().nonnegative(),
});

/**
 * The freeze-decision figure exists only where a freeze was decided; on any
 * other record it would be read as an overrun split that never happened.
 */
function restrictFreezeDecisionCostToFreezeActions(
  log: {
    action: z.infer<typeof ThresholdActionSchema>;
    costAtFreezeDecision?: number | null;
  },
  ctx: z.RefinementCtx,
): void {
  if (log.costAtFreezeDecision != null && log.action !== "FREEZE_ACCOUNT")
    ctx.addIssue({
      code: "custom",
      path: ["costAtFreezeDecision"],
      message: "only set when the action is FREEZE_ACCOUNT",
    });
}

/**
 * Threshold Breach Breakdown -- quantifies the earlier-detection benefit.
 * Dollar thresholds only: a crossed spend-rate limit logs SpendRateThresholdFired.
 */
export const BudgetThresholdFiredLogSchema = z
  .object({
    logDetailType: z.literal("BudgetThresholdFired"),
    // Bounds and null/absent choices match BreachRecordSchema field for field.
    // This record mirrors that row, and both are emitted from the same values, so
    // a metric that admits a magnitude the row rejects records a state the system
    // cannot produce. `.nullish()` rather than `.optional()` because the row makes
    // each counterpart `.nullable()`: the obvious `{ ...row }` projection carries
    // nulls, and requiring `undefined` would make that projection fail and lose
    // the record.
    thresholdDollars: z.number().nonnegative(),
    // Threshold values only: a `maxSpend` breach is not a threshold firing.
    action: ThresholdActionSchema,
    triggeredBy: z.enum(DollarThresholdTriggeredBySchema.options, {
      error: enumErrorMap,
    }),
    evaluatedBy: z.enum(BreachEvaluatedBySchema.options, {
      error: enumErrorMap,
    }),
    // Spend so far on the evaluator's basis. Required: logger drops null keys.
    spendAtFire: z.number().nonnegative(),
    billedCostAtFire: z.number().nonnegative(),
    // The projection used for the scheduled dollar comparison, on the
    // evaluator's basis.
    predictedCostAtFire: z.number().nonnegative().nullish(),
    hoursSinceLastRefresh: z.number().nonnegative().nullish(),
    // FREEZE_ACCOUNT only: cumulative cost at the freeze moment, splitting the
    // overrun into detection lag (before) and enforcement lag (after).
    costAtFreezeDecision: z.number().nonnegative().nullish(),
  })
  // The same pairing BreachRecordSchema enforces: the metric must not record a
  // state the system cannot produce, since the breakdown splits the overrun
  // from these fields.
  .superRefine((log, ctx) => {
    if (log.triggeredBy === "PREDICTED" && log.predictedCostAtFire == null)
      ctx.addIssue({
        code: "custom",
        path: ["predictedCostAtFire"],
        message: "required on a PREDICTED breach",
      });
    restrictFreezeDecisionCostToFreezeActions(log, ctx);
  });

/**
 * Spend Rate Threshold Breakdown -- one record per crossed spend-rate limit, ALERT
 * and FREEZE_ACCOUNT alike, whether or not selection raised an event for it.
 * Bounds match the RATE breach row, which is written from the same values.
 */
export const SpendRateThresholdFiredLogSchema = z
  .object({
    logDetailType: z.literal("SpendRateThresholdFired"),
    rateBasis: z.enum(RateBasisSchema.options, { error: enumErrorMap }),
    // Both in USD per `rateBasis`.
    thresholdRate: z.number().positive(),
    measuredRate: z.number().nonnegative(),
    action: ThresholdActionSchema,
    evaluatedBy: z.enum(BreachEvaluatedBySchema.options, {
      error: enumErrorMap,
    }),
    spendAtFire: z.number().nonnegative(),
    // Cost Explorer's own total.
    billedCostAtFire: z.number().nonnegative(),
    predictedCostAtFire: z.number().nonnegative().nullish(),
    hoursSinceLastRefresh: z.number().nonnegative().nullish(),
    costAtFreezeDecision: z.number().nonnegative().nullish(),
  })
  .superRefine(restrictFreezeDecisionCostToFreezeActions);

/**
 * Projection Accuracy -- the signal for whether predicted thresholds are
 * safe to freeze on. Emitted whenever a refresh confirms or corrects a prior
 * projection.
 */
export const ProjectionAccuracyLogSchema = z
  .object({
    logDetailType: z.literal("ProjectionAccuracy"),
    predictedCost: z.number().nonnegative(),
    billedCostAccrued: z.number().nonnegative(),
    // predictedCost - billedCostAccrued; positive means over-estimate. Signed,
    // unlike the two it is derived from.
    errorDollars: z.number(),
    // errorDollars over billedCostAccrued; null where that is 0.
    // `.nullish()` because the logger drops null-valued keys before the record is
    // written, so the emitter's null reaches the subscriber as a missing key.
    errorPercent: z.number().nullish(),
    intervalHours: z.number().nonnegative(),
    rateSource: z.enum(RateBasisSchema.options, { error: enumErrorMap }),
    // Not pinned to the current constant: a strategy change must stay parseable,
    // since comparing across strategies is the field's purpose. Bounded
    // because every value here reaches a log group.
    algorithmId: z.string().min(1).max(64),
  })
  // `errorDollars` is the two figures beside it restated, so the accuracy
  // signal cannot be read off a record whose difference disagrees with them --
  // the same reason `rateUnavailable` is refined against its two sources below.
  // A tolerance, not equality: these are floats and the subtraction is done by
  // the emitter.
  .superRefine((log, ctx) => {
    if (
      Math.abs(log.errorDollars - (log.predictedCost - log.billedCostAccrued)) >
      0.005
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["errorDollars"],
        message: "must equal predictedCost - billedCostAccrued",
      });
    }
  });

/**
 * Spend Rate Coverage. Aggregated into the heartbeat rather than
 * forwarded per emission.
 */
export const SpendRateComputedLogSchema = z
  .object({
    logDetailType: z.literal("SpendRateComputed"),
    // `.nullish()` because the logger drops null-valued keys before the record is
    // written: a lease with no rate yet emits both as null and the subscriber sees
    // neither key.
    hourlyRate: z.number().nullish(),
    dailyRate: z.number().nullish(),
    // Lease too young for a second interval.
    rateUnavailable: z.boolean(),
    // Did the reported total change this run; also yields the fleet-wide refresh
    // interval.
    costExplorerRefreshed: z.boolean(),
  })
  // The flag is the two rates restated, so the coverage figure cannot be read
  // off a record whose flag and rates disagree. `== null`: an absent rate is a
  // null the logger dropped, and means the same thing here.
  .refine(
    (log) =>
      log.rateUnavailable === (log.hourlyRate == null && log.dailyRate == null),
    {
      path: ["rateUnavailable"],
      message: "true exactly when both hourlyRate and dailyRate are null",
    },
  );

/**
 * A producer built an event detail its consumer's `parse` will reject, so the
 * notification is lost while the action it announces still happens.
 * A structured record rather than prose so it is alarmable; carries the failing
 * paths only, never their values.
 */
export const InvalidEventDetailEmittedLogSchema = z.object({
  logDetailType: z.literal("InvalidEventDetailEmitted"),
  // Bounded: both reach a log group, and the path list is one entry per failing
  // field of a schema with a fixed field count.
  eventDetailType: z.string().min(1).max(128),
  invalidPaths: z.array(z.string().max(256)).max(64),
});

/**
 * ACCEPTED RISK, owned by the observability wiring.
 *
 * `BudgetThresholdFiredLogSchema`, `SpendRateThresholdFiredLogSchema`,
 * `ProjectionAccuracyLogSchema` and `SpendRateComputedLogSchema` are the first
 * members here carrying cross-field refinements; every pre-existing member is a plain object. On a parse failure
 * `log-subscription-handler` logs the full zod error AND `failedLog:
 * structuredLog` -- the whole raw record -- into the subscriber's own log group.
 * So a producer that gets one of these pairings wrong turns a dropped metric into
 * a second copy of that record's cost figures.
 *
 * Kept rather than dropped, because the alternative is a metric that records states
 * the system cannot produce. The residual is a second copy of that record's figures
 * in the same log group -- the producer and the subscriber both write to
 * `globalLogGroup`, so there is no new audience -- plus loss of the metric for that
 * emission. The subscriber's failure logging gets bounded when the metric filters
 * these schemas exist for are wired up.
 */
export const SubscribableLogSchema = z.discriminatedUnion("logDetailType", [
  AccountDriftLogSchema,
  LeaseTerminatedLogSchema,
  LeasePublishedLogSchema,
  LeaseUnfrozenLogSchema,
  LeaseResetLogSchema,
  DeploymentSummaryLogSchema,
  CostReportingLogSchema,
  AccountCleanupCompletedLogSchema,
  AccountQuarantinedLogSchema,
  TagResourceFailedLogSchema,
  UntagResourceFailedLogSchema,
  MemoryCleanupCompleteLogSchema,
  MemoryCleanupFailedLogSchema,
  TagActivationCheckLogSchema,
  TagActivationSucceededLogSchema,
  TagActivationFailedLogSchema,
  LeaseCostFallbackLogSchema,
  AgentTurnMeteringFailedLogSchema,
  SandboxSpacesUsageRecordingFailedLogSchema,
  AssignmentExecutionCompletedLogSchema,
  BudgetThresholdFiredLogSchema,
  SpendRateThresholdFiredLogSchema,
  ProjectionAccuracyLogSchema,
  SpendRateComputedLogSchema,
  InvalidEventDetailEmittedLogSchema,
]);

export type SubscribableLog = z.infer<typeof SubscribableLogSchema>;
export type BudgetThresholdFiredLog = z.infer<
  typeof BudgetThresholdFiredLogSchema
>;
export type SpendRateThresholdFiredLog = z.infer<
  typeof SpendRateThresholdFiredLogSchema
>;

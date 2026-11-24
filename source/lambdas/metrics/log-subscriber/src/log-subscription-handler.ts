// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { CloudWatchLogsEvent, Context } from "aws-lambda";

import {
  LogSubscriberLambdaEnvironment,
  LogSubscriberLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/log-subscriber-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  AnonymizedAWSMetricData,
  sendAnonymizedMetricToAWS,
} from "@amzn/innovation-sandbox-commons/observability/anonymized-metric.js";
import {
  SubscribableLog,
  SubscribableLogSchema,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import * as zlib from "node:zlib";
import z from "zod";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "LogMetricForwarder" });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LogSubscriberLambdaEnvironmentSchema,
  moduleName: "metrics",
}).handler(forwardLogBatchToAWS);

//partial schema only, the rest of the event can be ignored
export const CloudwatchLogEventSchema = z.object({
  logEvents: z.array(z.object({ message: z.string() })),
});

async function forwardLogBatchToAWS(
  event: CloudWatchLogsEvent,
  context: Context & ValidatedEnvironment<LogSubscriberLambdaEnvironment>,
) {
  // Decode and decompress the data
  const decompressed = zlib
    .gunzipSync(Buffer.from(event.awslogs.data, "base64"))
    .toString("utf-8");

  const eventParser = z
    .string()
    .transform((str) => JSON.parse(str))
    .pipe(CloudwatchLogEventSchema)
    .safeParse(decompressed);

  if (!eventParser.success) {
    logger.warn(
      `failed to parse CW Log event: ${JSON.stringify(eventParser.error)}`,
      {
        failedEvent: decompressed,
      },
    );
    return;
  }

  const parsedEvent = eventParser.data;

  for (const structuredLog of parsedEvent.logEvents) {
    const logParser = z
      .string()
      .transform((str) => JSON.parse(str))
      .pipe(SubscribableLogSchema)
      .safeParse(structuredLog.message);

    if (!logParser.success) {
      logger.warn(
        `failed to parse CW Log: ${JSON.stringify(logParser.error)}`,
        {
          failedLog: structuredLog,
        },
      );
      continue;
    }

    const awsMetric = extractAwsMetric(logParser.data);
    if (awsMetric) {
      await sendAnonymizedMetricToAWS(awsMetric, {
        logger,
        tracer,
        env: context.env,
      });
    }
  }
}

function extractAwsMetric(
  log: SubscribableLog,
): AnonymizedAWSMetricData | undefined {
  switch (log.logDetailType) {
    case "LeasePublished":
      return {
        event_name: "LeasePublished",
        context_version: 4,
        context: {
          maxBudget: log.maxBudget,
          maxDurationHours: log.maxDurationHours,
          autoApproved: log.autoApproved,
          creationMethod: log.creationMethod,
          hasBlueprint: log.hasBlueprint,
          numDesiredAssignments: log.numDesiredAssignments ?? 0,
        },
      };
    case "LeaseTerminated":
      return {
        event_name: "LeaseTerminated",
        context_version: 3,
        context: {
          maxBudget: log.maxBudget,
          actualSpend: log.actualSpend,
          maxDurationHours: log.maxDurationHours,
          actualDurationHours: log.actualDurationHours,
          reasonForTermination: log.reasonForTermination,
          agentSpend: log.agentSpend,
          budgetExceededBy: log.budgetExceededBy,
          budgetTotalSpend: log.budgetTotalSpend,
        },
      };
    case "LeaseUnfrozen":
      return {
        event_name: "LeaseUnfrozen",
        context_version: 1,
        context: {
          leaseId: log.leaseId,
        },
      };
    case "LeaseReset":
      return {
        event_name: "LeaseReset",
        context_version: 1,
        context: {
          reasonForReset: log.reasonForReset,
        },
      };
    case "DeploymentSummary":
      return {
        event_name: "DeploymentSummary",
        context_version: 5,
        context: {
          numM2mClients: log.numM2mClients,
          numLeaseTemplates: log.numLeaseTemplates,
          numLeaseTemplatesWithBlueprint: log.numLeaseTemplatesWithBlueprint,
          numBlueprints: log.numBlueprints,
          blueprintServiceCounts: log.blueprintServiceCounts,
          // Account pool metrics
          activeAccounts: log.accountPool.active,
          availableAccounts: log.accountPool.available,
          cleanupAccounts: log.accountPool.cleanup,
          quarantineAccounts: log.accountPool.quarantine,
          frozenAccounts: log.accountPool.frozen,
          // Configuration metrics
          numCostReportGroups: log.config.numCostReportGroups,
          requireMaxBudget: log.config.requireMaxBudget,
          maxBudget: log.config.maxBudget,
          requireMaxDuration: log.config.requireMaxDuration,
          maxDurationHours: log.config.maxDurationHours,
          maxLeasesPerUser: log.config.maxLeasesPerUser,
          requireCostReportGroup: log.config.requireCostReportGroup,
          numberOfFailedAttemptsToCancelCleanup:
            log.config.numberOfFailedAttemptsToCancelCleanup,
          waitBeforeRetryFailedAttemptSeconds:
            log.config.waitBeforeRetryFailedAttemptSeconds,
          numberOfSuccessfulAttemptsToFinishCleanup:
            log.config.numberOfSuccessfulAttemptsToFinishCleanup,
          waitBeforeRerunSuccessfulAttemptSeconds:
            log.config.waitBeforeRerunSuccessfulAttemptSeconds,
          isStableTaggingEnabled: log.config.isStableTaggingEnabled,
          isMultiAccountDeployment: log.config.isMultiAccountDeployment,
          allowUserLeaseTermination: log.config.allowUserLeaseTermination,
          leaseRequestWindowHours: log.config.leaseRequestWindowHours,
          maxLeaseRequestsPerWindow: log.config.maxLeaseRequestsPerWindow,
          // SCP customization metrics
          additionalAllowedServicesList: log.additionalAllowedServicesList,
          bedrockInferenceProfilePatternsList:
            log.bedrockInferenceProfilePatternsList,
          leaseSharingEnabled: log.config.leaseSharingEnabled,
          enablePrincipalSearch: log.config.enablePrincipalSearch,
          allowPredictiveBudgetControls:
            log.config.allowPredictiveBudgetControls,
          serviceBreakdownEnabled: log.config.serviceBreakdownEnabled,
          allowBedrockTokenMonitoring: log.config.allowBedrockTokenMonitoring,
          // Multi-user lease metrics
          numTemplatesWithSharing: log.numTemplatesWithSharing,
          numLeasesWithAssignments: log.numLeasesWithAssignments,
          totalUserAssignments: log.totalUserAssignments,
          totalGroupAssignments: log.totalGroupAssignments,
          avgAssignmentsPerLease: log.avgAssignmentsPerLease,
          maxAssignmentsPerLease: log.maxAssignmentsPerLease,
          // daily API call mix
          dailyM2mApiCalls: log.dailyApiCallsByAuthType.m2m,
          dailyUserApiCalls: log.dailyApiCallsByAuthType.user,
          // Predictive budget controls adoption
          predictiveBudgetEnabledTemplates:
            log.predictiveBudget.enabledTemplates,
          predictiveBudgetEnabledActiveLeases:
            log.predictiveBudget.enabledActiveLeases,
          predictiveBudgetRateLimitTemplates:
            log.predictiveBudget.rateLimitTemplates,
          predictiveBudgetRateLimitActiveLeases:
            log.predictiveBudget.rateLimitActiveLeases,
          // Bedrock token monitoring adoption
          bedrockTokenMonitoringEnabledTemplates:
            log.bedrockTokenMonitoring.enabledTemplates,
          bedrockTokenMonitoringEnabledActiveLeases:
            log.bedrockTokenMonitoring.enabledActiveLeases,
          // Sandbox Spaces adoption
          sandboxSpacesEnabled: log.config.sandboxSpacesEnabled,
          sandboxSpacesEnabledActiveLeases:
            log.sandboxSpaces.enabledActiveLeases,
          // Permission profile adoption
          numTaggedPermissionSets:
            log.permissionProfiles.numTaggedPermissionSets,
          numAssignmentsWithCustomPermissionSet:
            log.permissionProfiles.numAssignmentsWithCustomPermissionSet,
          numLeasesWithCustomPermissionSet:
            log.permissionProfiles.numLeasesWithCustomPermissionSet,
          maxUniquePermissionSetsPerLease:
            log.permissionProfiles.maxUniquePermissionSetsPerLease,
          avgUniquePermissionSetsPerLease:
            log.permissionProfiles.avgUniquePermissionSetsPerLease,
          maxAllowedPermissionSetsPerTemplate:
            log.permissionProfiles.maxAllowedPermissionSetsPerTemplate,
          avgAllowedPermissionSetsPerTemplate:
            log.permissionProfiles.avgAllowedPermissionSetsPerTemplate,
          maxAllowedPermissionSetsPerLease:
            log.permissionProfiles.maxAllowedPermissionSetsPerLease,
          avgAllowedPermissionSetsPerLease:
            log.permissionProfiles.avgAllowedPermissionSetsPerLease,
          // Notification channel adoption and reliability
          notificationSesEnabled: log.notificationSesEnabled,
          notificationSnsEnabled: log.notificationSnsEnabled,
          notificationUsingDelegatedSesIdentity:
            log.notificationUsingDelegatedSesIdentity,
          notificationSnsSubscriptionCount:
            log.notificationSnsSubscriptionCount,
          notificationFailuresSes: log.notificationFailuresSes,
          notificationFailuresSns: log.notificationFailuresSns,
        },
      };
    case "CostReporting":
      return {
        event_name: "CostReporting",
        context_version: 2,
        context: {
          startDate: log.startDate,
          endDate: log.endDate,
          sandboxAccountsCost: log.sandboxAccountsCost,
          solutionOperatingCost: log.solutionOperatingCost,
          numAccounts: log.numAccounts,
        },
      };
    case "AccountCleanupCompleted":
      return {
        event_name: "AccountCleanupCompleted",
        context_version: 1,
        context: {
          outcome: log.outcome,
          durationMinutes: log.durationMinutes,
          reason: log.reason,
          failedStep: log.failedStep,
          validationMode: log.validationMode,
          totalResourcesBefore: log.totalResourcesBefore,
          totalResourcesIgnored: log.totalResourcesIgnored,
          resourcesBefore: log.resourcesBefore,
          resourcesRemaining: log.resourcesRemaining,
          resourcesClearedDuringCooldown: log.resourcesClearedDuringCooldown,
          cooldownConfiguredHours: log.cooldownConfiguredHours,
          cooldownActualSeconds: log.cooldownActualSeconds,
          cooldownSkipped: log.cooldownSkipped,
          steps: log.steps,
          idcAssignmentsFound: log.idcAssignmentsFound,
          idcAssignmentsDeleted: log.idcAssignmentsDeleted,
          principalRecordsFound: log.principalRecordsFound,
          principalRecordsDeleted: log.principalRecordsDeleted,
        },
      };
    case "MemoryCleanupFailed":
      return {
        event_name: "MemoryCleanupFailed",
        context_version: 1,
        context: {
          failedPhase: log.phase,
          errorName: log.errorName,
        },
      };
    case "AccountQuarantined":
      return {
        event_name: "AccountQuarantined",
        context_version: 1,
        context: {
          reasonForQuarantine: log.reasonForQuarantine,
        },
      };
    case "AssignmentExecutionCompleted":
      return {
        event_name: "AssignmentExecutionCompleted",
        context_version: 1,
        context: {
          intent: log.intent,
          principalsProcessed: log.principalsProcessed,
          succeeded: log.succeeded,
          failed: log.failed,
        },
      };
    case "TagResourceFailed":
      return {
        event_name: "TagResourceFailed",
        context_version: 1,
        context: {
          reason: log.reason,
          tagKeyCount: log.tagKeys.length,
          errorName: log.errorName,
        },
      };
    case "TagActivationFailed":
      return {
        event_name: "TagActivationFailed",
        context_version: 1,
        context: {
          reason: log.reason,
          tagsInactiveCount: log.tagsInactive.length,
          tagsMissingCount: log.tagsMissing.length,
        },
      };
    case "BudgetThresholdFired":
      return {
        event_name: "BudgetThresholdFired",
        context_version: 1,
        context: {
          thresholdDollars: log.thresholdDollars,
          action: log.action,
          triggeredBy: log.triggeredBy,
          evaluatedBy: log.evaluatedBy,
          spendAtFire: log.spendAtFire,
          billedCostAtFire: log.billedCostAtFire,
          predictedCostAtFire: log.predictedCostAtFire,
          hoursSinceLastRefresh: log.hoursSinceLastRefresh,
          costAtFreezeDecision: log.costAtFreezeDecision,
        },
      };
    case "SpendRateThresholdFired":
      return {
        event_name: "SpendRateThresholdFired",
        context_version: 1,
        context: {
          rateBasis: log.rateBasis,
          thresholdRate: log.thresholdRate,
          measuredRate: log.measuredRate,
          action: log.action,
          evaluatedBy: log.evaluatedBy,
          spendAtFire: log.spendAtFire,
          billedCostAtFire: log.billedCostAtFire,
          predictedCostAtFire: log.predictedCostAtFire,
          hoursSinceLastRefresh: log.hoursSinceLastRefresh,
          costAtFreezeDecision: log.costAtFreezeDecision,
        },
      };
    case "ProjectionAccuracy":
      return {
        event_name: "ProjectionAccuracy",
        context_version: 1,
        context: {
          predictedCost: log.predictedCost,
          billedCostAccrued: log.billedCostAccrued,
          errorDollars: log.errorDollars,
          errorPercent: log.errorPercent,
          intervalHours: log.intervalHours,
          rateSource: log.rateSource,
          algorithmId: log.algorithmId,
        },
      };
    // A type with no case is parsed and dropped. SpendRateComputed is one of
    // them on purpose: one record per lease per hour is too many to forward,
    // and parsing it keeps it from being logged as a failure.
    default: {
      return undefined;
    }
  }
}

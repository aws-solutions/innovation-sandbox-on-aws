// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  AccessAnalyzerClient,
  PolicyType,
  ValidatePolicyCommand,
} from "@aws-sdk/client-accessanalyzer";
import {
  CloudFormationClient,
  GetTemplateSummaryCommand,
} from "@aws-sdk/client-cloudformation";
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";
import { GetTopicAttributesCommand, SNSClient } from "@aws-sdk/client-sns";

import { AccountPoolConfig } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { PersistedLeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PersistedAssignment } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import {
  NOTIFICATION_CHANNEL_DIMENSION,
  NOTIFICATION_CHANNELS,
  NOTIFICATION_FAILED_METRIC,
  NOTIFICATION_ISB_NAMESPACE_DIMENSION,
  NOTIFICATION_METRIC_NAMESPACE,
  NotificationChannel,
} from "@amzn/innovation-sandbox-commons/observability/notification-metrics.js";
import { getCloudFormationTemplateServices } from "@amzn/innovation-sandbox-commons/utils/stack-set-parser.js";
import { resolveBedrockTokenMonitoringEnabled } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import {
  ONE_DAY_SECONDS,
  previousUtcDayWindow,
  sumMetricDataValues,
} from "./daily-metric-window.js";

export async function summarizeAccountPool(orgsService: SandboxOuService) {
  return {
    available: (await orgsService.listAllAccountsInOU("Available")).length,
    active: (await orgsService.listAllAccountsInOU("Active")).length,
    frozen: (await orgsService.listAllAccountsInOU("Frozen")).length,
    cleanup: (await orgsService.listAllAccountsInOU("CleanUp")).length,
    quarantine: (await orgsService.listAllAccountsInOU("Quarantine")).length,
  };
}

export async function getScpMetrics(
  logger: Logger,
  accountPoolConfig: AccountPoolConfig,
  accessAnalyzerClient: AccessAnalyzerClient,
): Promise<{
  additionalAllowedServicesList: string[];
  bedrockInferenceProfilePatternsList: string[];
}> {
  const allServices = parseCommaSeparatedList(
    accountPoolConfig.additionalAllowedServices,
  );

  return {
    additionalAllowedServicesList:
      allServices.length > 0
        ? await filterValidIamActions(logger, allServices, accessAnalyzerClient)
        : [],
    bedrockInferenceProfilePatternsList: parseCommaSeparatedList(
      accountPoolConfig.bedrockInferenceProfilePatterns,
    ).flatMap((arn) => {
      const slashIdx = arn.indexOf("/");
      return slashIdx === -1 ? [] : [arn.substring(slashIdx + 1)];
    }),
  };
}

async function filterValidIamActions(
  logger: Logger,
  actions: string[],
  accessAnalyzerClient: AccessAnalyzerClient,
): Promise<string[]> {
  try {
    const policyDocument = JSON.stringify({
      Version: "2012-10-17",
      Statement: [{ Effect: "Allow", Action: actions, Resource: "*" }],
    });

    const response = await accessAnalyzerClient.send(
      new ValidatePolicyCommand({
        policyDocument,
        policyType: PolicyType.IDENTITY_POLICY,
      }),
    );

    const invalidActions = new Set(
      response.findings
        ?.filter(
          (f) =>
            f.findingType === "ERROR" &&
            (f.issueCode === "INVALID_SERVICE_IN_ACTION" ||
              f.issueCode === "INVALID_ACTION"),
        )
        ?.map((f) => {
          // Primary: find "Action" in the path, take the next entry's index
          const path = f.locations?.at(0)?.path ?? [];
          const actionKeyIdx = path.findIndex((p) => p.value === "Action");
          const actionIndex = path[actionKeyIdx + 1]?.index;
          if (actionIndex !== undefined) {
            return actions[actionIndex];
          }
          // Fallback: parse full action string from findingDetails message if path structure is unexpected
          // Handles both "The service X specified..." (INVALID_SERVICE_IN_ACTION) and "The action X does not exist." (INVALID_ACTION)
          return (
            f.findingDetails?.match(/The service (\S+) specified/)?.[1] ??
            f.findingDetails?.match(/The action (\S+) does not exist/)?.[1]
          );
        })
        ?.filter((a): a is string => a !== undefined),
    );

    if (invalidActions.size > 0) {
      logger.warn("Filtering invalid IAM actions from metrics", {
        invalidActions: [...invalidActions],
      });
    }

    return actions.filter((a) => !invalidActions.has(a));
  } catch (error) {
    logger.warn(
      "Failed to validate IAM actions, skipping additionalAllowedServicesList metric",
      {
        error: error instanceof Error ? error.message : String(error),
      },
    );
    return [];
  }
}

function parseCommaSeparatedList(value: string | undefined): string[] {
  if (!value || value.trim() === "") {
    return [];
  }
  return value.split(",").map((item) => item.trim());
}

export async function summarizeBlueprints(
  logger: Logger,
  blueprintStore: BlueprintStore,
  cfnClient: CloudFormationClient,
): Promise<{
  numBlueprints: number;
  blueprintServiceCounts: Record<string, number>;
}> {
  const blueprints = await collect(
    stream(blueprintStore, blueprintStore.listBlueprints, {}),
  );

  const serviceCounts: Record<string, number> = {};

  // listBlueprints returns empty stackSets for performance, so we still need
  // get() per blueprint for the full stack-set details.
  const blueprintWithStackSets = await Promise.all(
    blueprints.map((blueprint) =>
      blueprintStore.get(blueprint.blueprint.blueprintId),
    ),
  );

  const stackSetIds = blueprintWithStackSets.flatMap(
    (blueprint) =>
      blueprint.result?.stackSets?.map((stackSet) => stackSet.stackSetId) ?? [],
  );

  await Promise.all(
    stackSetIds.map(async (stackSetId) => {
      // Skip a single unreadable StackSet rather than dropping the whole
      // metric — the others still contribute their counts.
      try {
        const response = await cfnClient.send(
          new GetTemplateSummaryCommand({ StackSetName: stackSetId }),
        );

        const resourceTypes = response.ResourceTypes ?? [];
        if (resourceTypes.length === 0) {
          return;
        }

        const templateServiceCounts =
          getCloudFormationTemplateServices(resourceTypes);

        Object.entries(templateServiceCounts).forEach(([service, count]) => {
          serviceCounts[service] = (serviceCounts[service] || 0) + count;
        });
      } catch (error) {
        logger.warn("Failed to analyze StackSet", {
          stackSetId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }),
  );

  return {
    numBlueprints: blueprints.length,
    blueprintServiceCounts: serviceCounts,
  };
}

export async function summarizeMultiUserLeases(
  leaseTemplates: PersistedLeaseTemplate[],
  assignments: PersistedAssignment[],
): Promise<{
  numTemplatesWithSharing: number;
  numLeasesWithAssignments: number;
  totalUserAssignments: number;
  totalGroupAssignments: number;
  avgAssignmentsPerLease: number;
  maxAssignmentsPerLease: number;
}> {
  const numTemplatesWithSharing = leaseTemplates.filter(
    (template) => template.allowOwnerToShareLease === true,
  ).length;

  let totalUserAssignments = 0;
  let totalGroupAssignments = 0;
  const leaseCountMap = new Map<string, number>();

  for (const assignment of assignments) {
    if (assignment.principalType === "USER") {
      totalUserAssignments++;
    } else {
      totalGroupAssignments++;
    }
    leaseCountMap.set(
      assignment.leaseId,
      (leaseCountMap.get(assignment.leaseId) ?? 0) + 1,
    );
  }

  const maxAssignmentsPerLease = [...leaseCountMap.values()].reduce(
    (max, count) => Math.max(max, count),
    0,
  );

  const numLeasesWithAssignments = leaseCountMap.size;
  const totalAssignments = totalUserAssignments + totalGroupAssignments;
  const avgAssignmentsPerLease =
    numLeasesWithAssignments > 0
      ? Math.round((totalAssignments / numLeasesWithAssignments) * 100) / 100
      : 0;

  return {
    numTemplatesWithSharing,
    numLeasesWithAssignments,
    totalUserAssignments,
    totalGroupAssignments,
    avgAssignmentsPerLease,
    maxAssignmentsPerLease,
  };
}

export interface PermissionProfileMetrics {
  numTaggedPermissionSets: number;
  numAssignmentsWithCustomPermissionSet: number;
  numLeasesWithCustomPermissionSet: number;
  maxUniquePermissionSetsPerLease: number;
  avgUniquePermissionSetsPerLease: number;
  maxAllowedPermissionSetsPerTemplate: number;
  avgAllowedPermissionSetsPerTemplate: number;
  maxAllowedPermissionSetsPerLease: number;
  avgAllowedPermissionSetsPerLease: number;
}

function summarizeCounts(values: number[]): { max: number; average: number } {
  if (values.length === 0) {
    return { max: 0, average: 0 };
  }

  return {
    max: Math.max(...values),
    average:
      Math.round(
        (values.reduce((sum, value) => sum + value, 0) / values.length) * 100,
      ) / 100,
  };
}

export async function summarizePermissionProfiles(
  leaseTemplates: PersistedLeaseTemplate[],
  assignments: PersistedAssignment[],
  activeLeases: PersistedLease[],
  leaseStore: Pick<LeaseStore, "findByStatus">,
  principalStore: Pick<PrincipalStore, "getPermissionSetCacheItems">,
  builtInPermissionSetArn: string,
): Promise<PermissionProfileMetrics> {
  const [frozenLeases, permissionSetCache] = await Promise.all([
    collect(
      stream(leaseStore, leaseStore.findByStatus, {
        status: "Frozen",
        pageSize: 1000,
      }),
    ),
    principalStore.getPermissionSetCacheItems(),
  ]);

  const monitoredLeases: PersistedLease[] = [...activeLeases, ...frozenLeases];
  const monitoredLeaseIds = new Set(monitoredLeases.map((lease) => lease.uuid));
  const assignmentsByLease = new Map<string, PersistedAssignment[]>();
  let numAssignmentsWithCustomPermissionSet = 0;

  for (const assignment of assignments) {
    const isCustom =
      assignment.permissionSetArn !== undefined &&
      assignment.permissionSetArn !== builtInPermissionSetArn;

    if (isCustom) {
      numAssignmentsWithCustomPermissionSet++;
    }

    if (!monitoredLeaseIds.has(assignment.leaseId)) {
      continue;
    }

    const leaseAssignments = assignmentsByLease.get(assignment.leaseId) ?? [];
    leaseAssignments.push(assignment);
    assignmentsByLease.set(assignment.leaseId, leaseAssignments);
  }

  const permissionSetsByLease = monitoredLeases.map((lease) => {
    const desiredAssignments = lease.desiredAssignments;
    // Lease-scoped metrics intentionally measure configured feature adoption,
    // not the eventually consistent IDC state. Desired assignments remain
    // authoritative while Active grants converge and while Frozen assignments
    // are revoked. Confirmed records are only a fallback for legacy leases
    // where desiredAssignments is absent; an explicitly empty array is final.
    const effectivePermissionSetArns =
      desiredAssignments === undefined
        ? (assignmentsByLease.get(lease.uuid) ?? []).map(
            (assignment) =>
              assignment.permissionSetArn ?? builtInPermissionSetArn,
          )
        : desiredAssignments.map(
            (assignment) =>
              assignment.permissionSetArn ??
              lease.defaultPermissionSetArn ??
              builtInPermissionSetArn,
          );

    return new Set(effectivePermissionSetArns);
  });
  const uniquePermissionSetCounts = permissionSetsByLease.map(
    (permissionSets) => permissionSets.size,
  );
  const leasesWithCustomPermissionSet = permissionSetsByLease.filter(
    (permissionSets) =>
      [...permissionSets].some(
        (permissionSetArn) => permissionSetArn !== builtInPermissionSetArn,
      ),
  );
  const templateAllowedPermissionSetCounts = leaseTemplates.map(
    (template) => template.allowedPermissionSetArns?.length ?? 0,
  );
  const leaseAllowedPermissionSetCounts = monitoredLeases.map(
    (lease) => lease.allowedPermissionSetArns?.length ?? 0,
  );
  const uniquePermissionSets = summarizeCounts(uniquePermissionSetCounts);
  const templateAllowedPermissionSets = summarizeCounts(
    templateAllowedPermissionSetCounts,
  );
  const leaseAllowedPermissionSets = summarizeCounts(
    leaseAllowedPermissionSetCounts,
  );

  return {
    numTaggedPermissionSets: permissionSetCache.length,
    numAssignmentsWithCustomPermissionSet,
    numLeasesWithCustomPermissionSet: leasesWithCustomPermissionSet.length,
    maxUniquePermissionSetsPerLease: uniquePermissionSets.max,
    avgUniquePermissionSetsPerLease: uniquePermissionSets.average,
    maxAllowedPermissionSetsPerTemplate: templateAllowedPermissionSets.max,
    avgAllowedPermissionSetsPerTemplate: templateAllowedPermissionSets.average,
    maxAllowedPermissionSetsPerLease: leaseAllowedPermissionSets.max,
    avgAllowedPermissionSetsPerLease: leaseAllowedPermissionSets.average,
  };
}

/**
 * Adoption of predictive budget controls: the templates that opt in and the
 * active leases carrying the opt-in. Fleet-wide accuracy and breach aggregates
 * are not read here; the cost history table has no index for a fleet-wide
 * read, so they wait on a data source.
 */
export function summarizePredictiveBudget(
  leaseTemplates: PersistedLeaseTemplate[],
  activeLeases: PersistedLease[],
): {
  enabledTemplates: number;
  enabledActiveLeases: number;
  rateLimitTemplates: number;
  rateLimitActiveLeases: number;
} {
  const enabledTemplates = leaseTemplates.filter(
    (template) => template.predictiveBudgetEnabled === true,
  );
  const enabledActiveLeases = activeLeases.filter(
    (lease) => lease.predictiveBudgetEnabled === true,
  );
  return {
    enabledTemplates: enabledTemplates.length,
    enabledActiveLeases: enabledActiveLeases.length,
    rateLimitTemplates: enabledTemplates.filter(hasRateLimits).length,
    rateLimitActiveLeases: enabledActiveLeases.filter(hasRateLimits).length,
  };
}

function hasRateLimits(item: { rateLimits?: unknown[] }): boolean {
  return (item.rateLimits?.length ?? 0) > 0;
}

/**
 * Adoption of Bedrock token monitoring. A template counts when the leases it
 * creates would have monitoring on.
 */
export function summarizeBedrockTokenMonitoring(
  leaseTemplates: PersistedLeaseTemplate[],
  activeLeases: PersistedLease[],
): { enabledTemplates: number; enabledActiveLeases: number } {
  const enabledTemplates = leaseTemplates.filter((template) =>
    resolveBedrockTokenMonitoringEnabled({
      configured: template.bedrockTokenMonitoringEnabled,
      sandboxSpacesEnabled: template.sandboxSpacesEnabled,
    }),
  ).length;
  const enabledActiveLeases = activeLeases.filter(
    (lease) => lease.bedrockTokenMonitoringEnabled === true,
  ).length;
  return { enabledTemplates, enabledActiveLeases };
}

export interface NotificationFailureSummary {
  /** Failed audience dispatch attempts by channel during the previous UTC day. */
  failuresSes: number;
  failuresSns: number;
}

export async function getNotificationSnsSubscriptionCount(
  sns: SNSClient,
  topicArn: string,
): Promise<number> {
  const topicAttributes = await sns.send(
    new GetTopicAttributesCommand({ TopicArn: topicArn }),
  );
  return Number(topicAttributes.Attributes?.SubscriptionsConfirmed ?? 0);
}

export async function summarizeNotificationFailures(
  cloudWatch: CloudWatchClient,
  isbNamespace: string,
): Promise<NotificationFailureSummary> {
  const { startTime, endTime } = previousUtcDayWindow();
  const queryId = (channel: NotificationChannel) => channel.toLowerCase();

  const metricData = await cloudWatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: NOTIFICATION_CHANNELS.map((channel) => ({
        Id: queryId(channel),
        MetricStat: {
          Metric: {
            Namespace: NOTIFICATION_METRIC_NAMESPACE,
            MetricName: NOTIFICATION_FAILED_METRIC,
            Dimensions: [
              {
                Name: NOTIFICATION_ISB_NAMESPACE_DIMENSION,
                Value: isbNamespace,
              },
              { Name: NOTIFICATION_CHANNEL_DIMENSION, Value: channel },
            ],
          },
          Period: ONE_DAY_SECONDS,
          Stat: "Sum",
        },
      })),
    }),
  );

  return {
    failuresSes: sumMetricDataValues(metricData, queryId("SES")),
    failuresSns: sumMetricDataValues(metricData, queryId("SNS")),
  };
}

/**
 * Adoption of Sandbox Spaces: the active leases whose template snapshot has it
 * enabled. Read against the global `sandboxSpacesEnabled` switch, which gates it.
 */
export function summarizeSandboxSpaces(activeLeases: PersistedLease[]): {
  enabledActiveLeases: number;
} {
  const enabledActiveLeases = activeLeases.filter(
    (lease) => lease.sandboxSpacesEnabled,
  ).length;
  return { enabledActiveLeases };
}

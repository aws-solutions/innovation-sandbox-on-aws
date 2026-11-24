// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { Context } from "aws-lambda";

import { PersistedLeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PersistedAssignment } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  DeploymentSummaryLambdaEnvironment,
  DeploymentSummaryLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { isSesNotificationEnabled } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { collectApiCallsByAuthType } from "./api-call-mix.js";
import { countM2mClients } from "./m2m-client-discovery.js";
import { collectMetric } from "./metric-task.js";
import {
  getNotificationSnsSubscriptionCount,
  getScpMetrics,
  summarizeAccountPool,
  summarizeBedrockTokenMonitoring,
  summarizeBlueprints,
  summarizeMultiUserLeases,
  summarizeNotificationFailures,
  summarizePermissionProfiles,
  summarizePredictiveBudget,
  summarizeSandboxSpaces,
} from "./metrics-collectors.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "HeartbeatMetrics" });

const MINUTE_MS = 60_000;
// Per-collector timeout budgets. Generous by design — the timeout is a safety
// net so one stuck collector can't consume the whole (15-min) Lambda, not an
// SLA. HEAVY is for the multi-call scans (blueprints, multi-user leases,
// predictive budget).
const DEFAULT_TIMEOUT_MS = 2 * MINUTE_MS;
const HEAVY_TIMEOUT_MS = 5 * MINUTE_MS;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: DeploymentSummaryLambdaEnvironmentSchema,
  moduleName: "metrics",
})
  .use(isbConfigMiddleware())
  .handler(summarizeDeployment);

async function summarizeDeployment(
  _event: unknown,
  context: Context &
    ValidatedEnvironment<DeploymentSummaryLambdaEnvironment> &
    ContextWithConfig,
) {
  const { env } = context;

  // Lease templates, assignments, and active leases are shared scans. Start
  // them immediately, but await assignments and active leases only inside
  // their consumers so that a slow scan does not delay unrelated collectors.
  const leaseTemplatesPromise = collectLeaseTemplates(env);
  const assignmentsPromise = collectAssignments(env);
  const activeLeasesPromise = collectActiveLeases(env);
  const leaseTemplates = await leaseTemplatesPromise;

  // Independent collectors run concurrently. Each is individually
  // timeout-guarded with a fallback (see the collect* helpers), so a single
  // slow/failing collector degrades only its own fields, not the whole
  // heartbeat.
  const [
    numM2mClients,
    blueprints,
    accountPool,
    scpMetrics,
    multiUserLeases,
    dailyApiCallsByAuthType,
    predictiveBudget,
    bedrockTokenMonitoring,
    permissionProfiles,
    notificationDelivery,
    sandboxSpaces,
  ] = await Promise.all([
    collectM2mClientCount(env),
    collectBlueprints(env),
    collectAccountPool(env),
    collectScpMetrics(env),
    collectMultiUserLeases(leaseTemplates, assignmentsPromise),
    collectApiCallMix(env),
    collectPredictiveBudget(leaseTemplates, activeLeasesPromise),
    collectBedrockTokenMonitoring(leaseTemplates, activeLeasesPromise),
    collectPermissionProfiles(
      env,
      leaseTemplates,
      assignmentsPromise,
      activeLeasesPromise,
    ),
    collectNotificationDelivery(env),
    collectSandboxSpaces(activeLeasesPromise),
  ]);

  const notificationConfig = context.globalConfig.notification;
  const { snsIntegrationTopicEnabled } = notificationConfig;

  logger.info("ISB Deployment Summary", {
    logDetailType: "DeploymentSummary",
    numM2mClients,
    numLeaseTemplates: leaseTemplates.length,
    numLeaseTemplatesWithBlueprint: leaseTemplates.filter(
      (template) => !!template.blueprintId,
    ).length,
    ...blueprints,
    config: {
      numCostReportGroups:
        context.globalConfig.costReporting.costReportGroups.length,
      requireMaxBudget: context.globalConfig.leases.requireMaxBudget,
      maxBudget: context.globalConfig.leases.maxBudget,
      requireMaxDuration: context.globalConfig.leases.requireMaxDuration,
      maxDurationHours: context.globalConfig.leases.maxDurationHours,
      maxLeasesPerUser: context.globalConfig.leases.maxLeasesPerUser,
      requireCostReportGroup:
        context.globalConfig.costReporting.requireCostReportGroup,
      numberOfFailedAttemptsToCancelCleanup:
        context.globalConfig.cleanup.numberOfFailedAttemptsToCancelCleanup,
      waitBeforeRetryFailedAttemptSeconds:
        context.globalConfig.cleanup.waitBeforeRetryFailedAttemptSeconds,
      numberOfSuccessfulAttemptsToFinishCleanup:
        context.globalConfig.cleanup.numberOfSuccessfulAttemptsToFinishCleanup,
      waitBeforeRerunSuccessfulAttemptSeconds:
        context.globalConfig.cleanup.waitBeforeRerunSuccessfulAttemptSeconds,
      isStableTaggingEnabled: context.env.IS_STABLE_TAGGING_ENABLED === "Yes",
      isMultiAccountDeployment:
        context.env.ORG_MGT_ACCOUNT_ID !== context.env.HUB_ACCOUNT_ID,
      allowUserLeaseTermination:
        context.globalConfig.leases.allowUserLeaseTermination,
      leaseRequestWindowHours:
        context.globalConfig.leases.leaseRequestWindowHours,
      maxLeaseRequestsPerWindow:
        context.globalConfig.leases.maxLeaseRequestsPerWindow,
      leaseSharingEnabled: context.globalConfig.leases.leaseSharingEnabled,
      enablePrincipalSearch: context.globalConfig.leases.enablePrincipalSearch,
      allowPredictiveBudgetControls:
        context.globalConfig.leases.allowPredictiveBudgetControls,
      serviceBreakdownEnabled:
        context.globalConfig.leases.serviceBreakdownEnabled,
      allowBedrockTokenMonitoring:
        context.globalConfig.leases.allowBedrockTokenMonitoring,
      sandboxSpacesEnabled: context.globalConfig.agent.sandboxSpacesEnabled,
    },
    accountPool,
    ...scpMetrics,
    ...multiUserLeases,
    dailyApiCallsByAuthType,
    predictiveBudget,
    bedrockTokenMonitoring,
    permissionProfiles,
    notificationSesEnabled: isSesNotificationEnabled(notificationConfig),
    notificationSnsEnabled: snsIntegrationTopicEnabled,
    notificationUsingDelegatedSesIdentity: env.SES_IDENTITY_ARN !== "",
    notificationSnsSubscriptionCount: notificationDelivery.snsSubscriptionCount,
    notificationFailuresSes: notificationDelivery.failuresSes,
    notificationFailuresSns: notificationDelivery.failuresSns,
    sandboxSpaces,
  } satisfies SubscribableLog);
}

// Each collect* helper binds one collector to its name, timeout budget, and
// fallback. Failures degrade to the fallback (logged) rather than failing the
// heartbeat. Add a new metric by adding a helper and a line in Promise.all.

function collectLeaseTemplates(env: DeploymentSummaryLambdaEnvironment) {
  const store = IsbServices.leaseTemplateStore(env);
  return collectMetric(logger, "leaseTemplates", DEFAULT_TIMEOUT_MS, [], () =>
    collect(stream(store, store.findAll, {})),
  );
}

function collectAssignments(env: DeploymentSummaryLambdaEnvironment) {
  const store = IsbServices.principalStore(env);
  return collectMetric(logger, "assignments", HEAVY_TIMEOUT_MS, [], () =>
    collect(
      stream(store, store.listAllAssignments, {
        pageSize: 1000,
      }),
    ),
  );
}

function collectActiveLeases(env: DeploymentSummaryLambdaEnvironment) {
  const store = IsbServices.leaseStore(env);
  return collectMetric(logger, "activeLeases", HEAVY_TIMEOUT_MS, [], () =>
    collect(
      stream(store, store.findByStatus, {
        status: "Active",
        pageSize: 1000,
      }),
    ),
  );
}

function collectM2mClientCount(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(logger, "numM2mClients", DEFAULT_TIMEOUT_MS, 0, () =>
    countM2mClients(IsbClients.iam(env), env.ISB_NAMESPACE),
  );
}

function collectApiCallMix(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "dailyApiCallsByAuthType",
    DEFAULT_TIMEOUT_MS,
    { m2m: 0, user: 0 },
    () =>
      collectApiCallsByAuthType(
        IsbClients.cloudWatch(env),
        env.WAF_WEB_ACL_NAME,
        env.WAF_REGION,
      ),
  );
}

async function collectNotificationDelivery(
  env: DeploymentSummaryLambdaEnvironment,
) {
  const [snsSubscriptionCount, failures] = await Promise.all([
    collectMetric(
      logger,
      "notificationSnsSubscriptionCount",
      DEFAULT_TIMEOUT_MS,
      0,
      () =>
        getNotificationSnsSubscriptionCount(
          IsbClients.sns(env),
          env.NOTIFICATION_TOPIC_ARN,
        ),
    ),
    collectMetric(
      logger,
      "notificationFailures",
      DEFAULT_TIMEOUT_MS,
      { failuresSes: 0, failuresSns: 0 },
      () =>
        summarizeNotificationFailures(
          IsbClients.cloudWatch(env),
          env.ISB_NAMESPACE,
        ),
    ),
  ]);
  return { snsSubscriptionCount, ...failures };
}

function collectBlueprints(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "blueprints",
    HEAVY_TIMEOUT_MS,
    { numBlueprints: 0, blueprintServiceCounts: {} },
    () =>
      summarizeBlueprints(
        logger,
        IsbServices.blueprintStore(env),
        IsbClients.cloudFormation(env),
      ),
  );
}

function collectAccountPool(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "accountPool",
    DEFAULT_TIMEOUT_MS,
    { available: 0, active: 0, frozen: 0, cleanup: 0, quarantine: 0 },
    () =>
      summarizeAccountPool(
        IsbServices.orgsService(
          env,
          fromTemporaryIsbOrgManagementCredentials(env),
        ),
      ),
  );
}

function collectScpMetrics(env: DeploymentSummaryLambdaEnvironment) {
  return collectMetric(
    logger,
    "scpMetrics",
    DEFAULT_TIMEOUT_MS,
    {
      additionalAllowedServicesList: [],
      bedrockInferenceProfilePatternsList: [],
    },
    async () =>
      getScpMetrics(
        logger,
        await IsbServices.accountPoolStackConfigStore(env).get(),
        IsbClients.accessAnalyzer(env),
      ),
  );
}

function collectPredictiveBudget(
  leaseTemplates: PersistedLeaseTemplate[],
  activeLeasesPromise: Promise<PersistedLease[]>,
) {
  return collectMetric(
    logger,
    "predictiveBudget",
    HEAVY_TIMEOUT_MS,
    {
      enabledTemplates: 0,
      enabledActiveLeases: 0,
      rateLimitTemplates: 0,
      rateLimitActiveLeases: 0,
    },
    async () =>
      summarizePredictiveBudget(leaseTemplates, await activeLeasesPromise),
  );
}

function collectBedrockTokenMonitoring(
  leaseTemplates: PersistedLeaseTemplate[],
  activeLeasesPromise: Promise<PersistedLease[]>,
) {
  return collectMetric(
    logger,
    "bedrockTokenMonitoring",
    HEAVY_TIMEOUT_MS,
    { enabledTemplates: 0, enabledActiveLeases: 0 },
    async () =>
      summarizeBedrockTokenMonitoring(
        leaseTemplates,
        await activeLeasesPromise,
      ),
  );
}

function collectSandboxSpaces(activeLeasesPromise: Promise<PersistedLease[]>) {
  return collectMetric(
    logger,
    "sandboxSpaces",
    HEAVY_TIMEOUT_MS,
    { enabledActiveLeases: 0 },
    async () => summarizeSandboxSpaces(await activeLeasesPromise),
  );
}

function collectMultiUserLeases(
  leaseTemplates: PersistedLeaseTemplate[],
  assignmentsPromise: Promise<PersistedAssignment[]>,
) {
  return collectMetric(
    logger,
    "multiUserLeases",
    HEAVY_TIMEOUT_MS,
    {
      numTemplatesWithSharing: 0,
      numLeasesWithAssignments: 0,
      totalUserAssignments: 0,
      totalGroupAssignments: 0,
      avgAssignmentsPerLease: 0,
      maxAssignmentsPerLease: 0,
    },
    async () =>
      summarizeMultiUserLeases(leaseTemplates, await assignmentsPromise),
  );
}

function collectPermissionProfiles(
  env: DeploymentSummaryLambdaEnvironment,
  leaseTemplates: PersistedLeaseTemplate[],
  assignmentsPromise: Promise<PersistedAssignment[]>,
  activeLeasesPromise: Promise<PersistedLease[]>,
) {
  return collectMetric(
    logger,
    "permissionProfiles",
    HEAVY_TIMEOUT_MS,
    {
      numTaggedPermissionSets: 0,
      numAssignmentsWithCustomPermissionSet: 0,
      numLeasesWithCustomPermissionSet: 0,
      maxUniquePermissionSetsPerLease: 0,
      avgUniquePermissionSetsPerLease: 0,
      maxAllowedPermissionSetsPerTemplate: 0,
      avgAllowedPermissionSetsPerTemplate: 0,
      maxAllowedPermissionSetsPerLease: 0,
      avgAllowedPermissionSetsPerLease: 0,
    },
    async () =>
      summarizePermissionProfiles(
        leaseTemplates,
        await assignmentsPromise,
        await activeLeasesPromise,
        IsbServices.leaseStore(env),
        IsbServices.principalStore(env),
        env.USER_PERMISSION_SET_ARN,
      ),
  );
}

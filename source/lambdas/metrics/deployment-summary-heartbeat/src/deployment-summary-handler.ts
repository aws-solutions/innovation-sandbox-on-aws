// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type { Context } from "aws-lambda";

import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import {
  DeploymentSummaryLambdaEnvironment,
  DeploymentSummaryLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-summary-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithGlobalAndReportingConfig,
  isbConfigMiddleware,
  isbReportingConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "HeartbeatMetrics" });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: DeploymentSummaryLambdaEnvironmentSchema,
  moduleName: "metrics",
})
  .use(isbConfigMiddleware())
  .use(isbReportingConfigMiddleware())
  .handler(summarizeDeployment);

async function summarizeDeployment(
  _event: unknown,
  context: Context &
    ValidatedEnvironment<DeploymentSummaryLambdaEnvironment> &
    ContextWithGlobalAndReportingConfig,
) {
  const leaseTemplateStore = IsbServices.leaseTemplateStore(context.env);

  logger.info("ISB Deployment Summary", {
    logDetailType: "DeploymentSummary",
    numLeaseTemplates: (
      await collect(stream(leaseTemplateStore, leaseTemplateStore.findAll, {}))
    ).length,
    config: {
      numCostReportGroups: context.reportingConfig.costReportGroups.length,
      requireMaxBudget: context.globalConfig.leases.requireMaxBudget,
      maxBudget: context.globalConfig.leases.maxBudget,
      requireMaxDuration: context.globalConfig.leases.requireMaxDuration,
      maxDurationHours: context.globalConfig.leases.maxDurationHours,
      maxLeasesPerUser: context.globalConfig.leases.maxLeasesPerUser,
      requireCostReportGroup: context.reportingConfig.requireCostReportGroup,
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
    },
    accountPool: await summarizeAccountPool({
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
    }),
  } satisfies SubscribableLog);
}

async function summarizeAccountPool(context: {
  orgsService: SandboxOuService;
}) {
  const { orgsService } = context;

  return {
    available: (await orgsService.listAllAccountsInOU("Available")).length,
    active: (await orgsService.listAllAccountsInOU("Active")).length,
    frozen: (await orgsService.listAllAccountsInOU("Frozen")).length,
    cleanup: (await orgsService.listAllAccountsInOU("CleanUp")).length,
    quarantine: (await orgsService.listAllAccountsInOU("Quarantine")).length,
  };
}

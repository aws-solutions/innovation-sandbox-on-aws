// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CleanupReportKey } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { ValidatorExclusionConfigSchema } from "@amzn/innovation-sandbox-commons/data/validator-exclusion-config/validator-exclusion-config.js";
import { CleanAccountRequestSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { ExclusionConfig } from "@amzn/innovation-sandbox-commons/isb-services/resource-exclusion-filter.js";
import { DurableCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/durable-cleanup-lambda-environment.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { StartBuildCommand } from "@aws-sdk/client-codebuild";
import { EventBridgeEvent } from "aws-lambda";
import yaml from "js-yaml";
import fs from "node:fs";
import path from "node:path";

import z from "zod";

import {
  DurableContext,
  withDurableExecution,
} from "@aws/durable-execution-sdk-js";

import { CleanupReportWriter } from "./cleanup-report-writer.js";
import { configureDurableLogger } from "./logging/durable-powertools-logger.js";
import {
  acquireAccountLock,
  enumerateResourcesAfterCleanup,
  enumerateResourcesBeforeCleanup,
  finalizeCleanup,
  handleCleanupFailure,
  initializeCleanup,
  removeLeaseTags,
  revokeAccess,
  runAccountCooldown,
  runStep,
  updateCleanupStatus,
  validateCleanupStep,
} from "./steps/index.js";
import type { CleanupContext } from "./steps/types.js";

export type { CleanupContext } from "./steps/types.js";

const NUKE_TIMEOUT_BUFFER_MINUTES = 10;

export const handler = withDurableExecution(durableCleanupHandler);

// ---------------------------------------------------------------------------

type CleanAccountRequestEvent = EventBridgeEvent<
  "CleanAccountRequest",
  z.infer<typeof CleanAccountRequestSchema>
>;

const NO_RETRY = { retryStrategy: () => ({ shouldRetry: false }) };

async function durableCleanupHandler(
  event: CleanAccountRequestEvent,
  context: DurableContext,
): Promise<void> {
  configureDurableLogger(context);

  const env = DurableCleanupLambdaEnvironmentSchema.parse(process.env);
  const request = CleanAccountRequestSchema.parse(event.detail);
  const accountId = request.accountId;
  const cleanupReason = request.reason;
  const initiatedBy = request.initiatedBy;
  const executionArn = context.executionContext.durableExecutionArn;

  context.logger.info("Durable cleanup orchestration invoked", {
    accountId,
    cleanupReason,
    executionArn,
  });

  // --- Pre-check: reject admin accounts before touching any state ---
  const adminAccountIds = [
    env.ORG_MGT_ACCOUNT_ID,
    env.IDC_ACCOUNT_ID,
    env.HUB_ACCOUNT_ID,
  ];
  if (adminAccountIds.includes(accountId)) {
    throw new Error(
      `Account ${accountId} is an ISB administration account. Aborting cleanup.`,
    );
  }

  // --- Step 0: Acquire account lock ---
  const accountStore = IsbServices.sandboxAccountStore(env);
  const executionStartTime = await context.step<string>(
    "acquire-account-lock",
    () =>
      acquireAccountLock(context, accountStore, {
        accountId,
        executionArn,
        cleanupReason,
      }),
    NO_RETRY,
  );

  // --- Construct immutable context now that we have the start time ---
  const reportWriter = new CleanupReportWriter(
    IsbServices.cleanupReportStore(env),
  );
  const reportKey = new CleanupReportKey(accountId, executionStartTime);

  const cleanupContext: CleanupContext = {
    durableContext: context,
    env,
    accountId,
    executionArn,
    cleanupReason,
    executionStartTime,
    accountStore,
    eventBridge: IsbServices.isbEventBridge(env),
    organizationsTaggingService: IsbServices.organizationsTaggingService(
      env,
      fromTemporaryIsbOrgManagementCredentials(env),
    ),
    reportWriter,
    reportKey,
  };

  // --- Critical path ---
  try {
    // Step 1: Initialize reporting (idempotent via conditional write, checkpointed to avoid replay)
    await runStep(
      cleanupContext,
      "initialize-reporting",
      async () => {
        await reportWriter.createReport(reportKey, {
          durableExecutionArn: executionArn,
          reasonForCleanup: cleanupReason,
          initiatedBy,
        });
      },
      { skipReport: true },
    );

    // Step 2: Initialize — fetch cleanup config section, validate spoke role,
    // fetch validation dependencies.
    const {
      output: { cleanupConfig, managedRegions, exclusionConfig },
    } = await runStep(cleanupContext, "initialize-cleanup", async () => {
      const cleanupConfig = await initializeCleanup(cleanupContext);
      const validationDeps = await fetchValidationDependencies(cleanupContext);
      return { cleanupConfig, ...validationDeps };
    });

    // Step 3: Revoke account access
    // 3a: Poll lease resourceLock until released (waitForCondition with exp backoff)
    // 3b: Authoritative sweep of remaining IDC assignments (backstop)
    await revokeAccess(cleanupContext);

    // Step 4: Summarize account resources before cleanup (baseline snapshot)
    const { output: beforeCleanup } = await runStep(
      cleanupContext,
      "summarize-account-before-cleanup",
      () =>
        enumerateResourcesBeforeCleanup(
          cleanupContext,
          { managedRegions, exclusionConfig },
          cleanupConfig,
        ),
    );

    // Step 5: Nuke iteration loop
    await runNukeIterations(cleanupContext, cleanupConfig);

    // Step 6: Post-nuke snapshot — the baseline for the cooldown staleness diff.
    const { output: afterCleanup } = await runStep(
      cleanupContext,
      "summarize-account-after-cleanup",
      () =>
        enumerateResourcesAfterCleanup(cleanupContext, {
          managedRegions,
          exclusionConfig,
        }),
    );

    // Step 7: Account cooldown. Runs before validation so it doubles as the
    // Resource Explorer staleness buffer (deleted resources age out of the index).
    await runAccountCooldown(cleanupContext, cleanupConfig);

    // Step 8: Validate cleanup — enumerate post-cooldown, diff, and enforce.
    await runStep(cleanupContext, "validate-cleanup", async () => {
      await updateCleanupStatus(cleanupContext, "VALIDATING");
      return validateCleanupStep(
        cleanupContext,
        cleanupConfig,
        beforeCleanup,
        afterCleanup,
        { managedRegions, exclusionConfig },
      );
    });

    // Step 9: Remove the 4 lease tags from the now-clean account.
    // Never propagate errors, so the cleanup lifecycle continues regardless.
    await runStep(cleanupContext, "remove-lease-tags", () =>
      removeLeaseTags(cleanupContext),
    );

    // Step 10: Finalize — update status, release lock, publish success event
    await runStep(cleanupContext, "finalize-cleanup", () =>
      finalizeCleanup(cleanupContext),
    );
  } catch (error) {
    await handleCleanupFailure(cleanupContext, error);
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Nuke iteration loop
// ---------------------------------------------------------------------------

async function runNukeIterations(
  ctx: CleanupContext,
  cleanupConfig: GlobalConfig["cleanup"],
): Promise<void> {
  const {
    durableContext,
    accountStore,
    reportWriter,
    reportKey,
    env,
    accountId,
    executionArn,
    cleanupReason,
  } = ctx;

  const {
    numberOfSuccessfulAttemptsToFinishCleanup,
    numberOfFailedAttemptsToCancelCleanup,
    waitBeforeRerunSuccessfulAttemptSeconds,
    waitBeforeRetryFailedAttemptSeconds,
  } = cleanupConfig;

  let succeededCount = 0;
  let failedCount = 0;
  let iteration = 0;

  while (succeededCount < numberOfSuccessfulAttemptsToFinishCleanup) {
    iteration++;

    // Set status and renew lock
    await runStep(
      ctx,
      `nuke-phase-${iteration}-start`,
      async () => {
        await accountStore.acquireLock(
          accountId,
          executionArn,
          (Number(env.CODEBUILD_TIMEOUT_MINUTES) +
            NUKE_TIMEOUT_BUFFER_MINUTES +
            5) /*add 5 minute buffer for ddb resource lock to allow for re-acquisition without race case*/ *
            60,
          {
            step: `nuke-phase-${iteration}`,
            reason: cleanupReason,
          },
        );
        await updateCleanupStatus(ctx, `NUKE_PHASE_${iteration}`);
      },
      { skipReport: true },
    );

    // Run CodeBuild and wait for completion via callback relay
    let iterationOutcome: "SUCCEEDED" | "FAILED" = "SUCCEEDED";

    try {
      await durableContext.waitForCallback(
        `nuke-phase-${iteration}-build`,
        async (callbackId) => {
          const codeBuildClient = IsbClients.codeBuild(env);
          const startBuildResponse = await codeBuildClient.send(
            new StartBuildCommand({
              projectName: env.CODEBUILD_PROJECT_NAME,
              environmentVariablesOverride: [
                {
                  name: "DURABLE_CALLBACK_ID",
                  value: callbackId,
                  type: "PLAINTEXT",
                },
                {
                  name: "CLEANUP_ACCOUNT_ID",
                  value: accountId,
                  type: "PLAINTEXT",
                },
                {
                  name: "APPCONFIG_APPLICATION_ID",
                  value: env.APP_CONFIG_APPLICATION_ID,
                  type: "PLAINTEXT",
                },
                {
                  name: "APPCONFIG_ENVIRONMENT_ID",
                  value: env.APP_CONFIG_ENVIRONMENT_ID,
                  type: "PLAINTEXT",
                },
                {
                  name: "APPCONFIG_NUKE_CONFIG_CONFIGURATION_PROFILE_ID",
                  value: env.APPCONFIG_NUKE_CONFIG_CONFIGURATION_PROFILE_ID,
                  type: "PLAINTEXT",
                },
              ],
            }),
          );

          // Write the nuke phase step entry with the CodeBuild ARN
          const codeBuildExecutionArn = startBuildResponse.build?.arn;
          await reportWriter.appendStep(
            reportKey,
            `nuke-phase-${iteration}-start`,
            codeBuildExecutionArn ? { codeBuildExecutionArn } : undefined,
          );

          durableContext.logger.info(
            `CodeBuild started for nuke iteration ${iteration}`,
            {
              accountId,
              callbackId,
              iteration,
              ...(codeBuildExecutionArn && { codeBuildExecutionArn }),
            },
          );
        },
        { timeout: { hours: 2 } },
      );

      succeededCount++;
      durableContext.logger.info(`Nuke iteration ${iteration} succeeded`, {
        accountId,
        iteration,
        succeededCount,
        failedCount,
      });

      if (succeededCount < numberOfSuccessfulAttemptsToFinishCleanup) {
        await durableContext.wait({
          seconds: waitBeforeRerunSuccessfulAttemptSeconds,
        });
      }
    } catch {
      iterationOutcome = "FAILED";
      failedCount++;
      succeededCount = 0;

      durableContext.logger.warn(`Nuke iteration ${iteration} failed`, {
        accountId,
        iteration,
        succeededCount,
        failedCount,
      });

      if (failedCount < numberOfFailedAttemptsToCancelCleanup) {
        await durableContext.wait({
          seconds: waitBeforeRetryFailedAttemptSeconds,
        });
      }
    }

    // Record the iteration outcome in the cleanup report.
    // We read the report to find the step index — this survives replay
    // boundaries (unlike closure variables set in the submitter function).
    await durableContext.step(
      `nuke-phase-${iteration}-record-outcome`,
      async () => {
        const { result: report } = await reportWriter
          .getStore()
          .getReport(reportKey, { consistentRead: true });
        if (!report) return;

        const stepName = `nuke-phase-${iteration}-start`;
        const idx = report.steps.findIndex((s) => s.name === stepName);
        if (idx < 0) return;

        await reportWriter.completeStep(reportKey, idx, {
          ...report.steps[idx]!.meta,
          outcome: iterationOutcome,
        });
      },
      NO_RETRY,
    );

    // Throw after recording outcome so the failure is visible in the report
    if (failedCount >= numberOfFailedAttemptsToCancelCleanup) {
      throw new Error(
        `Cleanup failed after ${failedCount} failed attempts for account ${accountId}`,
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Validation dependencies
// ---------------------------------------------------------------------------

/**
 * Fetches the ISB managed regions and validator exclusion config needed
 * for Resource Explorer enumeration.
 */
async function fetchValidationDependencies(ctx: CleanupContext): Promise<{
  managedRegions: string[];
  exclusionConfig: ExclusionConfig;
}> {
  const { env } = ctx;

  // Fetch managed regions from AccountPoolStackConfig SSM parameter
  const accountPoolConfigStore = IsbServices.accountPoolStackConfigStore(env);
  const accountPoolConfig = await accountPoolConfigStore.get();
  const managedRegions = accountPoolConfig.isbManagedRegions;

  // Fetch validator exclusion config from AppConfig
  const exclusionConfig = await fetchValidatorExclusionConfig(env);

  return { managedRegions, exclusionConfig };
}

/**
 * Fetches and parses the validator exclusion config from AppConfig.
 * Uses the AppConfigData client (StartConfigurationSession + GetLatestConfiguration).
 */
async function fetchValidatorExclusionConfig(env: {
  APP_CONFIG_APPLICATION_ID: string;
  APP_CONFIG_ENVIRONMENT_ID: string;
  APPCONFIG_VALIDATOR_EXCLUSION_CONFIG_PROFILE_ID: string;
  USER_AGENT_EXTRA: string;
}): Promise<ExclusionConfig> {
  const appConfigDataClient = IsbClients.appConfigData(env);

  const sessionResponse = await appConfigDataClient.send(
    new StartConfigurationSessionCommand({
      ApplicationIdentifier: env.APP_CONFIG_APPLICATION_ID,
      ConfigurationProfileIdentifier:
        env.APPCONFIG_VALIDATOR_EXCLUSION_CONFIG_PROFILE_ID,
      EnvironmentIdentifier: env.APP_CONFIG_ENVIRONMENT_ID,
    }),
  );

  const configResponse = await appConfigDataClient.send(
    new GetLatestConfigurationCommand({
      ConfigurationToken: sessionResponse.InitialConfigurationToken,
    }),
  );

  if (!configResponse.Configuration) {
    throw new Error(
      "Failed to fetch validator exclusion config: no configuration returned",
    );
  }

  const rawConfig = yaml.load(
    Buffer.from(configResponse.Configuration).toString("utf8"),
  );
  const parsed = ValidatorExclusionConfigSchema.parse(rawConfig);

  const overlayPath =
    process.env.ISB_VALIDATOR_OVERLAY_PATH ??
    path.join(__dirname, "validator-exclusion-config.isb-overlay.yaml");
  const overlay = ValidatorExclusionConfigSchema.parse(
    yaml.load(fs.readFileSync(overlayPath, "utf-8")),
  );

  // Map to ExclusionConfig interface (excludedResourceTypes not in AppConfig schema — default empty)
  return {
    excludedArnPatterns: [
      ...new Set([
        ...overlay.validation.excludedArnPatterns,
        ...parsed.validation.excludedArnPatterns,
      ]),
    ],
    excludedResourceTypes: [],
  };
}

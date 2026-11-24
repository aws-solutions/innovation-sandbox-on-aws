// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CleanupReportStep,
  PersistedCleanupReport,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { DateTime } from "luxon";

import type { CleanupContext } from "../steps/types.js";

interface AccountCleanupCompletedStep {
  name: string;
  durationSeconds: number;
  configuredHours?: number;
  skipped?: boolean;
}

/**
 * Builds an `AccountCleanupCompleted` structured log from the cleanup context
 * and the cleanup report stored in DynamoDB.
 *
 * Reads the report back from the store to get the full step timeline and resource summary.
 */
export async function buildCleanupCompletedLog(
  ctx: CleanupContext,
  params: { outcome: "SUCCESS" | "FAILED" },
): Promise<SubscribableLog> {
  const { cleanupReason, executionStartTime, reportKey } = ctx;
  const store = ctx.reportWriter.getStore();

  const reportResult = await store.getReport(reportKey, {
    consistentRead: true,
  });
  const report = reportResult.result;
  const resourceSummary = report?.resourceSummary;
  const accessCleanup = report?.accessCleanupSummary;
  const steps = computeStepDurations(report);

  return {
    logDetailType: "AccountCleanupCompleted",
    outcome: params.outcome,
    durationMinutes: Math.round(
      (Date.now() - new Date(executionStartTime).getTime()) / 60000,
    ),
    reason: cleanupReason,
    failedStep: report?.error?.step ?? null,
    idcAssignmentsFound: accessCleanup?.assignmentsFound ?? 0,
    idcAssignmentsDeleted: accessCleanup?.assignmentsDeleted ?? 0,
    principalRecordsFound: accessCleanup?.principalRecordsFound ?? 0,
    principalRecordsDeleted: accessCleanup?.principalRecordsDeleted ?? 0,
    validationMode: resourceSummary?.validationMode,
    totalResourcesBefore: resourceSummary?.beforeCleanup?.totalCount ?? 0,
    totalResourcesIgnored: resourceSummary?.beforeCleanup?.ignoredCount ?? 0,
    resourcesBefore: resourceSummary?.beforeCleanup?.byType ?? {},
    resourcesRemaining: resourceSummary?.afterCooldown?.byType ?? {},
    resourcesClearedDuringCooldown:
      computeClearedDuringCooldown(resourceSummary),
    ...summarizeCooldown(steps),
    steps,
  };
}

/**
 * Promotes the cooldown figures out of the step list to top-level metric fields,
 * so remaining/cleared resource counts can be correlated with how long the
 * account actually sat in cooldown without unnesting `steps`.
 *
 * The `account-cooldown` step's duration spans the real wait: the suspension
 * happens in `account-cooldown-wait`, which appends no report step, so the next
 * recorded step is the one after cooldown finishes.
 *
 * All zero / false when cooldown is disabled or the cleanup failed before it.
 */
function summarizeCooldown(steps: AccountCleanupCompletedStep[]): {
  cooldownConfiguredHours: number;
  cooldownActualSeconds: number;
  cooldownSkipped: boolean;
} {
  const cooldown = steps.find((step) => step.name === "account-cooldown");

  return {
    cooldownConfiguredHours: cooldown?.configuredHours ?? 0,
    // computeStepDurations uses -1 when an end time is unknown; report 0 rather
    // than a negative duration in the metric.
    cooldownActualSeconds: Math.max(0, cooldown?.durationSeconds ?? 0),
    cooldownSkipped: cooldown?.skipped ?? false,
  };
}

/**
 * Per-type count of resources present post-nuke but gone post-cooldown — ghosts
 * the RE index cleared during cooldown. {} when either snapshot is missing.
 */
function computeClearedDuringCooldown(
  resourceSummary: PersistedCleanupReport["resourceSummary"],
): Record<string, number> {
  const afterCleanup = resourceSummary?.afterCleanup?.byType;
  const afterCooldown = resourceSummary?.afterCooldown?.byType;
  if (!afterCleanup || !afterCooldown) {
    return {};
  }

  const cleared: Record<string, number> = {};
  for (const [type, postNukeCount] of Object.entries(afterCleanup)) {
    const remaining = afterCooldown[type] ?? 0;
    const diff = postNukeCount - remaining;
    if (diff > 0) {
      cleared[type] = diff;
    }
  }
  return cleared;
}

/**
 * Converts raw report steps (with `startedAt` timestamps) into
 * pre-computed steps with `durationSeconds`.
 *
 * Duration is computed as the diff between consecutive steps' `startedAt` values.
 * If a step has no following step (missing terminal marker), duration is -1.
 *
 * Terminal marker steps (`cleanup-complete`, `cleanup-failed`) are excluded from
 * output — they only serve as end-time markers for the preceding step.
 *
 * The `account-cooldown` step includes `configuredHours` and `skipped` metadata.
 * `skipped` is determined by the presence of `report.cooldownSkippedBy` (set by
 * the skip-cooldown API when an admin skips the cooldown).
 */
export function computeStepDurations(
  report: PersistedCleanupReport | undefined,
): AccountCleanupCompletedStep[] {
  const rawSteps: CleanupReportStep[] = report?.steps ?? [];
  if (rawSteps.length === 0) return [];

  const result: AccountCleanupCompletedStep[] = [];

  for (let i = 0; i < rawSteps.length; i++) {
    const currentStep = rawSteps[i]!;

    // Terminal marker steps don't represent work — skip them.
    // Their startedAt serves as the end time for the preceding step.
    if (
      currentStep.name === "cleanup-complete" ||
      currentStep.name === "cleanup-failed"
    ) {
      continue;
    }

    const nextStep = rawSteps[i + 1];

    // Duration is always derived from the next step's startedAt.
    // If there's no next step (terminal marker missing), use -1 sentinel.
    const startedAt = DateTime.fromISO(currentStep.startedAt, { zone: "utc" });
    const endedAt = nextStep
      ? DateTime.fromISO(nextStep.startedAt, { zone: "utc" })
      : undefined;

    const durationSeconds =
      startedAt.isValid && endedAt?.isValid
        ? Math.max(-1, Math.round(endedAt.diff(startedAt, "seconds").seconds))
        : -1;

    const step: AccountCleanupCompletedStep = {
      name: currentStep.name,
      durationSeconds,
    };

    // Enrich cooldown step with metadata
    if (currentStep.name === "account-cooldown" && currentStep.meta) {
      const meta = currentStep.meta;
      if (typeof meta.cooldownDurationHours === "number") {
        step.configuredHours = meta.cooldownDurationHours;
      }
      step.skipped = report?.cooldownSkippedBy != null;
    }

    result.push(step);
  }

  return result;
}

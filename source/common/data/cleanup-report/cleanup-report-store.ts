// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AccessCleanupSummary,
  CleanupReportError,
  CleanupReportKey,
  CleanupReportStatus,
  CleanupReportStep,
  CleanupStatusDetail,
  PersistedCleanupReport,
  ReasonForCleanup,
  ResourceSummary,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import {
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";

export abstract class CleanupReportStore {
  /**
   * Creates a new cleanup report record.
   * The store resolves the DynamoDB key from the CleanupReportKey.
   */
  abstract create(input: {
    key: CleanupReportKey;
    durableExecutionArn: string;
    reasonForCleanup: ReasonForCleanup;
    initiatedBy?: string;
    ttl: number;
  }): Promise<PersistedCleanupReport>;

  /**
   * Updates the status and/or other top-level fields of an existing report.
   */
  abstract updateReport(input: {
    key: CleanupReportKey;
    status?: CleanupReportStatus;
    cleanupStatus?: CleanupStatusDetail;
    completedAt?: string;
    resourceSummary?: ResourceSummary;
    accessCleanupSummary?: AccessCleanupSummary;
    error?: CleanupReportError;
    skipCooldownCallbackId?: string;
    cooldownSkippedBy?: string;
    ttl?: number;
  }): Promise<PersistedCleanupReport>;

  /**
   * Appends a new step entry to the report's steps array.
   * Uses DDB list_append with if_not_exists guard.
   * Returns the zero-based index of the appended step.
   */
  abstract addStep(input: {
    key: CleanupReportKey;
    step: CleanupReportStep;
  }): Promise<number>;

  /**
   * Updates a step entry at a specific index in the report's steps array.
   * Used to record per-step outcomes (e.g., after a nuke build completes).
   *
   * The `meta` field is a full replacement — callers must include all fields
   * (e.g., codeBuildExecutionArn) alongside new fields (e.g., outcome).
   */
  abstract updateStepAtIndex(input: {
    key: CleanupReportKey;
    index: number;
    completedAt: string;
    meta?: Record<string, unknown>;
  }): Promise<void>;

  /**
   * Gets a specific cleanup report by its exact key (accountId + startedAt).
   * @param options.consistentRead - When true, uses a strongly consistent read.
   */
  abstract getReport(
    key: CleanupReportKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<PersistedCleanupReport>>;

  /**
   * Gets the most recent cleanup report for an account.
   * Uses ScanIndexForward: false, Limit: 1.
   */
  abstract getLatestReport(
    accountId: string,
  ): Promise<SingleItemResult<PersistedCleanupReport>>;

  /**
   * Lists recent cleanup reports for an account, ordered newest first.
   */
  abstract listRecentReports(args: {
    accountId: string;
    limit?: number;
    pageIdentifier?: string;
  }): Promise<PaginatedQueryResult<PersistedCleanupReport>>;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";

import { CleanupReportView } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

export function formatDuration(report: CleanupReportView): string {
  const start = DateTime.fromISO(report.startedAt);
  const end = report.completedAt
    ? DateTime.fromISO(report.completedAt)
    : DateTime.now();
  const diff = end.diff(start, ["hours", "minutes", "seconds"]);
  // Floor seconds to avoid millisecond spillover, then rescale to drop zero units
  const floored = diff.set({
    seconds: Math.floor(diff.seconds),
    milliseconds: 0,
  });
  return floored.rescale().toHuman({ unitDisplay: "narrow" });
}

export function formatReason(reason: string): string {
  const reasonMap: Record<string, string> = {
    LEASE_TERMINATION: "Lease terminated",
    ACCOUNT_REGISTRATION: "Account registration",
    MANUALLY_INITIATED: "Manually initiated",
    RETRY_FAILED_CLEANUP: "Manually initiated",
    LEASE_RESET: "Lease reset",
  };
  return reasonMap[reason] ?? reason;
}

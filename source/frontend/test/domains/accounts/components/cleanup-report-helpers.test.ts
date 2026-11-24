// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  formatDuration,
  formatReason,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/components/cleanup-report-helpers";
import { CleanupReportView } from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { createMockCleanupReport } from "@amzn/innovation-sandbox-frontend-test/domains/accounts/factories/cleanupReportFactory";

describe("cleanup-report-helpers", () => {
  describe("formatDuration", () => {
    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
    });

    afterEach(() => {
      vi.useRealTimers();
    });

    test("returns formatted duration for a completed report with hours and minutes", () => {
      const report: CleanupReportView = createMockCleanupReport({
        startedAt: "2024-06-15T10:00:00.000Z",
        completedAt: "2024-06-15T11:30:00.000Z",
      });

      const result = formatDuration(report);

      // unitDisplay: "narrow" produces abbreviated units like "1h, 30m"
      expect(result).toBe("1h, 30m");
    });

    test("returns formatted duration for a completed report with only minutes", () => {
      const report: CleanupReportView = createMockCleanupReport({
        startedAt: "2024-06-15T11:15:00.000Z",
        completedAt: "2024-06-15T11:45:00.000Z",
      });

      const result = formatDuration(report);

      expect(result).toBe("30m");
    });

    test("returns formatted duration for a completed report with sub-minute duration", () => {
      const report: CleanupReportView = createMockCleanupReport({
        startedAt: "2024-06-15T11:59:00.000Z",
        completedAt: "2024-06-15T11:59:30.000Z",
      });

      const result = formatDuration(report);

      // Sub-minute durations show as seconds with narrow display
      expect(result).toMatch(/0m|30s/);
    });

    test("returns elapsed duration for an in-progress report using DateTime.now()", () => {
      const report: CleanupReportView = createMockCleanupReport({
        startedAt: "2024-06-15T10:30:00.000Z",
        completedAt: undefined,
      });

      const result = formatDuration(report);

      // From 10:30 to 12:00 is 1h 30m (narrow display)
      expect(result).toBe("1h, 30m");
    });

    test("returns only hours when duration is exact hours", () => {
      const report: CleanupReportView = createMockCleanupReport({
        startedAt: "2024-06-15T09:00:00.000Z",
        completedAt: "2024-06-15T12:00:00.000Z",
      });

      const result = formatDuration(report);

      expect(result).toBe("3h");
    });
  });

  describe("formatReason", () => {
    test("maps LEASE_TERMINATION to 'Lease terminated'", () => {
      expect(formatReason("LEASE_TERMINATION")).toBe("Lease terminated");
    });

    test("maps ACCOUNT_REGISTRATION to 'Account registration'", () => {
      expect(formatReason("ACCOUNT_REGISTRATION")).toBe("Account registration");
    });

    test("maps MANUALLY_INITIATED to 'Manually initiated'", () => {
      expect(formatReason("MANUALLY_INITIATED")).toBe("Manually initiated");
    });

    test("maps legacy RETRY_FAILED_CLEANUP to 'Manually initiated' (backward compat)", () => {
      expect(formatReason("RETRY_FAILED_CLEANUP")).toBe("Manually initiated");
    });

    test("maps LEASE_RESET to 'Lease reset'", () => {
      expect(formatReason("LEASE_RESET")).toBe("Lease reset");
    });

    test("returns unknown reason as-is (fallthrough)", () => {
      expect(formatReason("SOME_UNKNOWN_REASON")).toBe("SOME_UNKNOWN_REASON");
    });

    test("returns empty string as-is", () => {
      expect(formatReason("")).toBe("");
    });
  });
});

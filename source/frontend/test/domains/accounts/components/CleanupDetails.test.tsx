// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { CleanupDetails } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/CleanupDetails";
import {
  CleanupReportView,
  CleanupResourceSummaryView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/types";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  createMockCleanupReport,
  createMockFailedReport,
  createMockInProgressReport,
} from "@amzn/innovation-sandbox-frontend-test/domains/accounts/factories/cleanupReportFactory";

class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = ResizeObserver;

describe("CleanupDetails", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-15T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  test("renders cleanup details with correct status badge for COMPLETED", () => {
    const report = createMockCleanupReport();

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Cleanup details")).toBeInTheDocument();
    expect(screen.getAllByText("Completed").length).toBeGreaterThanOrEqual(1);
  });

  test("renders cleanup details with correct status badge for FAILED", () => {
    const report = createMockFailedReport();

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getAllByText("Failed").length).toBeGreaterThanOrEqual(1);
  });

  test("renders cleanup details with correct status badge for IN_PROGRESS", () => {
    const report = createMockInProgressReport();

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("In Progress")).toBeInTheDocument();
  });

  test("renders resource summary pending state when no resourceSummary", () => {
    const report = createMockCleanupReport({ resourceSummary: undefined });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Cleanup summary")).toBeInTheDocument();
    expect(
      screen.getByText("Waiting for resource enumeration"),
    ).toBeInTheDocument();
  });

  test("renders resource summary success state when all resources cleaned", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      beforeCleanup: {
        totalCount: 20,
        ignoredCount: 5,
        byType: { "ec2:instance": 10, "s3:bucket": 10 },
      },
      afterCooldown: { totalCount: 0, ignoredCount: 5, byType: {} },
      remainingTypes: [],
    };

    const report = createMockCleanupReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(
      screen.getByText("All resources cleaned successfully"),
    ).toBeInTheDocument();
    expect(screen.getByText(/20 resources/)).toBeInTheDocument();
  });

  test("renders resource summary failure state when resources remain", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Quarantine",
      beforeCleanup: {
        totalCount: 20,
        ignoredCount: 5,
        byType: { "ec2:instance": 10, "s3:bucket": 10 },
      },
      afterCooldown: {
        totalCount: 3,
        ignoredCount: 5,
        byType: { "ec2:instance": 3 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockFailedReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(
      screen.getByText("3 resources failed to clean up"),
    ).toBeInTheDocument();
  });

  test("hides the Post-cleanup validation section and Validate Cleanup step in Silent mode", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Silent",
      beforeCleanup: {
        totalCount: 10,
        ignoredCount: 2,
        byType: { "ec2:instance": 10 },
      },
      afterCooldown: {
        totalCount: 2,
        ignoredCount: 2,
        byType: { "ec2:instance": 2 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockCleanupReport({
      resourceSummary,
      steps: [
        {
          name: "acquire-cleanup-lock",
          startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
        },
        {
          name: "summarize-account-before-cleanup",
          startedAt: DateTime.now().minus({ hours: 1, minutes: 55 }).toISO()!,
        },
        {
          name: "summarize-account-after-cleanup",
          startedAt: DateTime.now().minus({ hours: 1, minutes: 40 }).toISO()!,
        },
        {
          name: "account-cooldown",
          startedAt: DateTime.now().minus({ hours: 1, minutes: 30 }).toISO()!,
        },
        {
          name: "validate-cleanup",
          startedAt: DateTime.now().minus({ minutes: 30 }).toISO()!,
        },
        {
          name: "cleanup-complete",
          startedAt: DateTime.now().minus({ minutes: 29 }).toISO()!,
        },
      ],
    });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(
      screen.queryByText("Post-cleanup validation"),
    ).not.toBeInTheDocument();
    expect(screen.queryByText("Validate Cleanup")).not.toBeInTheDocument();
    // Both account-summary snapshots are RE-validation artifacts too — hidden
    // in Silent mode.
    expect(
      screen.queryByText("Summarize Account (Before Cleanup)"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText("Summarize Account (After Cleanup)"),
    ).not.toBeInTheDocument();
  });

  test("Cleanup summary shows the disabled note and no resource evaluation in Silent mode", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Silent",
      beforeCleanup: {
        totalCount: 10,
        ignoredCount: 2,
        byType: { "ec2:instance": 10 },
      },
      afterCooldown: {
        totalCount: 2,
        ignoredCount: 2,
        byType: { "ec2:instance": 2 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockCleanupReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Cleanup summary")).toBeInTheDocument();
    expect(
      screen.getByText(/Resource Explorer validation disabled \(Silent mode\)/),
    ).toBeInTheDocument();
    // Reflects the overall cleanup outcome (report is COMPLETED).
    expect(screen.getByText("Cleanup complete")).toBeInTheDocument();
    // The before/after resource evaluation must not be shown in Silent mode.
    expect(
      screen.queryByText("All resources cleaned successfully"),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/resources failed to clean up/),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/validation not enforced/),
    ).not.toBeInTheDocument();
  });

  test("Cleanup summary reflects a FAILED cleanup in Silent mode", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Silent",
      beforeCleanup: {
        totalCount: 10,
        ignoredCount: 2,
        byType: { "ec2:instance": 10 },
      },
      afterCooldown: {
        totalCount: 4,
        ignoredCount: 2,
        byType: { "ec2:instance": 4 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockFailedReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Cleanup failed")).toBeInTheDocument();
    expect(
      screen.getByText(/Resource Explorer validation disabled \(Silent mode\)/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/resources failed to clean up/),
    ).not.toBeInTheDocument();
  });

  test("cooldown banner and skip control remain available in Silent mode", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Silent",
      beforeCleanup: {
        totalCount: 10,
        ignoredCount: 2,
        byType: { "ec2:instance": 10 },
      },
      afterCooldown: {
        totalCount: 2,
        ignoredCount: 2,
        byType: { "ec2:instance": 2 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockInProgressReport({
      cleanupStatus: "COOLING_DOWN",
      resourceSummary,
      steps: [
        {
          name: "acquire-cleanup-lock",
          startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
        },
        {
          name: "account-cooldown",
          startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
          meta: { cooldownDurationHours: 24 },
        },
      ],
    });
    const onSkipCooldown = vi.fn();

    renderWithQueryClient(
      <CleanupDetails report={report} onSkipCooldown={onSkipCooldown} />,
    );

    const cooldownElements = screen.getAllByText((_content, element) => {
      return (
        element?.tagName === "SPAN" &&
        (element?.textContent?.includes("Account cooling down") ?? false)
      );
    });
    expect(cooldownElements.length).toBeGreaterThanOrEqual(1);
    expect(
      screen.getByRole("button", { name: /Skip cooldown/ }),
    ).toBeInTheDocument();
  });

  test("shows the Post-cleanup validation section and Validate Cleanup step in Warn mode", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      validationMode: "Warn",
      beforeCleanup: {
        totalCount: 10,
        ignoredCount: 2,
        byType: { "ec2:instance": 10 },
      },
      afterCooldown: {
        totalCount: 2,
        ignoredCount: 2,
        byType: { "ec2:instance": 2 },
      },
      remainingTypes: ["ec2:instance"],
    };

    const report = createMockCleanupReport({
      resourceSummary,
      steps: [
        {
          name: "acquire-cleanup-lock",
          startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
        },
        {
          name: "summarize-account-before-cleanup",
          startedAt: DateTime.now().minus({ hours: 1, minutes: 55 }).toISO()!,
        },
        {
          name: "summarize-account-after-cleanup",
          startedAt: DateTime.now().minus({ hours: 1, minutes: 40 }).toISO()!,
        },
        {
          name: "validate-cleanup",
          startedAt: DateTime.now().minus({ minutes: 30 }).toISO()!,
        },
        {
          name: "cleanup-complete",
          startedAt: DateTime.now().minus({ minutes: 29 }).toISO()!,
        },
      ],
    });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Post-cleanup validation")).toBeInTheDocument();
    expect(screen.getByText("Validate Cleanup")).toBeInTheDocument();
    // Non-Silent modes show both account-summary snapshot steps.
    expect(
      screen.getByText("Summarize Account (Before Cleanup)"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Summarize Account (After Cleanup)"),
    ).toBeInTheDocument();
  });

  test("renders warning (not failure) when validation is warn-only and resources remain", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      beforeCleanup: {
        totalCount: 20,
        ignoredCount: 5,
        byType: { "ec2:instance": 10, "s3:bucket": 10 },
      },
      afterCooldown: {
        totalCount: 2,
        ignoredCount: 5,
        byType: { "ec2:instance": 2 },
      },
      remainingTypes: ["ec2:instance"],
    };

    // Cleanup that "completed" despite remaining resources because validation
    // was warn-only — the summary should warn, not report a failure.
    const report = createMockCleanupReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(
      screen.getByText("2 resources remaining — validation not enforced"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/failed to clean up/)).not.toBeInTheDocument();
  });

  test("renders steps section with step names", () => {
    const report = createMockCleanupReport();

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Steps")).toBeInTheDocument();
    expect(screen.getByText("Acquire Lock")).toBeInTheDocument();
    expect(screen.getByText("Initialize Cleanup")).toBeInTheDocument();
    expect(screen.getByText("Cleanup Complete")).toBeInTheDocument();
  });

  test("shows error details when report has error", () => {
    const report = createMockFailedReport();

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(
      screen.getAllByText("Nuke execution timed out after 60 minutes").length,
    ).toBeGreaterThanOrEqual(1);
  });

  test("shows 'Initiated by' when the report records an initiator", () => {
    const report = createMockCleanupReport({
      reasonForCleanup: "MANUALLY_INITIATED",
      initiatedBy: "admin@example.com",
    });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Initiated by")).toBeInTheDocument();
    expect(screen.getByText("admin@example.com")).toBeInTheDocument();
  });

  test("omits 'Initiated by' when the report has no initiator", () => {
    const report = createMockCleanupReport({ initiatedBy: undefined });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.queryByText("Initiated by")).not.toBeInTheDocument();
  });

  test("renders post-cleanup validation section when afterCooldown exists", () => {
    const resourceSummary: CleanupResourceSummaryView = {
      beforeCleanup: { totalCount: 10, ignoredCount: 3, byType: {} },
      afterCooldown: { totalCount: 0, ignoredCount: 3, byType: {} },
      remainingTypes: [],
      ignoredResources: [
        {
          arn: "arn:aws:iam::123456789012:role/TestRole",
          resourceType: "iam:role",
          region: "us-east-1",
        },
      ],
      ignoredResourcesTotalCount: 3,
    };

    const report = createMockCleanupReport({ resourceSummary });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("Post-cleanup validation")).toBeInTheDocument();
    expect(screen.getByText("Filtered resources")).toBeInTheDocument();
    expect(screen.getByText("Remaining resources")).toBeInTheDocument();
  });

  describe("Cooldown banner", () => {
    const cooldownResourceSummary: CleanupResourceSummaryView = {
      beforeCleanup: {
        totalCount: 15,
        ignoredCount: 3,
        byType: { "ec2:instance": 10, "s3:bucket": 5 },
      },
      afterCooldown: { totalCount: 0, ignoredCount: 3, byType: {} },
      remainingTypes: [],
    };

    function createCoolingDownReport(
      overrides?: Partial<CleanupReportView>,
    ): CleanupReportView {
      return createMockInProgressReport({
        cleanupStatus: "COOLING_DOWN",
        resourceSummary: cooldownResourceSummary,
        steps: [
          {
            name: "acquire-cleanup-lock",
            startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
          },
          {
            name: "initialize-cleanup",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 55 }).toISO()!,
          },
          {
            name: "account-cooldown",
            startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
            meta: { cooldownDurationHours: 24 },
          },
        ],
        ...overrides,
      });
    }

    test("renders cooldown banner when cleanupStatus is COOLING_DOWN and status is IN_PROGRESS", () => {
      const report = createCoolingDownReport();
      const onSkipCooldown = vi.fn();

      renderWithQueryClient(
        <CleanupDetails report={report} onSkipCooldown={onSkipCooldown} />,
      );

      const cooldownElements = screen.getAllByText((_content, element) => {
        return (
          element?.tagName === "SPAN" &&
          (element?.textContent?.includes("Account cooling down") ?? false)
        );
      });
      expect(cooldownElements.length).toBeGreaterThanOrEqual(1);
      expect(
        screen.getByRole("button", { name: /Skip cooldown/ }),
      ).toBeInTheDocument();
    });

    test("does not render skip button when onSkipCooldown is undefined", () => {
      const report = createCoolingDownReport();

      renderWithQueryClient(<CleanupDetails report={report} />);

      const cooldownElements = screen.getAllByText((_content, element) => {
        return (
          element?.tagName === "SPAN" &&
          (element?.textContent?.includes("Account cooling down") ?? false)
        );
      });
      expect(cooldownElements.length).toBeGreaterThanOrEqual(1);
      expect(
        screen.queryByRole("button", { name: /Skip cooldown/ }),
      ).not.toBeInTheDocument();
    });

    test("shows success state during cooldown when remaining resources is 0", () => {
      const report = createCoolingDownReport({
        resourceSummary: cooldownResourceSummary,
      });

      renderWithQueryClient(<CleanupDetails report={report} />);

      expect(
        screen.getByText("All resources cleaned successfully"),
      ).toBeInTheDocument();
      // Should NOT show the error/failure icon text
      expect(
        screen.queryByText(/resources failed to clean up/),
      ).not.toBeInTheDocument();
    });

    test("does not show cooldown banner when status is COMPLETED", () => {
      const report = createMockCleanupReport({
        status: "COMPLETED",
        cleanupStatus: "COMPLETED",
      });

      renderWithQueryClient(<CleanupDetails report={report} />);

      expect(
        screen.queryByText((_content, element) => {
          return (
            element?.textContent?.includes("Account cooling down") ?? false
          );
        }),
      ).not.toBeInTheDocument();
    });

    test("skip button shows loading state when isSkipping is true", () => {
      const report = createCoolingDownReport();
      const onSkipCooldown = vi.fn();

      renderWithQueryClient(
        <CleanupDetails
          report={report}
          onSkipCooldown={onSkipCooldown}
          isSkipping={true}
        />,
      );

      const skipButton = screen.getByRole("button", { name: /Skip cooldown/ });
      expect(skipButton).toBeInTheDocument();
      // Cloudscape Button with loading=true renders aria-disabled
      expect(skipButton).toHaveAttribute("aria-disabled", "true");
    });
  });

  describe("Nuke iteration outcomes", () => {
    test("renders warning status for failed nuke iteration that was retried", () => {
      const report = createMockCleanupReport({
        steps: [
          {
            name: "acquire-cleanup-lock",
            startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
          },
          {
            name: "initialize-cleanup",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 55 }).toISO()!,
          },
          {
            name: "nuke-phase-1-start",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 50 }).toISO()!,
            completedAt: DateTime.now()
              .minus({ hours: 1, minutes: 48 })
              .toISO()!,
            meta: {
              outcome: "FAILED",
              codeBuildExecutionArn:
                "arn:aws:codebuild:us-east-1:123:build/cleanup:build-1",
            },
          },
          {
            name: "nuke-phase-2-start",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 45 }).toISO()!,
            completedAt: DateTime.now()
              .minus({ hours: 1, minutes: 40 })
              .toISO()!,
            meta: {
              outcome: "SUCCEEDED",
              codeBuildExecutionArn:
                "arn:aws:codebuild:us-east-1:123:build/cleanup:build-2",
            },
          },
          {
            name: "cleanup-complete",
            startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
          },
        ],
      });

      renderWithQueryClient(<CleanupDetails report={report} />);

      // The Steps component renders statusIconAriaLabel for each step.
      // Failed nuke iteration should render "Warning" aria label.
      const warningIcons = screen.getAllByLabelText("Warning");
      expect(warningIcons.length).toBeGreaterThanOrEqual(1);

      // Succeeded nuke iteration should render "Success" aria label
      const successIcons = screen.getAllByLabelText("Success");
      expect(successIcons.length).toBeGreaterThanOrEqual(1);
    });

    test("renders all nuke iterations as success when none failed", () => {
      const report = createMockCleanupReport({
        steps: [
          {
            name: "acquire-cleanup-lock",
            startedAt: DateTime.now().minus({ hours: 2 }).toISO()!,
          },
          {
            name: "nuke-phase-1-start",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 50 }).toISO()!,
            completedAt: DateTime.now()
              .minus({ hours: 1, minutes: 40 })
              .toISO()!,
            meta: {
              outcome: "SUCCEEDED",
              codeBuildExecutionArn:
                "arn:aws:codebuild:us-east-1:123:build/cleanup:build-1",
            },
          },
          {
            name: "nuke-phase-2-start",
            startedAt: DateTime.now().minus({ hours: 1, minutes: 35 }).toISO()!,
            completedAt: DateTime.now()
              .minus({ hours: 1, minutes: 25 })
              .toISO()!,
            meta: {
              outcome: "SUCCEEDED",
              codeBuildExecutionArn:
                "arn:aws:codebuild:us-east-1:123:build/cleanup:build-2",
            },
          },
          {
            name: "cleanup-complete",
            startedAt: DateTime.now().minus({ hours: 1 }).toISO()!,
          },
        ],
      });

      renderWithQueryClient(<CleanupDetails report={report} />);

      // No warning icons should be present for nuke steps
      expect(screen.queryByLabelText("Warning")).not.toBeInTheDocument();
    });
  });

  test("shows the start and completion times as relative times", () => {
    const report = createMockCleanupReport({
      startedAt: "2024-06-15T07:00:00.000Z",
      completedAt: "2024-06-15T08:00:00.000Z",
    });

    renderWithQueryClient(<CleanupDetails report={report} />);

    expect(screen.getByText("5 hours ago")).toBeInTheDocument();
    expect(screen.getByText("4 hours ago")).toBeInTheDocument();
  });
});

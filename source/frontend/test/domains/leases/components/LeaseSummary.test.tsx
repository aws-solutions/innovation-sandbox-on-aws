// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { MonitoredLeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const developerPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "DeveloperAccess",
  description: "Developer sandbox access",
  availability: "AVAILABLE" as const,
};
const unavailablePermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
  permissionSetId: "ps-1123456789abcdef",
  availability: "UNAVAILABLE" as const,
};

const lease: MonitoredLeaseView = createActiveLease({
  costReportGroup: "engineering-team",
  budgetThresholds: [{ dollarsSpent: 50, action: "FREEZE_ACCOUNT" }],
  durationThresholds: [{ hoursRemaining: 24, action: "ALERT" }],
});

describe("LeaseSummary admin-field visibility", () => {
  describe("admin view (showAdminFields={true})", () => {
    it("shows Cost Report Settings, Last Monitored, and threshold sections", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={true} />,
      );

      expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
      expect(screen.getByText("Last Monitored")).toBeInTheDocument();
      expect(screen.getByText("Budget Thresholds")).toBeInTheDocument();
      expect(screen.getByText("Duration Thresholds")).toBeInTheDocument();
    });
  });

  describe("default (no showAdminFields prop)", () => {
    it("hides admin fields, failing safe when a consumer forgets the prop", () => {
      renderWithQueryClient(<LeaseSummary lease={lease} />);
      expect(screen.queryByText("Last Monitored")).not.toBeInTheDocument();
      expect(screen.queryByText("Budget Thresholds")).not.toBeInTheDocument();
      expect(screen.queryByText("Duration Thresholds")).not.toBeInTheDocument();
    });
  });

  describe("predictive budget read view", () => {
    it("shows the opt-ins as disabled and rate limits as not set on a lease without the feature", () => {
      // Pin sharing and Sandbox Spaces off so their Enabled/Disabled indicators are
      // deterministic, and pin a trigger-less threshold so the Cost basis
      // assertion below reads reported cost.
      const plainLease = createActiveLease({
        allowOwnerToShareLease: false,
        sandboxSpacesEnabled: false,
        budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
      });

      renderWithQueryClient(
        <LeaseSummary lease={plainLease} showAdminFields={true} />,
      );

      expect(screen.getByText("Estimated cost tracking")).toBeInTheDocument();
      expect(
        screen.getByText("Amazon Bedrock token monitoring"),
      ).toBeInTheDocument();
      expect(screen.getByText("Spend rate thresholds")).toBeInTheDocument();
      // Two feature rows plus the sharing and Sandbox Spaces indicators.
      expect(screen.getAllByText("Disabled")).toHaveLength(4);
      expect(screen.getByText("Not set")).toBeInTheDocument();
      expect(screen.getByText("Cost basis")).toBeInTheDocument();
      expect(screen.getByText("Reported cost")).toBeInTheDocument();
    });

    it("shows enabled opt-ins, formatted rate caps, and per-threshold triggers on an opted-in lease", () => {
      const optedInLease = createActiveLease({
        allowOwnerToShareLease: false,
        predictiveBudgetEnabled: true,
        bedrockTokenMonitoringEnabled: true,
        rateLimits: [
          { basis: "HOURLY", rate: 2.5, action: "ALERT" },
          { basis: "DAILY", rate: 40, action: "FREEZE_ACCOUNT" },
        ],
        budgetThresholds: [
          { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
          { dollarsSpent: 75, action: "ALERT" },
        ],
      });

      renderWithQueryClient(
        <LeaseSummary lease={optedInLease} showAdminFields={true} />,
      );

      expect(screen.getAllByText("Enabled")).toHaveLength(2);
      expect(
        screen.getByText("$2.50/hour (Send alert), $40.00/day (Freeze lease)"),
      ).toBeInTheDocument();
      // A PREDICTED threshold is labelled as such; one without triggerOn
      // reads as reported cost.
      expect(screen.getByText("Estimated cost")).toBeInTheDocument();
      expect(screen.getByText("Reported cost")).toBeInTheDocument();
    });

    it("shows no rate limits on an opted-in lease with no rateLimits list", () => {
      const optedInLease = createActiveLease({
        predictiveBudgetEnabled: true,
        rateLimits: undefined,
      });

      renderWithQueryClient(
        <LeaseSummary lease={optedInLease} showAdminFields={true} />,
      );

      expect(screen.getByText("Spend rate thresholds")).toBeInTheDocument();
      expect(screen.queryByText(/\/hour|\/day/)).not.toBeInTheDocument();
    });
  });

  describe("user view (showAdminFields={false})", () => {
    it("hides the Last Monitored row", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.queryByText("Last Monitored")).not.toBeInTheDocument();
    });

    it("hides the Budget and Duration Thresholds sections", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.queryByText("Budget Thresholds")).not.toBeInTheDocument();
      expect(screen.queryByText("Duration Thresholds")).not.toBeInTheDocument();
    });

    it("still shows Budget Status and Lease Expiry", () => {
      renderWithQueryClient(
        <LeaseSummary lease={lease} showAdminFields={false} />,
      );

      expect(screen.getByText("Budget Status")).toBeInTheDocument();
      expect(screen.getByText("Lease Expiry")).toBeInTheDocument();
    });

    it("shows the evaluated spend in Budget Status when it is above the billed total", () => {
      renderWithQueryClient(
        <LeaseSummary
          lease={{
            ...lease,
            maxSpend: 100,
            totalCostAccrued: 25,
            lastEvaluatedSpend: 40,
            bedrockTokenMonitoringEnabled: true,
          }}
          showAdminFields={false}
        />,
      );

      expect(screen.getByText("$40 of $100")).toBeInTheDocument();
    });
  });
});

describe("LeaseSummary Sandbox Spaces section", () => {
  // Sharing pinned off: it shares the overridden wording, and LeaseSummary
  // defaults lease sharing to globally disabled.
  const spacesLease = () =>
    createActiveLease({
      sandboxSpacesEnabled: true,
      allowOwnerToShareLease: false,
    });

  it("reads as overridden when the lease has it on but it is disabled globally", () => {
    renderWithQueryClient(
      <LeaseSummary lease={spacesLease()} sandboxSpacesEnabled={false} />,
    );

    expect(screen.getByText("Disabled (overridden)")).toBeInTheDocument();
  });

  it("offers Edit when edit buttons are shown and a handler is given", () => {
    renderWithQueryClient(
      <LeaseSummary
        lease={spacesLease()}
        sandboxSpacesEnabled
        showEditButtons
        onEditSandboxSpaces={() => {}}
      />,
    );
    expect(screen.getAllByRole("button", { name: "Edit" })).toHaveLength(1);
  });

  it("hides Edit when edit buttons are not shown", () => {
    renderWithQueryClient(
      <LeaseSummary
        lease={spacesLease()}
        sandboxSpacesEnabled
        onEditSandboxSpaces={() => {}}
      />,
    );
    expect(
      screen.queryByRole("button", { name: "Edit" }),
    ).not.toBeInTheDocument();
  });
});

describe("LeaseSummary permission profile section", () => {
  it("renders hydrated permission-set names, descriptions, and unavailable state", () => {
    renderWithQueryClient(
      <LeaseSummary
        lease={createActiveLease({
          defaultPermissionSet: developerPermissionSet,
          allowedPermissionSets: [
            developerPermissionSet,
            unavailablePermissionSet,
          ],
        })}
      />,
    );

    expect(screen.getByText("Access settings")).toBeInTheDocument();
    expect(screen.getByText("Lease sharing")).toBeInTheDocument();
    expect(screen.getByText("Permission sets")).toBeInTheDocument();
    expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
    expect(screen.getByText("Developer sandbox access")).toBeInTheDocument();
    expect(
      screen.getByText(unavailablePermissionSet.permissionSetArn),
    ).toBeInTheDocument();
    expect(screen.getByText("Unavailable")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
    expect(screen.queryByText("Allowed")).not.toBeInTheDocument();
  });

  it("renders the legacy built-in defaults without client catalog lookup", () => {
    renderWithQueryClient(
      <LeaseSummary
        lease={createActiveLease({
          defaultPermissionSet: undefined,
          allowedPermissionSets: undefined,
        })}
      />,
    );

    expect(screen.getByText("Full sandbox access")).toBeInTheDocument();
    expect(screen.getByText("Default")).toBeInTheDocument();
  });

  it("shows a specifically labelled edit action only when authorized by the caller", () => {
    const onEditAccessSettings = vi.fn();
    const { unmount } = renderWithQueryClient(
      <LeaseSummary
        lease={lease}
        showEditButtons
        onEditAccessSettings={onEditAccessSettings}
      />,
    );

    screen.getByRole("button", { name: "Edit access settings" }).click();
    expect(onEditAccessSettings).toHaveBeenCalledOnce();

    unmount();
    renderWithQueryClient(<LeaseSummary lease={lease} />);
    expect(
      screen.queryByRole("button", { name: "Edit access settings" }),
    ).not.toBeInTheDocument();
  });

  it("shows when the lease started and was last monitored as relative times", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));

    renderWithQueryClient(
      <LeaseSummary
        lease={createActiveLease({
          startDate: "2026-08-11T09:00:00.000Z",
          lastCheckedDate: "2026-08-11T11:00:00.000Z",
        })}
        showAdminFields={true}
      />,
    );

    expect(screen.getByText("5 hours ago")).toBeInTheDocument();
    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

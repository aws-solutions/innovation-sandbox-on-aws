// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { BrowserRouter as Router } from "react-router-dom";
import { describe, expect, test } from "vitest";

import { LeaseStatus } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { getLeaseStatusDisplayName } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  createActiveLease,
  createExpiredLease,
  createLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import moment from "moment";

describe("LeaseSummary", () => {
  const renderComponent = (lease: any) =>
    renderWithQueryClient(
      <Router>
        <LeaseSummary lease={lease} />
      </Router>,
    );

  test("renders active lease details correctly", () => {
    const activeLease = createActiveLease({
      status: "Active",
      approvedBy: "approver@example.com",
      totalCostAccrued: 500,
      maxSpend: 1000,
      costReportGroup: "finance-team-a",
    });

    renderComponent(activeLease);

    expect(screen.getByText("Lease Summary")).toBeInTheDocument();
    expect(screen.getByText(activeLease.uuid)).toBeInTheDocument();
    expect(screen.getByText(activeLease.awsAccountId)).toBeInTheDocument();
    expect(
      screen.getByText(activeLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText(activeLease.userEmail)).toBeInTheDocument();
    expect(screen.getByText("approver@example.com")).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText("finance-team-a")).toBeInTheDocument();
  });

  test("handles lease without max spend", () => {
    const leaseWithoutMaxSpend = createActiveLease({
      maxSpend: undefined,
      status: "Active",
    });
    renderComponent(leaseWithoutMaxSpend);

    expect(screen.getByText("No max budget")).toBeInTheDocument();
  });

  test("renders correctly for different lease statuses", () => {
    const statuses: LeaseStatus[] = [
      "Active",
      "Frozen",
      "Expired",
      "BudgetExceeded",
      "ManuallyTerminated",
    ];

    statuses.forEach((status) => {
      const lease = createLease({ status });
      const { unmount } = renderComponent(lease);

      expect(
        screen.getByText(getLeaseStatusDisplayName(status)),
      ).toBeInTheDocument();
      unmount();
    });
  });

  test("displays auto-approved status correctly", () => {
    const autoApprovedLease = createActiveLease({
      approvedBy: "AUTO_APPROVED",
    });
    renderComponent(autoApprovedLease);
    expect(screen.getByText("Auto Approved")).toBeInTheDocument();
  });

  test("renders pending lease details correctly", () => {
    const pendingLease = createPendingLease({
      status: "PendingApproval",
      comments: "Please approve this lease",
    });

    renderComponent(pendingLease);

    expect(screen.getByText("Lease Summary")).toBeInTheDocument();
    expect(screen.getByText(pendingLease.uuid)).toBeInTheDocument();
    expect(
      screen.getByText(pendingLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText(pendingLease.userEmail)).toBeInTheDocument();
    expect(screen.getByText("Pending Approval")).toBeInTheDocument();
    expect(screen.getByText("Please approve this lease")).toBeInTheDocument();
  });

  test.each([
    {
      description: "createdBy exists",
      createdBy: "admin@example.com",
      userEmail: "user@example.com",
      expectedCreatedBy: "admin@example.com",
    },
    {
      description: "createdBy does not exist",
      createdBy: undefined,
      userEmail: "different-user@example.com",
      expectedCreatedBy: "different-user@example.com",
    },
  ])(
    "renders Created By field correctly when $description",
    ({ createdBy, userEmail, expectedCreatedBy }) => {
      const lease = createActiveLease({
        createdBy: createdBy as any,
        userEmail,
      });

      renderComponent(lease);

      expect(screen.getByText("Created By")).toBeInTheDocument();

      const createdByElements = screen.getAllByText(expectedCreatedBy);
      expect(createdByElements.length).toBeGreaterThan(0);
    },
  );

  test("displays cost report group when assigned", () => {
    const leaseWithCostReportGroup = createActiveLease({
      costReportGroup: "marketing-team-b",
    });

    renderComponent(leaseWithCostReportGroup);

    expect(screen.getByText("Cost Report Group")).toBeInTheDocument();
    expect(screen.getByText("marketing-team-b")).toBeInTheDocument();
  });

  test("displays 'Not assigned' when cost report group is not set", () => {
    const leaseWithoutCostReportGroup = createActiveLease({
      costReportGroup: undefined,
    });

    renderComponent(leaseWithoutCostReportGroup);

    expect(screen.getByText("Cost Report Group")).toBeInTheDocument();
    expect(screen.getByText("Not assigned")).toBeInTheDocument();
  });

  test.each([
    { amount: 1, unit: "hours", expected: "an hour ago" },
    { amount: 3, unit: "hours", expected: "3 hours ago" },
    { amount: 1, unit: "days", expected: "a day ago" },
    { amount: 3, unit: "days", expected: "3 days ago" },
    { amount: 1, unit: "months", expected: "a month ago" },
  ])(
    "displays proper expiry date for expired lease - $expected",
    ({ amount, unit, expected }) => {
      const expirationDate = moment()
        .subtract(amount, unit as any)
        .toISOString();
      const expiredLease = createExpiredLease({
        endDate: expirationDate,
        // Ensure startDate and lastCheckedDate are different to avoid duplicates
        startDate: moment()
          .subtract(amount + 1, unit as any)
          .toISOString(),
        lastCheckedDate: moment()
          .subtract(amount + 1, unit as any)
          .toISOString(),
      });

      renderComponent(expiredLease);

      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );
});

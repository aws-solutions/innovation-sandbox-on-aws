// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

describe("LeaseStatusBadge", () => {
  const renderComponent = (lease: any) =>
    renderWithQueryClient(<LeaseStatusBadge lease={lease} />);

  test("renders Active status with correct color", () => {
    const activeLease = createActiveLease({ status: "Active" });
    renderComponent(activeLease);

    const badge = screen.getByText("Active");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-green");
  });

  test("renders Frozen status with correct color", () => {
    const frozenLease = createActiveLease({ status: "Frozen" });
    renderComponent(frozenLease);

    const badge = screen.getByText("Frozen");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-blue");
  });

  test("renders PendingApproval status with correct color", () => {
    const pendingLease = createPendingLease({ status: "PendingApproval" });
    renderComponent(pendingLease);

    const badge = screen.getByText("Pending Approval");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-severity-low");
  });

  test("renders Expired status with correct color", () => {
    const expiredLease = createExpiredLease({ status: "Expired" });
    renderComponent(expiredLease);

    const badge = screen.getByText("Lease Duration Expired");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-red");
  });

  test("renders BudgetExceeded status with correct color", () => {
    const budgetExceededLease = createExpiredLease({
      status: "BudgetExceeded",
    });
    renderComponent(budgetExceededLease);

    const badge = screen.getByText("Budget Exceeded");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-red");
  });

  test("renders ManuallyTerminated status with correct color", () => {
    const manuallyTerminatedLease = createExpiredLease({
      status: "ManuallyTerminated",
    });
    renderComponent(manuallyTerminatedLease);

    const badge = screen.getByText("Lease Manually Terminated");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-red");
  });

  test("renders unknown status with default color", () => {
    const unknownStatusLease = createActiveLease({
      status: "UnknownStatus" as any,
    });
    renderComponent(unknownStatusLease);

    const badge = screen.getByText("Unknown Status");
    expect(badge).toBeInTheDocument();
    expect(badge.className).toContain("badge-color-red");
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import {
  Lease,
  LeaseWithLeaseId,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeasePanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/LeasePanel";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import moment from "moment";

// Mock the AccountLoginLink component
vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <button>Login to account {accountId}</button>
    ),
  }),
);

describe("LeasePanel", () => {
  const renderComponent = (lease: Lease) => {
    return renderWithQueryClient(
      <BrowserRouter>
        <LeasePanel lease={lease as LeaseWithLeaseId} />
      </BrowserRouter>,
    );
  };

  test("renders active lease correctly", () => {
    const activeLease = createActiveLease();
    renderComponent(activeLease);

    expect(
      screen.getByText(activeLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText("Active")).toBeInTheDocument();
    expect(screen.getByText(activeLease.awsAccountId)).toBeInTheDocument();
    expect(
      screen.getByText(`Login to account ${activeLease.awsAccountId}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`$${activeLease.maxSpend!.toString()}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`$${activeLease.totalCostAccrued.toString()}`),
    ).toBeInTheDocument();
  });

  test("renders pending lease correctly", () => {
    const pendingLease = createPendingLease();
    renderComponent(pendingLease);

    expect(
      screen.getByText(pendingLease.originalLeaseTemplateName),
    ).toBeInTheDocument();
    expect(screen.getByText("Pending Approval")).toBeInTheDocument();
    expect(
      screen.getByText("Your account is pending approval"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("renders budget information correctly for a lease with max budget", () => {
    const leaseWithBudget = createActiveLease({
      maxSpend: 1000,
      totalCostAccrued: 500,
    });

    renderComponent(leaseWithBudget);
    expect(
      screen.getByText(`Login to account ${leaseWithBudget.awsAccountId}`),
    ).toBeInTheDocument();
    expect(screen.getByText(leaseWithBudget.awsAccountId)).toBeInTheDocument();
    expect(
      screen.getByText(`$${leaseWithBudget.maxSpend!.toString()}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`$${leaseWithBudget.totalCostAccrued.toString()}`),
    ).toBeInTheDocument();
  });

  test("renders budget information correctly for a lease without max budget", () => {
    const leaseWithoutBudget = createActiveLease({ maxSpend: undefined });

    renderComponent(leaseWithoutBudget);
    expect(
      screen.getByText(`Login to account ${leaseWithoutBudget.awsAccountId}`),
    ).toBeInTheDocument();
    expect(
      screen.getByText(leaseWithoutBudget.awsAccountId),
    ).toBeInTheDocument();
    expect(screen.getByText("No max budget")).toBeInTheDocument();
    expect(
      screen.getByText(`$${leaseWithoutBudget.totalCostAccrued.toString()}`),
    ).toBeInTheDocument();
  });

  test("displays expiration date correctly", () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const leaseWithFutureExpiry = createActiveLease({
      expirationDate: futureDate.toISOString(),
    });

    const pastDate = new Date();
    pastDate.setDate(pastDate.getDate() - 7);

    renderComponent(leaseWithFutureExpiry);
    expect(screen.getByText(/in 7 days/)).toBeInTheDocument();
  });

  test("handles lease without maxSpend", () => {
    const leaseWithoutMaxSpend = createActiveLease({ maxSpend: undefined });
    renderComponent(leaseWithoutMaxSpend);

    expect(screen.getByText("No max budget")).toBeInTheDocument();
  });

  test("handles lease without expirationDate", () => {
    const leaseWithoutExpiry = createPendingLease({
      leaseDurationInHours: 24,
    });
    renderComponent(leaseWithoutExpiry);

    expect(screen.getByText(/a day/)).toBeInTheDocument();
    expect(screen.getByText("after approval")).toBeInTheDocument();
  });

  test("handles lease without expirationDate and duration", () => {
    const leaseWithoutExpiryAndDuration = createActiveLease({
      expirationDate: undefined,
      leaseDurationInHours: undefined,
    });
    renderComponent(leaseWithoutExpiryAndDuration);

    expect(screen.getByText("No expiry")).toBeInTheDocument();
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
      });

      renderComponent(expiredLease);

      expect(screen.getByText(expected)).toBeInTheDocument();
    },
  );
});

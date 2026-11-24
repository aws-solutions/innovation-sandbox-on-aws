// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, test, vi } from "vitest";

import {
  getLeaseColumnDefinitions,
  LeaseSandboxSpaceOptions,
  LeaseTableItem,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/leaseTableConfig";
import { LeaseLoginPermissions } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockAuthenticatedUser } from "@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures";

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AccountLoginLink",
  () => ({
    AccountLoginLink: ({ accountId }: { accountId: string }) => (
      <span>Login to account {accountId}</span>
    ),
  }),
);

const userPermissions: LeaseLoginPermissions = {
  isAdmin: false,
  isManager: false,
};
const managerPermissions: LeaseLoginPermissions = {
  isAdmin: false,
  isManager: true,
};
const adminPermissions: LeaseLoginPermissions = {
  isAdmin: true,
  isManager: false,
};

const renderAccessCell = (
  lease: LeaseTableItem,
  permissions: LeaseLoginPermissions,
  sandboxSpaces?: LeaseSandboxSpaceOptions,
) => {
  const accessColumn = getLeaseColumnDefinitions(
    permissions,
    sandboxSpaces,
  ).find((column) => column.id === "access");
  if (!accessColumn) {
    throw new Error("Access column is not configured");
  }

  render(<>{accessColumn.cell(lease)}</>);
};

describe("lease table Access column", () => {
  test("renders Login for a manager on a frozen lease", () => {
    renderAccessCell(
      createActiveLease({ status: "Frozen" }),
      managerPermissions,
    );

    expect(screen.getByText(/Login to account/i)).toBeInTheDocument();
  });

  test("renders Login for an admin on a provisioning lease", () => {
    renderAccessCell(
      createActiveLease({
        awsAccountId: "111122223333",
        status: "Provisioning",
      }),
      adminPermissions,
    );

    expect(
      screen.getByText("Login to account 111122223333"),
    ).toBeInTheDocument();
  });

  test("does not render Login for a user on a frozen lease", () => {
    renderAccessCell(createActiveLease({ status: "Frozen" }), userPermissions);

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });

  test("does not render Login for an admin on an expired lease", () => {
    renderAccessCell(createExpiredLease(), adminPermissions);

    expect(screen.queryByText(/Login to account/i)).not.toBeInTheDocument();
  });
});

describe("lease table Access column Open Space menu", () => {
  const owner = { ...mockAuthenticatedUser, email: "owner@example.com" };
  const MENU_BUTTON = { name: "More access options" };

  const makeOptions = (
    overrides: Partial<LeaseSandboxSpaceOptions> = {},
  ): LeaseSandboxSpaceOptions => ({
    user: owner,
    onOpenSpace: vi.fn(),
    ...overrides,
  });

  const spaceLease = (
    overrides: Parameters<typeof createActiveLease>[0] = {},
  ): LeaseTableItem =>
    createActiveLease({
      awsAccountId: "111122223333",
      userEmail: owner.email,
      sandboxSpacesEnabled: true,
      ...overrides,
    });

  test("shows no menu when Sandbox Spaces is off for the deployment", () => {
    renderAccessCell(spaceLease(), userPermissions, undefined);

    expect(screen.getByText(/Login to account/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", MENU_BUTTON)).not.toBeInTheDocument();
  });

  test("shows no menu when the lease has no Space", () => {
    renderAccessCell(
      spaceLease({ sandboxSpacesEnabled: false }),
      userPermissions,
      makeOptions(),
    );

    expect(screen.queryByRole("button", MENU_BUTTON)).not.toBeInTheDocument();
  });

  test("Open Space in the menu opens the Space for the owner", async () => {
    const options = makeOptions();
    const lease = spaceLease();
    renderAccessCell(lease, userPermissions, options);

    await userEvent.click(screen.getByRole("button", MENU_BUTTON));
    await userEvent.click(await screen.findByText("Open Space"));

    expect(options.onOpenSpace).toHaveBeenCalledWith(lease);
  });

  test("shows the menu to a user added to the lease directly", async () => {
    const options = makeOptions();
    const lease = spaceLease({
      userEmail: "someone-else@example.com",
      desiredAssignments: [
        { principalType: "USER", principalId: owner.userId },
      ],
    });
    renderAccessCell(lease, userPermissions, options);

    await userEvent.click(screen.getByRole("button", MENU_BUTTON));
    await userEvent.click(await screen.findByText("Open Space"));

    expect(options.onOpenSpace).toHaveBeenCalledWith(lease);
  });

  test("shows no menu to a user who has access only through a group", () => {
    renderAccessCell(
      spaceLease({
        userEmail: "someone-else@example.com",
        desiredAssignments: [
          { principalType: "GROUP", principalId: owner.userId },
        ],
      }),
      userPermissions,
      makeOptions(),
    );

    expect(screen.queryByRole("button", MENU_BUTTON)).not.toBeInTheDocument();
  });

  test("shows no menu to a viewer who is not the owner or a direct assignee", () => {
    renderAccessCell(
      spaceLease({ userEmail: "someone-else@example.com" }),
      adminPermissions,
      makeOptions(),
    );

    expect(screen.getByText(/Login to account/i)).toBeInTheDocument();
    expect(screen.queryByRole("button", MENU_BUTTON)).not.toBeInTheDocument();
  });
});

const getBudgetColumn = () => {
  const budgetColumn = getLeaseColumnDefinitions(userPermissions).find(
    (column) => column.id === "budget",
  );
  if (!budgetColumn) {
    throw new Error("Budget column is not configured");
  }
  return budgetColumn;
};

describe("lease table Budget column", () => {
  test("shows the evaluated spend when it is above the billed total", () => {
    const lease = createActiveLease({
      maxSpend: 100,
      totalCostAccrued: 25,
      lastEvaluatedSpend: 40,
      bedrockTokenMonitoringEnabled: true,
    });

    render(<>{getBudgetColumn().cell(lease)}</>);

    expect(screen.getByText("$40 of $100")).toBeInTheDocument();
  });

  test("sorts on the same spend the bar shows", () => {
    const { sortingComparator } = getBudgetColumn();
    if (!sortingComparator) {
      throw new Error("Budget column has no sorting comparator");
    }
    const billedHigher = createActiveLease({
      totalCostAccrued: 30,
      lastEvaluatedSpend: 10,
      bedrockTokenMonitoringEnabled: true,
    });
    const evaluatedHigher = createActiveLease({
      totalCostAccrued: 5,
      lastEvaluatedSpend: 20,
      bedrockTokenMonitoringEnabled: true,
    });
    const expired = createExpiredLease({
      totalCostAccrued: 15,
      lastEvaluatedSpend: 40,
      bedrockTokenMonitoringEnabled: true,
    });
    const pending = createPendingLease();

    const sorted = [expired, billedHigher, pending, evaluatedHigher].sort(
      sortingComparator,
    );

    expect(sorted).toEqual([pending, evaluatedHigher, billedHigher, expired]);
  });
});

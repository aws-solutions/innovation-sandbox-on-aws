// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper, {
  ButtonWrapper,
} from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils";
import { ListLeases } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/ListLeases";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { ModalProvider } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import {
  createActiveLease,
  createExpiredLease,
  createPendingLease,
} from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import {
  mockConfigurationApi,
  mockLeaseApi,
} from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import moment from "moment";

// Mock ResizeObserver
global.ResizeObserver = vi.fn().mockImplementation(() => ({
  observe: vi.fn(),
  unobserve: vi.fn(),
  disconnect: vi.fn(),
}));

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

// Mock the navigate function
const mockNavigate = vi.fn();
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock(
  "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar",
  () => ({
    BudgetProgressBar: ({
      currentValue,
      maxValue,
    }: {
      currentValue: number;
      maxValue: number;
    }) => (
      <div
        data-testid="budget-progress-bar"
        data-current={currentValue}
        data-max={maxValue}
      />
    ),
  }),
);

describe("ListLeases", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <ModalProvider>
        <BrowserRouter>
          <ListLeases />
        </BrowserRouter>
      </ModalProvider>,
    );

  const mockActiveLease = createActiveLease({
    userEmail: "test@example.com",
    originalLeaseTemplateName: "Basic Template",
    status: "Active",
    awsAccountId: "123456789012",
    totalCostAccrued: 100,
    maxSpend: 1000,
  });

  const mockFrozenLease = createActiveLease({
    userEmail: "test@example.com",
    originalLeaseTemplateName: "Basic Template",
    status: "Frozen",
    awsAccountId: "123456789012",
    totalCostAccrued: 100,
    maxSpend: 1000,
  });

  const mockPendingLease = createPendingLease({
    userEmail: "pending@example.com",
    originalLeaseTemplateName: "Advanced Template",
    status: "PendingApproval",
  });

  const mockExpiredLease = createExpiredLease({
    userEmail: "expired@example.com",
    originalLeaseTemplateName: "Expired Template",
    status: "Expired",
    awsAccountId: "210987654321",
  });

  beforeEach(() => {
    const mockConfig = createConfiguration({
      auth: {
        awsAccessPortalUrl: "https://test.aws.amazon.com/access-portal",
        webAppUrl: "https://test.aws.amazon.com",
      },
    });
    mockConfigurationApi.returns(mockConfig);
    server.use(mockConfigurationApi.getHandler());
  });

  test("renders the header correctly", async () => {
    renderComponent();
    const wrapper = createWrapper();
    const header = wrapper.findHeader();
    expect(header?.findHeadingText()?.getElement()).toHaveTextContent("Leases");
    expect(header?.findDescription()?.getElement()).toHaveTextContent(
      "Manage sandbox account leases",
    );
  });

  test("displays active leases by default", async () => {
    const mockLeases = [mockActiveLease, mockPendingLease, mockExpiredLease];
    mockLeaseApi.returns(mockLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
      expect(
        screen.getByText(mockActiveLease.originalLeaseTemplateName),
      ).toBeInTheDocument();
      expect(
        screen.getByText(mockActiveLease.awsAccountId),
      ).toBeInTheDocument();

      // Ensure pending and expired leases are not initially displayed
      expect(
        screen.queryByText(mockPendingLease.userEmail),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(mockExpiredLease.userEmail),
      ).not.toBeInTheDocument();
    });
  });

  test("displays 'No items to display' when no leases", async () => {
    mockLeaseApi.returns([]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const wrapper = createWrapper();
      const table = wrapper.findTable();
      expect(table?.findEmptySlot()?.getElement()).toHaveTextContent(
        "No items to display",
      );
    });
  });

  test("allows filtering by status", async () => {
    const mockLeases = [mockActiveLease, mockPendingLease, mockExpiredLease];
    mockLeaseApi.returns(mockLeases);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByTestId("status-filter")).toBeInTheDocument();
    });

    const statusFilter = screen.getByTestId("status-filter");

    const chooseOptionsButton =
      within(statusFilter).getByText("Choose options");
    await user.click(chooseOptionsButton);

    await waitFor(() => {
      const dropdownButton = within(statusFilter).getByRole("button", {
        name: "Choose options",
      });
      expect(dropdownButton).toHaveAttribute("aria-expanded", "true");
    });

    const options = await screen.findAllByRole("option");

    const activeOption = options.find((option) =>
      option.textContent!.includes("Active"),
    );
    if (activeOption) await user.click(activeOption);

    const pendingOption = options.find((option) =>
      option.textContent!.includes("Pending Approval"),
    );
    if (pendingOption) await user.click(pendingOption);

    await waitFor(() => {
      expect(screen.getByText(mockPendingLease.userEmail)).toBeInTheDocument();
      expect(
        screen.queryByText(mockActiveLease.userEmail),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText(mockExpiredLease.userEmail),
      ).not.toBeInTheDocument();
    });

    await user.click(chooseOptionsButton);

    const selectedOptions = within(statusFilter).getAllByRole("group");
    expect(selectedOptions).toHaveLength(1);
    expect(selectedOptions[0]).toHaveTextContent("Pending Approval");
  });

  test("displays AWS account information and login link", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText(mockActiveLease.awsAccountId),
      ).toBeInTheDocument();
      expect(screen.getByText("Login to account")).toBeInTheDocument();
    });

    const loginButton = screen.getByText("Login to account");
    expect(loginButton).toBeInTheDocument();
  });

  test("allows selecting and deselecting leases", async () => {
    mockLeaseApi.returns([mockActiveLease, mockPendingLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1]; // First checkbox after "select all"
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions").closest("button");
    expect(actionsButton).not.toBeDisabled();

    await user.click(checkbox);

    expect(actionsButton).toBeDisabled();
  });

  test("opens terminate modal when 'Terminate' action is selected", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const terminateOption = await screen.findByText("Terminate");
    await user.click(terminateOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Terminate Lease(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockActiveLease.awsAccountId),
      ).toBeInTheDocument(),
    );
  });

  test("opens freeze modal when 'Freeze' action is selected", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const freezeOption = await screen.findByText("Freeze");
    await user.click(freezeOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Freeze Lease(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockActiveLease.awsAccountId),
      ).toBeInTheDocument(),
    );
  });

  test("opens unfreeze modal when 'Unfreeze' action is selected", async () => {
    mockLeaseApi.returns([mockFrozenLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockFrozenLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const unfreezeOption = await screen.findByText("Unfreeze");
    await user.click(unfreezeOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);

    expect(modalContent.getByText("Unfreeze Lease(s)")).toBeInTheDocument();

    await waitFor(() =>
      expect(
        modalContent.getByText(mockFrozenLease.awsAccountId),
      ).toBeInTheDocument(),
    );
  });

  test("refreshes lease data when refresh button is clicked", async () => {
    let requestCount = 0;
    server.use(
      http.get(`${config.ApiUrl}/leases`, () => {
        requestCount++;
        return HttpResponse.json({
          status: "success",
          data: {
            result:
              requestCount === 1
                ? [mockActiveLease, mockPendingLease]
                : [mockActiveLease],
            nextPageIdentifier: null,
          },
        });
      }),
    );

    renderComponent();

    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
      expect(
        screen.queryByText(mockPendingLease.userEmail),
      ).not.toBeInTheDocument();
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();
    const refreshButton = table?.findComponent(
      'button[aria-label="Refresh"]',
      ButtonWrapper,
    );

    expect(refreshButton).not.toBeNull();
    expect(refreshButton?.getElement()).not.toBeDisabled();
    await user.click(refreshButton!.getElement());

    await waitFor(() => {
      expect(screen.getByText(mockActiveLease.userEmail)).toBeInTheDocument();
      // The pending lease should still not be visible after refresh
      expect(
        screen.queryByText(mockPendingLease.userEmail),
      ).not.toBeInTheDocument();
    });
  });

  test("renders budget progress bar correctly for active leases", async () => {
    const mockLease = createActiveLease({
      totalCostAccrued: 500,
      maxSpend: 1000,
      userEmail: "test@example.com",
      originalLeaseTemplateName: "Test Template",
    });
    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockLease.userEmail)).toBeInTheDocument();
    });

    // Find the mocked BudgetProgressBar
    const budgetProgressBar = screen.getByTestId("budget-progress-bar");
    expect(budgetProgressBar).toBeInTheDocument();

    // Check if the correct values are passed to the BudgetProgressBar
    expect(budgetProgressBar).toHaveAttribute("data-current", "500");
    expect(budgetProgressBar).toHaveAttribute("data-max", "1000");
  });

  test("renders expiry status correctly for active leases", async () => {
    const futureDate = new Date();
    futureDate.setDate(futureDate.getDate() + 7);
    const mockLease = createActiveLease({
      expirationDate: futureDate.toISOString(),
      leaseDurationInHours: 168,
    });
    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/in 7 days/i)).toBeInTheDocument();
    });
  });

  test.each([
    { amount: 1, unit: "hours", expected: /an hour ago/i },
    { amount: 3, unit: "hours", expected: /3 hours ago/i },
    { amount: 1, unit: "days", expected: /a day ago/i },
    { amount: 3, unit: "days", expected: /3 days ago/i },
    { amount: 1, unit: "months", expected: /a month ago/i },
  ])(
    "renders expiry status correctly for expired leases - $amount $unit ago",
    async ({ amount, unit, expected }) => {
      const expirationDate = moment()
        .subtract(amount, unit as any)
        .toISOString();
      const mockLease = createExpiredLease({
        endDate: expirationDate,
      });
      mockLeaseApi.returns([mockLease]);
      server.use(mockLeaseApi.getHandler());

      renderComponent();
      const user = userEvent.setup();

      const statusFilter = screen.getByTestId("status-filter");
      const chooseOptionsButton =
        within(statusFilter).getByText("Choose options");
      await user.click(chooseOptionsButton);

      within(statusFilter).getByRole("button", {
        name: "Choose options",
      });

      const options = await screen.findAllByRole("option");
      const expiredOption = options.find((option) =>
        option.textContent!.includes("Expired"),
      );
      if (expiredOption) await user.click(expiredOption);

      await waitFor(() => {
        expect(screen.getByText(expected)).toBeInTheDocument();
      });
    },
  );

  test("renders account login link for active leases", async () => {
    mockLeaseApi.returns([mockActiveLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      const loginLink = screen.getByText("Login to account");
      expect(loginLink).toBeInTheDocument();
    });
  });

  test("should render all columns properly", async () => {
    const mockLease = createActiveLease({
      costReportGroup: "finance-team-a",
    });

    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(mockLease.userEmail)).toBeInTheDocument();
      expect(screen.getByText(mockLease.createdBy!)).toBeInTheDocument();
      expect(
        screen.getByText(mockLease.originalLeaseTemplateName),
      ).toBeInTheDocument();
      expect(screen.getByText(mockLease.awsAccountId)).toBeInTheDocument();
      expect(screen.getByText("Login to account")).toBeInTheDocument();
      expect(screen.getByText("finance-team-a")).toBeInTheDocument();

      const budgetProgressBar = screen.getByTestId("budget-progress-bar");
      expect(budgetProgressBar).toBeInTheDocument();
      expect(budgetProgressBar).toHaveAttribute(
        "data-current",
        mockLease.totalCostAccrued.toString(),
      );
      expect(budgetProgressBar).toHaveAttribute(
        "data-max",
        mockLease.maxSpend?.toString(),
      );
      const activeElements = screen.getAllByText("Active");
      expect(activeElements.length).toBe(2);
    });

    const wrapper = createWrapper();
    const table = wrapper.findTable();

    expect(table?.findColumnHeaders()).toHaveLength(10);

    const columnHeaders = table?.findColumnHeaders();
    const headerTexts = columnHeaders?.map(
      (header) => header.getElement().textContent,
    );

    expect(headerTexts).toContain("User");
    expect(headerTexts).toContain("Created By");
    expect(headerTexts).toContain("Lease Template");
    expect(headerTexts).toContain("Cost Report Group");
    expect(headerTexts).toContain("Budget");
    expect(headerTexts).toContain("Expiry");
    expect(headerTexts).toContain("Status");
    expect(headerTexts).toContain("AWS Account");
    expect(headerTexts).toContain("Access");
  });

  test("shows threshold breach warning when unfreezing lease with budget risk", async () => {
    const mockLease = createActiveLease({
      status: "Frozen",
      totalCostAccrued: 75, // Above budget threshold
      maxSpend: 1000,
      budgetThresholds: [{ dollarsSpent: 50, action: "FREEZE_ACCOUNT" }],
      durationThresholds: [{ hoursRemaining: 4, action: "FREEZE_ACCOUNT" }],
      expirationDate: now().plus({ hour: 2 }).toISO(), // 2 hours from now (less than 4 hour threshold)
    });

    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const unfreezeOption = await screen.findByText("Unfreeze");
    await user.click(unfreezeOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);
    expect(modalContent.getByText("Unfreeze Lease(s)")).toBeInTheDocument();

    // Should show threshold breach warning
    expect(
      modalContent.getByText("Threshold Breach Warning"),
    ).toBeInTheDocument();
    expect(
      modalContent.getByText(/Budget threshold breached/),
    ).toBeInTheDocument();
    expect(
      modalContent.getByText(/Duration threshold breached/),
    ).toBeInTheDocument();
    expect(
      modalContent.getByText(
        /Consider extending the lease duration or budget limits/,
      ),
    ).toBeInTheDocument();
  });

  test("shows no warning when unfreezing lease without threshold risk", async () => {
    const mockLease = createActiveLease({
      status: "Frozen",
      totalCostAccrued: 20, // Below threshold
      maxSpend: 1000,
      budgetThresholds: [{ dollarsSpent: 50, action: "FREEZE_ACCOUNT" }],
      durationThresholds: [{ hoursRemaining: 4, action: "FREEZE_ACCOUNT" }],
      expirationDate: now().plus({ hour: 8 }).toISO(), // 8 hours from now (more than 4 hour threshold)
    });

    mockLeaseApi.returns([mockLease]);
    server.use(mockLeaseApi.getHandler());

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(mockLease.userEmail)).toBeInTheDocument();
    });

    const checkbox = screen.getAllByRole("checkbox")[1];
    await user.click(checkbox);

    const actionsButton = screen.getByText("Actions");
    await user.click(actionsButton);

    const unfreezeOption = await screen.findByText("Unfreeze");
    await user.click(unfreezeOption);

    const modal = screen.getByRole("dialog");
    await waitFor(() => {
      expect(modal).toBeInTheDocument();
    });

    const modalContent = within(modal);
    expect(modalContent.getByText("Unfreeze Lease(s)")).toBeInTheDocument();

    // Should not show threshold breach warning
    expect(
      modalContent.queryByText("Threshold Breach Warning"),
    ).not.toBeInTheDocument();
  });
});

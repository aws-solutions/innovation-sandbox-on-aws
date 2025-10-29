// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { BrowserRouter } from "react-router-dom";
import { describe, expect, test, vi } from "vitest";

import { showSuccessToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { UpdateLease } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/UpdateLease";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import {
  mockConfigurationApi,
  mockLeaseApi,
} from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock the useBreadcrumb hook
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

// Mock the useParams hook
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useParams: () => ({ leaseId: "test-lease-id" }),
    useNavigate: () => vi.fn(),
  };
});

// Mock the Toast component
vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
}));

describe("UpdateLease", () => {
  const mockLease = createActiveLease({
    uuid: "test-lease-id",
    budgetThresholds: [],
  });

  const renderComponent = () => {
    // Setup configuration mock for cost reporting
    server.use(mockConfigurationApi.getHandler());

    return renderWithQueryClient(
      <BrowserRouter>
        <UpdateLease />
      </BrowserRouter>,
    );
  };

  test("renders lease details correctly", async () => {
    mockLeaseApi.returns(mockLease);
    server.use(mockLeaseApi.getHandler("/:id"));

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", { name: mockLease.userEmail }),
      ).toBeInTheDocument();
      const summaryTab = screen.getByRole("tabpanel", { name: "Summary" });
      expect(within(summaryTab).getByText("Active")).toBeInTheDocument();
    });
  });

  test("renders tabs for active lease", async () => {
    mockLeaseApi.returns(mockLease);
    server.use(mockLeaseApi.getHandler("/:id"));

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Summary")).toBeInTheDocument();
      expect(screen.getByText("Budget")).toBeInTheDocument();
      expect(screen.getByText("Duration")).toBeInTheDocument();
      expect(screen.getByText("Cost Report")).toBeInTheDocument();
    });
  });

  test("updates budget successfully", async () => {
    const user = userEvent.setup();
    mockLeaseApi.returns(mockLease);
    server.use(mockLeaseApi.getHandler("/:id"));
    server.use(mockLeaseApi.patchHandler("/:id"));

    renderComponent();

    const budgetTab = await screen.findByRole("tab", { name: "Budget" });
    await user.click(budgetTab);

    await screen.findByRole("tabpanel", { name: "Budget" });

    const budgetInput = screen.getByLabelText("Maximum Budget Amount");

    await user.click(budgetInput);
    await user.keyboard("{Control>}a{/Control}");
    await user.keyboard("2000");

    const updateButton = screen.getByRole("button", {
      name: /Update Budget Settings/i,
    });
    await user.click(updateButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Lease updated successfully.",
      );
    });
  });

  test("updates cost report group successfully", async () => {
    const user = userEvent.setup();
    mockLeaseApi.returns(mockLease);
    server.use(mockLeaseApi.getHandler("/:id"));
    server.use(mockLeaseApi.patchHandler("/:id"));

    renderComponent();

    const costReportTab = await screen.findByRole("tab", {
      name: "Cost Report",
    });
    await user.click(costReportTab);

    await screen.findByRole("tabpanel", { name: "Cost Report" });

    const costReportInput = screen.getByLabelText("Cost Report Group");

    await user.click(costReportInput);
    await user.keyboard("{Control>}a{/Control}");
    await user.keyboard("finance-team-a");

    const updateButton = screen.getByRole("button", {
      name: /Update Cost Report Group/i,
    });
    await user.click(updateButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Lease updated successfully.",
      );
    });
  });

  test("handles error when fetching lease details", async () => {
    mockLeaseApi.returns(null);
    server.use(mockLeaseApi.getHandler("/:id"));

    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading this lease."),
      ).toBeInTheDocument();
    });
  });
});

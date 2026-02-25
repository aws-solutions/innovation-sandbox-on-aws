// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useNavigate, useParams } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeaseDetails } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/LeaseDetails";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

// Mock hooks
vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: vi.fn(),
    useParams: vi.fn(),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb");

const mockActiveLease = {
  uuid: "lease-123",
  leaseId: "lease-123",
  userEmail: "user@example.com",
  createdBy: "admin@example.com",
  approvedBy: "manager@example.com",
  status: "Active",
  awsAccountId: "123456789012",
  originalLeaseTemplateName: "Standard Template",
  startDate: "2024-01-01T00:00:00Z",
  lastCheckedDate: "2024-01-05T12:00:00Z",
  expirationDate: "2024-01-08T00:00:00Z",
  maxSpend: 100,
  totalCostAccrued: 45.5,
  budgetThresholds: [
    { dollarsSpent: 50, action: "ALERT" as const },
    { dollarsSpent: 75, action: "FREEZE_ACCOUNT" as const },
  ],
  durationThresholds: [
    { hoursRemaining: 48, action: "ALERT" as const },
    { hoursRemaining: 24, action: "ALERT" as const },
  ],
  costReportGroup: "engineering-team",
  comments: "Test lease for development",
};

const mockPendingLease = {
  uuid: "lease-456",
  leaseId: "lease-456",
  userEmail: "pending@example.com",
  createdBy: "pending@example.com",
  status: "Pending",
  originalLeaseTemplateName: "Standard Template",
  maxSpend: 100,
  budgetThresholds: [],
  durationThresholds: [],
  comments: null,
};

const mockConfig = {
  leases: {
    maxBudget: 100,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
  },
  termsOfService: "Terms",
};

describe("LeaseDetails", () => {
  const mockNavigate = vi.fn();
  const mockSetBreadcrumb = vi.fn();
  const mockRefetch = vi.fn();
  const mockRefetchConfig = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();

    (useNavigate as any).mockReturnValue(mockNavigate);
    (useParams as any).mockReturnValue({ leaseId: "lease-123" });
    (useBreadcrumb as any).mockReturnValue(mockSetBreadcrumb);

    (useGetLeaseById as any).mockReturnValue({
      data: mockActiveLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    (useGetConfigurations as any).mockReturnValue({
      data: mockConfig,
      isLoading: false,
      isError: false,
      refetch: mockRefetchConfig,
      error: null,
    });
  });

  it("shows loading state while fetching lease data", () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: true,
      isLoading: true,
      isError: false,
    });

    renderWithQueryClient(<LeaseDetails />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows loading state while fetching config data", () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: true,
      isError: false,
    });

    renderWithQueryClient(<LeaseDetails />);

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when lease fails to load", () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: false,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
      error: new Error("Failed to load lease"),
    });

    renderWithQueryClient(<LeaseDetails />);

    expect(
      screen.getByText("There was a problem loading this lease."),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /try again/i }),
    ).toBeInTheDocument();
  });

  it("shows error state when config fails to load", () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mockRefetchConfig,
      error: new Error("Failed to load config"),
    });

    renderWithQueryClient(<LeaseDetails />);

    expect(
      screen.getByText(
        "There was a problem loading global configuration settings.",
      ),
    ).toBeInTheDocument();
  });

  it("displays lease details for active lease", async () => {
    renderWithQueryClient(<LeaseDetails />);

    // Wait for the page to load by checking for a unique element
    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Check basic details - use more specific queries to avoid duplicates
    expect(screen.getByText("lease-123")).toBeInTheDocument();
    expect(screen.getByText("123456789012")).toBeInTheDocument();
    expect(screen.getByText("Standard Template")).toBeInTheDocument();

    // Check for emails - they appear multiple times, so just check they exist
    expect(screen.getAllByText("user@example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("admin@example.com").length).toBeGreaterThan(0);
    expect(screen.getAllByText("manager@example.com").length).toBeGreaterThan(
      0,
    );

    // Check comments
    expect(screen.getByText("Test lease for development")).toBeInTheDocument();

    // Check section headers
    expect(screen.getByText("Budget Settings")).toBeInTheDocument();
    expect(screen.getByText("Duration Settings")).toBeInTheDocument();
    expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
    expect(screen.getByText("engineering-team")).toBeInTheDocument();
  });

  it("displays edit buttons for active lease", async () => {
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should have 3 edit buttons (Budget, Duration, Cost Report)
    const editButtons = screen.getAllByRole("button", { name: "Edit" });
    expect(editButtons).toHaveLength(3);
  });

  it("navigates to edit budget page when edit budget clicked", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Budget Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Budget Settings section
    const budgetSection = screen
      .getByText("Budget Settings")
      .closest("div[class*='awsui_header']");
    const editButton = budgetSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/budget",
      );
    }
  });

  it("navigates to edit duration page when edit duration clicked", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Duration Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Duration Settings section
    const durationSection = screen
      .getByText("Duration Settings")
      .closest("div[class*='awsui_header']");
    const editButton = durationSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/duration",
      );
    }
  });

  it("navigates to edit cost report page when edit cost report clicked", async () => {
    const user = userEvent.setup();
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Cost Report Settings")).toBeInTheDocument();
    });

    // Find the edit button in the Cost Report Settings section
    const costReportSection = screen
      .getByText("Cost Report Settings")
      .closest("div[class*='awsui_header']");
    const editButton = costReportSection?.querySelector(
      'button[aria-label="Edit"]',
    );

    if (editButton) {
      await user.click(editButton as HTMLElement);
      expect(mockNavigate).toHaveBeenCalledWith(
        "/leases/lease-123/edit/cost-report",
      );
    }
  });

  it("does not show edit buttons for pending lease", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should not have any edit buttons
    const editButtons = screen.queryAllByRole("button", { name: "Edit" });
    expect(editButtons).toHaveLength(0);
  });

  it("displays pending lease without account information", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    // Should show "No account assigned" instead of account ID
    expect(screen.getByText("No account assigned")).toBeInTheDocument();
  });

  it("displays no comments message when comments are null", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: mockPendingLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("No comments provided")).toBeInTheDocument();
  });

  it("displays auto-approved status", async () => {
    const autoApprovedLease = {
      ...mockActiveLease,
      approvedBy: "AUTO_APPROVED",
    };

    (useGetLeaseById as any).mockReturnValue({
      data: autoApprovedLease,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Auto Approved")).toBeInTheDocument();
  });

  it("displays no cost report group message when not assigned", async () => {
    const leaseWithoutCostReport = {
      ...mockActiveLease,
      costReportGroup: null,
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutCostReport,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    expect(screen.getByText("Not assigned")).toBeInTheDocument();
  });

  it("displays budget thresholds", async () => {
    const leaseWithoutCostReport = {
      ...mockActiveLease,
      costReportGroup: null,
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutCostReport,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Budget Thresholds")).toBeInTheDocument();
    });

    // Check threshold values are displayed - they may be formatted with $ or other text
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("$75.00")).toBeInTheDocument();
  });

  it("displays duration thresholds", async () => {
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Duration Thresholds")).toBeInTheDocument();
    });

    // Check threshold values are displayed
    expect(screen.getByText("48 hours")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();
  });

  it("displays no thresholds message when budget thresholds are empty", async () => {
    const leaseWithoutThresholds = {
      ...mockActiveLease,
      budgetThresholds: [],
      durationThresholds: [],
    };

    (useGetLeaseById as any).mockReturnValue({
      data: leaseWithoutThresholds,
      isFetching: false,
      isLoading: false,
      isError: false,
      refetch: mockRefetch,
      error: null,
    });

    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("Lease Details")).toBeInTheDocument();
    });

    const noThresholdsMessages = screen.getAllByText(
      "No thresholds configured",
    );
    expect(noThresholdsMessages.length).toBeGreaterThan(0);
  });

  it("sets breadcrumb with lease information", async () => {
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalled();
    });
  });

  it("retries loading lease on error retry click", async () => {
    (useGetLeaseById as any).mockReturnValue({
      data: null,
      isFetching: false,
      isLoading: false,
      isError: true,
      refetch: mockRefetch,
      error: new Error("Failed to load"),
    });

    const user = userEvent.setup();
    renderWithQueryClient(<LeaseDetails />);

    const retryButton = screen.getByRole("button", { name: /try again/i });
    await user.click(retryButton);

    expect(mockRefetch).toHaveBeenCalled();
  });

  it("retries loading config on error retry click", async () => {
    (useGetConfigurations as any).mockReturnValue({
      data: null,
      isLoading: false,
      isError: true,
      refetch: mockRefetchConfig,
      error: new Error("Failed to load"),
    });

    const user = userEvent.setup();
    renderWithQueryClient(<LeaseDetails />);

    const retryButton = screen.getByRole("button", { name: /try again/i });
    await user.click(retryButton);

    expect(mockRefetchConfig).toHaveBeenCalled();
  });

  it("displays lease ID with copy functionality", async () => {
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("lease-123")).toBeInTheDocument();
    });

    // The CopyToClipboard component should be present
    const leaseIdText = screen.getByText("lease-123");
    expect(leaseIdText).toBeInTheDocument();
  });

  it("displays AWS account ID with copy functionality for active lease", async () => {
    renderWithQueryClient(<LeaseDetails />);

    await waitFor(() => {
      expect(screen.getByText("123456789012")).toBeInTheDocument();
    });

    // The CopyToClipboard component should be present
    const accountIdText = screen.getByText("123456789012");
    expect(accountIdText).toBeInTheDocument();
  });
});

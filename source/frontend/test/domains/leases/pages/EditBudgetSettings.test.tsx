// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditBudgetSettings";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ leaseId: "lease-123" }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => vi.fn(),
}));

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const mockLease: MonitoredLeaseWithLeaseId = {
  uuid: "lease-123",
  leaseId: "lease-123",
  userEmail: "user@example.com",
  maxSpend: 100,
  budgetThresholds: [
    { dollarsSpent: 50, action: "ALERT" as const },
    { dollarsSpent: 75, action: "ALERT" as const },
  ],
  status: "Active",
  awsAccountId: "123456789012",
  startDate: "2024-01-01T00:00:00.000Z",
  approvedBy: "manager@example.com",
  lastCheckedDate: "2024-01-01T00:00:00.000Z",
  originalLeaseTemplateName: "Test",
  originalLeaseTemplateUuid: crypto.randomUUID(),
  totalCostAccrued: 0,
};

const mockConfig = {
  costReportGroups: [],
  requireCostReportGroup: false,
  leases: {
    maxBudget: 500,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
  },
  termsOfService: "Terms",
  isbManagedRegions: ["us-east-1"],
};

describe("EditBudgetSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBudgetSettings />
      </Router>,
    );

  beforeEach(() => {
    vi.clearAllMocks();

    // Setup default MSW handlers
    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: mockLease,
        };
        return HttpResponse.json(response);
      }),
      http.get(`${config.ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof mockConfig> = {
          status: "success",
          data: mockConfig,
        };
        return HttpResponse.json(response);
      }),
    );
  });

  it("shows loading state while fetching lease data", () => {
    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        // Simulate loading by delaying indefinitely
        return new Promise(() => {});
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows loading state while fetching config data", () => {
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        // Simulate loading by delaying indefinitely
        return new Promise(() => {});
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when lease fails to load", async () => {
    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to load lease" },
          { status: 500 },
        );
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading this lease."),
      ).toBeInTheDocument();
    });

    const retryButton = screen.getByRole("button", { name: /try again/i });
    expect(retryButton).toBeInTheDocument();

    // Test retry functionality
    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: mockLease,
        };
        return HttpResponse.json(response);
      }),
    );

    await user.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });
  });

  it("shows error state when config fails to load", async () => {
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json(
          { status: "error", message: "Failed to load config" },
          { status: 500 },
        );
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByText("There was a problem loading configuration settings."),
      ).toBeInTheDocument();
    });

    const retryButton = screen.getByRole("button", { name: /try again/i });
    expect(retryButton).toBeInTheDocument();

    // Test retry functionality
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof mockConfig> = {
          status: "success",
          data: mockConfig,
        };
        return HttpResponse.json(response);
      }),
    );

    await user.click(retryButton);

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });
  });

  it("initializes form with lease budget data", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Check that max budget is enabled and populated
    const maxSpendInput = screen.getByPlaceholderText("e.g., 50");
    expect(maxSpendInput).toHaveValue(100);

    // Check that thresholds are populated
    const thresholdInputs = screen.getAllByPlaceholderText("e.g., 25");
    expect(thresholdInputs).toHaveLength(2);
  });

  it("submits form with updated budget settings", async () => {
    let submittedData: any = null;

    server.use(
      http.patch(`${config.ApiUrl}/leases/lease-123`, async ({ request }) => {
        submittedData = await request.json();
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Modify the max spend
    const maxSpendInput = screen.getByPlaceholderText("e.g., 50");
    await user.clear(maxSpendInput);
    await user.type(maxSpendInput, "150");

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        budgetThresholds: mockLease.budgetThresholds,
        maxSpend: 150,
      });
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Budget settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    });
  });

  it("submits with null maxSpend when budget is disabled", async () => {
    let submittedData: any = null;

    server.use(
      http.patch(`${config.ApiUrl}/leases/lease-123`, async ({ request }) => {
        submittedData = await request.json();
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Disable max budget
    const toggleButton = screen.getByRole("checkbox");
    await user.click(toggleButton);

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        budgetThresholds: mockLease.budgetThresholds,
        maxSpend: null,
      });
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Budget settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    });
  });

  it("shows error toast when submission fails", async () => {
    const errorMessage = "Network error";

    server.use(
      http.patch(`${config.ApiUrl}/leases/lease-123`, () => {
        return HttpResponse.json(
          { status: "error", message: errorMessage },
          { status: 500 },
        );
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Modify the form
    const maxSpendInput = screen.getByPlaceholderText("e.g., 50");
    await user.clear(maxSpendInput);
    await user.type(maxSpendInput, "150");

    // Wait for button to be enabled
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });

    // Submit the form
    await user.click(saveButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update budget settings"),
        "Update Failed",
      );
    });

    // Should not navigate on error
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("navigates back on cancel", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("disables save button when form is invalid", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Clear max spend to make form invalid
    const maxSpendInput = screen.getByPlaceholderText("e.g., 50");
    await user.clear(maxSpendInput);

    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await waitFor(() => {
      expect(saveButton).toBeDisabled();
    });
  });

  it("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
  });

  it("applies global max budget limit from config", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // The form should show the global limit in the description
    expect(screen.getByText(/Global limit: \$500/i)).toBeInTheDocument();
  });

  it("handles lease with no budget settings", async () => {
    const leaseWithNoBudget: MonitoredLeaseWithLeaseId = {
      ...mockLease,
      maxSpend: undefined,
      budgetThresholds: [],
    };

    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithNoBudget,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Budget should be disabled
    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
  });
});

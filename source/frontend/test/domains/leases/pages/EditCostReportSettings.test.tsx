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
import { EditCostReportSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditCostReportSettings";
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
  costReportGroup: "engineering-team",
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
  costReportGroups: ["engineering-team", "data-science-team", "ml-team"],
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

describe("EditCostReportSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditCostReportSettings />
      </Router>,
    );

  const mockedShowSuccessToast = vi.mocked(showSuccessToast);
  const mockedShowErrorToast = vi.mocked(showErrorToast);

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
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
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
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });
  });

  it("initializes form with lease cost report data", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Check that cost report group is enabled
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();

    // Check that the select shows the correct value
    await waitFor(() => {
      expect(screen.getByText("engineering-team")).toBeInTheDocument();
    });
  });

  it("submits form with updated cost report settings", async () => {
    let submittedData: any = null;

    server.use(
      http.patch(`${config.ApiUrl}/leases/lease-123`, async ({ request }) => {
        submittedData = await request.json();
        return HttpResponse.json({ status: "success", data: {} });
      }),
    );

    const user = userEvent.setup();
    renderComponent();

    // Wait for the form to fully load with data
    await waitFor(() => {
      expect(screen.getByText("engineering-team")).toBeInTheDocument();
    });

    // Find the select trigger button (it shows the current value "engineering-team")
    const selectButtons = screen.getAllByRole("button");
    const selectTrigger = selectButtons.find((btn) =>
      btn.textContent?.includes("engineering-team"),
    );
    expect(selectTrigger).toBeDefined();

    await user.click(selectTrigger!);

    // Select a different option
    const option = await screen.findByText("data-science-team");
    await user.click(option);

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        costReportGroup: "data-science-team",
      });
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Cost report settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
    });
  });

  it("submits with null costReportGroup when disabled", async () => {
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
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Toggle is already checked (enabled), so click to disable
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();

    await user.click(toggle);

    // Toggle should now be unchecked
    await waitFor(() => {
      expect(toggle).not.toBeChecked();
    });

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });

    // Wait for button to be enabled (form is dirty and valid)
    await waitFor(() => {
      expect(saveButton).not.toBeDisabled();
    });

    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        costReportGroup: null,
      });
      expect(mockedShowSuccessToast).toHaveBeenCalledWith(
        "Cost report settings updated successfully.",
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
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Find the select trigger button
    const selectButtons = screen.getAllByRole("button");
    const selectTrigger = selectButtons.find((btn) =>
      btn.textContent?.includes("engineering-team"),
    );
    expect(selectTrigger).toBeDefined();

    await user.click(selectTrigger!);

    // Select a different option
    const option = await screen.findByText("ml-team");
    await user.click(option);

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(mockedShowErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update cost report settings"),
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
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
  });

  it("displays available cost report groups from config", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Find the select trigger button
    const user = userEvent.setup();
    const selectButtons = screen.getAllByRole("button");
    const selectTrigger = selectButtons.find((btn) =>
      btn.textContent?.includes("engineering-team"),
    );
    expect(selectTrigger).toBeDefined();

    await user.click(selectTrigger!);

    // Check that all options are available (there will be duplicates for the selected item)
    await waitFor(() => {
      const engineeringTeamElements = screen.getAllByText("engineering-team");
      expect(engineeringTeamElements.length).toBeGreaterThan(0);

      expect(screen.getByText("data-science-team")).toBeInTheDocument();
      expect(screen.getByText("ml-team")).toBeInTheDocument();
    });
  });

  it("handles lease with no cost report group", async () => {
    const leaseWithNoCostReport = {
      ...mockLease,
      costReportGroup: undefined,
    };

    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithNoCostReport as MonitoredLeaseWithLeaseId,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Cost report group should be disabled
    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
  });

  it("handles empty cost report groups list", async () => {
    const configWithNoGroups = {
      ...mockConfig,
      costReportGroups: [],
    };

    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof configWithNoGroups> = {
          status: "success",
          data: configWithNoGroups,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // Form should still render
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });

  it("validates required cost report group when enabled", async () => {
    const configWithRequired = {
      ...mockConfig,
      requireCostReportGroup: true,
    };

    const leaseWithNoCostReport = {
      ...mockLease,
      costReportGroup: undefined,
    };

    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof configWithRequired> = {
          status: "success",
          data: configWithRequired,
        };
        return HttpResponse.json(response);
      }),
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithNoCostReport as MonitoredLeaseWithLeaseId,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Cost Report Settings")).toBeInTheDocument();
    });

    // When required and no selection, save button should be disabled
    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await waitFor(() => {
      expect(saveButton).toBeDisabled();
    });
  });
});

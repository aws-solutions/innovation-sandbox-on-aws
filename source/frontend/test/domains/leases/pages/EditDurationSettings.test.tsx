// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditDurationSettings";
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
  startDate: "2024-01-01T00:00:00.000Z",
  expirationDate: "2024-01-08T00:00:00.000Z",
  durationThresholds: [
    { hoursRemaining: 48, action: "ALERT" as const },
    { hoursRemaining: 24, action: "ALERT" as const },
  ],
  status: "Active",
  awsAccountId: "123456789012",
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
    maxDurationHours: 720,
    requireMaxDuration: false,
    maxBudget: 500,
    requireMaxBudget: false,
  },
  termsOfService: "Terms",
  isbManagedRegions: ["us-east-1"],
};

describe("EditDurationSettings", () => {
  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditDurationSettings />
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
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
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
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });
  });

  it("initializes form with lease duration data", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Check that max duration is enabled
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();

    // Check that expiration date is populated (don't check exact value due to timezone)
    const dateInput = screen.getByPlaceholderText(
      "YYYY/MM/DD",
    ) as HTMLInputElement;
    await waitFor(() => {
      expect(dateInput.value).toBeTruthy();
      expect(dateInput.value).toMatch(/\d{4}\/\d{2}\/\d{2}/);
    });

    // Check that thresholds are populated (look for "Enter hours" placeholder)
    const thresholdInputs = screen.getAllByPlaceholderText("Enter hours");
    expect(thresholdInputs).toHaveLength(2);
  });

  it("navigates back on cancel", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    const cancelButton = screen.getByRole("button", { name: "Cancel" });
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("disables save button when form is invalid", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Clear expiration date to make form invalid
    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    await user.clear(dateInput);

    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await waitFor(() => {
      expect(saveButton).toBeDisabled();
    });
  });

  it("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    expect(saveButton).toBeDisabled();
  });

  it("displays expiration date field when enabled", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Check that date and time fields are displayed
    expect(screen.getByPlaceholderText("YYYY/MM/DD")).toBeInTheDocument();
    expect(screen.getByPlaceholderText("hh:mm")).toBeInTheDocument();
  });

  it("handles lease with no duration settings", async () => {
    const leaseWithNoDuration: MonitoredLeaseWithLeaseId = {
      ...mockLease,
      expirationDate: undefined,
      durationThresholds: [],
    };

    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithNoDuration,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Duration should be disabled
    const toggle = screen.getByRole("checkbox");
    expect(toggle).not.toBeChecked();
  });

  it("validates expiration date is after start date", async () => {
    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Try to set expiration date before start date
    const dateInput = screen.getByPlaceholderText("YYYY/MM/DD");
    await user.clear(dateInput);
    await user.type(dateInput, "2023/12/31");

    const saveButton = screen.getByRole("button", { name: "Save changes" });

    await waitFor(() => {
      expect(saveButton).toBeDisabled();
    });
  });

  it("handles lease without start date", async () => {
    const leaseWithoutStartDate = {
      ...mockLease,
      startDate: undefined,
    };

    server.use(
      http.get(`${config.ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseWithLeaseId> = {
          status: "success",
          data: leaseWithoutStartDate as any,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // Form should still render
    expect(screen.getByRole("checkbox")).toBeInTheDocument();
  });
});

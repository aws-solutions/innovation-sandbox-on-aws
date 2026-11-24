// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { MonitoredLeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { EditDurationSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditDurationSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { createLeasePermissionProfile } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";

const mockNavigate = vi.fn();
const mockSetBreadcrumb = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ leaseId: "lease-123" }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb", () => ({
  useBreadcrumb: () => mockSetBreadcrumb,
}));

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showSuccessToast: vi.fn(),
  showErrorToast: vi.fn(),
}));

const mockLease: MonitoredLeaseView = {
  uuid: "11111111-1111-4111-8111-111111111111",
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
  sandboxSpacesEnabled: false,
  selectableModels: [],
  ...createLeasePermissionProfile(),
};

// Full AdminConfig via the shared factory (the generated client's
// `getConfigurations` requires every section); overrides carry the leases values
// this suite asserts.
const mockConfig = createConfiguration({
  leases: {
    maxDurationHours: 720,
    requireMaxDuration: false,
    maxBudget: 500,
    requireMaxBudget: false,
  },
  isbManagedRegions: ["us-east-1"],
});

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
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: mockLease,
        };
        return HttpResponse.json(response);
      }),
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        const response: ApiResponse<typeof mockConfig> = {
          status: "success",
          data: mockConfig,
        };
        return HttpResponse.json(response);
      }),
    );
  });

  it("uses the canonical lease name in the breadcrumb", async () => {
    renderComponent();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Leases", href: "/leases" },
        { text: "Test (11111111)", href: "/leases/lease-123" },
        { text: "Edit Duration Settings", href: "" },
      ]);
    });
  });

  it("shows loading state while fetching lease data", () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        // Simulate loading by delaying indefinitely
        return new Promise(() => {});
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows loading state while fetching config data", () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        // Simulate loading by delaying indefinitely
        return new Promise(() => {});
      }),
    );

    renderComponent();

    expect(screen.getByText("Loading...")).toBeInTheDocument();
  });

  it("shows error state when lease fails to load", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
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
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
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
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
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
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
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

  it("ignores hidden invalid values when the expiration is turned off, so the change can be saved", async () => {
    let submittedData: any = null;
    server.use(
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: {} });
        },
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });

    // The lease's saved expiration is in the past, and a new row starts at 0
    // hours remaining; both are invalid.
    await user.click(screen.getByRole("button", { name: "Add threshold" }));
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(saveButton).toBeDisabled());

    await user.click(screen.getByRole("checkbox"));

    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() =>
      expect(submittedData).toEqual({
        durationThresholds: [],
        expirationDate: null,
      }),
    );
  });

  it("removes an added threshold when the expiration is turned off and on, for a lease with no saved thresholds", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockLease, durationThresholds: undefined },
        }),
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: "Add threshold" }));
    expect(screen.getAllByPlaceholderText("Enter hours")).toHaveLength(1);

    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);
    await user.click(toggle);

    expect(
      screen.queryByPlaceholderText("Enter hours"),
    ).not.toBeInTheDocument();
  });

  it("puts back the saved expiration date when the expiration is turned off and on", async () => {
    const start = DateTime.utc().minus({ days: 1 });
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockLease,
            startDate: start.toISO(),
            expirationDate: start.plus({ days: 7 }).toISO(),
            durationThresholds: [{ hoursRemaining: 100, action: "ALERT" }],
          },
        }),
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    const dateInput = await screen.findByPlaceholderText("YYYY/MM/DD");
    await waitFor(() => expect(dateInput).not.toHaveValue(""));
    // Three days from the start leaves 72 hours, under the 100-hour threshold.
    await user.clear(dateInput);
    await user.type(
      dateInput,
      start.plus({ days: 3 }).toLocal().toFormat("yyyy/MM/dd"),
    );
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(saveButton).toBeDisabled());

    const toggle = screen.getByRole("checkbox");
    await user.click(toggle);
    await user.click(toggle);

    await waitFor(() =>
      expect(screen.getByPlaceholderText("YYYY/MM/DD")).toHaveValue(
        start.plus({ days: 7 }).toLocal().toFormat("yyyy/MM/dd"),
      ),
    );
  });

  it("shows the expiration toggle on when an expiration date is required and the lease has none", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: { maxDurationHours: 720, requireMaxDuration: true },
          }),
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockLease, expirationDate: undefined },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Edit Duration Settings")).toBeInTheDocument();
    });
    const toggle = screen.getByRole("checkbox");
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();
    expect(
      screen.getByRole("button", { name: "Add threshold" }),
    ).toBeInTheDocument();
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
    const leaseWithNoDuration: MonitoredLeaseView = {
      ...mockLease,
      expirationDate: undefined,
      durationThresholds: [],
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
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

  it("shows an error for an active lease without a start date", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: {
            ...mockLease,
            startDate: undefined,
          } as unknown as MonitoredLeaseView,
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    expect(
      await screen.findByText("There was a problem loading this lease."),
    ).toBeInTheDocument();
  });
  it("warns without blocking when an opted-in lease's expiry is within 48 hours of its start", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockLease,
            predictiveBudgetEnabled: true,
            startDate: "2024-01-01T00:00:00.000Z",
            expirationDate: "2024-01-01T12:00:00.000Z",
          },
        });
      }),
    );

    renderComponent();

    expect(
      await screen.findByText(
        /estimated-cost thresholds may never fire for this lease\./i,
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });
});

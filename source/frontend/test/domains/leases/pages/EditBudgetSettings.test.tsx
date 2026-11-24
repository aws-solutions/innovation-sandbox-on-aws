// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { MonitoredLeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { EditBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditBudgetSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { createLeasePermissionProfile } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";
import {
  expectGateNotice,
  gateOffInUse,
  gateOffSwitchedOff,
  gateOffUnused,
} from "@amzn/innovation-sandbox-frontend-test/utils/globalGateNotice";

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
  sandboxSpacesEnabled: false,
  selectableModels: [],
  ...createLeasePermissionProfile(),
};

// Full AdminConfig (all six sections + deploy fields) via the shared factory:
// the generated client's `getConfigurations` requires every section, so a partial
// hand-rolled mock now fails to load. Overrides carry the leases values this
// suite asserts.
const mockConfig = createConfiguration({
  leases: {
    maxBudget: 500,
    requireMaxBudget: false,
    maxDurationHours: 720,
    requireMaxDuration: false,
  },
  isbManagedRegions: ["us-east-1"],
});

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

  it("describes maximum budget behavior", async () => {
    renderComponent();

    expect(
      await screen.findByText(
        "When current cost reaches the maximum budget, the lease is terminated and all of its resources are cleaned up. Current cost is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. This can't be undone, so don't use a maximum budget for accounts whose contents users can't afford to lose. Set the amount in the terminate threshold.",
      ),
    ).toBeInTheDocument();
    expect(
      await screen.findByRole("button", {
        name: "Maximum budget cost basis Current cost",
      }),
    ).toBeDisabled();
  });

  it("uses the canonical lease name in the breadcrumb", async () => {
    renderComponent();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Leases", href: "/leases" },
        { text: "Test (11111111)", href: "/leases/lease-123" },
        { text: "Edit Budget Settings", href: "" },
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
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
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
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });
  });

  it("submits form with updated budget settings", async () => {
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
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Modify the max spend
    const maxSpendInput = await screen.findByPlaceholderText("e.g., 50");
    await user.clear(maxSpendInput);
    await user.type(maxSpendInput, "150");

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        budgetThresholds: mockLease.budgetThresholds,
        maxSpend: 150,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: false,
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
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    // Disable max budget
    const toggleButton = screen.getByRole("checkbox", {
      name: /maximum budget/i,
    });
    await user.click(toggleButton);

    // Submit the form
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData).toEqual({
        budgetThresholds: mockLease.budgetThresholds,
        maxSpend: null,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: false,
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
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () => {
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
    const maxSpendInput = await screen.findByPlaceholderText("e.g., 50");
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
    const maxSpendInput = await screen.findByPlaceholderText("e.g., 50");
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
    expect(screen.getByText("Must be $500.00 or less.")).toBeInTheDocument();
  });

  it("handles lease with no budget settings", async () => {
    const leaseWithNoBudget: MonitoredLeaseView = {
      ...mockLease,
      maxSpend: undefined,
      budgetThresholds: [],
    };

    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
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
    const toggle = screen.getByRole("checkbox", { name: /maximum budget/i });
    expect(toggle).not.toBeChecked();
  });

  it("assigns a budget when required and none was previously set", async () => {
    // Regression: with a required budget and none set, the enable toggle is
    // forced-on-but-disabled, so maxBudgetEnabled stays false. Entering a value
    // must still submit it (not null).
    const configRequired = {
      ...mockConfig,
      leases: { ...mockConfig.leases, requireMaxBudget: true },
    };
    const leaseWithNoBudget: MonitoredLeaseView = {
      ...mockLease,
      maxSpend: undefined,
      budgetThresholds: [],
    };

    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({ status: "success", data: leaseWithNoBudget }),
      ),
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
      expect(screen.getByText("Edit Budget Settings")).toBeInTheDocument();
    });

    const maxSpendInput = await screen.findByPlaceholderText("e.g., 50");
    await user.clear(maxSpendInput);
    await user.type(maxSpendInput, "150");

    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(saveButton).not.toBeDisabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData?.maxSpend).toBe(150));
  });

  it("shows no required error for a saved maximum budget when a budget is required", async () => {
    const configRequired = {
      ...mockConfig,
      leases: { ...mockConfig.leases, requireMaxBudget: true },
    };
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, async () => {
        await delay(50);
        return HttpResponse.json({ status: "success", data: mockLease });
      }),
    );

    renderComponent();

    await waitFor(() =>
      expect(screen.getByLabelText("Maximum budget amount (USD)")).toHaveValue(
        100,
      ),
    );
    await expect(
      screen.findByText(
        "Maximum budget is required and must be greater than 0",
        {},
        { timeout: 300 },
      ),
    ).rejects.toThrow(/Unable to find/);
  });

  it("shows the error for a saved maximum budget above the global limit when the configuration loads after the lease", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            leases: { ...mockConfig.leases, maxBudget: 50 },
          },
        });
      }),
    );

    renderComponent();

    expect(
      await screen.findByText(
        "Maximum budget cannot exceed global limit of $50.00",
      ),
    ).toBeInTheDocument();
  });

  it("shows the required error for a lease without maximum budget when the configuration that requires it loads after the lease", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            leases: { ...mockConfig.leases, requireMaxBudget: true },
          },
        });
      }),
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...mockLease, maxSpend: undefined, budgetThresholds: [] },
        }),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        "Maximum budget is required and must be greater than 0",
      ),
    ).toBeInTheDocument();
  });

  it("shows the predictive and monitoring toggles off and pins thresholds to reported cost for a lease without estimated cost tracking", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    expect(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    ).not.toBeChecked();
    const monitoringToggle = screen.getByRole("checkbox", {
      name: /bedrock token monitoring/i,
    });
    expect(monitoringToggle).not.toBeChecked();
    // Allow Amazon Bedrock token monitoring is off in this configuration.
    expect(monitoringToggle).toBeDisabled();
    await expectGateNotice(
      userEvent.setup(),
      "Amazon Bedrock token monitoring",
      "info",
      gateOffUnused("Lease Policies"),
    );
    // The trigger-on column stays in place so the grid never shifts; without
    // estimated cost tracking it is pinned to reported cost rather than editable.
    expect(screen.getByText("Cost basis")).toBeInTheDocument();
    expect(screen.getAllByText("Reported cost").length).toBeGreaterThan(0);
    const reportedCostBasisSelects = screen.getAllByRole("button", {
      name: /^Threshold \d+ cost basis Reported cost$/,
    });
    expect(reportedCostBasisSelects).toHaveLength(2);
    reportedCostBasisSelects.forEach((select) => expect(select).toBeDisabled());
    expect(
      screen.queryByRole("button", { name: "Add rate threshold" }),
    ).not.toBeInTheDocument();
    expect(createWrapper().findHeader()!.findInfo()!.findLink()).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cost tracking help" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Budget thresholds help" }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Spend rate thresholds help" }),
    ).not.toBeInTheDocument();
  });

  describe("predictive budget controls and Amazon Bedrock token monitoring", () => {
    const allowBoth = createConfiguration({
      leases: {
        ...mockConfig.leases,
        allowPredictiveBudgetControls: true,
        allowBedrockTokenMonitoring: true,
      },
    });

    function serve(lease: MonitoredLeaseView, config = allowBoth) {
      const submitted: { body: Record<string, unknown> | null } = {
        body: null,
      };
      server.use(
        http.get(`${getConfig().ApiUrl}/configurations`, () =>
          HttpResponse.json({ status: "success", data: config }),
        ),
        http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
          HttpResponse.json({ status: "success", data: lease }),
        ),
        http.patch(
          `${getConfig().ApiUrl}/leases/lease-123`,
          async ({ request }) => {
            submitted.body = (await request.json()) as Record<string, unknown>;
            return HttpResponse.json({ status: "success", data: lease });
          },
        ),
      );
      return submitted;
    }

    const toggle = (name: RegExp) => screen.getByRole("checkbox", { name });

    async function save(user: ReturnType<typeof userEvent.setup>) {
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await waitFor(() => expect(saveButton).toBeEnabled());
      await user.click(saveButton);
    }

    it("turning estimated cost tracking off drops the rate thresholds and sends the thresholds as reported ones", async () => {
      const submitted = serve({
        ...mockLease,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
          { dollarsSpent: 75, action: "FREEZE_ACCOUNT" },
        ],
        rateLimits: [{ basis: "DAILY", rate: 40, action: "ALERT" }],
      });
      const user = userEvent.setup();
      renderComponent();

      await screen.findByLabelText("Rate threshold 1 rate (USD)");
      await user.click(toggle(/estimated cost tracking/i));

      expect(
        screen.queryByLabelText("Rate threshold 1 rate (USD)"),
      ).not.toBeInTheDocument();
      await save(user);

      await waitFor(() => expect(submitted.body).not.toBeNull());
      expect(submitted.body).toEqual({
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 50, action: "ALERT" },
          { dollarsSpent: 75, action: "FREEZE_ACCOUNT" },
        ],
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      });
    });

    it("keeps Save disabled after turning estimated cost tracking off and on again", async () => {
      serve({
        ...mockLease,
        predictiveBudgetEnabled: true,
        rateLimits: [{ basis: "DAILY", rate: 40, action: "ALERT" }],
      });
      const user = userEvent.setup();
      renderComponent();

      await screen.findByLabelText("Rate threshold 1 rate (USD)");
      await user.click(toggle(/estimated cost tracking/i));
      const saveButton = screen.getByRole("button", { name: /save changes/i });
      await waitFor(() => expect(saveButton).toBeEnabled());
      await user.click(toggle(/estimated cost tracking/i));

      expect(
        await screen.findByLabelText("Rate threshold 1 rate (USD)"),
      ).toHaveValue(40);
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeDisabled();
    });

    it("turning estimated cost tracking on offers the trigger-on selectors and rate thresholds, and sends the switch", async () => {
      const submitted = serve(mockLease);
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/estimated cost tracking/i)).toBeEnabled(),
      );
      await user.click(toggle(/estimated cost tracking/i));

      expect(
        screen.getAllByLabelText(/^Threshold \d+ cost basis$/).length,
      ).toBeGreaterThan(0);
      expect(
        screen.getByRole("button", { name: "Add rate threshold" }),
      ).toBeInTheDocument();
      await save(user);

      await waitFor(() => expect(submitted.body).not.toBeNull());
      expect(submitted.body).toMatchObject({
        predictiveBudgetEnabled: true,
        rateLimits: null,
      });
    });

    it("keeps a PREDICTED trigger chosen after turning estimated cost tracking on in the same edit", async () => {
      const submitted = serve(mockLease);
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/estimated cost tracking/i)).toBeEnabled(),
      );
      await user.click(toggle(/estimated cost tracking/i));
      const [labeled] = await screen.findAllByLabelText(
        "Threshold 1 cost basis",
      );
      const trigger = createWrapper()
        .findAllSelects()
        .find((select) => select.getElement().contains(labeled!))!;
      trigger.openDropdown();
      trigger.selectOptionByValue("PREDICTED");
      await save(user);

      await waitFor(() => expect(submitted.body).not.toBeNull());
      expect(submitted.body?.budgetThresholds).toEqual([
        { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
        { dollarsSpent: 75, action: "ALERT" },
      ]);
    });

    it("keeps the predictive toggle live for a lease using it while it is globally disabled", async () => {
      serve(
        { ...mockLease, predictiveBudgetEnabled: true },
        createConfiguration({ leases: mockConfig.leases }),
      );
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/estimated cost tracking/i)).toBeChecked(),
      );
      expect(toggle(/estimated cost tracking/i)).toBeEnabled();
      await expectGateNotice(
        user,
        "Estimated cost tracking",
        "info",
        gateOffInUse("Lease Policies", "lease"),
      );
    });

    it("sends Amazon Bedrock token monitoring as toggled", async () => {
      const submitted = serve(mockLease);
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/bedrock token monitoring/i)).toBeEnabled(),
      );
      await user.click(toggle(/bedrock token monitoring/i));
      await save(user);

      await waitFor(() => expect(submitted.body).not.toBeNull());
      expect(submitted.body).toMatchObject({
        bedrockTokenMonitoringEnabled: true,
      });
    });

    it("locks Amazon Bedrock token monitoring on while the lease uses Sandbox Spaces", async () => {
      const submitted = serve(
        {
          ...mockLease,
          sandboxSpacesEnabled: true,
          bedrockTokenMonitoringEnabled: true,
        },
        createConfiguration({ leases: mockConfig.leases }),
      );
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/bedrock token monitoring/i)).toBeChecked(),
      );
      expect(toggle(/bedrock token monitoring/i)).toBeDisabled();
      expect(
        screen.getByText("Required while Sandbox Spaces is enabled."),
      ).toBeInTheDocument();
      expect(
        screen.queryByRole("button", {
          name: /Amazon Bedrock token monitoring globally disabled/,
        }),
      ).not.toBeInTheDocument();

      // An unrelated edit still sends the locked value.
      const maxSpendInput = screen.getByPlaceholderText("e.g., 50");
      await user.clear(maxSpendInput);
      await user.type(maxSpendInput, "150");
      await save(user);

      await waitFor(() => expect(submitted.body).not.toBeNull());
      expect(submitted.body).toMatchObject({
        maxSpend: 150,
        bedrockTokenMonitoringEnabled: true,
      });
    });

    it("shows the gate icons while both features are globally disabled", async () => {
      // Not using estimated cost tracking, still using token monitoring.
      serve(
        { ...mockLease, bedrockTokenMonitoringEnabled: true },
        createConfiguration({ leases: mockConfig.leases }),
      );
      const user = userEvent.setup();
      renderComponent();

      await waitFor(() =>
        expect(toggle(/bedrock token monitoring/i)).toBeChecked(),
      );
      expect(toggle(/estimated cost tracking/i)).toBeDisabled();
      await expectGateNotice(
        user,
        "Estimated cost tracking",
        "info",
        gateOffUnused("Lease Policies"),
      );
      expect(toggle(/bedrock token monitoring/i)).toBeEnabled();
      await expectGateNotice(
        user,
        "Amazon Bedrock token monitoring",
        "info",
        gateOffInUse("Lease Policies", "lease"),
      );

      await user.click(toggle(/bedrock token monitoring/i));

      await expectGateNotice(
        user,
        "Amazon Bedrock token monitoring",
        "warning",
        gateOffSwitchedOff("Lease Policies"),
      );
    });
  });

  it("shows the trigger-on column and editable rate thresholds when the lease is opted in", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: {
            ...mockLease,
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "DAILY", rate: 40, action: "ALERT" }],
          },
        };
        return HttpResponse.json(response);
      }),
    );

    renderComponent();

    // Await the rate field itself: the Cost basis column renders before the
    // fetched lease populates the rate rows.
    const rateInput = await screen.findByLabelText(
      "Rate threshold 1 rate (USD)",
    );
    expect(screen.getByText("Cost basis")).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Spend rate thresholds help" }),
    ).toBeInTheDocument();
    // The configured daily limit loads as one row.
    expect(rateInput).toHaveValue(40);
    expect(screen.getByText("Per day")).toBeInTheDocument();
  });

  it("sends the edited rows as the rateLimits list", async () => {
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: {
            ...mockLease,
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "DAILY", rate: 40, action: "ALERT" }],
          },
        };
        return HttpResponse.json(response);
      }),
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: mockLease });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await screen.findByLabelText("Rate threshold 1 rate (USD)");
    await user.click(
      screen.getByRole("button", { name: "Add rate threshold" }),
    );
    const second = await screen.findByLabelText("Rate threshold 2 rate (USD)");
    await user.tripleClick(second);
    await user.keyboard("12");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData).not.toBeNull());
    expect(submittedData).not.toHaveProperty("rateLimit");
    expect(submittedData.rateLimits).toEqual([
      { basis: "DAILY", rate: 40, action: "ALERT" },
      { basis: "HOURLY", rate: 12, action: "ALERT" },
    ]);
  });

  it("sends rateLimits null to clear the limits when every row is removed", async () => {
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: {
            ...mockLease,
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "DAILY", rate: 40, action: "ALERT" }],
          },
        };
        return HttpResponse.json(response);
      }),
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: mockLease });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByLabelText("Rate threshold 1 rate (USD)")).toHaveValue(
        40,
      );
    });

    await user.click(
      screen.getByRole("button", { name: "Remove rate threshold 1" }),
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData).not.toBeNull());
    expect(submittedData).toHaveProperty("rateLimits", null);
    expect(submittedData).not.toHaveProperty("rateLimit");
  });

  it("warns without blocking when the lease is opted in and shorter than 48 hours", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () => {
        const response: ApiResponse<MonitoredLeaseView> = {
          status: "success",
          data: {
            ...mockLease,
            predictiveBudgetEnabled: true,
            startDate: "2024-01-01T00:00:00.000Z",
            expirationDate: "2024-01-01T12:00:00.000Z",
          },
        };
        return HttpResponse.json(response);
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

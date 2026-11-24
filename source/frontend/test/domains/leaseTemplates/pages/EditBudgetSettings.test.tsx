// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditBudgetSettings } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditBudgetSettings";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockAdvancedLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();
const mockUuid = mockAdvancedLeaseTemplate.uuid;

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
    useParams: () => ({ uuid: mockUuid }),
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

const MAX_SPEND_REQUIRED =
  "Maximum budget is required and must be greater than 0";
const GATE_OFF_UNUSED =
  "Globally disabled. An administrator can allow this under Lease Policies on the Settings page.";
const GATE_OFF_IN_USE =
  "Globally disabled. This template still uses this feature. If you turn it off and save, you cannot turn it on again until an administrator allows it under Lease Policies on the Settings page.";
const GATE_OFF_SWITCHED_OFF =
  "Globally disabled. If you save with this feature off, you cannot turn it on again until an administrator allows it under Lease Policies on the Settings page.";

describe("EditBudgetSettings", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditBudgetSettings />
      </Router>,
    );

  const gateAnnouncements = () =>
    createWrapper()
      .findAllLiveRegions()
      .map((region) => region.getElement().textContent ?? "")
      .filter((text) => text.includes("Globally disabled"));

  const expectGateNotice = async (
    user: ReturnType<typeof userEvent.setup>,
    triggerName: string,
    iconType: "info" | "warning",
    content: string,
  ) => {
    const trigger = screen.getByRole("button", { name: triggerName });
    expect(
      trigger.querySelector(`[class*="status-${iconType}"]`),
    ).not.toBeNull();
    const popover = createWrapper()
      .findAllPopovers()
      .find((candidate) => candidate.findTrigger().getElement() === trigger)!;
    await user.click(trigger);
    await waitFor(() =>
      expect(popover.findContent()?.getElement()).toHaveTextContent(content),
    );
  };

  test("shows an error panel when the lease template cannot be loaded", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json(
          { status: "error", message: "Template load failed" },
          { status: 500 },
        ),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        "There was a problem loading this lease template.",
      ),
    ).toBeInTheDocument();
  });

  test("shows an error panel when global settings cannot be loaded", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json(
          { status: "error", message: "Configuration load failed" },
          { status: 500 },
        ),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        "There was a problem loading configuration settings.",
      ),
    ).toBeInTheDocument();
  });

  test("describes maximum budget behavior", async () => {
    renderComponent();

    expect(
      await screen.findByText(
        "When current cost reaches the maximum budget, the lease is terminated and all of its resources are cleaned up. Current cost is the higher of reported cost and, when Amazon Bedrock token monitoring is on, reported cost with billed Amazon Bedrock charges replaced by the monitored token cost. This can't be undone, so don't use a maximum budget for accounts whose contents users can't afford to lose. Set the amount in the terminate threshold.",
      ),
    ).toBeInTheDocument();
  });

  test("navigates back on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));

    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("submits form successfully", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          const data = await request.json();
          submitSpy(data);
          return HttpResponse.json({ status: "success", data });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    const maxSpendInput = screen.getByLabelText("Maximum budget amount (USD)");
    await user.tripleClick(maxSpendInput);
    await user.keyboard("2000");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Budget settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
  });

  test("displays error toast on submission failure", async () => {
    server.use(
      http.put(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () => {
        return HttpResponse.json(
          { status: "error", message: "Update failed" },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    const maxSpendInput = screen.getByLabelText("Maximum budget amount (USD)");
    await user.tripleClick(maxSpendInput);
    await user.keyboard("2000");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("Failed to update budget settings"),
        "Update Failed",
      );
    });
  });

  test("disables save button when form is not dirty", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    expect(saveButton).toBeDisabled();
  });

  test("assigns a budget when required and none was previously set", async () => {
    // Regression: with a required budget and none set, the enable toggle is
    // forced-on-but-disabled, so maxBudgetEnabled stays false. Entering a value
    // must still submit it (not undefined).
    const configRequired = createConfiguration({
      leases: {
        maxBudget: 5000,
        requireMaxBudget: true,
      },
    });

    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: configRequired }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: undefined,
            budgetThresholds: undefined,
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    const toggle = screen.getByRole("checkbox", { name: /maximum budget/i });
    expect(toggle).toBeChecked();
    expect(toggle).toBeDisabled();

    const maxSpendInput = screen.getByLabelText("Maximum budget amount (USD)");
    await user.tripleClick(maxSpendInput);
    await user.keyboard("250");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData?.maxSpend).toBe(250));
  });

  test("shows no required error for a saved maximum budget when a budget is required", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: { maxBudget: 50, requireMaxBudget: true },
          }),
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 20,
            budgetThresholds: [],
          },
        });
      }),
    );

    renderComponent();

    await waitFor(() =>
      expect(screen.getByLabelText("Maximum budget amount (USD)")).toHaveValue(
        20,
      ),
    );
    await expect(
      screen.findByText(MAX_SPEND_REQUIRED, {}, { timeout: 300 }),
    ).rejects.toThrow(/Unable to find/);
  });

  test("shows the error for a saved maximum budget above the global limit when the template loads after the configuration", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({ leases: { maxBudget: 50 } }),
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            budgetThresholds: [],
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

  test("shows the error for a saved maximum budget above the global limit when the configuration loads after the template", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: createConfiguration({ leases: { maxBudget: 50 } }),
        });
      }),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            budgetThresholds: [],
          },
        }),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        "Maximum budget cannot exceed global limit of $50.00",
      ),
    ).toBeInTheDocument();
  });

  test("shows the required error for a template without maximum budget when the configuration that requires it loads after the template", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, async () => {
        await delay(50);
        return HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: { maxBudget: 50, requireMaxBudget: true },
          }),
        });
      }),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: undefined,
            budgetThresholds: [],
          },
        }),
      ),
    );

    renderComponent();

    expect(await screen.findByText(MAX_SPEND_REQUIRED)).toBeInTheDocument();
  });

  test("predictive toggle is live when the global setting is on", async () => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /estimated cost tracking/i,
      });
      expect(toggle).toBeEnabled();
      expect(toggle).not.toBeChecked();
    });
    // The whole description, so a status suffix on the allowed state fails it.
    expect(
      screen.getByText(
        "Estimates each lease's current cost from the trend in its reported spend. Lets budget thresholds use estimated cost, and enables spend rate thresholds.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Estimated cost tracking globally disabled/,
      }),
    ).not.toBeInTheDocument();
  });

  test("predictive toggle is disabled when the global setting is off and the template does not use it", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /estimated cost tracking/i,
      });
      expect(toggle).toBeDisabled();
    });
    expect(
      screen.getByText(
        "Estimates each lease's current cost from the trend in its reported spend. Lets budget thresholds use estimated cost, and enables spend rate thresholds.",
      ),
    ).toBeInTheDocument();
    await expectGateNotice(
      user,
      "Estimated cost tracking globally disabled",
      "info",
      GATE_OFF_UNUSED,
    );
  });

  test("shows icon-only help for the page and visible Budget sections", async () => {
    renderComponent();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
      ).not.toBeChecked();
    });
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

  test("predictive toggle stays live with a gate notice that turns into a warning once switched off while the global setting is off", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: true,
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /estimated cost tracking/i,
      });
      expect(toggle).toBeEnabled();
      expect(toggle).toBeChecked();
    });
    const user = userEvent.setup();
    expect(gateAnnouncements()).toEqual([]);
    await expectGateNotice(
      user,
      "Estimated cost tracking globally disabled",
      "info",
      GATE_OFF_IN_USE,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );
    await waitFor(() =>
      expect(gateAnnouncements()).toEqual([
        `Warning: Estimated cost tracking. ${GATE_OFF_SWITCHED_OFF}`,
      ]),
    );
    await expectGateNotice(
      user,
      "Warning: Estimated cost tracking globally disabled",
      "warning",
      GATE_OFF_SWITCHED_OFF,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );
    expect(
      screen.getByRole("button", {
        name: "Estimated cost tracking globally disabled",
      }),
    ).toBeInTheDocument();
  });

  test("shows the trigger-on column and rate thresholds when estimated cost tracking is on", async () => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "HOURLY", rate: 2.5, action: "ALERT" }],
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      expect(screen.getByText("Cost basis")).toBeInTheDocument();
    });
    // Each configured limit loads as one row.
    expect(screen.getByLabelText("Rate threshold 1 rate (USD)")).toHaveValue(
      2.5,
    );
    expect(
      screen.queryByLabelText("Rate threshold 2 rate (USD)"),
    ).not.toBeInTheDocument();
    expect(screen.getByText("Per hour")).toBeInTheDocument();
    expect(screen.getByText("Rate (USD)")).toBeInTheDocument();
    expect(screen.getByText("Period")).toBeInTheDocument();
    // "Action" also heads the budget-threshold columns.
    expect(screen.getAllByText("Action").length).toBeGreaterThanOrEqual(2);
    expect(
      screen.getByRole("button", { name: "Remove rate threshold 1" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Spend rate thresholds help" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: "Add rate threshold" }),
    ).toBeInTheDocument();
  });

  /** Serves an opted-in template with `rateLimits`; returns the PUT body. */
  const serveRateLimitTemplate = (rateLimits: unknown[]) => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    const submitted: { data: any } = { data: null };
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            predictiveBudgetEnabled: true,
            budgetThresholds: [],
            rateLimits,
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submitted.data = await request.json();
          return HttpResponse.json({ status: "success", data: submitted.data });
        },
      ),
    );
    return submitted;
  };

  test("loads the configured rate thresholds, removes a row and saves the rest as the rateLimits list", async () => {
    const submitted = serveRateLimitTemplate([
      { basis: "HOURLY", rate: 10, action: "FREEZE_ACCOUNT" },
      { basis: "DAILY", rate: 200, action: "ALERT" },
    ]);

    renderComponent();
    const user = userEvent.setup();

    expect(
      await screen.findByLabelText("Rate threshold 1 rate (USD)"),
    ).toHaveValue(10);
    expect(screen.getByLabelText("Rate threshold 2 rate (USD)")).toHaveValue(
      200,
    );
    expect(
      screen.queryByLabelText("Rate threshold 3 rate (USD)"),
    ).not.toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Remove rate threshold 1" }),
    );
    expect(
      screen.queryByLabelText("Rate threshold 2 rate (USD)"),
    ).not.toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submitted.data).not.toBeNull());
    expect(submitted.data).not.toHaveProperty("rateLimit");
    expect(submitted.data.rateLimits).toEqual([
      { basis: "DAILY", rate: 200, action: "ALERT" },
    ]);
  });

  test("flags a second row repeating a period and rate", async () => {
    serveRateLimitTemplate([{ basis: "HOURLY", rate: 10, action: "ALERT" }]);

    renderComponent();
    const user = userEvent.setup();

    await screen.findByLabelText("Rate threshold 1 rate (USD)");
    await user.click(
      screen.getByRole("button", { name: "Add rate threshold" }),
    );
    const second = await screen.findByLabelText("Rate threshold 2 rate (USD)");
    await user.tripleClick(second);
    await user.keyboard("10");

    expect(
      await screen.findByText(
        "This period already has a rate threshold at this rate",
      ),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeDisabled();
  });

  test("keeps a saved estimated-cost threshold and rate thresholds when the template is saved", async () => {
    const rateLimits = [
      { basis: "HOURLY", rate: 2.5, action: "ALERT" },
      { basis: "DAILY", rate: 40, action: "ALERT" },
    ];
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            predictiveBudgetEnabled: true,
            budgetThresholds: [
              { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
            ],
            rateLimits,
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    const maxSpendInput = await screen.findByLabelText(
      "Maximum budget amount (USD)",
    );
    await waitFor(() => expect(maxSpendInput).toHaveValue(100));
    await user.tripleClick(maxSpendInput);
    await user.keyboard("120");

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => expect(submittedData).not.toBeNull());
    expect(submittedData.budgetThresholds).toEqual([
      { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
    ]);
    expect(submittedData.rateLimits).toEqual(rateLimits);
    expect(submittedData).not.toHaveProperty("rateLimit");
  });

  test("submits the toggle value and rate threshold after enabling estimated cost tracking", async () => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
      ).toBeEnabled();
    });

    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );
    // Enabling the toggle reveals the predictive-only controls.
    await waitFor(() => {
      expect(screen.getByText("Cost basis")).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: "Add rate threshold" }),
    );
    const rateInput = await screen.findByLabelText(
      "Rate threshold 1 rate (USD)",
    );
    const saveButton = screen.getByRole("button", { name: /save changes/i });

    // A new row starts blank, not at 0, and blocks saving until it has a rate.
    expect(rateInput).toHaveValue(null);
    await waitFor(() => expect(saveButton).toBeDisabled());
    await user.click(rateInput);
    await user.tab();
    expect(await screen.findByText("Rate is required")).toBeInTheDocument();

    await user.click(rateInput);
    await user.keyboard("3");
    await waitFor(() =>
      expect(screen.queryByText("Rate is required")).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData?.predictiveBudgetEnabled).toBe(true);
    });
    // A new row defaults to an hourly alert.
    expect(submittedData?.rateLimits).toEqual([
      { basis: "HOURLY", rate: 3, action: "ALERT" },
    ]);
    expect(submittedData).not.toHaveProperty("rateLimit");
  });

  test("switching estimated cost tracking off strips the rate threshold and threshold trigger-on values", async () => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: true,
            rateLimits: [{ basis: "HOURLY", rate: 2.5, action: "ALERT" }],
            budgetThresholds: [
              { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
            ],
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
      ).toBeChecked();
    });

    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData?.predictiveBudgetEnabled).toBe(false);
    });
    expect(submittedData).not.toHaveProperty("rateLimit");
    expect(submittedData?.rateLimits).toBeUndefined();
    expect(submittedData?.budgetThresholds?.[0]?.triggerOn).toBeUndefined();
  });

  test("surfaces the threshold-exceeds-maxSpend error live as the amount is typed", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            predictiveBudgetEnabled: false,
            budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
          },
        }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    const amountInput = await screen.findByPlaceholderText("e.g., 25");
    expect(
      screen.queryByText(/Must be less than the Terminate lease amount/i),
    ).not.toBeInTheDocument();

    await user.tripleClick(amountInput);
    await user.keyboard("150");

    // Typing an over-max amount re-runs cross-field validation, so the error
    // appears without touching the maximum budget field.
    expect(
      await screen.findByText(/Must be less than the Terminate lease amount/i),
    ).toBeInTheDocument();
  });

  test("ignores the saved maximum budget once it is turned off", async () => {
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            predictiveBudgetEnabled: false,
            budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    const amountInput = await screen.findByPlaceholderText("e.g., 25");
    await user.tripleClick(amountInput);
    await user.keyboard("150");
    expect(
      await screen.findByText(/Must be less than the Terminate lease amount/i),
    ).toBeInTheDocument();

    const toggle = screen.getByRole("checkbox", { name: /maximum budget/i });
    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await user.click(toggle);

    await waitFor(() =>
      expect(
        screen.queryByText(/Must be less than the Terminate lease amount/i),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(saveButton).toBeEnabled());

    // Turning the budget back on caps the threshold by the saved maximum again.
    await user.click(toggle);
    expect(
      await screen.findByText(/Must be less than the Terminate lease amount/i),
    ).toBeInTheDocument();
    await waitFor(() => expect(saveButton).toBeDisabled());

    await user.click(toggle);
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() =>
      expect(submittedData?.budgetThresholds).toEqual([
        { dollarsSpent: 150, action: "ALERT" },
      ]),
    );
    expect(submittedData.maxSpend).toBeUndefined();
  });

  test("enables Save after the maximum budget is turned off with an invalid amount typed", async () => {
    renderComponent();
    const user = userEvent.setup();

    const maxSpendInput = await screen.findByLabelText(
      "Maximum budget amount (USD)",
    );
    await user.tripleClick(maxSpendInput);
    await user.keyboard("0");
    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeDisabled());

    await user.click(screen.getByRole("checkbox", { name: /maximum budget/i }));

    await waitFor(() => expect(saveButton).toBeEnabled());
  });

  test("recovers form validity by clearing an invalid rate threshold row when estimated cost tracking is switched off", async () => {
    const config = createConfiguration({
      leases: { allowPredictiveBudgetControls: true },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            maxSpend: 100,
            predictiveBudgetEnabled: true,
            // No thresholds, so the only source of invalidity is the rate cap.
            budgetThresholds: [],
          },
        }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await user.click(
      await screen.findByRole("button", { name: "Add rate threshold" }),
    );
    const rate = await screen.findByLabelText("Rate threshold 1 rate (USD)");
    await user.tripleClick(rate);
    await user.keyboard("-5");
    expect(
      await screen.findByText(/Rate must be greater than 0/i),
    ).toBeInTheDocument();

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeDisabled());

    // Toggling predictive off hides the rate inputs; the toggle resets the
    // invalid cap so the form is not stuck invalid with no visible error.
    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );

    await waitFor(() =>
      expect(
        screen.queryByText(/Rate must be greater than 0/i),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(saveButton).toBeEnabled());
  });

  test("warns without blocking when estimated cost tracking is on and the duration is under 48 hours", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            predictiveBudgetEnabled: true,
            leaseDurationInHours: 12,
          },
        }),
      ),
    );

    renderComponent();

    expect(
      await screen.findByText(
        /estimated-cost thresholds may never fire for these leases\./i,
      ),
    ).toBeInTheDocument();
    // Warn, never block: the form still renders its save control.
    expect(
      screen.getByRole("button", { name: /save changes/i }),
    ).toBeInTheDocument();
  });

  test("Amazon Bedrock token monitoring toggle is live when the global setting is on", async () => {
    const config = createConfiguration({
      leases: { allowBedrockTokenMonitoring: true },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /bedrock token monitoring/i,
      });
      expect(toggle).toBeEnabled();
      expect(toggle).not.toBeChecked();
    });
    expect(
      screen.getByText(
        "Monitors and attributes Amazon Bedrock token usage to the lease budget between Cost Explorer reports.",
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", {
        name: /Amazon Bedrock token monitoring globally disabled/,
      }),
    ).not.toBeInTheDocument();
  });

  test("Amazon Bedrock token monitoring toggle is disabled when the global setting is off and the template does not use it", async () => {
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /bedrock token monitoring/i,
      });
      expect(toggle).toBeDisabled();
    });
    expect(
      screen.getByText(
        "Monitors and attributes Amazon Bedrock token usage to the lease budget between Cost Explorer reports.",
      ),
    ).toBeInTheDocument();
    await expectGateNotice(
      user,
      "Amazon Bedrock token monitoring globally disabled",
      "info",
      GATE_OFF_UNUSED,
    );
  });

  test("Amazon Bedrock token monitoring toggle stays live with a gate notice that turns into a warning once switched off while the global setting is off", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            bedrockTokenMonitoringEnabled: true,
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /bedrock token monitoring/i,
      });
      expect(toggle).toBeEnabled();
      expect(toggle).toBeChecked();
    });
    const user = userEvent.setup();
    expect(gateAnnouncements()).toEqual([]);
    await expectGateNotice(
      user,
      "Amazon Bedrock token monitoring globally disabled",
      "info",
      GATE_OFF_IN_USE,
    );

    await user.click(
      screen.getByRole("checkbox", { name: /bedrock token monitoring/i }),
    );
    await waitFor(() =>
      expect(gateAnnouncements()).toEqual([
        `Warning: Amazon Bedrock token monitoring. ${GATE_OFF_SWITCHED_OFF}`,
      ]),
    );
    await expectGateNotice(
      user,
      "Warning: Amazon Bedrock token monitoring globally disabled",
      "warning",
      GATE_OFF_SWITCHED_OFF,
    );
  });

  test("locks the stored monitoring value while Sandbox Spaces is enabled", async () => {
    const config = createConfiguration({
      leases: {
        maxBudget: 10000,
        allowBedrockTokenMonitoring: false,
      },
      agent: { sandboxSpacesEnabled: true },
    });
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: true,
          },
        }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    const monitoringToggle = await screen.findByRole("checkbox", {
      name: /bedrock token monitoring/i,
    });
    expect(monitoringToggle).toBeChecked();
    expect(monitoringToggle).toBeDisabled();
    expect(
      screen.getByText("Required while Sandbox Spaces is enabled."),
    ).toBeInTheDocument();

    const maxSpendInput = screen.getByLabelText("Maximum budget amount (USD)");
    await user.tripleClick(maxSpendInput);
    await user.keyboard("600");
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => expect(submittedData).not.toBeNull());
    expect(submittedData.bedrockTokenMonitoringEnabled).toBe(true);
  });

  test("shows a stored off monitoring value on the locked toggle while Sandbox Spaces is enabled", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: { maxBudget: 10000, allowBedrockTokenMonitoring: true },
            agent: { sandboxSpacesEnabled: true },
          }),
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: false,
          },
        }),
      ),
    );

    renderComponent();

    await waitFor(() => {
      const toggle = screen.getByRole("checkbox", {
        name: /bedrock token monitoring/i,
      });
      expect(toggle).toBeDisabled();
      expect(toggle).not.toBeChecked();
    });
  });

  test("gates Amazon Bedrock token monitoring on its own global setting while Sandbox Spaces is on globally", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: { maxBudget: 10000, allowBedrockTokenMonitoring: false },
            agent: { sandboxSpacesEnabled: true },
          }),
        }),
      ),
      http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockAdvancedLeaseTemplate,
            sandboxSpacesEnabled: false,
            bedrockTokenMonitoringEnabled: false,
          },
        }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", { name: /bedrock token monitoring/i }),
      ).toBeDisabled();
    });
    await expectGateNotice(
      user,
      "Amazon Bedrock token monitoring globally disabled",
      "info",
      GATE_OFF_UNUSED,
    );
  });

  test("submits Amazon Bedrock token monitoring after enabling it, leaving estimated cost tracking off", async () => {
    const config = createConfiguration({
      leases: { allowBedrockTokenMonitoring: true },
    });
    let submittedData: any = null;
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: config }),
      ),
      http.put(
        `${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`,
        async ({ request }) => {
          submittedData = await request.json();
          return HttpResponse.json({ status: "success", data: submittedData });
        },
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    const toggle = await screen.findByRole("checkbox", {
      name: /bedrock token monitoring/i,
    });
    await waitFor(() => expect(toggle).toBeEnabled());
    await user.click(toggle);

    const saveButton = screen.getByRole("button", { name: /save changes/i });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedData?.bedrockTokenMonitoringEnabled).toBe(true);
    });
    expect(submittedData?.predictiveBudgetEnabled).toBe(false);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { GlobalConfigForUI } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { AddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/AddLeaseTemplate";
import { config } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

const mockNavigate = vi.fn();

vi.mock("react-router-dom", async () => {
  const actual = await vi.importActual("react-router-dom");
  return {
    ...actual,
    useNavigate: () => mockNavigate,
  };
});

vi.mock("@amzn/innovation-sandbox-frontend/components/Toast", () => ({
  showErrorToast: vi.fn(),
  showSuccessToast: vi.fn(),
}));

describe("AddLeaseTemplate", () => {
  // Mock configuration with require flags set to true
  const mockConfig: GlobalConfigForUI = createConfiguration({
    leases: {
      maxBudget: 10000,
      requireMaxBudget: true,
      maxDurationHours: 1000,
      requireMaxDuration: true,
      maxLeasesPerUser: 5,
      ttl: 1000,
    },
  });

  beforeEach(() => {
    mockNavigate.mockClear();

    // Override the configuration endpoint to return our test config
    server.use(
      http.get(`${config.ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: mockConfig,
        });
      }),
      // Mock the blueprints endpoint
      http.get(`${config.ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [],
          },
        });
      }),
    );
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <AddLeaseTemplate />
      </Router>,
    );

  const fillFormAndNavigate = async (
    user: ReturnType<typeof userEvent.setup>,
  ) => {
    // Wait for the form to be fully loaded with configuration data
    // Wizard starts on Basic Details step (index 0)
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    // Fill out the Basic Details
    await user.type(screen.getByLabelText("Name"), "Test Template");

    await user.type(screen.getByLabelText(/Description/i), "Test Description");

    const visibilitySelect = screen.getByLabelText("Visibility");
    await user.click(visibilitySelect);
    await waitFor(() => {
      const publicOptions = screen.getAllByText("Public");
      return user.click(publicOptions[0]);
    });

    await user.click(screen.getByLabelText("Approval required"));

    // Navigate to Blueprint step
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(
        screen.getByText(/Enable Blueprint Selection/i),
      ).toBeInTheDocument();
    });
    //navigate to Budget step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Wait for the input field to be enabled after clicking the toggle
    await waitFor(() => {
      expect(screen.getByLabelText("Maximum Spend (USD)")).toBeInTheDocument();
    });

    const maxSpendInput = screen.getByLabelText("Maximum Spend (USD)");
    await user.type(maxSpendInput, "50");

    // Navigate to Duration step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Wait for Duration step to be fully rendered
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    const maxDurationInput = screen.getByLabelText("Maximum Duration (Hours)");
    await user.type(maxDurationInput, "24");

    // Navigate to Cost Report step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Navigate to Review step
    await user.click(screen.getByRole("button", { name: /next/i }));
  };

  test("renders the form with correct initial values", async () => {
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });
  });

  test("navigates back to lease templates page on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    const cancelButton = (
      await screen.findAllByRole("button", { name: /cancel/i })
    )[0];
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
  });

  test("submits form and navigates on successful submission", async () => {
    const submitSpy = vi.fn();
    server.use(
      http.post(`${config.ApiUrl}/leaseTemplates`, async ({ request }) => {
        const data = await request.json();
        submitSpy(data);
        return HttpResponse.json({ status: "success", data });
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    // Wait for Cost Report step to be fully rendered
    await waitFor(() => {
      expect(
        screen.getByRole("button", {
          name: "Create lease template",
        }),
      ).toBeInTheDocument();
    });

    const submitButton = screen.getByRole("button", {
      name: "Create lease template",
    });

    await user.click(submitButton);

    await waitFor(() => {
      expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Template",
          description: "Test Description",
          requiresApproval: false,
          visibility: "PUBLIC",
          maxSpend: 50,
          budgetThresholds: [],
          leaseDurationInHours: 24,
          durationThresholds: [],
        }),
      );
    });
  });

  test("displays error message on submission failure", async () => {
    server.use(
      http.post(`${config.ApiUrl}/leaseTemplates`, () => {
        return HttpResponse.json(
          {
            status: "Creation Failed",
            message:
              "Failed to create lease template: HTTP error 500 Please check your inputs and try again.",
          },
          { status: 500 },
        );
      }),
    );

    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    const submitButton = await screen.findByRole("button", {
      name: "Create lease template",
    });
    await user.click(submitButton);

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        "Failed to create lease template: HTTP error 500 Please check your inputs and try again.",
        "Creation Failed",
      );
    });
  });

  test("displays review step with correct form values", async () => {
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    await waitFor(() => {
      expect(
        screen.getByText("Review your lease template configuration"),
      ).toBeInTheDocument();
    });

    // Verify the form values are displayed correctly in the summary
    expect(screen.getByText("Test Template")).toBeInTheDocument();
    expect(screen.getByText("Test Description")).toBeInTheDocument();
    expect(screen.getByText("Public")).toBeInTheDocument();
    expect(screen.getByText("$50.00")).toBeInTheDocument();
    expect(screen.getByText("24 hours")).toBeInTheDocument();

    // Verify submit button is available
    const submitButton = screen.getByRole("button", {
      name: /create lease template/i,
    });
    expect(submitButton).toBeInTheDocument();
  });

  test("allows navigation back from review step to edit values", async () => {
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    // Verify we're on the review step
    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /create lease template/i }),
      ).toBeInTheDocument();
    });

    // Navigate back to Cost Report step
    const previousButton = screen.getByRole("button", { name: /previous/i });
    await user.click(previousButton);

    // Should be back on Cost Report step
    await waitFor(() => {
      const costReportHeaders = screen.getAllByText("Cost Report");
      expect(costReportHeaders.length).toBeGreaterThan(0);
    });

    // Navigate back again to Duration step
    await user.click(screen.getByRole("button", { name: /previous/i }));

    // Should be on Duration step
    await waitFor(() => {
      const durationHeaders = screen.getAllByText("Lease Duration");
      expect(durationHeaders.length).toBeGreaterThan(0);
    });
  });

  test("prevents navigation to next step when current step has validation errors", async () => {
    renderComponent();
    const user = userEvent.setup();

    // Wait for Basic Details step to load (first step)
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    // Try to navigate without filling required name field
    const nextButton = screen.getByRole("button", { name: /next/i });
    await user.click(nextButton);

    // Should still be on Basic Details step
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });
  });
});

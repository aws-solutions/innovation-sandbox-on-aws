// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useAddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { AddLeaseTemplate } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/AddLeaseTemplate";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import {
  expectNoMonitoringMessage,
  expectNoMonitoringToggle,
  expectStaysOnMessage,
  expectTurnedOffMessage,
} from "@amzn/innovation-sandbox-frontend-test/utils/bedrockTokenMonitoringMessages";
import {
  expectSandboxSpacesGateNotice,
  SANDBOX_SPACES_GATE_OFF_UNUSED,
} from "@amzn/innovation-sandbox-frontend-test/utils/sandboxSpacesGate";

const mockNavigate = vi.fn();
const mockAddLeaseTemplate = vi.fn();
const builtInPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2123456789abcdef",
  permissionSetId: "ps-2123456789abcdef",
  name: "test_IsbUsersPS",
  description: "Built-in sandbox user access",
};

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks",
  async () => {
    const actual = await vi.importActual(
      "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks",
    );
    return { ...actual, useAddLeaseTemplate: vi.fn() };
  },
);

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

const MAX_SPEND_REQUIRED =
  "Maximum budget is required and must be greater than 0";

describe("AddLeaseTemplate", () => {
  // Mock configuration with require flags set to true
  const mockConfig = createConfiguration({
    leases: {
      maxBudget: 10000,
      requireMaxBudget: true,
      maxDurationHours: 1000,
      requireMaxDuration: true,
      maxLeasesPerUser: 5,
      ttl: 1000,
      leaseSharingEnabled: true,
      allowUserLeaseTermination: true,
      leaseRequestWindowHours: 168,
      maxLeaseRequestsPerWindow: 10,
      enablePrincipalSearch: true,
    },
    agent: { sandboxSpacesEnabled: true },
  });

  beforeEach(() => {
    mockNavigate.mockClear();
    mockAddLeaseTemplate.mockReset();
    mockAddLeaseTemplate.mockResolvedValue(undefined);
    vi.mocked(useAddLeaseTemplate).mockReturnValue({
      mutateAsync: mockAddLeaseTemplate,
      isPending: false,
    } as unknown as ReturnType<typeof useAddLeaseTemplate>);

    // Override the configuration endpoint to return our test config
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () => {
        return HttpResponse.json({
          status: "success",
          data: mockConfig,
        });
      }),
      // Mock the blueprints endpoint
      http.get(`${getConfig().ApiUrl}/blueprints`, () => {
        return HttpResponse.json({
          status: "success",
          data: {
            blueprints: [],
          },
        });
      }),
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        HttpResponse.json({
          status: "success",
          data: { result: [builtInPermissionSet] },
        }),
      ),
    );
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <AddLeaseTemplate />
      </Router>,
    );

  const expectNoMaxSpendRequiredError = async () => {
    await expect(
      screen.findByText(MAX_SPEND_REQUIRED, {}, { timeout: 300 }),
    ).rejects.toThrow(/Unable to find/);
  };

  const fillFormAndNavigate = async (
    user: ReturnType<typeof userEvent.setup>,
    options: {
      onBudgetStepOpen?: () => Promise<void>;
      /** Runs on the Budget step once maximum budget has been filled in. */
      onBudgetStep?: () => Promise<void>;
      /** Runs after the Access and sharing step has mounted. */
      onPermissionProfileStep?: () => Promise<void>;
      /** Runs on the Duration step once Maximum Duration has been filled in. */
      onDurationStep?: () => Promise<void>;
      onCostReportStep?: () => Promise<void>;
    } = {},
  ) => {
    // Wait for the form to be fully loaded with configuration data
    // Wizard starts on Basic Details step (index 0)
    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });

    // Fill out the Basic Details
    await user.type(screen.getByLabelText("Name"), "Test Template");

    await user.type(screen.getByLabelText(/Description/i), "Test Description");

    await user.click(screen.getByLabelText("Assignment only"));

    await user.click(screen.getByLabelText("Approval required"));

    // Navigate to Blueprint step
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "Deploy a blueprint",
          level: 2,
        }),
      ).toBeInTheDocument();
    });
    // Navigate to Access and sharing step
    await user.click(screen.getByRole("button", { name: /next/i }));

    await waitFor(() => {
      expect(screen.getByText("Add permission sets")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(builtInPermissionSet.name).length,
      ).toBeGreaterThan(0);
    });
    await options.onPermissionProfileStep?.();

    // Navigate to Sandbox Space step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Wait for the Sandbox Space step to mount before advancing.
    await waitFor(() => {
      expect(
        screen.getByText(
          "When enabled, every lease created from this template is provisioned with a Sandbox Space.",
        ),
      ).toBeInTheDocument();
    });

    // Navigate to Budget step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Wait for the input field to be enabled after clicking the toggle
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    await options.onBudgetStepOpen?.();

    const maxSpendInput = screen.getByLabelText("Maximum budget amount (USD)");
    await user.type(maxSpendInput, "50");
    await options.onBudgetStep?.();

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
    await options.onDurationStep?.();

    // Navigate to Cost reporting step
    await user.click(screen.getByRole("button", { name: /next/i }));

    // Wait for Cost reporting step to mount before advancing — the step contains
    // a Cloudscape Select whose Transition state takes a few frames to settle
    // on slower CI hosts; clicking next before it does causes the next step
    // to wedge, and the eventual submit-button waitFor times out at 10s.
    await waitFor(() => {
      expect(screen.getByText("Enable Cost Report Group")).toBeInTheDocument();
    });
    await options.onCostReportStep?.();

    // Navigate from Cost reporting to Review.
    await user.click(screen.getByRole("button", { name: /next/i }));
  };

  test("navigates back to lease templates page on cancel", async () => {
    renderComponent();
    const user = userEvent.setup();

    const cancelButton = (
      await screen.findAllByRole("button", { name: /cancel/i })
    )[0];
    await user.click(cancelButton);

    expect(mockNavigate).toHaveBeenCalledWith("/lease_templates");
  });

  test("always submits the required permission profile and navigates on success", async () => {
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
      expect(mockAddLeaseTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Template",
          description: "Test Description",
          requiresApproval: false,
          visibility: "PUBLIC",
          maxSpend: 50,
          budgetThresholds: [],
          leaseDurationInHours: 24,
          durationThresholds: [],
          allowOwnerToShareLease: false,
          sandboxSpacesEnabled: false,
          bedrockTokenMonitoringEnabled: false,
          defaultPermissionSetArn: builtInPermissionSet.permissionSetArn,
          allowedPermissionSetArns: [],
        }),
      );
    });
  });

  test("reviews and submits selected permission profiles with hydrated names", async () => {
    const developerPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
      permissionSetId: "ps-0123456789abcdef",
      name: "DeveloperAccess",
      description: "Developer sandbox access",
    };
    const auditorPermissionSet = {
      permissionSetArn:
        "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1123456789abcdef",
      permissionSetId: "ps-1123456789abcdef",
      name: "AuditorAccess",
      description: "Read-only sandbox access",
    };
    server.use(
      http.get(`${getConfig().ApiUrl}/permissionSets`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            result: [
              builtInPermissionSet,
              developerPermissionSet,
              auditorPermissionSet,
            ],
          },
        }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();
    await fillFormAndNavigate(user, {
      onPermissionProfileStep: async () => {
        await user.click(screen.getByLabelText("Add permission sets"));
        await user.click(await screen.findByText("DeveloperAccess"));
        await user.click(await screen.findByText("AuditorAccess"));
        await user.click(
          screen.getByRole("button", {
            name: "Set DeveloperAccess as default permission set",
          }),
        );
      },
    });

    expect(screen.getByText("DeveloperAccess")).toBeInTheDocument();
    expect(screen.getByText("Developer sandbox access")).toBeInTheDocument();
    expect(screen.getByText("AuditorAccess")).toBeInTheDocument();
    expect(screen.getByText("Read-only sandbox access")).toBeInTheDocument();

    await user.click(
      screen.getByRole("button", { name: "Create lease template" }),
    );

    await waitFor(() =>
      expect(mockAddLeaseTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          defaultPermissionSetArn: developerPermissionSet.permissionSetArn,
          allowedPermissionSetArns: [
            builtInPermissionSet.permissionSetArn,
            auditorPermissionSet.permissionSetArn,
          ],
        }),
      ),
    );
  });

  test("keeps the Sandbox Spaces step but disables authoring when the global setting is off", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            agent: { ...mockConfig.agent, sandboxSpacesEnabled: false },
          },
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user);

    // Jump back to the Sandbox Space step (4th in the wizard menu).
    await user.click(
      createWrapper().findWizard()!.findMenuNavigationLink(4)!.getElement(),
    );

    expect(await screen.findByRole("checkbox")).toBeDisabled();
    await expectSandboxSpacesGateNotice(
      user,
      "info",
      SANDBOX_SPACES_GATE_OFF_UNUSED,
    );
  });

  describe("Bedrock token monitoring with Sandbox Spaces", () => {
    // 1-based Cloudscape Wizard menu positions for the steps these tests visit.
    const SANDBOX_SPACES_STEP = 4;
    const BUDGET_STEP = 5;
    const REVIEW_STEP = 8;
    const SANDBOX_SPACES_TOGGLE = {
      name: /^Sandbox Space (enabled|disabled) Enable Sandbox Space$/,
    };

    // Re-resolve the wrapper on every jump; the wizard re-renders between steps.
    const goToStep = (user: ReturnType<typeof userEvent.setup>, step: number) =>
      user.click(
        createWrapper()
          .findWizard()!
          .findMenuNavigationLink(step)!
          .getElement(),
      );

    const openSandboxSpacesStep = async () => {
      renderComponent();
      const user = userEvent.setup();
      await fillFormAndNavigate(user);
      await goToStep(user, SANDBOX_SPACES_STEP);
      return user;
    };

    const toggleSandboxSpaces = async (
      user: ReturnType<typeof userEvent.setup>,
    ) => user.click(await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE));

    const findBudgetMonitoringToggle = () =>
      screen.findByRole("checkbox", { name: /bedrock token monitoring/i });

    const createAndGetRequest = async (
      user: ReturnType<typeof userEvent.setup>,
    ) => {
      await goToStep(user, REVIEW_STEP);
      await user.click(
        await screen.findByRole("button", { name: "Create lease template" }),
      );
      await waitFor(() => {
        expect(mockAddLeaseTemplate).toHaveBeenCalledTimes(1);
      });
      return mockAddLeaseTemplate.mock.calls[0]![0];
    };

    const allowMonitoringGlobally = () =>
      server.use(
        http.get(`${getConfig().ApiUrl}/configurations`, () =>
          HttpResponse.json({
            status: "success",
            data: {
              ...mockConfig,
              leases: {
                ...mockConfig.leases,
                allowBedrockTokenMonitoring: true,
              },
            },
          }),
        ),
      );

    test("enabling Sandbox Spaces turns monitoring on, locks Budget on and creates the template with monitoring on", async () => {
      allowMonitoringGlobally();
      const user = await openSandboxSpacesStep();

      await toggleSandboxSpaces(user);
      expectNoMonitoringToggle();
      expectNoMonitoringMessage();

      await goToStep(user, BUDGET_STEP);
      const monitoringToggle = await findBudgetMonitoringToggle();
      expect(monitoringToggle).toBeChecked();
      expect(monitoringToggle).toBeDisabled();

      const request = await createAndGetRequest(user);
      expect(request.sandboxSpacesEnabled).toBe(true);
      expect(request.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("disabling Sandbox Spaces leaves monitoring on with the stays-on message across steps", async () => {
      allowMonitoringGlobally();
      const user = await openSandboxSpacesStep();

      await toggleSandboxSpaces(user);
      await toggleSandboxSpaces(user);
      expectStaysOnMessage();

      // Budget shows the stored value and is editable again.
      await goToStep(user, BUDGET_STEP);
      const monitoringToggle = await findBudgetMonitoringToggle();
      expect(monitoringToggle).toBeChecked();
      expect(monitoringToggle).toBeEnabled();

      // The message stays until the form is saved or left.
      await goToStep(user, SANDBOX_SPACES_STEP);
      await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE);
      expectStaysOnMessage();

      const request = await createAndGetRequest(user);
      expect(request.sandboxSpacesEnabled).toBe(false);
      expect(request.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("hides the stays-on message once monitoring is turned off in the Budget step", async () => {
      allowMonitoringGlobally();
      const user = await openSandboxSpacesStep();

      await toggleSandboxSpaces(user);
      await toggleSandboxSpaces(user);
      expectStaysOnMessage();

      await goToStep(user, BUDGET_STEP);
      await user.click(await findBudgetMonitoringToggle());
      await goToStep(user, SANDBOX_SPACES_STEP);
      await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE);
      expectNoMonitoringMessage();

      const request = await createAndGetRequest(user);
      expect(request.sandboxSpacesEnabled).toBe(false);
      expect(request.bedrockTokenMonitoringEnabled).toBe(false);
    });

    test("disabling Sandbox Spaces turns monitoring off while the global setting is off", async () => {
      const user = await openSandboxSpacesStep();
      // No message shows until Sandbox Spaces is switched off in this form.
      expectNoMonitoringMessage();

      await toggleSandboxSpaces(user);
      await toggleSandboxSpaces(user);
      expectTurnedOffMessage();

      await goToStep(user, BUDGET_STEP);
      const monitoringToggle = await findBudgetMonitoringToggle();
      expect(monitoringToggle).not.toBeChecked();
      expect(monitoringToggle).toBeDisabled();

      const request = await createAndGetRequest(user);
      expect(request.sandboxSpacesEnabled).toBe(false);
      expect(request.bedrockTokenMonitoringEnabled).toBe(false);
    });
  });

  describe("cost report group", () => {
    const serveCostReportingConfig = (requireCostReportGroup: boolean) =>
      server.use(
        http.get(`${getConfig().ApiUrl}/configurations`, () =>
          HttpResponse.json({
            status: "success",
            data: {
              ...mockConfig,
              costReporting: {
                ...mockConfig.costReporting,
                costReportGroups: ["Engineering"],
                requireCostReportGroup,
              },
            },
          }),
        ),
      );

    const getCostReportToggle = () =>
      screen.getByRole("checkbox", { name: /cost reporting group/i });

    const pickEngineering = async (
      user: ReturnType<typeof userEvent.setup>,
    ) => {
      const selectTrigger = screen
        .getAllByRole("button")
        .find((btn) => btn.textContent?.includes("Select a cost report group"));
      expect(selectTrigger).toBeDefined();
      await user.click(selectTrigger!);
      await user.click(await screen.findByText("Engineering"));
    };

    const createAndGetRequest = async (
      user: ReturnType<typeof userEvent.setup>,
    ) => {
      await user.click(
        await screen.findByRole("button", { name: "Create lease template" }),
      );
      await waitFor(() => {
        expect(mockAddLeaseTemplate).toHaveBeenCalledTimes(1);
      });
      return mockAddLeaseTemplate.mock.calls[0]![0];
    };

    test("neither reviews nor sends a group picked before the toggle was turned off", async () => {
      serveCostReportingConfig(false);
      renderComponent();
      const user = userEvent.setup();

      await fillFormAndNavigate(user, {
        onCostReportStep: async () => {
          await user.click(getCostReportToggle());
          expect(screen.getByText("Cost Report Group")).toBeVisible();
          await pickEngineering(user);
          await user.click(getCostReportToggle());
        },
      });

      expect(await screen.findByText("Not assigned")).toBeVisible();
      expect(screen.queryByText("Engineering")).not.toBeInTheDocument();
      const request = await createAndGetRequest(user);
      expect(request.costReportGroup).toBeUndefined();
    });

    test("reviews and sends a group picked with the toggle on", async () => {
      serveCostReportingConfig(false);
      renderComponent();
      const user = userEvent.setup();

      await fillFormAndNavigate(user, {
        onCostReportStep: async () => {
          await user.click(getCostReportToggle());
          await pickEngineering(user);
        },
      });

      expect(await screen.findByText("Engineering")).toBeVisible();
      const request = await createAndGetRequest(user);
      expect(request.costReportGroup).toBe("Engineering");
    });

    test("reviews and sends a required group while the toggle value is off", async () => {
      serveCostReportingConfig(true);
      renderComponent();
      const user = userEvent.setup();

      await fillFormAndNavigate(user, {
        onCostReportStep: async () => {
          expect(getCostReportToggle()).toBeChecked();
          await pickEngineering(user);
        },
      });

      expect(await screen.findByText("Engineering")).toBeVisible();
      const request = await createAndGetRequest(user);
      expect(request.costReportGroup).toBe("Engineering");
    });
  });

  test("displays error message on submission failure", async () => {
    mockAddLeaseTemplate.mockRejectedValueOnce(new Error("HTTP error 500"));

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
    expect(screen.getByText("Allow user requests")).toBeInTheDocument();
    expect(screen.getByText("Requests allowed")).toBeInTheDocument();
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

    // Navigate back to Cost reporting step
    await user.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      expect(screen.getByText("Enable Cost Report Group")).toBeInTheDocument();
    });

    // Navigate back to Duration step
    await user.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });

    // Navigate back to Budget step
    await user.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });

    // Navigate back to Sandbox Space step
    await user.click(screen.getByRole("button", { name: /previous/i }));
    await waitFor(() => {
      expect(
        screen.getByText(
          "When enabled, every lease created from this template is provisioned with a Sandbox Space.",
        ),
      ).toBeInTheDocument();
    });
  });

  test("turning the maximum duration off lets the wizard continue past hidden invalid values and creates the template without a duration", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            leases: { ...mockConfig.leases, requireMaxDuration: false },
          },
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onDurationStep: async () => {
        // Above the 1000-hour global limit, plus a new row at 0 hours
        // remaining: both are invalid once hidden.
        await user.type(
          screen.getByLabelText("Maximum Duration (Hours)"),
          "00",
        );
        await user.click(screen.getByRole("button", { name: "Add Threshold" }));
        await user.click(
          screen.getByRole("checkbox", { name: /Duration limit/ }),
        );
      },
    });

    expect(
      await screen.findByText("Review your lease template configuration"),
    ).toBeInTheDocument();
    expect(screen.queryByText("2400 hours")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create lease template" }),
    );
    await waitFor(() => expect(mockAddLeaseTemplate).toHaveBeenCalledTimes(1));
    const request = mockAddLeaseTemplate.mock.calls[0]![0];
    expect(request.leaseDurationInHours).toBeUndefined();
    expect(request.durationThresholds).toEqual([]);
  });

  test("creates the template without the maximum budget typed before it was turned off", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: {
            ...mockConfig,
            leases: { ...mockConfig.leases, requireMaxBudget: false },
          },
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStep: async () => {
        await user.click(
          screen.getByRole("checkbox", { name: /maximum budget/i }),
        );
      },
    });

    expect(
      await screen.findByText("Review your lease template configuration"),
    ).toBeInTheDocument();
    expect(screen.queryByText("$50.00")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Create lease template" }),
    );
    await waitFor(() => expect(mockAddLeaseTemplate).toHaveBeenCalledTimes(1));
    expect(mockAddLeaseTemplate.mock.calls[0]![0].maxSpend).toBeUndefined();
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
  test("warns on the duration step when estimated cost tracking is on and duration is under 48 hours, without blocking", async () => {
    const gateOnConfig = createConfiguration({
      leases: {
        maxBudget: 10000,
        maxDurationHours: 1000,
        allowPredictiveBudgetControls: true,
      },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: gateOnConfig }),
      ),
    );

    const user = userEvent.setup();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByLabelText("Name")).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("Name"), "Short Lease Template");

    // Basic Details -> Blueprint
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: "Deploy a blueprint",
          level: 2,
        }),
      ).toBeInTheDocument();
    });

    // Blueprint -> Access and sharing
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(screen.getByText("Add permission sets")).toBeInTheDocument();
    });
    await waitFor(() => {
      expect(
        screen.getAllByText(builtInPermissionSet.name).length,
      ).toBeGreaterThan(0);
    });

    // Access and sharing -> Sandbox Space
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(
        screen.getByText(
          "When enabled, every lease created from this template is provisioned with a Sandbox Space.",
        ),
      ).toBeInTheDocument();
    });

    // Sandbox Space -> Budget
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum budget amount (USD)"),
      ).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("Maximum budget amount (USD)"), "50");
    // The gate-on config override above makes the toggle live.
    await user.click(
      screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
    );

    // Budget -> Duration
    await user.click(screen.getByRole("button", { name: /next/i }));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Maximum Duration (Hours)"),
      ).toBeInTheDocument();
    });
    await user.type(screen.getByLabelText("Maximum Duration (Hours)"), "12");

    expect(
      await screen.findByText(/estimated-cost thresholds may never fire/i),
    ).toBeInTheDocument();
    // Warn, never block: the wizard still lets the user continue.
    const nextButton = screen.getByRole("button", { name: /next/i });
    expect(nextButton).toBeEnabled();
  });

  test("Bedrock token monitoring toggle is disabled on the budget step while the global monitoring setting is off, even with Sandbox Spaces enabled globally", async () => {
    // mockConfig enables Sandbox Spaces globally and leaves
    // allowBedrockTokenMonitoring unset; the two settings are independent.
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStep: async () => {
        expect(
          screen.getByRole("checkbox", { name: /bedrock token monitoring/i }),
        ).toBeDisabled();
        const trigger = screen.getByRole("button", {
          name: "Amazon Bedrock token monitoring globally disabled",
        });
        const popover = createWrapper()
          .findAllPopovers()
          .find(
            (candidate) => candidate.findTrigger().getElement() === trigger,
          )!;
        await user.click(trigger);
        await waitFor(() =>
          expect(popover.findContent()?.getElement()).toHaveTextContent(
            "Globally disabled. An administrator can allow this under Lease Policies on the Settings page.",
          ),
        );
      },
    });
  });

  test("opens the budget step without a required error before maximum budget is typed", async () => {
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStepOpen: async () => {
        await expectNoMaxSpendRequiredError();
        await user.click(screen.getByRole("button", { name: /next/i }));
        expect(await screen.findByText(MAX_SPEND_REQUIRED)).toBeInTheDocument();
      },
    });
  });

  test("switching estimated cost tracking on before maximum budget is typed shows no required error", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: {
              maxBudget: 10000,
              maxDurationHours: 1000,
              allowPredictiveBudgetControls: true,
            },
          }),
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStepOpen: async () => {
        await user.click(
          screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
        );
        await expectNoMaxSpendRequiredError();
      },
    });
  });

  test("shows estimated cost tracking and configured spend-rate limits on the review step", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: {
              maxBudget: 10000,
              maxDurationHours: 1000,
              allowPredictiveBudgetControls: true,
            },
          }),
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStep: async () => {
        await user.click(
          screen.getByRole("checkbox", { name: /estimated cost tracking/i }),
        );
        await user.click(
          await screen.findByRole("button", { name: "Add rate threshold" }),
        );
        const rateInput = await screen.findByLabelText(
          "Rate threshold 1 rate (USD)",
        );
        await user.tripleClick(rateInput);
        await user.keyboard("3");
      },
    });

    expect(
      await screen.findByText("Review your lease template configuration"),
    ).toBeInTheDocument();
    expect(screen.getByText("Estimated cost tracking")).toBeVisible();
    // Predictive controls are the only feature switched on in this flow.
    expect(screen.getAllByText("Enabled")).toHaveLength(1);
    expect(screen.getByText("Spend rate thresholds")).toBeVisible();
    // A new row defaults to an hourly alert.
    expect(screen.getByText("$3.00/hour (Send alert)")).toBeVisible();
  });

  test("review shows an estimated-cost threshold as saved after estimated cost tracking is turned off", async () => {
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            leases: {
              maxBudget: 10000,
              maxDurationHours: 1000,
              allowPredictiveBudgetControls: true,
            },
          }),
        }),
      ),
    );
    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStep: async () => {
        const estimatedCostToggle = screen.getByRole("checkbox", {
          name: /estimated cost tracking/i,
        });
        await user.click(estimatedCostToggle);
        await user.click(screen.getByRole("button", { name: "Add threshold" }));
        await user.tripleClick(screen.getByPlaceholderText("e.g., 25"));
        await user.keyboard("40");
        const costBasis = await screen.findByRole("button", {
          name: /Threshold 1 cost basis/,
        });
        await user.click(costBasis);
        await user.click(
          await screen.findByRole("option", { name: "Estimated cost" }),
        );
        await waitFor(() =>
          expect(costBasis).toHaveTextContent("Estimated cost"),
        );
        await user.click(estimatedCostToggle);
        expect(
          await screen.findByRole("button", {
            name: /Threshold 1 cost basis Reported cost/,
          }),
        ).toHaveTextContent("Reported cost");
      },
    });

    expect(
      await screen.findByText("Review your lease template configuration"),
    ).toBeInTheDocument();
    expect(screen.getByText("$40.00")).toBeVisible();
    expect(screen.getByText("Cost basis")).toBeVisible();
    expect(screen.getByText("Reported cost")).toBeVisible();
    expect(screen.queryByText("Estimated cost")).not.toBeInTheDocument();

    await user.click(
      await screen.findByRole("button", { name: "Create lease template" }),
    );
    await waitFor(() => {
      expect(mockAddLeaseTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          predictiveBudgetEnabled: false,
          budgetThresholds: [{ dollarsSpent: 40, action: "ALERT" }],
        }),
      );
    });
  });

  test("submits Bedrock token monitoring on when the toggle is enabled on the budget step", async () => {
    const gateOnConfig = createConfiguration({
      leases: {
        maxBudget: 10000,
        maxDurationHours: 1000,
        allowBedrockTokenMonitoring: true,
      },
    });
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({ status: "success", data: gateOnConfig }),
      ),
    );

    renderComponent();
    const user = userEvent.setup();

    await fillFormAndNavigate(user, {
      onBudgetStep: async () => {
        const toggle = screen.getByRole("checkbox", {
          name: /bedrock token monitoring/i,
        });
        expect(toggle).toBeEnabled();
        await user.click(toggle);
      },
    });

    // The review step reflects the toggle before anything is sent: with
    // estimated cost tracking, sharing and Sandbox Spaces all off, the Bedrock row
    // is the only one reading Enabled.
    expect(
      await screen.findByText("Amazon Bedrock token monitoring"),
    ).toBeVisible();
    expect(screen.getAllByText("Enabled")).toHaveLength(1);
    await user.click(
      await screen.findByRole("button", { name: "Create lease template" }),
    );

    await waitFor(() => {
      expect(mockAddLeaseTemplate).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "Test Template",
          bedrockTokenMonitoringEnabled: true,
          predictiveBudgetEnabled: false,
        }),
      );
    });
  });
});

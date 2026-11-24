// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { MonitoredLeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { EditSandboxSpacesSettings } from "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditSandboxSpacesSettings";
import { SANDBOX_SPACES_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useEnabledCatalogModels } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { createLeasePermissionProfile } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { ApiResponse } from "@amzn/innovation-sandbox-frontend/types";
import {
  expectNoMonitoringMessage,
  expectStaysOnMessage,
  expectTurnedOffMessage,
} from "@amzn/innovation-sandbox-frontend-test/utils/bedrockTokenMonitoringMessages";
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

vi.mock("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries");

const SONNET = "global.anthropic.claude-sonnet-4-6";
const HAIKU = "global.anthropic.claude-haiku";

const baseLease: MonitoredLeaseView = {
  uuid: "11111111-1111-4111-8111-111111111111",
  leaseId: "lease-123",
  userEmail: "user@example.com",
  status: "Active",
  awsAccountId: "123456789012",
  startDate: "2024-01-01T00:00:00.000Z",
  approvedBy: "manager@example.com",
  lastCheckedDate: "2024-01-01T00:00:00.000Z",
  originalLeaseTemplateName: "Test Template",
  originalLeaseTemplateUuid: crypto.randomUUID(),
  totalCostAccrued: 0,
  sandboxSpacesEnabled: false,
  allowOwnerToShareLease: false,
  selectableModels: [],
  ...createLeasePermissionProfile(),
};

const SANDBOX_SPACES_TOGGLE = {
  name: /^Sandbox Space (enabled|disabled) Enable Sandbox Space$/,
};

describe("EditSandboxSpacesSettings", () => {
  let submittedBody: Record<string, unknown> | undefined;

  const serveLease = (overrides: Partial<MonitoredLeaseView>) =>
    server.use(
      http.get(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json({
          status: "success",
          data: { ...baseLease, ...overrides },
        } as ApiResponse<MonitoredLeaseView>),
      ),
    );

  const renderPage = () =>
    renderWithQueryClient(
      <Router>
        <EditSandboxSpacesSettings />
      </Router>,
    );

  const mockCatalog = (haikuEnabled: boolean) => {
    const catalog = [
      {
        modelId: SONNET,
        displayName: "Claude Sonnet 4.6",
        provider: "Anthropic",
        availability: "global",
        enabled: true,
      },
      {
        modelId: HAIKU,
        displayName: "Claude Haiku",
        provider: "Anthropic",
        availability: "global",
        enabled: haikuEnabled,
      },
    ];
    vi.mocked(useEnabledCatalogModels).mockReturnValue({
      data: catalog.filter((model) => model.enabled),
      catalog,
      isLoading: false,
      isError: false,
      isSuccess: true,
    } as unknown as ReturnType<typeof useEnabledCatalogModels>);
  };

  const serveGlobalSetting = (
    sandboxSpacesEnabled: boolean,
    allowBedrockTokenMonitoring = false,
  ) =>
    server.use(
      http.get(`${getConfig().ApiUrl}/configurations`, () =>
        HttpResponse.json({
          status: "success",
          data: createConfiguration({
            agent: { sandboxSpacesEnabled },
            leases: { allowBedrockTokenMonitoring },
          }),
        }),
      ),
    );

  beforeEach(() => {
    vi.clearAllMocks();
    submittedBody = undefined;
    mockCatalog(true);
    serveGlobalSetting(true);
    server.use(
      http.patch(
        `${getConfig().ApiUrl}/leases/lease-123`,
        async ({ request }) => {
          submittedBody = (await request.json()) as Record<string, unknown>;
          return HttpResponse.json({ status: "success", data: {} });
        },
      ),
    );
  });

  it("uses the canonical lease name in the breadcrumb", async () => {
    serveLease({});
    renderPage();

    await waitFor(() => {
      expect(mockSetBreadcrumb).toHaveBeenCalledWith([
        { text: "Home", href: "/" },
        { text: "Leases", href: "/leases" },
        { text: "Test Template (11111111)", href: "/leases/lease-123" },
        { text: "Edit Sandbox Spaces", href: "" },
      ]);
    });
  });

  it("seeds the form from the lease's own settings", async () => {
    serveLease({ sandboxSpacesEnabled: true, allowedModelIds: [SONNET] });
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE)).toBeChecked();
    });
  });

  it("enables Sandbox Spaces with no subset, clearing models with null", async () => {
    serveLease({ sandboxSpacesEnabled: false });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      ).not.toBeChecked();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(submittedBody).toEqual({
        sandboxSpacesEnabled: true,
        allowedModelIds: null,
        defaultModelId: null,
        bedrockTokenMonitoringEnabled: true,
      });
    });
    expectNoMonitoringMessage();
    expect(showSuccessToast).toHaveBeenCalled();
    expect(mockNavigate).toHaveBeenCalledWith("/leases/lease-123");
  });

  it("disabling clears the lease's model selection and, while Allow Bedrock token monitoring is off, turns monitoring off", async () => {
    serveLease({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
      allowedModelIds: [SONNET],
      defaultModelId: SONNET,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE)).toBeChecked();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

    expectTurnedOffMessage();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(submittedBody).toEqual({
        sandboxSpacesEnabled: false,
        allowedModelIds: null,
        defaultModelId: null,
        bedrockTokenMonitoringEnabled: false,
      });
    });
  });

  it("saves monitoring off after Sandbox Spaces is turned on and off again while Allow Bedrock token monitoring is off", async () => {
    serveLease({
      sandboxSpacesEnabled: false,
      bedrockTokenMonitoringEnabled: true,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      ).not.toBeChecked();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

    expectTurnedOffMessage();
    const saveButton = screen.getByRole("button", { name: "Save changes" });
    await waitFor(() => expect(saveButton).toBeEnabled());
    await user.click(saveButton);

    await waitFor(() => {
      expect(submittedBody).toMatchObject({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      });
    });
  });

  it("disabling keeps monitoring on while Allow Bedrock token monitoring is on", async () => {
    serveGlobalSetting(true, true);
    serveLease({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE)).toBeChecked();
    });
    expectNoMonitoringMessage();
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

    expectStaysOnMessage();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(submittedBody).toMatchObject({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: true,
      });
    });
  });

  it("shows the server's error when the update is rejected", async () => {
    serveLease({ sandboxSpacesEnabled: false });
    server.use(
      http.patch(`${getConfig().ApiUrl}/leases/lease-123`, () =>
        HttpResponse.json(
          {
            status: "fail",
            data: {
              errors: [
                {
                  message:
                    "One or more selected models are not enabled in the model catalog.",
                },
              ],
            },
          },
          { status: 400 },
        ),
      ),
    );
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      ).not.toBeChecked();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(showErrorToast).toHaveBeenCalledWith(
        expect.stringContaining("not enabled in the model catalog"),
        "Update Failed",
      );
    });
    expect(mockNavigate).not.toHaveBeenCalled();
  });

  it("blocks a disabled default and saves the replacement", async () => {
    mockCatalog(false);
    serveLease({
      sandboxSpacesEnabled: true,
      bedrockTokenMonitoringEnabled: true,
      allowedModelIds: [HAIKU, SONNET],
      defaultModelId: HAIKU,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", {
        name: "Set Claude Sonnet 4.6 as default model",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(submittedBody).toEqual(
        expect.objectContaining({
          sandboxSpacesEnabled: true,
          defaultModelId: SONNET,
          bedrockTokenMonitoringEnabled: true,
        }),
      );
    });
  });

  it("turns Sandbox Spaces off even when the stored default is disabled", async () => {
    mockCatalog(false);
    serveLease({
      sandboxSpacesEnabled: true,
      allowedModelIds: [HAIKU],
      defaultModelId: HAIKU,
    });
    const user = userEvent.setup();
    renderPage();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => {
      expect(submittedBody).toEqual({
        sandboxSpacesEnabled: false,
        allowedModelIds: null,
        defaultModelId: null,
        bedrockTokenMonitoringEnabled: false,
      });
    });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  describe("with disabled models saved on the lease", () => {
    const OPUS = "global.anthropic.claude-opus";
    const NOVA = "us.amazon.nova-pro-v1";

    const mockMixedCatalog = () => {
      const catalog = [
        {
          modelId: SONNET,
          displayName: "Claude Sonnet 4.6",
          provider: "Anthropic",
          availability: "global",
          enabled: true,
        },
        {
          modelId: NOVA,
          displayName: "Nova Pro",
          provider: "Amazon",
          availability: "us-east-1",
          enabled: true,
        },
        {
          modelId: HAIKU,
          displayName: "Claude Haiku",
          provider: "Anthropic",
          availability: "global",
          enabled: false,
        },
        {
          modelId: OPUS,
          displayName: "Claude Opus",
          provider: "Anthropic",
          availability: "global",
          enabled: false,
        },
      ];
      vi.mocked(useEnabledCatalogModels).mockReturnValue({
        data: catalog.filter((model) => model.enabled),
        catalog,
        isLoading: false,
        isError: false,
        isSuccess: true,
      } as unknown as ReturnType<typeof useEnabledCatalogModels>);
    };

    it("lists every saved model and keeps disabled ones until they are removed", async () => {
      mockMixedCatalog();
      serveLease({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
        allowedModelIds: [HAIKU, SONNET, OPUS],
        defaultModelId: HAIKU,
      });
      const user = userEvent.setup();
      renderPage();

      expect(await screen.findByText("(3)")).toBeInTheDocument();
      expect(
        screen.getByRole("button", {
          name: "Warning: Claude Opus globally disabled",
        }),
      ).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", { name: "Remove Claude Opus" }),
      );
      await user.click(
        screen.getByRole("button", {
          name: "Set Claude Sonnet 4.6 as default model",
        }),
      );
      expect(
        screen.getByRole("button", {
          name: "Warning: Claude Haiku globally disabled",
        }),
      ).toBeInTheDocument();

      await user.click(screen.getByText("1 selected"));
      await user.click(
        within(screen.getByRole("listbox")).getByText("Nova Pro"),
      );
      expect(screen.getByText("(3)")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Save changes" }));
      await waitFor(() => {
        expect(submittedBody).toEqual({
          sandboxSpacesEnabled: true,
          allowedModelIds: [HAIKU, SONNET, NOVA],
          defaultModelId: SONNET,
          bedrockTokenMonitoringEnabled: true,
        });
      });
    });

    it("does not mark models disabled, and keeps Save disabled, when the catalog fails to load", async () => {
      vi.mocked(useEnabledCatalogModels).mockReturnValue({
        data: [],
        catalog: undefined,
        isLoading: false,
        isError: true,
        isSuccess: false,
      } as unknown as ReturnType<typeof useEnabledCatalogModels>);
      serveLease({
        sandboxSpacesEnabled: true,
        allowedModelIds: [SONNET],
        defaultModelId: SONNET,
      });
      const user = userEvent.setup();
      renderPage();

      expect(
        await screen.findByText("Models could not be loaded. Try again."),
      ).toBeInTheDocument();
      expect(screen.queryByText("Disabled")).not.toBeInTheDocument();
      expect(
        screen.queryByRole("button", { name: /^Remove / }),
      ).not.toBeInTheDocument();

      await user.click(
        screen.getByRole("checkbox", { name: /Limit available models/ }),
      );
      expect(
        screen.getByRole("button", { name: "Save changes" }),
      ).toBeDisabled();
    });
  });

  describe("while Sandbox Spaces is off globally", () => {
    it("lets a lease using Sandbox Spaces disable it while Sandbox Spaces is off globally, keeping monitoring on", async () => {
      serveGlobalSetting(false, true);
      serveLease({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
        allowedModelIds: [SONNET],
      });
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => {
        expect(
          screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
        ).toBeChecked();
      });
      expect(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE)).toBeEnabled();
      await expectGateNotice(
        user,
        "Sandbox Spaces",
        "info",
        gateOffInUse("Sandbox Spaces", "lease"),
      );

      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

      await expectGateNotice(
        user,
        "Sandbox Spaces",
        "warning",
        gateOffSwitchedOff("Sandbox Spaces"),
      );
      // The sentence about a template's existing leases is not shown here.
      expectStaysOnMessage();
      await user.click(screen.getByRole("button", { name: "Save changes" }));

      await waitFor(() => {
        expect(submittedBody).toMatchObject({
          sandboxSpacesEnabled: false,
          bedrockTokenMonitoringEnabled: true,
        });
      });
    });

    it("disables the toggle with an info icon on a lease not using Sandbox Spaces", async () => {
      serveGlobalSetting(false);
      serveLease({ sandboxSpacesEnabled: false });
      const user = userEvent.setup();
      renderPage();

      await waitFor(() => {
        expect(
          screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
        ).toBeDisabled();
      });
      expect(
        screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      ).not.toBeChecked();
      await expectGateNotice(
        user,
        "Sandbox Spaces",
        "info",
        gateOffUnused("Sandbox Spaces"),
      );
    });
  });
});

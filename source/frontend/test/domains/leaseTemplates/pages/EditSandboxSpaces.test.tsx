// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { EditSandboxSpaces } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditSandboxSpaces";
import { SANDBOX_SPACES_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { mockBasicLeaseTemplate } from "@amzn/innovation-sandbox-frontend/mocks/handlers/leaseTemplateHandlers";
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
  SANDBOX_SPACES_GATE_OFF_IN_USE,
  SANDBOX_SPACES_GATE_OFF_SWITCHED_OFF,
  SANDBOX_SPACES_GATE_OFF_UNUSED,
} from "@amzn/innovation-sandbox-frontend-test/utils/sandboxSpacesGate";

const mockNavigate = vi.fn();
const mockUuid = mockBasicLeaseTemplate.uuid;

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

const SANDBOX_SPACES_TOGGLE = {
  name: /^Sandbox Space (enabled|disabled) Enable Sandbox Space$/,
};

const ENABLED_MODEL = { modelId: "anthropic.claude-3-sonnet", name: "Sonnet" };
const DISABLED_MODEL = { modelId: "anthropic.claude-3-haiku", name: "Haiku" };
const OTHER_DISABLED_MODEL = {
  modelId: "anthropic.claude-3-opus",
  name: "Opus",
};
const OTHER_ENABLED_MODEL = { modelId: "amazon.nova-pro", name: "Nova Pro" };
// Saved on the template but no longer in the catalog.
const UNKNOWN_MODEL_ID = "retired.model-v1";

function catalogRow(model: typeof ENABLED_MODEL, enabled: boolean) {
  return {
    modelId: model.modelId,
    displayName: model.name,
    provider: "Anthropic",
    availability: "global",
    enabled,
    addedAt: "2026-09-01T12:00:00.000Z",
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: "2026-01-01T00:00:00.000Z",
      lastEditTime: "2026-09-01T12:00:00.000Z",
    },
  };
}

// `createLeaseTemplate()` randomizes sandboxSpacesEnabled; pin it so the initial
// toggle state (and thus the model-catalog fetch) is deterministic. The
// global setting defaults on so the section is authorable.
function pinTemplate(
  template: {
    sandboxSpacesEnabled?: boolean;
    allowedModelIds?: string[];
    defaultModelId?: string;
    bedrockTokenMonitoringEnabled?: boolean;
  } = {},
  options: {
    sandboxSpacesSetting?: boolean;
    allowBedrockTokenMonitoring?: boolean;
    /** Catalog rows to serve, or "error" for a failed catalog request. */
    catalog?: ReturnType<typeof catalogRow>[] | "error";
  } = {},
) {
  const catalog = options.catalog ?? [
    catalogRow(ENABLED_MODEL, true),
    catalogRow(DISABLED_MODEL, false),
  ];
  server.use(
    http.get(`${getConfig().ApiUrl}/leaseTemplates/${mockUuid}`, () =>
      HttpResponse.json({
        status: "success",
        data: {
          ...mockBasicLeaseTemplate,
          sandboxSpacesEnabled: false,
          allowedModelIds: [],
          defaultModelId: undefined,
          bedrockTokenMonitoringEnabled: false,
          ...template,
        },
      }),
    ),
    http.get(`${getConfig().ApiUrl}/configurations`, () =>
      HttpResponse.json({
        status: "success",
        data: createConfiguration({
          agent: {
            sandboxSpacesEnabled: options.sandboxSpacesSetting ?? true,
          },
          leases: {
            allowBedrockTokenMonitoring:
              options.allowBedrockTokenMonitoring ?? true,
          },
        }),
      }),
    ),
    http.get(`${getConfig().ApiUrl}/configurations/agent/models`, () =>
      catalog === "error"
        ? HttpResponse.json(
            { status: "error", message: "Internal server error" },
            { status: 500 },
          )
        : HttpResponse.json({
            status: "success",
            data: { models: catalog },
          }),
    ),
  );
}

function mockUpdate() {
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
  return submitSpy;
}

describe("EditSandboxSpaces", () => {
  beforeEach(() => {
    mockNavigate.mockClear();
    vi.clearAllMocks();
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <EditSandboxSpaces />
      </Router>,
    );

  test("renders the Sandbox Spaces edit form", async () => {
    pinTemplate();
    renderComponent();

    await waitFor(() => {
      expect(screen.getByText(/Edit Sandbox Spaces/i)).toBeInTheDocument();
    });
  });

  test("navigates back on cancel", async () => {
    pinTemplate();
    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Sandbox Spaces/i)).toBeInTheDocument();
    });

    await user.click(screen.getByRole("button", { name: /cancel/i }));
    expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
  });

  test("enabling Sandbox Spaces saves sandboxSpacesEnabled=true", async () => {
    pinTemplate();
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Sandbox Spaces/i)).toBeInTheDocument();
    });

    // Flip the enable toggle on (it starts disabled).
    await user.click(screen.getByRole("checkbox"));

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).not.toBeDisabled();
    });

    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(showSuccessToast).toHaveBeenCalledWith(
        "Sandbox Spaces settings updated successfully.",
      );
      expect(mockNavigate).toHaveBeenCalledWith(`/lease_templates/${mockUuid}`);
    });
    expect(submitSpy).toHaveBeenCalledWith(
      expect.objectContaining({ sandboxSpacesEnabled: true }),
    );
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  test("keeps the template's stored default model when saving", async () => {
    // Update replaces the whole template, so a default the page or client
    // fails to send is erased server-side.
    pinTemplate({
      sandboxSpacesEnabled: false,
      allowedModelIds: [],
      defaultModelId: ENABLED_MODEL.modelId,
    });
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(screen.getByText(/Edit Sandbox Spaces/i)).toBeInTheDocument();
    });
    await user.click(screen.getByRole("checkbox"));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          sandboxSpacesEnabled: true,
          defaultModelId: ENABLED_MODEL.modelId,
        }),
      );
    });
  });

  test("explains on load that none of the selected models are enabled", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [DISABLED_MODEL.modelId],
    });
    renderComponent();

    expect(
      await screen.findByText(
        SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_ENABLED_MODELS_SELECTED,
      ),
    ).toBeInTheDocument();
  });

  test("flags a disabled default and persists the replacement the manager picks", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [DISABLED_MODEL.modelId, ENABLED_MODEL.modelId],
      defaultModelId: DISABLED_MODEL.modelId,
    });
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByRole("button", {
        name: `Set ${ENABLED_MODEL.name} as default model`,
      }),
    );

    await waitFor(() => {
      expect(
        screen.getByRole("button", { name: /save changes/i }),
      ).not.toBeDisabled();
    });
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledWith(
        expect.objectContaining({ defaultModelId: ENABLED_MODEL.modelId }),
      );
    });
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  test("explains a disabled default when its Disabled label is opened", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [DISABLED_MODEL.modelId, ENABLED_MODEL.modelId],
      defaultModelId: DISABLED_MODEL.modelId,
    });

    renderComponent();
    const user = userEvent.setup();

    const trigger = await screen.findByRole("button", {
      name: `Warning: ${DISABLED_MODEL.name} globally disabled`,
    });
    await user.click(trigger);

    expect(
      await screen.findByText(
        SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_DETAILS,
      ),
    ).toBeInTheDocument();
  });

  test("removing a disabled default drops it from the selection", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [DISABLED_MODEL.modelId, ENABLED_MODEL.modelId],
      defaultModelId: DISABLED_MODEL.modelId,
    });
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });

    // The disabled default's row offers Remove, which clears the default and
    // drops the model from the selection.
    await user.click(
      screen.getByRole("button", { name: `Remove ${DISABLED_MODEL.name}` }),
    );

    await waitFor(() => {
      expect(
        screen.queryByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).not.toBeInTheDocument();
    });
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
    const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.sandboxSpacesEnabled).toBe(true);
    expect(sent.allowedModelIds).toEqual([ENABLED_MODEL.modelId]);
    expect(sent).not.toHaveProperty("defaultModelId");
  });

  test("turns Sandbox Spaces off even when the stored default is disabled", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [DISABLED_MODEL.modelId],
      defaultModelId: DISABLED_MODEL.modelId,
    });
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });
    await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
    const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.sandboxSpacesEnabled).toBe(false);
    expect(sent).not.toHaveProperty("allowedModelIds");
    expect(sent).not.toHaveProperty("defaultModelId");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  test("clears a disabled default when no model is selected", async () => {
    pinTemplate({
      sandboxSpacesEnabled: true,
      allowedModelIds: [],
      defaultModelId: DISABLED_MODEL.modelId,
    });
    const submitSpy = mockUpdate();

    renderComponent();
    const user = userEvent.setup();

    await waitFor(() => {
      expect(
        screen.getByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ),
      ).toBeInTheDocument();
    });
    await user.click(
      screen.getByRole("button", { name: `Remove ${DISABLED_MODEL.name}` }),
    );
    await user.click(screen.getByRole("button", { name: /save changes/i }));

    await waitFor(() => {
      expect(submitSpy).toHaveBeenCalledTimes(1);
    });
    const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
    expect(sent.sandboxSpacesEnabled).toBe(true);
    expect(sent).not.toHaveProperty("defaultModelId");
    expect(showErrorToast).not.toHaveBeenCalled();
  });

  describe("with disabled models saved on the template", () => {
    test("lists every saved model and saves what is left after Remove and Set as default", async () => {
      pinTemplate(
        {
          sandboxSpacesEnabled: true,
          bedrockTokenMonitoringEnabled: true,
          allowedModelIds: [
            DISABLED_MODEL.modelId,
            ENABLED_MODEL.modelId,
            OTHER_DISABLED_MODEL.modelId,
            UNKNOWN_MODEL_ID,
          ],
          defaultModelId: DISABLED_MODEL.modelId,
        },
        {
          catalog: [
            catalogRow(ENABLED_MODEL, true),
            catalogRow(DISABLED_MODEL, false),
            catalogRow(OTHER_DISABLED_MODEL, false),
          ],
        },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      expect(await screen.findByText("(4)")).toBeInTheDocument();
      expect(
        within(screen.getByRole("table")).getAllByRole("row"),
      ).toHaveLength(5);
      for (const name of [
        DISABLED_MODEL.name,
        OTHER_DISABLED_MODEL.name,
        UNKNOWN_MODEL_ID,
      ]) {
        expect(
          screen.getByRole("button", {
            name: `Warning: ${name} globally disabled`,
          }),
        ).toBeInTheDocument();
      }

      await user.click(
        screen.getByRole("button", {
          name: `Remove ${OTHER_DISABLED_MODEL.name}`,
        }),
      );
      expect(await screen.findByText("(3)")).toBeInTheDocument();

      await user.click(
        screen.getByRole("button", {
          name: `Set ${ENABLED_MODEL.name} as default model`,
        }),
      );
      // The former default stays listed, and removable, while it is saved.
      expect(
        screen.getByRole("button", {
          name: `Warning: ${DISABLED_MODEL.name} globally disabled`,
        }),
      ).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: `Remove ${DISABLED_MODEL.name}` }),
      ).toBeInTheDocument();
      expect(screen.getByText("(3)")).toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent.allowedModelIds).toEqual([
        DISABLED_MODEL.modelId,
        ENABLED_MODEL.modelId,
        UNKNOWN_MODEL_ID,
      ]);
      expect(sent.defaultModelId).toBe(ENABLED_MODEL.modelId);
    });

    test("keeps disabled models when Add models changes", async () => {
      pinTemplate(
        {
          sandboxSpacesEnabled: true,
          allowedModelIds: [
            ENABLED_MODEL.modelId,
            OTHER_DISABLED_MODEL.modelId,
          ],
          defaultModelId: ENABLED_MODEL.modelId,
        },
        {
          catalog: [
            catalogRow(ENABLED_MODEL, true),
            catalogRow(OTHER_ENABLED_MODEL, true),
            catalogRow(OTHER_DISABLED_MODEL, false),
          ],
        },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await user.click(await screen.findByText("1 selected"));
      const listbox = screen.getByRole("listbox");
      expect(
        within(listbox).queryByText(OTHER_DISABLED_MODEL.name),
      ).not.toBeInTheDocument();
      await user.click(within(listbox).getByText(OTHER_ENABLED_MODEL.name));

      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent.allowedModelIds).toEqual([
        ENABLED_MODEL.modelId,
        OTHER_DISABLED_MODEL.modelId,
        OTHER_ENABLED_MODEL.modelId,
      ]);
      expect(sent.defaultModelId).toBe(ENABLED_MODEL.modelId);
    });

    test("does not mark models disabled, and keeps Save disabled, when the catalog fails to load", async () => {
      pinTemplate(
        {
          sandboxSpacesEnabled: true,
          allowedModelIds: [ENABLED_MODEL.modelId],
          defaultModelId: ENABLED_MODEL.modelId,
        },
        { catalog: "error" },
      );
      renderComponent();
      const user = userEvent.setup();

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
        screen.getByRole("button", { name: /save changes/i }),
      ).toBeDisabled();
    });
  });

  describe("while Sandbox Spaces is turned off in Settings", () => {
    test("keeps the toggle disabled for a template not using Sandbox Spaces", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: false },
        { sandboxSpacesSetting: false },
      );
      renderComponent();
      const user = userEvent.setup();

      const toggle = await screen.findByRole("checkbox");
      expect(toggle).toBeDisabled();
      await expectSandboxSpacesGateNotice(
        user,
        "info",
        SANDBOX_SPACES_GATE_OFF_UNUSED,
      );
    });

    test("lets a template using Sandbox Spaces turn it off and keeps monitoring on", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        { sandboxSpacesSetting: false },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      // The config and template queries resolve independently, so wait for both.
      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeChecked();
        expect(screen.getByRole("checkbox")).toBeEnabled();
      });
      expect(screen.queryByText(/Selected models/)).not.toBeInTheDocument();
      await expectSandboxSpacesGateNotice(
        user,
        "info",
        SANDBOX_SPACES_GATE_OFF_IN_USE,
      );

      await user.click(screen.getByRole("checkbox"));
      await expectSandboxSpacesGateNotice(
        user,
        "warning",
        SANDBOX_SPACES_GATE_OFF_SWITCHED_OFF,
      );
      expectStaysOnMessage({ existingLeasesNote: true });

      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("keeps Save disabled when a template switches Sandbox Spaces off and back on", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        {
          sandboxSpacesSetting: false,
          allowBedrockTokenMonitoring: false,
        },
      );
      renderComponent();
      const user = userEvent.setup();
      const saveButton = () =>
        screen.getByRole("button", { name: /save changes/i });

      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeEnabled();
      });
      await user.click(screen.getByRole("checkbox"));
      await waitFor(() => {
        expect(saveButton()).not.toBeDisabled();
      });
      await user.click(screen.getByRole("checkbox"));

      expectNoMonitoringMessage();
      expect(saveButton()).toBeDisabled();
    });

    test("lets a template using Sandbox Spaces turn it off and turns monitoring off while its global setting is off", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        {
          sandboxSpacesSetting: false,
          allowBedrockTokenMonitoring: false,
        },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await waitFor(() => {
        expect(screen.getByRole("checkbox")).toBeEnabled();
      });
      await user.click(screen.getByRole("checkbox"));
      expectTurnedOffMessage({ existingLeasesNote: true });

      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      const sent = submitSpy.mock.calls[0]![0] as Record<string, unknown>;
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(false);
    });
  });

  describe("Bedrock token monitoring", () => {
    const saveAndGetSent = async (
      user: ReturnType<typeof userEvent.setup>,
      submitSpy: ReturnType<typeof mockUpdate>,
    ) => {
      await user.click(screen.getByRole("button", { name: /save changes/i }));
      await waitFor(() => {
        expect(submitSpy).toHaveBeenCalledTimes(1);
      });
      return submitSpy.mock.calls[0]![0] as Record<string, unknown>;
    };

    const waitForSandboxSpacesEnabled = () =>
      waitFor(() => {
        expect(
          screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
        ).toBeChecked();
      });

    test("shows no monitoring toggle or message for a template with Sandbox Spaces on", async () => {
      pinTemplate({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
      });
      renderComponent();

      await waitForSandboxSpacesEnabled();
      expectNoMonitoringToggle();
      expectNoMonitoringMessage();
      expect(
        screen.queryByRole("button", {
          name: /Sandbox Spaces globally disabled/,
        }),
      ).not.toBeInTheDocument();
    });

    test("enabling Sandbox Spaces saves monitoring on without showing a monitoring toggle", async () => {
      pinTemplate({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      });
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      );
      expectNoMonitoringToggle();
      expectNoMonitoringMessage();

      const sent = await saveAndGetSent(user, submitSpy);
      expect(sent.sandboxSpacesEnabled).toBe(true);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("disabling Sandbox Spaces leaves monitoring on and shows the stays-on message", async () => {
      pinTemplate({
        sandboxSpacesEnabled: true,
        bedrockTokenMonitoringEnabled: true,
      });
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await waitForSandboxSpacesEnabled();
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectStaysOnMessage();

      const sent = await saveAndGetSent(user, submitSpy);
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("switching Sandbox Spaces on and off leaves monitoring on to save", async () => {
      pinTemplate({
        sandboxSpacesEnabled: false,
        bedrockTokenMonitoringEnabled: false,
      });
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      );
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectStaysOnMessage();

      const sent = await saveAndGetSent(user, submitSpy);
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(true);
    });

    test("disabling Sandbox Spaces turns monitoring off while the global setting is off", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: true, bedrockTokenMonitoringEnabled: true },
        { allowBedrockTokenMonitoring: false },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await waitForSandboxSpacesEnabled();
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectTurnedOffMessage();

      const sent = await saveAndGetSent(user, submitSpy);
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(false);
    });

    test("keeps Save disabled when switching Sandbox Spaces on and off changes nothing", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: false },
        { allowBedrockTokenMonitoring: false },
      );
      renderComponent();
      const user = userEvent.setup();
      const saveButton = () =>
        screen.getByRole("button", { name: /save changes/i });

      await user.click(
        await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      );
      await waitFor(() => {
        expect(saveButton()).not.toBeDisabled();
      });
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

      expectTurnedOffMessage();
      expect(saveButton()).toBeDisabled();
    });

    test("switching Sandbox Spaces on and off turns saved monitoring off while the global setting is off", async () => {
      pinTemplate(
        { sandboxSpacesEnabled: false, bedrockTokenMonitoringEnabled: true },
        { allowBedrockTokenMonitoring: false },
      );
      const submitSpy = mockUpdate();
      renderComponent();
      const user = userEvent.setup();

      await user.click(
        await screen.findByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      );
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectTurnedOffMessage();

      const sent = await saveAndGetSent(user, submitSpy);
      expect(sent.sandboxSpacesEnabled).toBe(false);
      expect(sent.bedrockTokenMonitoringEnabled).toBe(false);
    });
  });
});

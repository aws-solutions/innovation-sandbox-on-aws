// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { zodResolver } from "@hookform/resolvers/zod";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { FormProvider, useForm, useWatch } from "react-hook-form";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  SandboxSpacesForm,
  SandboxSpacesFormValues,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesForm";
import {
  createSandboxSpacesEditValidationSchema,
  SANDBOX_SPACES_CONSTRAINTS,
  SandboxSpacesValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useEnabledCatalogModels } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import {
  expectNoMonitoringMessage,
  expectStaysOnMessage,
} from "@amzn/innovation-sandbox-frontend-test/utils/bedrockTokenMonitoringMessages";

vi.mock("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries");

const ANTHROPIC_MODEL = {
  modelId: "global.anthropic.claude-sonnet-4-6",
  displayName: "Claude Sonnet 4.6",
  provider: "Anthropic",
  availability: "global",
};

const AMAZON_MODEL = {
  modelId: "us.amazon.nova-pro-v1",
  displayName: "Nova Pro",
  provider: "Amazon",
  availability: "us-east-1",
};

const DISABLED_MODEL = {
  modelId: "us.meta.llama-retired",
  displayName: "Llama Retired",
  provider: "Meta",
  availability: "us-east-1",
};

const ENABLED_MODELS = [ANTHROPIC_MODEL, AMAZON_MODEL];
const CATALOG = [...ENABLED_MODELS, DISABLED_MODEL];

// Exposes the live form values so tests can assert what would be saved.
function FormValuesProbe() {
  const values = useWatch<SandboxSpacesFormValues>();
  return <output data-testid="form-values">{JSON.stringify(values)}</output>;
}

function formValues(): SandboxSpacesFormValues {
  return JSON.parse(
    screen.getByTestId("form-values").textContent ?? "{}",
  ) as SandboxSpacesFormValues;
}

function TestWrapper({
  defaultValues,
  sandboxSpacesSetting = true,
  validated = false,
}: {
  defaultValues?: Partial<SandboxSpacesFormValues>;
  sandboxSpacesSetting?: boolean;
  /** Apply the cross-field rules the pages use, not only the field types. */
  validated?: boolean;
}) {
  const methods = useForm<SandboxSpacesFormValues>({
    resolver: zodResolver(
      validated
        ? createSandboxSpacesEditValidationSchema({})
        : SandboxSpacesValidationSchema,
    ),
    mode: "all",
    defaultValues: {
      sandboxSpacesEnabled: false,
      allowedModelIds: [],
      defaultModelId: undefined,
      ...defaultValues,
    },
  });

  return (
    <FormProvider {...methods}>
      <SandboxSpacesForm
        sandboxSpacesSetting={sandboxSpacesSetting}
        variant="template"
        monitoring={{
          allowBedrockTokenMonitoring: true,
          sandboxSpacesTurnedOff: false,
          onSandboxSpacesTurnedOff: () => {},
        }}
      />
      <FormValuesProbe />
    </FormProvider>
  );
}

// Holds the turned-off flag the way the lease template pages do.
function TokenMonitoringWrapper({
  defaultValues,
}: {
  defaultValues: Partial<SandboxSpacesFormValues>;
}) {
  const methods = useForm<SandboxSpacesFormValues>({
    defaultValues: {
      sandboxSpacesEnabled: false,
      allowedModelIds: [],
      defaultModelId: undefined,
      bedrockTokenMonitoringEnabled: false,
      ...defaultValues,
    },
  });
  const [sandboxSpacesTurnedOff, setSandboxSpacesTurnedOff] = useState(false);

  return (
    <FormProvider {...methods}>
      <SandboxSpacesForm
        sandboxSpacesSetting={true}
        variant="template"
        monitoring={{
          allowBedrockTokenMonitoring: true,
          sandboxSpacesTurnedOff,
          onSandboxSpacesTurnedOff: () => setSandboxSpacesTurnedOff(true),
        }}
      />
    </FormProvider>
  );
}

const SANDBOX_SPACES_TOGGLE = {
  name: /^Sandbox Space (enabled|disabled) Enable Sandbox Space$/,
};
const LIMIT_MODELS_TOGGLE = { name: /Limit available models/ };

const setAsDefault = (model: { displayName: string }) =>
  screen.getByRole("button", {
    name: `Set ${model.displayName} as default model`,
  });
const removeButton = (model: { displayName: string }) =>
  screen.getByRole("button", { name: `Remove ${model.displayName}` });
const modelsTable = () => screen.getByRole("table");

describe("SandboxSpacesForm", () => {
  beforeEach(() => {
    localStorage.clear();
    vi.mocked(useEnabledCatalogModels).mockReturnValue({
      data: ENABLED_MODELS,
      catalog: CATALOG,
      isLoading: false,
      isError: false,
      isSuccess: true,
    } as unknown as ReturnType<typeof useEnabledCatalogModels>);
  });

  describe("About Sandbox Spaces", () => {
    const aboutToggle = () =>
      screen.getByRole("button", { name: "About Sandbox Spaces" });

    it("starts expanded, and can be collapsed and expanded again", async () => {
      const user = userEvent.setup();
      render(<TestWrapper />);

      expect(aboutToggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Governed by the lease")).toBeVisible();

      await user.click(aboutToggle());
      expect(aboutToggle()).toHaveAttribute("aria-expanded", "false");

      await user.click(aboutToggle());
      expect(aboutToggle()).toHaveAttribute("aria-expanded", "true");
      expect(screen.getByText("Governed by the lease")).toBeVisible();
    });

    it("remembers the collapsed or expanded state on later visits", async () => {
      const user = userEvent.setup();
      const { unmount } = render(<TestWrapper />);
      await user.click(aboutToggle());
      unmount();

      const { unmount: unmountCollapsed } = render(<TestWrapper />);
      // Still there to reopen, just collapsed.
      expect(aboutToggle()).toHaveAttribute("aria-expanded", "false");
      await user.click(aboutToggle());
      unmountCollapsed();

      render(<TestWrapper />);
      expect(aboutToggle()).toHaveAttribute("aria-expanded", "true");
    });
  });

  it("shows only the enable toggle when Sandbox Spaces is disabled", () => {
    render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: false }} />);

    expect(
      screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
    ).not.toBeChecked();
    expect(screen.queryByText("Models")).not.toBeInTheDocument();
    expect(
      screen.queryByRole("checkbox", LIMIT_MODELS_TOGGLE),
    ).not.toBeInTheDocument();
  });

  it("only fetches the catalog when Sandbox Spaces is enabled", () => {
    render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: false }} />);
    expect(vi.mocked(useEnabledCatalogModels)).toHaveBeenCalledWith({
      enabled: false,
    });

    vi.mocked(useEnabledCatalogModels).mockClear();
    render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />);
    expect(vi.mocked(useEnabledCatalogModels)).toHaveBeenCalledWith({
      enabled: true,
    });
  });

  describe("with every enabled model available", () => {
    it("lists every enabled model with a count, and no Add models or Remove", () => {
      render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />);

      expect(
        screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE),
      ).not.toBeChecked();
      expect(screen.getByText("All enabled models")).toBeInTheDocument();
      expect(
        screen.getByText(`(${ENABLED_MODELS.length})`),
      ).toBeInTheDocument();
      expect(screen.queryByText("Add models")).not.toBeInTheDocument();
      for (const model of ENABLED_MODELS) {
        expect(
          within(modelsTable()).getByText(model.displayName),
        ).toBeInTheDocument();
        expect(
          within(modelsTable()).getByText(model.modelId),
        ).toBeInTheDocument();
      }
      expect(
        screen.queryByRole("button", { name: /^Remove / }),
      ).not.toBeInTheDocument();
    });

    it("sets the default from the table and shows it first with a badge", async () => {
      const user = userEvent.setup();
      render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />);

      await user.click(setAsDefault(AMAZON_MODEL));

      expect(formValues().defaultModelId).toBe(AMAZON_MODEL.modelId);
      expect(formValues().allowedModelIds).toEqual([]);
      const firstRow = within(modelsTable()).getAllByRole("row")[1]!;
      expect(
        within(firstRow).getByText(AMAZON_MODEL.displayName),
      ).toBeVisible();
      expect(within(firstRow).getByText("Default")).toBeVisible();
      expect(
        screen.queryByRole("button", {
          name: `Set ${AMAZON_MODEL.displayName} as default model`,
        }),
      ).not.toBeInTheDocument();
    });
  });

  describe("limiting the available models", () => {
    it("turning the limit on keeps the chosen default selected", async () => {
      const user = userEvent.setup();
      render(
        <TestWrapper
          defaultValues={{
            sandboxSpacesEnabled: true,
            defaultModelId: AMAZON_MODEL.modelId,
          }}
        />,
      );

      await user.click(screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE));

      expect(screen.getByText("Selected models only")).toBeInTheDocument();
      expect(screen.getByText("Add models")).toBeInTheDocument();
      expect(formValues().allowedModelIds).toEqual([AMAZON_MODEL.modelId]);
      expect(
        within(modelsTable()).queryByText(ANTHROPIC_MODEL.displayName),
      ).not.toBeInTheDocument();
    });

    it("starts limited when the template already has a selection", () => {
      render(
        <TestWrapper
          defaultValues={{
            sandboxSpacesEnabled: true,
            allowedModelIds: [ANTHROPIC_MODEL.modelId],
            defaultModelId: ANTHROPIC_MODEL.modelId,
          }}
        />,
      );

      expect(screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE)).toBeChecked();
      expect(screen.getByText("1 selected")).toBeInTheDocument();
      expect(screen.getByText("(1)")).toBeInTheDocument();
    });

    it("sources Add models from the enabled catalog, grouped by provider, and defaults to the first pick", async () => {
      const user = userEvent.setup();
      render(<TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />);
      await user.click(screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE));

      await user.click(screen.getByText("Search and add models"));
      const listbox = screen.getByRole("listbox");
      expect(within(listbox).getByText("Anthropic")).toBeInTheDocument();
      expect(within(listbox).getByText("Amazon")).toBeInTheDocument();
      expect(
        within(listbox).queryByText(DISABLED_MODEL.displayName),
      ).not.toBeInTheDocument();

      await user.click(within(listbox).getByText(ANTHROPIC_MODEL.displayName));

      expect(formValues().allowedModelIds).toEqual([ANTHROPIC_MODEL.modelId]);
      expect(formValues().defaultModelId).toBe(ANTHROPIC_MODEL.modelId);
    });

    it("removes a selected model that is not the default", async () => {
      const user = userEvent.setup();
      render(
        <TestWrapper
          defaultValues={{
            sandboxSpacesEnabled: true,
            allowedModelIds: [ANTHROPIC_MODEL.modelId, AMAZON_MODEL.modelId],
            defaultModelId: ANTHROPIC_MODEL.modelId,
          }}
        />,
      );

      expect(
        screen.queryByRole("button", {
          name: `Remove ${ANTHROPIC_MODEL.displayName}`,
        }),
      ).not.toBeInTheDocument();
      await user.click(removeButton(AMAZON_MODEL));

      expect(formValues().allowedModelIds).toEqual([ANTHROPIC_MODEL.modelId]);
      expect(formValues().defaultModelId).toBe(ANTHROPIC_MODEL.modelId);
    });

    it("shows an error when the limit is turned on with no models selected", async () => {
      const user = userEvent.setup();
      render(
        <TestWrapper
          validated
          defaultValues={{ sandboxSpacesEnabled: true }}
        />,
      );

      await user.click(screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE));

      expect(
        await screen.findByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_MODELS_SELECTED,
        ),
      ).toBeInTheDocument();
      expect(formValues().limitModels).toBe(true);
      expect(formValues().allowedModelIds).toEqual([]);
    });

    it("shows an error when every selected model is deselected, and clears it when one is added back", async () => {
      const user = userEvent.setup();
      render(
        <TestWrapper
          validated
          defaultValues={{
            sandboxSpacesEnabled: true,
            allowedModelIds: [ANTHROPIC_MODEL.modelId],
            defaultModelId: ANTHROPIC_MODEL.modelId,
            limitModels: true,
          }}
        />,
      );

      await user.click(screen.getByText("1 selected"));
      const listbox = screen.getByRole("listbox");
      await user.click(within(listbox).getByText(ANTHROPIC_MODEL.displayName));

      expect(
        await screen.findByText(
          SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_MODELS_SELECTED,
        ),
      ).toBeInTheDocument();
      expect(formValues().allowedModelIds).toEqual([]);

      await user.click(within(listbox).getByText(AMAZON_MODEL.displayName));
      expect(
        screen.queryByText(SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_MODELS_SELECTED),
      ).not.toBeInTheDocument();
    });

    it("turning the limit off clears the selection and keeps the default", async () => {
      const user = userEvent.setup();
      render(
        <TestWrapper
          defaultValues={{
            sandboxSpacesEnabled: true,
            allowedModelIds: [ANTHROPIC_MODEL.modelId],
            defaultModelId: ANTHROPIC_MODEL.modelId,
          }}
        />,
      );

      await user.click(screen.getByRole("checkbox", LIMIT_MODELS_TOGGLE));

      expect(formValues().allowedModelIds).toEqual([]);
      expect(formValues().defaultModelId).toBe(ANTHROPIC_MODEL.modelId);
      expect(
        within(modelsTable()).getByText(AMAZON_MODEL.displayName),
      ).toBeInTheDocument();
    });
  });

  it("shows model loading and error states", async () => {
    vi.mocked(useEnabledCatalogModels).mockReturnValue({
      data: [],
      catalog: [],
      isLoading: true,
      isError: false,
    } as unknown as ReturnType<typeof useEnabledCatalogModels>);
    const { rerender } = render(
      <TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />,
    );
    expect(await screen.findByText("Loading models")).toBeInTheDocument();

    vi.mocked(useEnabledCatalogModels).mockReturnValue({
      data: [],
      catalog: [],
      isLoading: false,
      isError: true,
    } as unknown as ReturnType<typeof useEnabledCatalogModels>);
    rerender(<TestWrapper defaultValues={{ sandboxSpacesEnabled: true }} />);
    expect(
      await screen.findByText("Models could not be loaded. Try again."),
    ).toBeInTheDocument();
  });

  it("flags a stored default that is no longer enabled and lets it be removed", async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper
        defaultValues={{
          sandboxSpacesEnabled: true,
          allowedModelIds: [DISABLED_MODEL.modelId, ANTHROPIC_MODEL.modelId],
          defaultModelId: DISABLED_MODEL.modelId,
        }}
      />,
    );

    expect(
      within(modelsTable()).getByText(DISABLED_MODEL.displayName),
    ).toBeInTheDocument();
    expect(within(modelsTable()).getByText("Disabled")).toBeInTheDocument();

    await user.click(removeButton(DISABLED_MODEL));

    expect(formValues().defaultModelId).toBeUndefined();
    expect(formValues().allowedModelIds).toEqual([ANTHROPIC_MODEL.modelId]);
    expect(
      within(modelsTable()).queryByText(DISABLED_MODEL.displayName),
    ).not.toBeInTheDocument();
  });

  it("explains a disabled model that is not the default when its Disabled label is opened", async () => {
    const user = userEvent.setup();
    render(
      <TestWrapper
        defaultValues={{
          sandboxSpacesEnabled: true,
          allowedModelIds: [ANTHROPIC_MODEL.modelId, DISABLED_MODEL.modelId],
          defaultModelId: ANTHROPIC_MODEL.modelId,
        }}
      />,
    );

    await user.click(
      screen.getByRole("button", {
        name: `Warning: ${DISABLED_MODEL.displayName} globally disabled`,
      }),
    );

    expect(
      await screen.findByText(
        SANDBOX_SPACES_CONSTRAINTS.MODEL_DISABLED_DETAILS,
      ),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(
        SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_DETAILS,
      ),
    ).not.toBeInTheDocument();
  });

  it("lists disabled models right after the default", () => {
    render(
      <TestWrapper
        defaultValues={{
          sandboxSpacesEnabled: true,
          allowedModelIds: [
            ANTHROPIC_MODEL.modelId,
            AMAZON_MODEL.modelId,
            DISABLED_MODEL.modelId,
          ],
          defaultModelId: ANTHROPIC_MODEL.modelId,
        }}
      />,
    );

    const rows = within(modelsTable()).getAllByRole("row").slice(1);
    expect(
      within(rows[0]!).getByText(ANTHROPIC_MODEL.displayName),
    ).toBeVisible();
    expect(
      within(rows[1]!).getByText(DISABLED_MODEL.displayName),
    ).toBeVisible();
    expect(within(rows[2]!).getByText(AMAZON_MODEL.displayName)).toBeVisible();
  });

  it("returns to the first page when a model on a later page is set as default", async () => {
    const manyModels = Array.from({ length: 12 }, (_, index) => ({
      modelId: `us.amazon.model-${index + 1}`,
      displayName: `Model ${index + 1}`,
      provider: "Amazon",
      availability: "us-east-1",
    }));
    vi.mocked(useEnabledCatalogModels).mockReturnValue({
      data: manyModels,
      catalog: manyModels,
      isLoading: false,
      isError: false,
      isSuccess: true,
    } as unknown as ReturnType<typeof useEnabledCatalogModels>);
    const user = userEvent.setup();
    render(
      <TestWrapper
        defaultValues={{
          sandboxSpacesEnabled: true,
          defaultModelId: manyModels[0]!.modelId,
        }}
      />,
    );

    await user.click(screen.getByRole("button", { name: "2" }));
    await user.click(setAsDefault(manyModels[11]!));

    expect(formValues().defaultModelId).toBe(manyModels[11]!.modelId);
    const firstRow = within(modelsTable()).getAllByRole("row")[1]!;
    expect(within(firstRow).getByText("Model 12")).toBeVisible();
    expect(within(firstRow).getByText("Default")).toBeVisible();
  });

  describe("when Sandbox Spaces is turned off in Settings", () => {
    it("disables the toggle and does not fetch the catalog", () => {
      render(
        <TestWrapper
          sandboxSpacesSetting={false}
          defaultValues={{ sandboxSpacesEnabled: false }}
        />,
      );

      expect(
        screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE),
      ).toBeDisabled();
      expect(vi.mocked(useEnabledCatalogModels)).toHaveBeenCalledWith({
        enabled: false,
      });
    });

    it("still shows an already-enabled template as enabled without model controls", () => {
      render(
        <TestWrapper
          sandboxSpacesSetting={false}
          defaultValues={{
            sandboxSpacesEnabled: true,
            allowedModelIds: [ANTHROPIC_MODEL.modelId],
          }}
        />,
      );

      const toggle = screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE);
      expect(toggle).toBeChecked();
      expect(toggle).toBeDisabled();
      expect(
        screen.queryByRole("checkbox", LIMIT_MODELS_TOGGLE),
      ).not.toBeInTheDocument();
    });
  });

  describe("Bedrock token monitoring", () => {
    it("shows no message while Sandbox Spaces stays off", () => {
      render(
        <TokenMonitoringWrapper
          defaultValues={{ bedrockTokenMonitoringEnabled: true }}
        />,
      );

      expectNoMonitoringMessage();
    });

    it("shows no stays-on message when monitoring is already off", async () => {
      const user = userEvent.setup();
      render(
        <TokenMonitoringWrapper
          defaultValues={{
            sandboxSpacesEnabled: true,
            bedrockTokenMonitoringEnabled: false,
          }}
        />,
      );

      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));

      expectNoMonitoringMessage();
    });

    it("hides the stays-on message when Sandbox Spaces is turned back on", async () => {
      const user = userEvent.setup();
      render(<TokenMonitoringWrapper defaultValues={{}} />);

      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectStaysOnMessage();

      await user.click(screen.getByRole("checkbox", SANDBOX_SPACES_TOGGLE));
      expectNoMonitoringMessage();
    });
  });
});

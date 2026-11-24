// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  ColumnLayout,
  Container,
  ExpandableSection,
  ExpandableSectionProps,
  FormField,
  Header,
  Icon,
  IconProps,
  Link,
  LiveRegion,
  Multiselect,
  MultiselectProps,
  SelectProps,
  SpaceBetween,
  Toggle,
  ToggleProps,
} from "@cloudscape-design/components";
import { type ReactNode, useMemo, useState } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import ToggleField from "@amzn/innovation-sandbox-frontend/components/FormFields/ToggleField";
import { globalGateIcon } from "@amzn/innovation-sandbox-frontend/components/Forms/GlobalGateIcon";
import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";
import {
  SandboxSpacesModel,
  SandboxSpacesModelRow,
  SandboxSpacesModelsTable,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/SandboxSpacesModelsTable";
import { useEnabledCatalogModels } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { BEDROCK_TOKEN_MONITORING_HREF } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";

export interface SandboxSpacesFormValues {
  sandboxSpacesEnabled: boolean;
  allowedModelIds: string[];
  defaultModelId?: string;
  bedrockTokenMonitoringEnabled?: boolean;
  /** Form-only: users are limited to `allowedModelIds`. Not saved. */
  limitModels?: boolean;
}

/**
 * Lease template and lease forms turn Bedrock token monitoring on with Sandbox
 * Spaces, and let a template or lease already using Sandbox Spaces switch it
 * off while it is globally disabled. The page holds `sandboxSpacesTurnedOff` so
 * the monitoring messages stay visible across wizard steps until the form is
 * saved or left.
 */
export interface SandboxSpacesMonitoringOptions {
  /** The allowBedrockTokenMonitoring global setting */
  allowBedrockTokenMonitoring: boolean;
  /** The saved Sandbox Spaces value; undefined when creating a template. */
  persistedSandboxSpacesEnabled?: boolean;
  sandboxSpacesTurnedOff: boolean;
  onSandboxSpacesTurnedOff: () => void;
}

interface MonitoringMessageText {
  header: string;
  /** Plain text, for the live region. */
  body: string;
  /** Shown in the alert; defaults to `body`. */
  content?: ReactNode;
}

const MONITORING_STAYS_ON: MonitoringMessageText = {
  header: "Bedrock token monitoring stays on",
  body: "Bedrock token monitoring stays on when you disable Sandbox Spaces. You can turn it off in the budget settings.",
};

// The setting link opens a new tab so the form's unsaved changes are kept.
const MONITORING_TURNED_OFF: MonitoringMessageText = {
  header: "Bedrock token monitoring turned off",
  body: "Bedrock token monitoring is turned off when you disable Sandbox Spaces, because Allow Bedrock token monitoring is off in Settings.",
  content: (
    <>
      Bedrock token monitoring is turned off when you disable Sandbox Spaces,
      because{" "}
      <Link
        external
        href={BEDROCK_TOKEN_MONITORING_HREF}
        variant="primary"
        fontSize="inherit"
      >
        Allow Bedrock token monitoring
      </Link>{" "}
      is off in Settings.
    </>
  ),
};

/**
 * An info alert about a change the Sandbox Spaces toggle made to monitoring,
 * which has no control on this step. The hidden live region announces it to
 * screen readers when it appears.
 */
function MonitoringMessage({
  message,
  existingLeasesNote,
}: Readonly<{
  message: MonitoringMessageText;
  existingLeasesNote: string;
}>) {
  return (
    <>
      <Alert type="info" header={message.header}>
        {message.content ?? message.body}
        {existingLeasesNote}
      </Alert>
      <LiveRegion hidden>
        {`${message.header}. ${message.body}${existingLeasesNote}`}
      </LiveRegion>
    </>
  );
}

// The enable-toggle description names what the form edits: a template or one lease.
const SANDBOX_SPACE_DESCRIPTIONS: Record<SettingsFormVariant, string> = {
  template:
    "When enabled, every lease created from this template is provisioned with a Sandbox Space.",
  lease: "When enabled, this lease is provisioned with a Sandbox Space.",
};

const ABOUT_COLLAPSED_STORAGE_KEY = "isb.sandboxSpaces.aboutCollapsed";

const ABOUT_SANDBOX_SPACES: {
  icon: IconProps.Name;
  title: string;
  body: string;
}[] = [
  {
    icon: "gen-ai",
    title: "Build and experiment with natural language",
    body: "Users describe what they want and the sandbox agent creates, deploys and operates real AWS resources in their sandbox account. Get building immediately, nothing to install or configure.",
  },
  {
    icon: "lock-private",
    title: "Runs in your AWS environment",
    body: "The agent and its models run on Amazon Bedrock inside your own AWS environment, not a third-party AI service. Data stays within your AWS accounts and off users' laptops, and is handled under your existing AWS agreements. Prompts aren't shared with model providers or used to train their models.",
  },
  {
    icon: "security",
    title: "Governed by the lease",
    body: "The agent acts within the user's permission set, model usage counts against the lease budget, and the agent's memory is deleted when the lease is terminated (conversation history expires after 30 days).",
  },
];

function readAboutCollapsed(): boolean {
  try {
    return (
      globalThis.localStorage?.getItem(ABOUT_COLLAPSED_STORAGE_KEY) === "1"
    );
  } catch {
    return false;
  }
}

/** An overview of Sandbox Spaces that can be collapsed and expanded; the choice persists. */
function AboutSandboxSpaces() {
  const [expanded, setExpanded] = useState(() => !readAboutCollapsed());

  const handleChange: ExpandableSectionProps["onChange"] = ({ detail }) => {
    setExpanded(detail.expanded);
    try {
      globalThis.localStorage?.setItem(
        ABOUT_COLLAPSED_STORAGE_KEY,
        detail.expanded ? "0" : "1",
      );
    } catch {
      // Storage may be unavailable (private mode); the choice lasts until reload.
    }
  };

  return (
    <ExpandableSection
      variant="container"
      headerText="About Sandbox Spaces"
      expanded={expanded}
      onChange={handleChange}
    >
      <ColumnLayout columns={3} borders="vertical">
        {ABOUT_SANDBOX_SPACES.map(({ icon, title, body }) => (
          <SpaceBetween key={title} size="s">
            <Icon name={icon} size="medium" />
            <Box variant="h3" padding="n">
              {title}
            </Box>
            <Box color="text-body-secondary">{body}</Box>
          </SpaceBetween>
        ))}
      </ColumnLayout>
    </ExpandableSection>
  );
}

const UNGROUPED_PROVIDER_LABEL = "Other";

function toModelOption(model: SandboxSpacesModel): SelectProps.Option {
  return {
    label: model.displayName,
    value: model.modelId,
    description: [model.provider, model.availability]
      .filter(Boolean)
      .join(" · "),
  };
}

/**
 * Groups options into Cloudscape OptionGroups by provider, preserving the
 * catalog's model order within each group and the first-seen order of
 * providers. Rows without a provider fall into a trailing "Other" group.
 */
function groupByProvider(
  models: SandboxSpacesModel[],
): MultiselectProps.Options {
  const groups = new Map<string, SelectProps.Option[]>();
  for (const model of models) {
    const provider = model.provider || UNGROUPED_PROVIDER_LABEL;
    const bucket = groups.get(provider) ?? [];
    bucket.push(toModelOption(model));
    groups.set(provider, bucket);
  }
  return Array.from(groups.entries()).map(([provider, options]) => ({
    label: provider,
    options,
  }));
}

/** A saved model's table entry, named from the catalog when it is listed there. */
function toStoredModel(
  modelId: string,
  catalog: SandboxSpacesModel[] | undefined,
): SandboxSpacesModel {
  const entry = catalog?.find((model) => model.modelId === modelId);
  return {
    modelId,
    displayName: entry?.displayName ?? modelId,
    provider: entry?.provider ?? "",
    availability: entry?.availability ?? "",
  };
}

/** Table rows: the default, then disabled models, then the rest. */
function toModelRows(
  offeredModels: SandboxSpacesModel[],
  disabledModels: SandboxSpacesModel[],
  defaultModelId: string | undefined,
): SandboxSpacesModelRow[] {
  const rows = [
    ...offeredModels.map((model) => ({ model, isDisabled: false })),
    ...disabledModels.map((model) => ({ model, isDisabled: true })),
  ].map((row) => ({ ...row, isDefault: row.model.modelId === defaultModelId }));
  // Disabled models sort to the first page so they are seen and removed.
  const rank = (row: SandboxSpacesModelRow) => {
    if (row.isDefault) return 0;
    if (row.isDisabled) return 1;
    return 2;
  };
  return rows.sort((a, b) => rank(a) - rank(b));
}

export function SandboxSpacesForm({
  sandboxSpacesSetting,
  variant,
  monitoring,
}: Readonly<{
  /** The global `agent.sandboxSpacesEnabled` setting; undefined while loading. */
  sandboxSpacesSetting: boolean | undefined;
  variant: SettingsFormVariant;
  monitoring: SandboxSpacesMonitoringOptions;
}>) {
  const {
    control,
    setValue,
    trigger,
    formState: { errors },
  } = useFormContext<SandboxSpacesFormValues>();
  const sandboxSpacesEnabled = useWatch({
    control,
    name: "sandboxSpacesEnabled",
  });
  const allowedModelIds = useWatch({ control, name: "allowedModelIds" });
  const defaultModelId = useWatch({ control, name: "defaultModelId" });
  const bedrockTokenMonitoringEnabled = useWatch({
    control,
    name: "bedrockTokenMonitoringEnabled",
  });
  const limitModelsValue = useWatch({ control, name: "limitModels" });

  const setBedrockTokenMonitoringEnabled = (enabled: boolean) => {
    setValue("bedrockTokenMonitoringEnabled", enabled, { shouldDirty: true });
  };

  // Switching Sandbox Spaces on turns monitoring on. Switching it off leaves
  // monitoring on only while the global setting allows it.
  const handleSandboxSpacesChange: ToggleProps["onChange"] = ({ detail }) => {
    if (detail.checked) {
      setBedrockTokenMonitoringEnabled(true);
      return;
    }
    if (!monitoring.allowBedrockTokenMonitoring) {
      setBedrockTokenMonitoringEnabled(false);
    }
    monitoring.onSandboxSpacesTurnedOff();
  };

  const globallyEnabled = sandboxSpacesSetting === true;
  // A template or lease already using Sandbox Spaces keeps a live toggle while
  // it is globally disabled, so it can be switched off; turning it on again
  // needs the global setting.
  const toggleDisabled =
    !globallyEnabled && !monitoring.persistedSandboxSpacesEnabled;

  const turnedOffInThisForm =
    monitoring.sandboxSpacesTurnedOff && !sandboxSpacesEnabled;
  const showMonitoringStaysOn =
    turnedOffInThisForm && !!bedrockTokenMonitoringEnabled;
  const showMonitoringTurnedOff =
    turnedOffInThisForm && !monitoring.allowBedrockTokenMonitoring;
  const existingLeasesNote =
    globallyEnabled || variant !== "template"
      ? ""
      : " Existing leases from this template keep their current settings.";

  const showModelControls = sandboxSpacesEnabled && globallyEnabled;

  // Only enabled, persisted catalog rows are selectable here — a template can
  // never allow a model an admin has not curated and enabled globally.
  const {
    data: enabledModels,
    catalog,
    isLoading,
    isError,
    isSuccess,
  } = useEnabledCatalogModels({ enabled: showModelControls });

  const selectedIds = allowedModelIds ?? [];

  // An empty selection allows every enabled model, so "limit" is a form-only
  // field; validation rejects limiting to no models. Forms seed it from the
  // stored selection.
  const limitModels = limitModelsValue ?? selectedIds.length > 0;

  const availableOptionGroups = useMemo(
    () => groupByProvider(enabledModels),
    [enabledModels],
  );

  // The models selected on this template, in catalog order.
  const selectedModels = useMemo(
    () => enabledModels.filter((model) => selectedIds.includes(model.modelId)),
    [enabledModels, selectedIds],
  );

  const enabledIds = useMemo(
    () => new Set(enabledModels.map((model) => model.modelId)),
    [enabledModels],
  );

  // Only a loaded catalog can say a model is disabled; until then none are.
  const disabledModels = useMemo(() => {
    if (!isSuccess) {
      return [];
    }
    const ids = limitModels
      ? selectedIds.filter((id) => !enabledIds.has(id))
      : [];
    if (
      defaultModelId !== undefined &&
      !enabledIds.has(defaultModelId) &&
      !ids.includes(defaultModelId)
    ) {
      ids.push(defaultModelId);
    }
    return ids.map((id) => toStoredModel(id, catalog));
  }, [
    isSuccess,
    limitModels,
    selectedIds,
    enabledIds,
    defaultModelId,
    catalog,
  ]);

  const offeredModels = limitModels ? selectedModels : enabledModels;
  const modelRows = useMemo(
    () => toModelRows(offeredModels, disabledModels, defaultModelId),
    [offeredModels, disabledModels, defaultModelId],
  );

  const setAllowedModelIds = (ids: string[]) => {
    setValue("allowedModelIds", ids, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const setDefaultModelId = (modelId: string | undefined) => {
    setValue("defaultModelId", modelId, {
      shouldDirty: true,
      shouldValidate: true,
    });
  };

  const handleLimitChange: ToggleProps["onChange"] = ({ detail }) => {
    setValue("limitModels", detail.checked, { shouldDirty: true });
    if (detail.checked) {
      // Keep a chosen default valid: it must be one of the selected models.
      if (defaultModelId !== undefined && selectedIds.length === 0) {
        setAllowedModelIds([defaultModelId]);
      } else {
        void trigger("allowedModelIds");
      }
      return;
    }
    // Every enabled model is offered; the default stays.
    setAllowedModelIds([]);
  };

  const handleSelectionChange: MultiselectProps["onChange"] = ({ detail }) => {
    const pickedIds = detail.selectedOptions
      .map((option) => option.value)
      .filter((value): value is string => value !== undefined);
    // Disabled models are not options here, so a change keeps them.
    const nextIds = [
      ...selectedIds.filter(
        (id) => !enabledIds.has(id) || pickedIds.includes(id),
      ),
      ...pickedIds.filter((id) => !selectedIds.includes(id)),
    ];
    setAllowedModelIds(nextIds);

    // The default must stay one of the selected models; the first selected
    // model becomes the default when there is none.
    if (defaultModelId === undefined || !nextIds.includes(defaultModelId)) {
      setDefaultModelId(pickedIds[0]);
    }
  };

  const handleRemove = (modelId: string) => {
    setAllowedModelIds(selectedIds.filter((id) => id !== modelId));
  };

  // A default that is no longer enabled can only be cleared; with a
  // selection it is dropped from it too.
  const handleRemoveDisabledDefault = () => {
    if (defaultModelId !== undefined && selectedIds.includes(defaultModelId)) {
      setAllowedModelIds(selectedIds.filter((id) => id !== defaultModelId));
    }
    setDefaultModelId(undefined);
  };

  let statusType: NonNullable<MultiselectProps["statusType"]> = "finished";
  if (isLoading) {
    statusType = "loading";
  } else if (isError) {
    statusType = "error";
  }

  const emptyText = limitModels
    ? "No models selected. Add models above."
    : "No enabled models. Enable models in Settings first.";

  return (
    <SpaceBetween size="l">
      <AboutSandboxSpaces />

      <Container>
        <SpaceBetween size="l">
          <ToggleField
            controllerProps={{ control, name: "sandboxSpacesEnabled" }}
            formFieldProps={{
              label: "Enable Sandbox Space",
              description: SANDBOX_SPACE_DESCRIPTIONS[variant],
            }}
            toggleProps={{
              children: sandboxSpacesEnabled
                ? "Sandbox Space enabled"
                : "Sandbox Space disabled",
              disabled: toggleDisabled,
              onChange: handleSandboxSpacesChange,
            }}
            toggleSuffix={globalGateIcon({
              featureName: "Sandbox Spaces",
              allowed: globallyEnabled,
              persistedEnabled: monitoring.persistedSandboxSpacesEnabled,
              enabled: sandboxSpacesEnabled,
              settingsArea: "Sandbox Spaces",
              variant,
            })}
          />

          {showMonitoringStaysOn && (
            <MonitoringMessage
              message={MONITORING_STAYS_ON}
              existingLeasesNote={existingLeasesNote}
            />
          )}

          {showMonitoringTurnedOff && (
            <MonitoringMessage
              message={MONITORING_TURNED_OFF}
              existingLeasesNote={existingLeasesNote}
            />
          )}
        </SpaceBetween>
      </Container>

      {showModelControls && (
        <Container
          header={
            <Header
              variant="h2"
              counter={isLoading ? undefined : `(${modelRows.length})`}
              description="Amazon Bedrock models users can choose from in the Space. The default is selected when a user first opens the Space; they can switch at any time."
            >
              Models
            </Header>
          }
        >
          <SpaceBetween size="l">
            {isError && (
              <Alert type="error">Models could not be loaded. Try again.</Alert>
            )}

            <FormField
              label="Limit available models"
              description="When enabled, users can only choose from the models you add below. When disabled, users can choose from every model an administrator enables in Settings › Sandbox Spaces, including ones enabled later."
            >
              <Toggle checked={limitModels} onChange={handleLimitChange}>
                {limitModels ? "Selected models only" : "All enabled models"}
              </Toggle>
            </FormField>

            {limitModels && (
              <FormField
                label="Add models"
                errorText={errors.allowedModelIds?.message}
              >
                <Multiselect
                  selectedOptions={selectedModels.map(toModelOption)}
                  onChange={handleSelectionChange}
                  options={availableOptionGroups}
                  hideTokens
                  statusType={statusType}
                  loadingText="Loading models…"
                  errorText="Could not load models"
                  placeholder={
                    selectedModels.length > 0
                      ? `${selectedModels.length} selected`
                      : "Search and add models"
                  }
                  filteringType="auto"
                  empty="No enabled models. Enable models in Settings first."
                />
              </FormField>
            )}

            <FormField stretch errorText={errors.defaultModelId?.message}>
              <SandboxSpacesModelsTable
                rows={modelRows}
                loading={isLoading}
                empty={emptyText}
                onSetDefault={setDefaultModelId}
                onRemove={limitModels ? handleRemove : undefined}
                onRemoveDisabledDefault={handleRemoveDisabledDefault}
              />
            </FormField>
          </SpaceBetween>
        </Container>
      )}
    </SpaceBetween>
  );
}

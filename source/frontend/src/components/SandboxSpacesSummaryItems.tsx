// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  KeyValuePairsProps,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { SANDBOX_SPACES_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import { useAgentModelCatalog } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";

interface SandboxSpacesModelSource {
  sandboxSpacesEnabled?: boolean;
  allowedModelIds?: string[];
  defaultModelId?: string;
}

/**
 * The Sandbox Spaces model rows shared by the lease and lease template
 * summaries: the allowed-model subset and the default model.
 *
 * Model IDs resolve to catalog display names, but only Managers and Admins can
 * read the catalog; pass `canReadCatalog: false` for other viewers and the rows
 * show raw model IDs instead of triggering a 403.
 */
export const useSandboxSpacesSummaryItems = (
  source: SandboxSpacesModelSource,
  { canReadCatalog }: { canReadCatalog: boolean },
): KeyValuePairsProps.Pair[] => {
  const enabled = source.sandboxSpacesEnabled === true;
  const { data: catalogModels } = useAgentModelCatalog({
    enabled: canReadCatalog && enabled,
  });
  const catalogEntry = (modelId: string) =>
    catalogModels?.find((model) => model.modelId === modelId);
  const modelName = (modelId: string) =>
    catalogEntry(modelId)?.displayName ?? modelId;

  const renderAllowedModels = (): React.ReactNode => {
    if (!enabled) {
      return <StatusIndicator type="info">—</StatusIndicator>;
    }
    if (!source.allowedModelIds?.length) {
      return <StatusIndicator type="info">All enabled models</StatusIndicator>;
    }
    if (catalogModels === undefined) {
      return source.allowedModelIds.map(modelName).join(", ");
    }
    const isEnabled = (modelId: string) =>
      catalogEntry(modelId)?.enabled === true;
    const enabledIds = source.allowedModelIds.filter(isEnabled);
    const disabledIds = source.allowedModelIds.filter(
      (modelId) => !isEnabled(modelId),
    );
    if (disabledIds.length === 0) {
      return enabledIds.map(modelName).join(", ");
    }
    return (
      <SpaceBetween size="xxs">
        {enabledIds.length > 0 && (
          <Box>{enabledIds.map(modelName).join(", ")}</Box>
        )}
        <StatusIndicator type="warning">
          {SANDBOX_SPACES_CONSTRAINTS.SELECTED_MODELS_DISABLED(
            disabledIds.map(modelName),
          )}
        </StatusIndicator>
      </SpaceBetween>
    );
  };

  const renderDefaultModel = (): React.ReactNode => {
    if (!enabled) {
      return <StatusIndicator type="info">—</StatusIndicator>;
    }
    if (!source.defaultModelId) {
      return <StatusIndicator type="info">Not set</StatusIndicator>;
    }
    if (
      catalogModels !== undefined &&
      catalogEntry(source.defaultModelId)?.enabled !== true
    ) {
      return (
        <SpaceBetween size="xxs">
          <StatusIndicator type="warning">
            {SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED(
              modelName(source.defaultModelId),
            )}
          </StatusIndicator>
          <Box variant="small" color="text-body-secondary">
            {SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_HINT}
          </Box>
        </SpaceBetween>
      );
    }
    return modelName(source.defaultModelId);
  };

  return [
    { label: "Allowed models", value: renderAllowedModels() },
    { label: "Default model", value: renderDefaultModel() },
  ];
};

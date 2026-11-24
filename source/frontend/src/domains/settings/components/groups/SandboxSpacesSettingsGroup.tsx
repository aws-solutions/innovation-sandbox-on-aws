// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";
import { useState } from "react";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useAgentModelCatalog } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { AgentConfigForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/AgentConfigForm";
import {
  CatalogDraft,
  ModelCatalogTable,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/ModelCatalogTable";
import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

import {
  configurationGroup,
  SettingsGroupController,
} from "./configurationGroup";

const KEEP_ONE_MODEL_ENABLED_MESSAGE =
  "Keep at least one model enabled while Sandbox Spaces is turned on.";

export function useSandboxSpacesSettingsGroup(
  agent: ConfigurationForm<"agent">,
  bedrockInferenceProfilePatterns: string[],
): SettingsGroupController {
  const { isAdmin } = useUser();
  const [catalog, setCatalog] = useState<CatalogDraft | null>(null);
  const catalogQuery = useAgentModelCatalog({ enabled: false });
  const configuration = configurationGroup([
    { label: "Sandbox Spaces availability", form: agent },
  ]);

  return {
    ...configuration,
    audit: [
      ...configuration.audit,
      ...(catalogQuery.data ?? []).map((row) => ({
        lastSavedBy: row.lastSavedBy ?? null,
        meta: row.meta,
      })),
    ],
    status: () => {
      const state = configuration.status();
      return {
        ...state,
        dirty: state.dirty || !!catalog?.dirty,
        conflict: state.conflict || !!catalog?.conflict,
      };
    },
    save: async () => {
      const leavesNoEnabledModel =
        !!catalog?.dirty && catalog.remainingEnabledCount === 0;
      if (
        leavesNoEnabledModel &&
        agent.methods.getValues("sandboxSpacesEnabled")
      ) {
        showErrorToast(KEEP_ONE_MODEL_ENABLED_MESSAGE, "Settings not saved");
        return false;
      }
      const configurationSaved = await configuration.save();
      // Disabling every model is safe only once Sandbox Spaces is saved off.
      if (leavesNoEnabledModel && !configurationSaved) return false;
      // Keep the existing order and preserve either successful write on failure.
      const catalogSaved = catalog?.dirty ? await catalog.save() : true;
      return configurationSaved && catalogSaved;
    },
    discard: () => {
      configuration.discard();
      catalog?.discard();
    },
    reload: async () => {
      await configuration.reload();
      await catalog?.reload();
    },
    getSaveWarning: () => {
      if (
        !agent.baseline.sandboxSpacesEnabled ||
        agent.methods.getValues("sandboxSpacesEnabled")
      )
        return null;
      return (
        <Alert type="warning" header="Turn off Sandbox Spaces?">
          Turning this off prevents new agent turns. Tasks already running are
          not cancelled and may continue making AWS calls while their leases
          remain active.
        </Alert>
      );
    },
    // Keep the catalog mounted across groups to preserve selection and its draft.
    render: (visible, busy) => (
      <>
        {visible && (
          <AgentConfigForm
            bedrockInferenceProfilePatterns={bedrockInferenceProfilePatterns}
          />
        )}
        <ModelCatalogTable
          readOnly={!isAdmin}
          visible={visible}
          busy={busy}
          onDraftChange={setCatalog}
        />
      </>
    ),
  };
}

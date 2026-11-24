// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button } from "@cloudscape-design/components";
import { ReactNode, useMemo } from "react";

import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { showSuccessToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { SectionForm } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/SectionForm";
import { SettingsFormContext } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsFormContext";
import { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import {
  ConfigurationForm,
  useConfigurationForm,
} from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import type { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

function getDisabledReason(state: ReturnType<ConfigurationForm["status"]>) {
  if (state.conflict) return "Reload latest values before saving.";
  if (state.invalid) return "Fix validation errors before saving.";
  if (!state.dirty && !state.needsSetup) return "No changes to save.";
  return undefined;
}

/** Exercises one section's real controller and controls, without page confirmations. */
export function ConfigurationFormHarness({
  section,
  data,
  children,
  renderFields,
}: {
  section: ConfigSection;
  data: ConfigurationSectionView<ConfigSection>;
  children?: ReactNode;
  renderFields?: (readOnly: boolean) => ReactNode;
}) {
  const form = useConfigurationForm(section, data);
  const { isAdmin, isLoading } = useUser();
  const state = form.status();
  const disabledReason = getDisabledReason(state);
  const { methods, conflict, busy } = form;
  const formContext = useMemo(
    () => ({
      // Only the selected section is mounted in this isolated harness.
      sections: { [section]: { methods, conflict } } as Record<
        ConfigSection,
        Pick<ConfigurationForm, "methods" | "conflict">
      >,
      busy,
    }),
    [section, methods, methods.formState, conflict, busy],
  );
  if (isLoading) return <Loader />;
  return (
    <SettingsFormContext.Provider value={formContext}>
      {renderFields ? (
        <SectionForm section={section} renderFields={renderFields} />
      ) : (
        children
      )}
      {isAdmin && (
        <>
          {state.conflict && (
            <Button onClick={() => void form.reload()} loading={form.busy}>
              Reload
            </Button>
          )}
          <Button
            disabled={!!disabledReason}
            disabledReason={disabledReason}
            loading={form.busy}
            onClick={async () => {
              if (await form.save()) showSuccessToast("Settings saved.");
            }}
          >
            Save
          </Button>
        </>
      )}
    </SettingsFormContext.Provider>
  );
}

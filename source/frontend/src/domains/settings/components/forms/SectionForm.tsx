// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert, SpaceBetween } from "@cloudscape-design/components";
import { ReactNode } from "react";
import { FormProvider } from "react-hook-form";

import { useSettingsFormContext } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsFormContext";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import type { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

/** Supplies the page's form state; each form renders its own controls. */
export function SectionForm({
  section,
  renderFields,
}: Readonly<{
  section: ConfigSection;
  renderFields: (readOnly: boolean) => ReactNode;
}>) {
  const { sections, busy } = useSettingsFormContext();
  const form = sections[section];
  const { isAdmin } = useUser();
  return (
    <FormProvider {...form.methods}>
      <SpaceBetween size="l">
        {form.conflict && (
          <Alert
            type="warning"
            header="Settings changed by another administrator"
          >
            {form.conflict.savedBy
              ? `${form.conflict.savedBy} saved these settings. `
              : "These settings were modified by another administrator. "}
            Reload latest values before saving.
          </Alert>
        )}
        {form.methods.formState.errors.root?.server && (
          <Alert type="error" header="Validation error">
            {form.methods.formState.errors.root.server.message}
          </Alert>
        )}
        <fieldset
          disabled={busy}
          style={{ border: 0, margin: 0, padding: 0, minWidth: 0 }}
        >
          {renderFields(!isAdmin)}
        </fieldset>
      </SpaceBetween>
    </FormProvider>
  );
}

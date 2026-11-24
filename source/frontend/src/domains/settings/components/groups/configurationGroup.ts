// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ReactNode } from "react";

import { showErrorToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";
import type { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

export type ConfigurationAudit = Pick<
  ConfigurationSectionView<ConfigSection>,
  "lastSavedBy" | "meta"
>;

type GroupForm = {
  label: string;
  form: ConfigurationForm;
  fields?: readonly string[];
};

async function saveForm({ label, form, fields }: GroupForm) {
  const { dirty, needsSetup } = form.status(fields);
  let error: string | undefined;
  const success = await form.save(fields, (message) => {
    error = message;
  });
  return {
    label,
    success,
    // A clean, persisted form returns success without making a request.
    saved: success && (dirty || needsSetup),
    error,
  };
}

/** Combines existing API forms without changing their persistence boundaries. */
export function configurationGroup(forms: GroupForm[]) {
  return {
    busy: forms.some(({ form }) => form.busy),
    audit: forms.map(({ form }): ConfigurationAudit => form.baseline),
    status: () => {
      const states = forms.map(({ form, fields }) => form.status(fields));
      return {
        dirty: states.some((state) => state.dirty),
        invalid: states.some((state) => state.invalid),
        conflict: states.some((state) => state.conflict),
        needsSetup: states.some((state) => state.needsSetup),
      };
    },
    // Evaluate every form so all validation errors are shown before any writes.
    validate: () =>
      forms.map(({ form, fields }) => form.validate(fields)).every(Boolean),
    save: async () => {
      // Writes are independent; successful sections stay saved after a partial failure.
      const outcomes = await Promise.all(forms.map(saveForm));
      const failed = outcomes.filter((outcome) => !outcome.success);
      if (!failed.length) return true;
      const saved = outcomes
        .filter((outcome) => outcome.saved)
        .map((outcome) => outcome.label)
        .join(", ");
      const errors = failed
        .map(({ label, error }) => (error ? `${label}: ${error}` : label))
        .join("; ");
      const savedMessage = saved ? `Saved: ${saved}. ` : "";
      showErrorToast(
        `${savedMessage}Not saved: ${errors}. Review the errors and try saving again.`,
        saved ? "Some settings were saved" : "Settings not saved",
      );
      return false;
    },
    discard: () => forms.forEach(({ form, fields }) => form.discard(fields)),
    reload: async () => {
      await Promise.all(forms.map(({ form }) => form.reload()));
    },
  };
}

export type SettingsGroupController = ReturnType<typeof configurationGroup> & {
  getSaveWarning?: () => ReactNode | Promise<ReactNode>;
  render: (visible: boolean, busy: boolean) => ReactNode;
};

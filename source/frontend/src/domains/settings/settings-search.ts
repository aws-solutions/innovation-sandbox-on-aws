// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { deploymentSettingsSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/DeploymentSettings";
import { agentConfigFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/AgentConfigForm";
import { cleanupFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CleanupForm";
import { costReportingFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CostReportingForm";
import { leasesFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/LeasesForm";
import { maintenanceFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/MaintenanceForm";
import { modelCatalogSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/ModelCatalogTable";
import { notificationFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/NotificationForm";
import { termsOfServiceFormSearchFields } from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/TermsOfServiceForm";

import {
  SETTINGS_GROUPS,
  SettingsGroupId,
  SettingsSearchField,
} from "./settings-navigation";

export const SEARCHABLE_SETTINGS: readonly SettingsSearchField[] = [
  ...maintenanceFormSearchFields,
  ...termsOfServiceFormSearchFields,
  ...deploymentSettingsSearchFields,
  ...leasesFormSearchFields,
  ...costReportingFormSearchFields,
  ...cleanupFormSearchFields,
  ...notificationFormSearchFields,
  ...agentConfigFormSearchFields,
  ...modelCatalogSearchFields,
];
export function searchSettings(query: string) {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  const matches = (text: string) => {
    const normalized = text.toLocaleLowerCase();
    return words.every((word) => normalized.includes(word));
  };
  const results = SEARCHABLE_SETTINGS.map((field) => {
    const group = SETTINGS_GROUPS.find((group) => group.id === field.group)!;
    const fieldText = `${field.label} ${field.subgroup} ${field.description}`;
    // Broader tiers retain field text so query words can span multiple sources.
    const rank = [
      field.label,
      fieldText,
      `${fieldText} ${group.label} ${group.description}`,
    ].findIndex(matches);
    return { field, rank };
  });
  return results
    .filter(({ rank }) => rank >= 0)
    .sort(
      (a, b) => a.rank - b.rank || a.field.label.localeCompare(b.field.label),
    )
    .map(({ field }) => field);
}
export function resolveSettingsHash(hash: string): {
  group: SettingsGroupId;
  target?: string;
} {
  const field = SEARCHABLE_SETTINGS.find((field) => field.id === hash);
  if (field) return { group: field.group, target: field.id };
  const group = SETTINGS_GROUPS.find((group) => group.id === hash);
  if (group) return { group: group.id };
  return { group: "general" };
}

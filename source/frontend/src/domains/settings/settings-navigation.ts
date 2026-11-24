// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { FieldPath } from "react-hook-form";

import type {
  ConfigSection,
  ConfigSectionWriteFields,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const SANDBOX_SPACES_GROUP_ID = "sandbox-spaces";

export const SETTINGS_GROUPS = [
  {
    id: "general",
    label: "General",
    description:
      "Maintenance mode, the terms users accept when requesting a lease, and read-only deployment details.",
    help: "settings-general",
  },
  {
    id: "lease-policies",
    label: "Lease policies",
    description:
      "Limits and options that every lease template and lease must stay within, and who can do what with a lease.",
    help: "settings-leases-cost",
  },
  {
    id: "cost",
    label: "Cost",
    description:
      "Service cost breakdown, and the cost report groups available to lease templates.",
    help: "settings-cost",
  },
  {
    id: "account-cleanup",
    label: "Account cleanup",
    description:
      "How sandbox accounts are wiped and returned to the pool after a lease ends.",
    help: "settings-cleanup",
  },
  {
    id: "notifications",
    label: "Notifications",
    description:
      "Where lease, budget, and account notifications are delivered.",
    help: "settings-notifications",
  },
  {
    id: SANDBOX_SPACES_GROUP_ID,
    label: "Sandbox Spaces",
    description:
      "Deployment-wide settings for Sandbox Spaces, the AI agent workspaces attached to leases.",
    help: "settings-sandbox-spaces",
  },
] as const;
export type SettingsGroupId = (typeof SETTINGS_GROUPS)[number]["id"];

export function settingsGroupHref(group: SettingsGroupId) {
  return `/settings#${group}`;
}

export type SettingsSearchField = {
  id: string;
  group: SettingsGroupId;
  subgroup: string;
  label: string;
  description: string;
  section?: ConfigSection;
  field?: string;
};

type FieldCopy = { label: string; description?: string };
export type ConfigurationFieldName<Section extends ConfigSection> = FieldPath<
  ConfigSectionWriteFields<Section>
>;
export type FormFieldDefinitions<Section extends ConfigSection> = Partial<
  Record<ConfigurationFieldName<Section>, FieldCopy>
>;
type SearchOptions = {
  group: SettingsGroupId;
  subgroup: string;
  description?: string;
};

/** Derives searchable entries from a form's field definitions. */
export function formSearchFields<
  Section extends ConfigSection,
  Name extends ConfigurationFieldName<NoInfer<Section>>,
>(
  options: SearchOptions & {
    section: Section;
    fields: Record<Name, FieldCopy>;
  },
): SettingsSearchField[];
export function formSearchFields(
  options: SearchOptions & {
    section?: never;
    fields: Record<string, FieldCopy>;
  },
): SettingsSearchField[];
export function formSearchFields({
  section,
  group,
  subgroup,
  fields,
  description = "",
}: SearchOptions & {
  section?: ConfigSection;
  fields: Record<string, FieldCopy>;
}): SettingsSearchField[] {
  return Object.entries(fields).map(([field, fieldDefinition]) => ({
    ...fieldDefinition,
    description: fieldDefinition.description ?? description,
    ...(section ? { section, field } : {}),
    group,
    subgroup,
    id: section ? formatSettingAnchor(section, field) : field,
  }));
}

// Public signatures check field names; enumeration widens keys to strings.
function formatSettingAnchor(sectionName: ConfigSection, fieldPath: string) {
  return `setting-${sectionName}-${fieldPath.replaceAll(".", "-")}`;
}

export function settingAnchor<Section extends ConfigSection>(
  sectionName: Section,
  fieldPath: ConfigurationFieldName<NoInfer<Section>>,
) {
  return formatSettingAnchor(sectionName, fieldPath);
}

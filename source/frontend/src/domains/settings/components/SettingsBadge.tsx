// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Badge } from "@cloudscape-design/components";

import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { SEARCHABLE_SETTINGS } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-search";

export function SettingsBadge() {
  const { data: config } = useGetConfigurations();
  if (!config) return null;
  // Count affected pages, matching the navigation icons even when sections are shared.
  const unsavedGroups = new Set(
    SEARCHABLE_SETTINGS.filter(
      ({ section }) => section && config[section].lastSavedBy === null,
    ).map(({ group }) => group),
  ).size;
  if (unsavedGroups === 0) return null;
  return (
    <Badge
      color="blue"
      nativeAttributes={{
        role: "img",
        "aria-label": `${unsavedGroups} settings ${unsavedGroups === 1 ? "page has" : "pages have"} unsaved defaults`,
      }}
    >
      {unsavedGroups}
    </Badge>
  );
}

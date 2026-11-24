// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { createContext, useContext } from "react";

import { ConfigurationForm } from "@amzn/innovation-sandbox-frontend/domains/settings/useConfigurationForm";
import type { ConfigSection } from "@amzn/innovation-sandbox-shared/types/configuration.js";

export const SettingsFormContext = createContext<{
  sections: Record<
    ConfigSection,
    Pick<ConfigurationForm, "methods" | "conflict">
  >;
  busy: boolean;
} | null>(null);
export function useSettingsFormContext() {
  const context = useContext(SettingsFormContext);
  if (!context) throw new Error("Settings forms require SettingsFormContext.");
  return context;
}

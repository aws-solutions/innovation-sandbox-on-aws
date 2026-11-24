// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AdminConfigurationView,
  DeployTimeConfigurationView,
} from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import {
  ConfigSchemas,
  ConfigSection,
  ConfigSectionFields,
  ConfigurationResponseMetadata,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

// Per-section partial fields + deploy-time fields, shallow merged onto schema defaults.
export type ConfigurationOverrides = Partial<
  {
    [S in ConfigSection]: Partial<ConfigSectionFields<S>>;
  } & DeployTimeConfigurationView
>;

const DEFAULT_LAST_SAVED_BY = "admin@example.com";
const DEFAULT_META: ConfigurationResponseMetadata = {
  createdTime: "2026-04-04T10:00:00.000Z",
  lastEditTime: "2026-04-04T12:30:00.000Z",
};

// Permissive lease limits + maintenance off so edit-form tests submit cleanly; overridable per call.
const BASELINE: ConfigurationOverrides = {
  leases: {
    requireMaxBudget: false,
    maxBudget: 100000,
    requireMaxDuration: false,
    maxDurationHours: 999,
    maxLeasesPerUser: 2,
  },
  maintenance: { enabled: false },
};

export function createConfiguration(
  overrides: ConfigurationOverrides = {},
): AdminConfigurationView {
  const sections = Object.fromEntries(
    (Object.keys(ConfigSchemas) as ConfigSection[]).map((section) => {
      const fields = ConfigSchemas[section].parse({});
      return [
        section,
        {
          ...fields,
          ...BASELINE[section],
          ...overrides[section],
          lastSavedBy: DEFAULT_LAST_SAVED_BY,
          meta: DEFAULT_META,
        },
      ];
    }),
  );

  return {
    ...sections,
    isbManagedRegions: overrides.isbManagedRegions ?? [
      "us-east-1",
      "us-west-2",
    ],
    awsAccessPortalUrl:
      overrides.awsAccessPortalUrl ?? "https://d-0000000000.awsapps.com/start",
    bedrockInferenceProfilePatterns:
      overrides.bedrockInferenceProfilePatterns ?? [
        "arn:aws:bedrock:*:*:inference-profile/global.*",
        "arn:aws:bedrock:*:*:inference-profile/us.*",
      ],
  } as AdminConfigurationView;
}

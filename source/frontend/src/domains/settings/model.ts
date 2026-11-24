// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  type ConfigSection,
  ConfigWriteSchemas,
  LeasesConfigBaseSchema,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const configurationSectionAuditShape = {
  lastSavedBy: z.string().nullable(),
  meta: z
    .strictObject({
      createdTime: z.string(),
      lastEditTime: z.string(),
    })
    .optional(),
} as const;

/** Required response fields plus frontend-normalized audit metadata. */
export const ConfigurationSectionViewSchemas = {
  // Response parsing requires every field but must not apply the write-only
  // leases cross-field refinement to stored or migrated configuration.
  leases: LeasesConfigBaseSchema.safeExtend(configurationSectionAuditShape),
  cleanup: ConfigWriteSchemas.cleanup.safeExtend(
    configurationSectionAuditShape,
  ),
  notification: ConfigWriteSchemas.notification.safeExtend(
    configurationSectionAuditShape,
  ),
  maintenance: ConfigWriteSchemas.maintenance.safeExtend(
    configurationSectionAuditShape,
  ),
  termsOfService: ConfigWriteSchemas.termsOfService.safeExtend(
    configurationSectionAuditShape,
  ),
  costReporting: ConfigWriteSchemas.costReporting.safeExtend(
    configurationSectionAuditShape,
  ),
  agent: ConfigWriteSchemas.agent.safeExtend(configurationSectionAuditShape),
} as const;

/** One configuration section normalized for frontend consumers. */
export type ConfigurationSectionView<T extends ConfigSection> = z.infer<
  (typeof ConfigurationSectionViewSchemas)[T]
>;

/** Read-only fields resolved at deployment time rather than stored per section. */
export type DeployTimeConfigurationView = {
  isbManagedRegions: string[];
  awsAccessPortalUrl: string;
  bedrockInferenceProfilePatterns: string[];
};

/** The complete Admin Settings read model. */
export type AdminConfigurationView = {
  [Section in ConfigSection]: ConfigurationSectionView<Section>;
} & DeployTimeConfigurationView;

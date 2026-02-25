// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Schema for Data Stack configuration stored in SSM Parameter Store.
 * This configuration is created by the Data Stack and consumed by other stacks.
 */
export const DataConfigSchema = z.object({
  configApplicationId: z.string(),
  configEnvironmentId: z.string(),
  globalConfigConfigurationProfileId: z.string(),
  nukeConfigConfigurationProfileId: z.string(),
  reportingConfigConfigurationProfileId: z.string(),
  accountTable: z.string(),
  leaseTemplateTable: z.string(),
  leaseTable: z.string(),
  blueprintTable: z.string(),
  tableKmsKeyId: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
});

export type DataConfig = z.infer<typeof DataConfigSchema>;

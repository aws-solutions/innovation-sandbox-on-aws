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
  configTableName: z.string(),
  nukeConfigConfigurationProfileId: z.string(),
  validatorExclusionConfigConfigurationProfileId: z.string(),
  accountTable: z.string(),
  leaseTemplateTable: z.string(),
  leaseTable: z.string(),
  blueprintTable: z.string(),
  principalTable: z.string(),
  cleanupReportTable: z.string(),
  sandboxSpacesUsageTable: z.string(),
  leaseCostHistoryTable: z.string(),
  tableKmsKeyId: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
  cognitoUserPoolId: z.string(),
  cognitoUserPoolArn: z.string(),
  cognitoAppClientId: z.string(),
  cognitoMcpClientId: z.string(),
  cognitoIdentityPoolId: z.string(),
  cognitoDomain: z.string(),
  awsAccessPortalUrl: z.string(),
  identityPoolAdminRoleName: z.string(),
  identityPoolManagerRoleName: z.string(),
  identityPoolUserRoleName: z.string(),
});

export type DataConfig = z.infer<typeof DataConfigSchema>;

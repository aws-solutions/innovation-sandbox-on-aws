// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Schema for IDC Stack configuration stored in SSM Parameter Store.
 * This configuration is created by the IDC Stack and consumed by other stacks.
 */
export const IdcConfigSchema = z.object({
  identityStoreId: z.string(),
  ssoInstanceArn: z.string(),
  adminGroupId: z.string(),
  managerGroupId: z.string(),
  userGroupId: z.string(),
  adminPermissionSetArn: z.string(),
  managerPermissionSetArn: z.string(),
  userPermissionSetArn: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
});

export type IdcConfig = z.infer<typeof IdcConfigSchema>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const InitializeCleanupLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    IDC_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
    CLEANUP_SPOKE_ROLE_NAME: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
  });

export type InitializeCleanupLambdaEnvironment = z.infer<
  typeof InitializeCleanupLambdaEnvironmentSchema
>;

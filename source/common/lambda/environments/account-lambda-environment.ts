// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const AccountLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    LEASE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    SANDBOX_ACCOUNT_ROLE_NAME: z.string(),
    ISB_EVENT_BUS: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    IDC_ACCOUNT_ID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
  });

export type AccountLambdaEnvironment = z.infer<
  typeof AccountLambdaEnvironmentSchema
>;

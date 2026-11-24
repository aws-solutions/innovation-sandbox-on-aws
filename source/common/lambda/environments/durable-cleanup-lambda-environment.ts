// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const DurableCleanupLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ACCOUNT_TABLE_NAME: z.string(),
    LEASE_TABLE_NAME: z.string(),
    CLEANUP_REPORT_TABLE_NAME: z.string(),
    CONFIG_TABLE_NAME: z.string(),
    PRINCIPAL_TABLE_NAME: z.string(),
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    ORG_MGT_ACCOUNT_ID: AwsAccountIdSchema,
    IDC_ACCOUNT_ID: AwsAccountIdSchema,
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
    CLEANUP_SPOKE_ROLE_NAME: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    ISB_EVENT_BUS: z.string(),
    ISB_NAMESPACE: z.string(),
    CODEBUILD_PROJECT_NAME: z.string(),
    APPCONFIG_NUKE_CONFIG_CONFIGURATION_PROFILE_ID: z.string(),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
    APPCONFIG_VALIDATOR_EXCLUSION_CONFIG_PROFILE_ID: z.string(),
    CODEBUILD_TIMEOUT_MINUTES: z.string(),
  });

export type DurableCleanupLambdaEnvironment = z.infer<
  typeof DurableCleanupLambdaEnvironmentSchema
>;

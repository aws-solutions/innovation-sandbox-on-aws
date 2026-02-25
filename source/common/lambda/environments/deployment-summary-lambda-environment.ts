// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const DeploymentSummaryLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    METRICS_URL: z.string(),
    SOLUTION_ID: z.string(),
    SOLUTION_VERSION: z.string(),
    METRICS_UUID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
    ORG_MGT_ACCOUNT_ID: z.string(),
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    LEASE_TEMPLATE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    REPORTING_CONFIG_PROFILE_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
    IS_STABLE_TAGGING_ENABLED: z.string(),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
  });

export type DeploymentSummaryLambdaEnvironment = z.infer<
  typeof DeploymentSummaryLambdaEnvironmentSchema
>;

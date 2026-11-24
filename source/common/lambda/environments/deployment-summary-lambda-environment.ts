// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const DeploymentSummaryLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    METRICS_URL: z.string(),
    SOLUTION_ID: z.string(),
    SOLUTION_VERSION: z.string(),
    METRICS_UUID: z.string(),
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
    ORG_MGT_ACCOUNT_ID: AwsAccountIdSchema,
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    LEASE_TEMPLATE_TABLE_NAME: z.string(),
    LEASE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    PRINCIPAL_TABLE_NAME: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    CONFIG_TABLE_NAME: z.string(),
    IS_STABLE_TAGGING_ENABLED: z.string(),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
    USER_PERMISSION_SET_ARN: z.string(),
    WAF_WEB_ACL_NAME: z.string(),
    // Dedicated var (not the reserved AWS_REGION) so region is validated env,
    // read as env.WAF_REGION instead of raw process.env in the collector.
    WAF_REGION: z.string(),
    NOTIFICATION_TOPIC_ARN: z.string(),
    // Empty uses the hub account's SES identity.
    SES_IDENTITY_ARN: z.string(),
  });

export type DeploymentSummaryLambdaEnvironment = z.infer<
  typeof DeploymentSummaryLambdaEnvironmentSchema
>;

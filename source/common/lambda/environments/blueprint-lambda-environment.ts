// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const BlueprintLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    CONFIG_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    LEASE_TEMPLATE_TABLE_NAME: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    SANDBOX_ACCOUNT_ROLE_NAME: z.string(),
    ORG_MGT_ACCOUNT_ID: AwsAccountIdSchema,
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
  });

export type BlueprintLambdaEnvironment = z.infer<
  typeof BlueprintLambdaEnvironmentSchema
>;

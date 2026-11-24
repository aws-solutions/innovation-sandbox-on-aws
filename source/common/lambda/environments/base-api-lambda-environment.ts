// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { z } from "zod";

export const BaseApiLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    COGNITO_USER_POOL_ID: z.string().min(1),
    COGNITO_APP_CLIENT_ID: z.string().min(1),
    COGNITO_MCP_CLIENT_ID: z.string().min(1),
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
    ISB_NAMESPACE: z.string().regex(new RegExp(NAMESPACE_PATTERN)),
  });

export type BaseApiLambdaEnvironment = z.infer<
  typeof BaseApiLambdaEnvironmentSchema
>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import {
  SesIdentityEnvironmentShape,
  validateSesIdentityRegion,
} from "@amzn/innovation-sandbox-commons/lambda/environments/ses-identity-environment.js";

export const ConfigurationLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string(),
    CONFIG_TABLE_NAME: z.string(),
    BEDROCK_REGIONAL_PRICE_TABLE_NAME: z.string(),
    AWS_ACCESS_PORTAL_URL: z.string(),
    ...SesIdentityEnvironmentShape,
  }).superRefine(validateSesIdentityRegion);

export type ConfigurationLambdaEnvironment = z.infer<
  typeof ConfigurationLambdaEnvironmentSchema
>;

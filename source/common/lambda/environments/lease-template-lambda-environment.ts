// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const LeaseTemplateLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    REPORTING_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    LEASE_TEMPLATE_TABLE_NAME: z.string(),
    BLUEPRINT_TABLE_NAME: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
  });

export type LeaseTemplateLambdaEnvironment = z.infer<
  typeof LeaseTemplateLambdaEnvironmentSchema
>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const ConfigurationLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    REPORTING_CONFIG_PROFILE_ID: z.string(),
    ISB_MANAGED_REGIONS: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
  });

export type ConfigurationLambdaEnvironment = z.infer<
  typeof ConfigurationLambdaEnvironmentSchema
>;

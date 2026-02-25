// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const AuthorizerLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
  });

export type AuthorizerLambdaEnvironment = z.infer<
  typeof AuthorizerLambdaEnvironmentSchema
>;

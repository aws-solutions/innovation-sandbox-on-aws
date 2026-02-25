// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const SsoLambdaEnvironmentSchema = BaseApiLambdaEnvironmentSchema.extend(
  {
    IDP_CERT_SECRET_NAME: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    ISB_NAMESPACE: z.string(),
    APP_CONFIG_APPLICATION_ID: z.string(),
    APP_CONFIG_PROFILE_ID: z.string(),
    APP_CONFIG_ENVIRONMENT_ID: z.string(),
    AWS_APPCONFIG_EXTENSION_PREFETCH_LIST: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
  },
);

export type SsoLambdaEnvironment = z.infer<typeof SsoLambdaEnvironmentSchema>;

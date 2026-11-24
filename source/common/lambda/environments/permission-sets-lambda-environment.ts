// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const PermissionSetsLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    CONFIG_TABLE_NAME: z.string(),
    PRINCIPAL_TABLE_NAME: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
  });

export type PermissionSetsLambdaEnvironment = z.infer<
  typeof PermissionSetsLambdaEnvironmentSchema
>;

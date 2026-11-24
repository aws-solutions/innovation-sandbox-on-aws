// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { NAMESPACE_PATTERN } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const PrincipalCacheSyncEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    PRINCIPAL_TABLE_NAME: z.string(),
    IDC_CONFIG_PARAM_ARN: z.string(),
    IDC_ROLE_ARN: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    IDC_ACCOUNT_ID: AwsAccountIdSchema,
    ISB_NAMESPACE: z.string().regex(new RegExp(NAMESPACE_PATTERN)),
  });

export type PrincipalCacheSyncEnvironment = z.infer<
  typeof PrincipalCacheSyncEnvironmentSchema
>;

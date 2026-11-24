// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const TagActivationCheckerEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ISB_NAMESPACE: z.string(),
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
  });

export type TagActivationCheckerEnvironment = z.infer<
  typeof TagActivationCheckerEnvironmentSchema
>;

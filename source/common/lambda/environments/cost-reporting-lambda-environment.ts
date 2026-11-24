// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const CostReportingLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    ACCOUNT_TABLE_NAME: z.string(),
    ISB_NAMESPACE: z.string(),
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
    ISB_TAG_NAME: z.string(),
    ISB_TAG_VALUE: z.string(),
    IDC_ACCOUNT_ID: AwsAccountIdSchema,
    ORG_MGT_ACCOUNT_ID: AwsAccountIdSchema,
    HUB_ACCOUNT_ID: AwsAccountIdSchema,
  });

export type CostReportingLambdaEnvironment = z.infer<
  typeof CostReportingLambdaEnvironmentSchema
>;

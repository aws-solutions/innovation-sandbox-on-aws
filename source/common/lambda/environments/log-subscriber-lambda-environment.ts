// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const LogSubscriberLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    METRICS_URL: z.string(),
    SOLUTION_ID: z.string(),
    SOLUTION_VERSION: z.string(),
    METRICS_UUID: z.string(),
    HUB_ACCOUNT_ID: z.string(),
  });

export type LogSubscriberLambdaEnvironment = z.infer<
  typeof LogSubscriberLambdaEnvironmentSchema
>;

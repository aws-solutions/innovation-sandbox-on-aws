// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const ObservabilitySinksEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    INTERMEDIATE_ROLE_ARN: z.string(),
    ORG_MGT_ROLE_ARN: z.string(),
  });

export type ObservabilitySinksEnvironment = z.infer<
  typeof ObservabilitySinksEnvironmentSchema
>;

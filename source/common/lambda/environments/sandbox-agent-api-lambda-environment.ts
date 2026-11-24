// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

export const SandboxAgentApiLambdaEnvironmentSchema =
  BaseApiLambdaEnvironmentSchema.extend({
    LEASE_TABLE_NAME: z.string().min(1),
    SANDBOX_SPACES_USAGE_TABLE_NAME: z.string().min(1),
    CONFIG_TABLE_NAME: z.string().min(1),
    BEDROCK_REGIONAL_PRICE_TABLE_NAME: z.string().min(1),
    MEMORY_ACCESS_ROLE_ARN: z.string().min(1),
    USER_MEMORY_ARN: z.string().min(1),
  });

export type SandboxAgentApiLambdaEnvironment = z.infer<
  typeof SandboxAgentApiLambdaEnvironmentSchema
>;

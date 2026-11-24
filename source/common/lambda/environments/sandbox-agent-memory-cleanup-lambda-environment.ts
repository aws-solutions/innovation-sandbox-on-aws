// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";

export const SandboxAgentMemoryCleanupLambdaEnvironmentSchema =
  BaseLambdaEnvironmentSchema.extend({
    MEMORY_ACCESS_ROLE_ARN: z.string().min(1),
    USER_MEMORY_ARN: z.string().min(1),
    MAX_RECEIVE_COUNT: z.string().regex(/^[1-9]\d*$/),
  });

export type SandboxAgentMemoryCleanupLambdaEnvironment = z.infer<
  typeof SandboxAgentMemoryCleanupLambdaEnvironmentSchema
>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const AgentRuntimeEnvironmentSchema = z.object({
  INTERMEDIATE_ROLE_ARN: z.string(),
  SANDBOX_AGENT_ROLE_NAME: z.string(),
  HUB_ACCOUNT_ID: AwsAccountIdSchema,
  USER_AGENT_EXTRA: z.string(),
  LEASE_TABLE_NAME: z.string(),
  ACCOUNT_TABLE_NAME: z.string(),
  GUARDRAIL_ID: z.string(),
  GUARDRAIL_VERSION: z.string(),
  AWS_REGION: z.string(),
  USER_MEMORY_ID: z.string().optional(),
});

export type AgentRuntimeEnvironment = z.infer<
  typeof AgentRuntimeEnvironmentSchema
>;

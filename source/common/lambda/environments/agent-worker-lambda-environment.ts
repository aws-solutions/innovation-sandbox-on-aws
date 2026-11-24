// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAgentWebSocketEnvironmentBaseSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-websocket-base-lambda-environment.js";
import { z } from "zod";

export const AgentWorkerLambdaEnvironmentSchema =
  SandboxAgentWebSocketEnvironmentBaseSchema.extend({
    CONNECTIONS_TABLE_NAME: z.string().min(1),
    LEASE_TABLE_NAME: z.string().min(1),
    PRINCIPAL_TABLE_NAME: z.string().min(1),
    SANDBOX_SPACES_USAGE_TABLE_NAME: z.string().min(1),
    CONFIG_TABLE_NAME: z.string().min(1),
    BEDROCK_REGIONAL_PRICE_TABLE_NAME: z.string().min(1),
    ACCOUNT_POOL_CONFIG_PARAM_ARN: z.string().min(1),
    IDC_ROLE_ARN: z.string().min(1),
    IDC_CONFIG_PARAM_ARN: z.string().min(1),
    INTERMEDIATE_ROLE_ARN: z.string().min(1),
    WEBSOCKET_API_ENDPOINT: z.url(),
    AGENT_RUNTIME_ARN: z.string().min(1),
  });

export type AgentWorkerLambdaEnvironment = z.infer<
  typeof AgentWorkerLambdaEnvironmentSchema
>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAgentWebSocketEnvironmentBaseSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-websocket-base-lambda-environment.js";
import { z } from "zod";

export const AgentConnectLambdaEnvironmentSchema =
  SandboxAgentWebSocketEnvironmentBaseSchema.extend({
    CONNECTIONS_TABLE_NAME: z.string().min(1),
  });

export type ConnectLambdaEnvironment = z.infer<
  typeof AgentConnectLambdaEnvironmentSchema
>;

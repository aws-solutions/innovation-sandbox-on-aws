// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";

/**
 * Base for the sandbox agent's WebSocket Lambdas (connect, worker). The chat path
 * accepts web console ID tokens only, so the MCP app client id is not required.
 */
export const SandboxAgentWebSocketEnvironmentBaseSchema =
  BaseApiLambdaEnvironmentSchema.omit({
    COGNITO_MCP_CLIENT_ID: true,
    HUB_ACCOUNT_ID: true,
  });

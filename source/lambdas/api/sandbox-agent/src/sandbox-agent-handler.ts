// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  getSandboxAgentApiServiceHandler,
  JSendStatus,
  SandboxAgentApiServiceOperations,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/sandbox-agent";
import { SandboxAgentApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-api-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";

import { sandboxAgentService } from "@amzn/innovation-sandbox-agent-api/smithy/sandbox-agent-operations.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "SandboxAgentApi" });

// Authentication is enforced at API Gateway (AWS_IAM / SigV4) and in
// `apiMiddlewareBundle` (Cognito JWT + RBAC), ahead of the generated handler.
const serviceHandler = getSandboxAgentApiServiceHandler(
  sandboxAgentService(logger),
  jsendValidationCustomizer<SandboxAgentApiServiceOperations>(
    (errors) =>
      new ValidationError({
        status: JSendStatus.FAIL,
        message: "",
        data: { errors },
      }),
  ),
);

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: SandboxAgentApiLambdaEnvironmentSchema,
}).handler(toLambdaHandler(serviceHandler));

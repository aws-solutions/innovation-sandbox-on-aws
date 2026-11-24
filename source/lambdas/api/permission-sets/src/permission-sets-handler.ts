// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

import {
  getPermissionSetsApiServiceHandler,
  JSendStatus,
  PermissionSetsApiServiceOperations,
  ValidationError,
} from "@amzn/innovation-sandbox-api-server/permission-sets";
import { PermissionSetsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/permission-sets-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { toLambdaHandler } from "@amzn/innovation-sandbox-commons/lambda/smithy/api-gateway-handler.js";
import { jsendValidationCustomizer } from "@amzn/innovation-sandbox-commons/lambda/smithy/jsend-validation-customizer.js";

import { permissionSetsService } from "@amzn/innovation-sandbox-permission-sets-handler/smithy/permission-set-operations.js";

const tracer = new Tracer();
const logger = new Logger({ serviceName: "PermissionSets" });

const serviceHandler = getPermissionSetsApiServiceHandler(
  permissionSetsService(logger),
  jsendValidationCustomizer<PermissionSetsApiServiceOperations>(
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
  environmentSchema: PermissionSetsLambdaEnvironmentSchema,
}).handler(toLambdaHandler(serviceHandler));

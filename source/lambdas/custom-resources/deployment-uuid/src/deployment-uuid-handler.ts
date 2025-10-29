// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import type {
  CdkCustomResourceEvent,
  CdkCustomResourceResponse,
  CloudFormationCustomResourceDeleteEvent,
  CloudFormationCustomResourceUpdateEvent,
  Context,
} from "aws-lambda";

import { DeploymentUuidLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/deployment-uuid-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { randomUUID } from "crypto";

const tracer = new Tracer();
const logger = new Logger();

const lambdaHandler = async (
  event: CdkCustomResourceEvent,
  _context: Context,
): Promise<CdkCustomResourceResponse> => {
  switch (event.RequestType) {
    case "Create": {
      return onCreate();
    }
    case "Update":
    case "Delete": {
      return onUpdateOrDelete(event);
    }
  }
};

const onCreate = (): CdkCustomResourceResponse => {
  const uuid = randomUUID();
  return {
    Data: {
      DeploymentUUID: uuid,
    },
    PhysicalResourceId: uuid,
  };
};

const onUpdateOrDelete = (
  event:
    | CloudFormationCustomResourceUpdateEvent
    | CloudFormationCustomResourceDeleteEvent,
): CdkCustomResourceResponse => {
  return {
    Data: {
      DeploymentUUID: event.PhysicalResourceId,
    },
    PhysicalResourceId: event.PhysicalResourceId,
  };
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: DeploymentUuidLambdaEnvironmentSchema,
  moduleName: "deployment-uuid",
}).handler(lambdaHandler);

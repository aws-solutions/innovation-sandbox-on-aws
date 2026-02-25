// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import middy from "@middy/core";
import httpRouterHandler, { Route } from "@middy/http-router";
import { APIGatewayProxyResult } from "aws-lambda";

import { getGlobalConfigForUI } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  ConfigurationLambdaEnvironment,
  ConfigurationLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import apiMiddlewareBundle, {
  IsbApiContext,
  IsbApiEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import {
  ContextWithGlobalAndReportingConfig,
  isbConfigMiddleware,
  isbReportingConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";

const tracer = new Tracer();
const logger = new Logger();

const middyFactory = middy<
  IsbApiEvent,
  any,
  Error,
  ContextWithGlobalAndReportingConfig &
    IsbApiContext<ConfigurationLambdaEnvironment>
>;

const routes: Route<IsbApiEvent, APIGatewayProxyResult>[] = [
  {
    path: "/configurations",
    method: "GET",
    handler: middyFactory().handler(getAllConfigurationsHandler),
  },
];

export const handler = apiMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: ConfigurationLambdaEnvironmentSchema,
})
  .use(isbConfigMiddleware())
  .use(isbReportingConfigMiddleware())
  .handler(httpRouterHandler(routes));

async function getAllConfigurationsHandler(
  _event: IsbApiEvent,
  context: ContextWithGlobalAndReportingConfig &
    IsbApiContext<ConfigurationLambdaEnvironment>,
): Promise<APIGatewayProxyResult> {
  const accountPoolConfigStore = IsbServices.accountPoolStackConfigStore(
    context.env,
  );
  const { isbManagedRegions } = await accountPoolConfigStore.get();

  return {
    statusCode: 200,
    body: JSON.stringify({
      status: "success",
      data: {
        ...getGlobalConfigForUI(context.globalConfig, isbManagedRegions),
        ...context.reportingConfig,
      },
    }),
    headers: {
      "Content-Type": "application/json",
    },
  };
}

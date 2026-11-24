// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import middy from "@middy/core";
import { Context } from "aws-lambda";
import { z } from "zod";

import { BaseLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment.js";
import environmentValidatorMiddleware, {
  ValidatedEnvironment,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { injectLambdaContextWithEventSanitizer } from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";

export type BaseLambdaSchema = z.ZodType<BaseLambdaEnvironment>;

export interface BaseMiddlewareBundleOptions<T extends BaseLambdaSchema> {
  logger: Logger;
  eventLogSanitizer?: (event: unknown) => unknown;
  moduleName: string;
  tracer: Tracer;
  environmentSchema: T;
}

export type IsbLambdaContext<T extends BaseLambdaEnvironment> = Context &
  ValidatedEnvironment<T>;

export default function baseMiddlewareBundle<T extends BaseLambdaSchema>(
  opts: BaseMiddlewareBundleOptions<T>,
): middy.MiddyfiedHandler<unknown, any, Error, IsbLambdaContext<z.infer<T>>> {
  const { logger, tracer, environmentSchema: schema } = opts;

  logger.appendKeys({
    module: opts.moduleName,
  });

  const injectContextOptions = {
    logEvent: process.env.AWS_LAMBDA_LOG_LEVEL === "DEBUG",
    resetKeys: true,
  };
  const contextInjector = opts.eventLogSanitizer
    ? injectLambdaContextWithEventSanitizer(
        logger,
        opts.eventLogSanitizer,
        injectContextOptions,
      )
    : injectLambdaContext(logger, injectContextOptions);

  return middy()
    .use(environmentValidatorMiddleware({ schema, logger }))
    .use(contextInjector)
    .use(captureLambdaHandler(tracer));
}

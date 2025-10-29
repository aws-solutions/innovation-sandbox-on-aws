// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  BaseMiddlewareBundleOptions,
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import environmentValidatorMiddleware from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { httpErrorHandler } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpUrlencodeQueryParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-urlencode-query-parser.js";
import { injectSanitizedLambdaContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";
import {
  IsbUser,
  JSendResponse,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { decodeJwt } from "@amzn/innovation-sandbox-commons/utils/jwt.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { Logger } from "@aws-lambda-powertools/logger";
import { captureLambdaHandler } from "@aws-lambda-powertools/tracer/middleware";
import middy, { MiddlewareObj } from "@middy/core";
import httpEventNormalizer, {
  Event as NormalizedEvent,
} from "@middy/http-event-normalizer";
import httpHeaderNormalizer, {
  Event as NormalizedHeadersEvent,
} from "@middy/http-header-normalizer";
import httpSecurityHeaders from "@middy/http-security-headers";
import {
  APIGatewayEventRequestContextWithAuthorizer,
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  APIGatewayRequestAuthorizerEvent,
} from "aws-lambda";
import createHttpError from "http-errors";
import { Schema, z } from "zod";

type ApiMiddlewareBundleOptions<T extends Schema> = Omit<
  BaseMiddlewareBundleOptions<T>,
  "moduleName"
>;

export type IsbApiEvent = NormalizedHeadersEvent & NormalizedEvent;

export type IsbApiContext<T> = IsbLambdaContext<T> &
  APIGatewayEventRequestContextWithAuthorizer<APIGatewayRequestAuthorizerEvent> & {
    user: IsbUser;
  };

export default function apiMiddlewareBundle<T extends Schema>(
  opts: ApiMiddlewareBundleOptions<T>,
): middy.MiddyfiedHandler<IsbApiEvent, any, Error, IsbApiContext<z.infer<T>>> {
  const { logger, tracer, environmentSchema: schema } = opts;
  logger.resetKeys(); // remove any keys that were added at module load time to avoid different behavior between cold and warm lambda starts

  return middy()
    .use(environmentValidatorMiddleware<z.infer<T>>({ schema, logger }))
    .use(httpHeaderNormalizer())
    .use(httpEventNormalizer())
    .use(httpUrlencodeQueryParser())
    .use(httpSecurityHeaders())
    .use(captureIsbUser())
    .use(captureAPIRequestLogFields(logger))
    .use(
      httpErrorHandler({
        fallbackMessage: JSON.stringify({
          status: "error",
          message: "An unexpected error occurred.",
        } satisfies JSendResponse),
        logger: (error: Error) => {
          logger.error(error.message, { error: error });
        },
      }),
    )
    .use(injectSanitizedLambdaContext(logger))
    .use(captureLambdaHandler(tracer));
}

function captureIsbUser<T extends Schema>(): MiddlewareObj<
  APIGatewayProxyEvent,
  any,
  Error,
  IsbApiContext<T>
> {
  const captureIsbUserBefore: MiddlewareFn<APIGatewayProxyEvent> = (
    request,
  ) => {
    const authorizationHeader = request.event.headers.authorization;
    if (!authorizationHeader) {
      throw new createHttpError.BadRequest(
        "Authorization header is missing from the request.",
      );
    }
    const token = authorizationHeader.split(" ")[1];
    if (!token) {
      throw new createHttpError.BadRequest(
        "token is missing from the Authorization header.",
      );
    }
    const user: IsbUser | null = decodeJwt(token);
    if (user === null) {
      throw new createHttpError.BadRequest(
        "Unable to capture the UserEmail from the Authorization token.",
      );
    }
    Object.assign(request.context, { user });
  };

  return {
    before: captureIsbUserBefore,
  };
}

function captureAPIRequestLogFields<T extends Schema>(
  logger: Logger,
): MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Error,
  IsbApiContext<T>
> {
  const captureAPIRequestLogFieldsBefore: MiddlewareFn<
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
    Error,
    IsbApiContext<T>
  > = async (request): Promise<void> => {
    const { event } = request;

    const { email, roles } = request.context.user;

    logger.appendKeys({
      path: event.path,
      httpMethod: event.httpMethod,
      requestId: event.requestContext.extendedRequestId,
      user: email,
      userGroups: roles,
    });
  };

  return {
    before: captureAPIRequestLogFieldsBefore,
  };
}

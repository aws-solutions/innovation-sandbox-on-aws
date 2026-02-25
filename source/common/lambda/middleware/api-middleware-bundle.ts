// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import {
  BaseMiddlewareBundleOptions,
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import environmentValidatorMiddleware from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  createHttpJSendError,
  httpErrorHandler,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { httpUrlencodeQueryParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-urlencode-query-parser.js";
import { injectSanitizedLambdaContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  IsbUser,
  IsbUserSchema,
  JSendResponse,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { verifyJwt } from "@amzn/innovation-sandbox-commons/utils/jwt.js";
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
import { z } from "zod";

export type BaseApiLambdaSchema = z.ZodType<BaseApiLambdaEnvironment>;

type ApiMiddlewareBundleOptions<T extends BaseApiLambdaSchema> = Omit<
  BaseMiddlewareBundleOptions<T>,
  "moduleName"
>;

export type IsbApiEvent = NormalizedHeadersEvent & NormalizedEvent;

export type IsbApiContext<T extends BaseApiLambdaEnvironment> =
  IsbLambdaContext<T> &
    APIGatewayEventRequestContextWithAuthorizer<APIGatewayRequestAuthorizerEvent> & {
      user: IsbUser;
    };

/**
 * Cache TTL for JWT secret in warm Lambda instances (in seconds).
 *
 * Default SecretsProvider TTL is 5 seconds, but since the JWT secret rotates monthly,
 * we extend the cache to 60 seconds to reduce latency and Secrets Manager API costs.
 *
 * Note: During secret rotation, active user sessions may receive 403 errors and need to re-authenticate.
 */
const POWERTOOLS_PARAMETERS_MAX_AGE = 60;

export default function apiMiddlewareBundle<T extends BaseApiLambdaSchema>(
  opts: ApiMiddlewareBundleOptions<T>,
): middy.MiddyfiedHandler<IsbApiEvent, any, Error, IsbApiContext<z.infer<T>>> {
  const { logger, tracer, environmentSchema: schema } = opts;
  logger.resetKeys(); // remove any keys that were added at module load time to avoid different behavior between cold and warm lambda starts

  return middy()
    .use(environmentValidatorMiddleware({ schema, logger }))
    .use(httpHeaderNormalizer())
    .use(httpEventNormalizer())
    .use(httpUrlencodeQueryParser())
    .use(httpSecurityHeaders())
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
    .use(captureIsbUser())
    .use(captureAPIRequestLogFields(logger))
    .use(injectSanitizedLambdaContext(logger))
    .use(captureLambdaHandler(tracer));
}

function captureIsbUser<T extends BaseApiLambdaEnvironment>(): MiddlewareObj<
  APIGatewayProxyEvent,
  any,
  Error,
  IsbApiContext<T>
> {
  const captureIsbUserBefore: MiddlewareFn<
    APIGatewayProxyEvent,
    any,
    Error,
    IsbApiContext<T>
  > = async (request) => {
    const authorizationHeader = request.event.headers.authorization;
    if (!authorizationHeader) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            { message: "Authorization header is missing from the request." },
          ],
        },
      });
    }

    const match = authorizationHeader.match(/^Bearer\s+(\S+)$/);
    if (!match?.[1]) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: "Authorization header must be in format: Bearer <token>",
            },
          ],
        },
      });
    }
    const token: string = match[1];

    const env = request.context.env;
    const secretsProvider = IsbClients.secretsProvider(env);
    const jwtSecret = await secretsProvider.get(env.JWT_SECRET_NAME, {
      maxAge: POWERTOOLS_PARAMETERS_MAX_AGE,
    });

    if (typeof jwtSecret !== "string") {
      throw new Error("Failed to retrieve JWT secret from Secrets Manager.");
    }

    const jwtVerification = await verifyJwt(jwtSecret, token);
    if (!jwtVerification.verified) {
      throw createHttpJSendError({
        statusCode: 401,
        data: {
          errors: [{ message: "Invalid bearer token." }],
        },
      });
    }

    const userValidation = IsbUserSchema.safeParse(
      jwtVerification.session?.user,
    );
    if (!userValidation.success) {
      throw createHttpJSendError({
        statusCode: 400,
        data: {
          errors: [
            {
              message: "Token payload has invalid user object.",
            },
          ],
        },
      });
    }

    const user: IsbUser = userValidation.data;
    Object.assign(request.context, { user });
  };

  return {
    before: captureIsbUserBefore,
  };
}

function captureAPIRequestLogFields<T extends BaseApiLambdaEnvironment>(
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

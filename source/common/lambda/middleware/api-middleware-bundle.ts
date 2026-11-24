// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import {
  IdentityTokenError,
  readIdentityHeader,
  verifyAndExtractClaims,
} from "@amzn/innovation-sandbox-commons/lambda/auth/identity-token-verifier.js";
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
import { isbConfigMiddleware } from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { rbacAuthorizer } from "@amzn/innovation-sandbox-commons/lambda/middleware/rbac-authorizer.js";
import { JSendResponse } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { parseM2mAssumedRoleArn } from "@amzn/innovation-sandbox-commons/utils/m2m-role-arn.js";
import {
  type IsbUser,
  COGNITO_IDC_USER_ID_CLAIM,
  COGNITO_ISB_ROLES_CLAIM,
  getUserEmail,
  m2mRoleTierToRoles,
  parseRolesClaim,
  resolveEmailFromClaims,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
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
      globalConfig: GlobalConfig;
    };

export default function apiMiddlewareBundle<T extends BaseApiLambdaSchema>(
  opts: ApiMiddlewareBundleOptions<T>,
): middy.MiddyfiedHandler<IsbApiEvent, any, Error, IsbApiContext<z.infer<T>>> {
  const { logger, tracer, environmentSchema: schema } = opts;
  // remove any keys that were added at module load time to avoid different behavior between cold and warm lambda starts
  logger.resetKeys();

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
    .use(isbConfigMiddleware())
    .use(rbacAuthorizer())
    .use(captureAPIRequestLogFields(logger))
    .use(injectSanitizedLambdaContext(logger))
    .use(captureLambdaHandler(tracer, { captureResponse: false }));
}

// Shape of the Cognito ID-token claims relevant to the user-path. The
// verifier returns Record<string, unknown> from JWKS validation; this schema
// narrows the fields we read into typed values without scattered `typeof`
// guards. resolveEmailFromClaims still runs separately because it can pull
// from `cognito:username` when `email` is absent.
const UserClaimsSchema = z.object({
  [COGNITO_IDC_USER_ID_CLAIM]: z.string(),
  [COGNITO_ISB_ROLES_CLAIM]: z.string(),
});

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
    const env = request.context.env;
    const userArn =
      request.event.requestContext?.identity?.userArn ?? undefined;

    // Decide auth path from the IAM principal first, NOT from header presence.
    // Driving path selection from header presence opens a privilege-escalation
    // primitive where an M2M caller attaches a victim's ID token and inherits
    // their roles.
    const m2m = parseM2mAssumedRoleArn(
      userArn,
      env.ISB_NAMESPACE,
      env.HUB_ACCOUNT_ID,
    );

    if (m2m) {
      // Hybrid request guard: M2M IAM principals must NOT carry x-isb-identity.
      if (readIdentityHeader(request.event)) {
        throw createHttpJSendError({
          statusCode: 400,
          errorType: "ValidationError",
          data: {
            errors: [
              {
                message:
                  "x-isb-identity header is not permitted on M2M requests.",
              },
            ],
          },
        });
      }

      const roles = m2mRoleTierToRoles(m2m.roleTier);
      if (roles.length === 0) {
        throw createHttpJSendError({
          statusCode: 403,
          errorType: "AccessDeniedError",
          data: { errors: [{ message: "No valid ISB role on M2M caller." }] },
        });
      }
      const m2mUser: IsbUser = {
        type: "m2m",
        clientId: m2m.clientName,
        roles,
      };
      Object.assign(request.context, { user: m2mUser });
      return;
    }

    // User path: verify the x-isb-identity ID token via JWKS.
    const claims = await verifyAndExtractClaims(request.event, env).catch(
      (err: unknown) => {
        if (err instanceof IdentityTokenError) {
          throw createHttpJSendError({
            statusCode: err.kind === "SubMismatch" ? 403 : 401,
            errorType:
              err.kind === "SubMismatch"
                ? "AccessDeniedError"
                : "UnauthenticatedError",
            data: { errors: [{ message: err.message }] },
          });
        }
        throw err;
      },
    );

    const email = resolveEmailFromClaims(claims);
    const parsedClaims = UserClaimsSchema.safeParse(claims);
    if (!email || !parsedClaims.success) {
      throw createHttpJSendError({
        statusCode: 401,
        errorType: "UnauthenticatedError",
        data: {
          errors: [
            {
              message:
                "Token is missing required claims. Please re-authenticate.",
            },
          ],
        },
      });
    }

    const roles = parseRolesClaim(parsedClaims.data[COGNITO_ISB_ROLES_CLAIM]);
    if (roles.length === 0) {
      throw createHttpJSendError({
        statusCode: 403,
        errorType: "AccessDeniedError",
        data: { errors: [{ message: "No valid ISB role on user token." }] },
      });
    }
    const user: IsbUser = {
      type: "user",
      email,
      userId: parsedClaims.data[COGNITO_IDC_USER_ID_CLAIM],
      roles,
    };
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
    const { user } = request.context;

    logger.appendKeys({
      path: event.path,
      httpMethod: event.httpMethod,
      requestId: event.requestContext.extendedRequestId,
      user: getUserEmail(user),
      userGroups: user.roles,
      authType: user.type,
    });
  };

  return {
    before: captureAPIRequestLogFieldsBefore,
  };
}

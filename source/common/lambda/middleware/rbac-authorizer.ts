// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  type HttpMethod,
  resolveAllowedRoles,
} from "@amzn/innovation-sandbox-commons/lambda/authorization-map.js";
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import type { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent } from "aws-lambda";

// Preserve the middleware module's existing public exports while keeping the
// implementation in the dependency-free authorization-map module.
export {
  getAllowedRoles,
  resolveAllowedRoles,
} from "@amzn/innovation-sandbox-commons/lambda/authorization-map.js";

export function isAllowedInMaintenanceMode(
  user: IsbUser,
  path: string,
  method: string,
): boolean {
  const isGetConfig = method === "GET" && path.startsWith("/configurations");
  return (user.roles?.includes("Admin") ?? false) || isGetConfig;
}

export function rbacAuthorizer<
  T extends BaseApiLambdaEnvironment,
>(): MiddlewareObj<APIGatewayProxyEvent, any, Error, IsbApiContext<T>> {
  const rbacAuthorizerBefore: MiddlewareFn<
    APIGatewayProxyEvent,
    any,
    Error,
    IsbApiContext<T>
  > = async (request) => {
    const { user } = request.context;
    const { path, httpMethod } = request.event;
    const method = httpMethod as HttpMethod;

    const allowedRoles = resolveAllowedRoles(path, method);

    if (allowedRoles.length === 0) {
      throw createHttpJSendError({
        statusCode: 403,
        errorType: "AccessDeniedError",
        data: {
          errors: [{ message: "Access denied." }],
        },
      });
    }

    const userRoles = user.roles ?? [];
    const hasAllowedRole = userRoles.some((role) =>
      allowedRoles.includes(role),
    );

    if (!hasAllowedRole) {
      throw createHttpJSendError({
        statusCode: 403,
        errorType: "AccessDeniedError",
        data: {
          errors: [{ message: "Access denied." }],
        },
      });
    }

    const { globalConfig } = request.context;
    if (globalConfig.maintenance.enabled) {
      if (!isAllowedInMaintenanceMode(user, path, method)) {
        throw createHttpJSendError({
          statusCode: 403,
          errorType: "AccessDeniedError",
          data: {
            errors: [
              {
                message:
                  "System is in maintenance mode. Only Admin users may access the system.",
              },
            ],
          },
        });
      }
    }
  };

  return {
    before: rbacAuthorizerBefore,
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { JSendErrorObject } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent, Context } from "aws-lambda";

export function httpUrlencodeQueryParser(): MiddlewareObj<
  APIGatewayProxyEvent,
  any,
  Error,
  Context
> {
  const httpUrlencodeQueryParserBefore: MiddlewareFn<
    APIGatewayProxyEvent
  > = async (request) => {
    const { queryStringParameters } = request.event;
    if (queryStringParameters) {
      const errors: JSendErrorObject[] = [];
      Object.entries(queryStringParameters).forEach(([key, value]) => {
        if (!value) return;
        try {
          queryStringParameters[key] = decodeURIComponent(value);
        } catch (error) {
          errors.push({
            field: key,
            message: "The query string parameter could not be url decoded.",
          });
        }
      });
      if (errors.length > 0) {
        throw createHttpJSendError({
          statusCode: 400,
          data: {
            errors,
          },
        });
      }
    }
  };

  return {
    before: httpUrlencodeQueryParserBefore,
  };
}

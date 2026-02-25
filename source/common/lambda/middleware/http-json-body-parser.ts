// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { createHttpJSendError } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent, Context } from "aws-lambda";

const mimePattern = /^application\/(.+\+)?json($|;.+)/;

export function httpJsonBodyParser(): MiddlewareObj<
  APIGatewayProxyEvent,
  any,
  Error,
  Context
> {
  const httpJsonBodyParserBefore: MiddlewareFn<APIGatewayProxyEvent> = async (
    request,
  ) => {
    const { headers, body } = request.event;

    const contentType =
      headers?.["Content-Type"] ??
      headers?.["content-type"] ??
      "application/json";

    if (!mimePattern.test(contentType)) {
      throw createHttpJSendError({
        statusCode: 415,
        data: {
          errors: [{ message: `Unsupported Media Type.` }],
        },
      });
    }

    if (body === null) {
      throw createHttpJSendError({
        statusCode: 415,
        data: {
          errors: [{ message: "Body not provided." }],
        },
      });
    }

    try {
      const data = request.event.isBase64Encoded
        ? Buffer.from(body, "base64").toString()
        : body;

      request.event.body = typeof data === "string" ? JSON.parse(data) : data;
    } catch (err) {
      throw createHttpJSendError({
        statusCode: 415,
        data: {
          errors: [{ message: "Invalid JSON in request body. Please check your JSON syntax." }],
        },
      });
    }
  };

  return {
    before: httpJsonBodyParserBefore,
  };
}

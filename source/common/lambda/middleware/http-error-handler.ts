// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { JSendData } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import middleHttpErrorHandler from "@middy/http-error-handler";
import { APIGatewayProxyEvent, Context } from "aws-lambda";
import createHttpError from "http-errors";
import { ZodError } from "zod";

const errorMappings: Record<string, { statusCode: number; message: string }> = {
  AccountNotFoundException: {
    statusCode: 409,
    message:
      "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
  },
  ConcurrentModificationException: {
    statusCode: 409,
    message:
      "Could not move account due to concurrent modification of the organization. Please try again.",
  },
  TooManyRequestsException: {
    statusCode: 429,
    message:
      "Could not move account due to too many requests. Please try again momentarily.",
  },
  // AWS Service Throttling Exceptions
  ThrottlingException: {
    statusCode: 429,
    message: "Too many requests. Please try again later.",
  },
  ProvisionedThroughputExceededException: {
    statusCode: 429,
    message: "Request rate limit exceeded. Please try again later.",
  },
  LimitExceededException: {
    statusCode: 429,
    message: "Rate limit exceeded. Please try again later.",
  },
  RequestLimitExceeded: {
    statusCode: 429,
    message: "Too many requests. Please try again later.",
  },
  BlueprintInUseError: {
    statusCode: 409,
    message: "Cannot delete blueprint - currently in use by lease templates.",
  },
  StackSetNotFoundError: {
    statusCode: 404,
    message: "StackSet not found.",
  },
  UnsupportedPermissionModelError: {
    statusCode: 400,
    message: "StackSet uses unsupported permission model.",
  },
  ZodError: {
    statusCode: 400,
    message: "Invalid Request.",
  },
};

interface Options {
  logger?: ((error: any) => void) | boolean;
  fallbackMessage?: string;
}

export const httpErrorHandler = (
  options: Options,
): MiddlewareObj<APIGatewayProxyEvent, any, Error, Context> => {
  const baseErrorHandler = middleHttpErrorHandler(options);

  const onError: MiddlewareFn<APIGatewayProxyEvent> = async (request) => {
    const { error } = request;

    if (error) {
      let errorMapping = errorMappings[error.name];

      // If error is from a transaction, the underlying error will be present in the "cause" property instead.
      if (!errorMapping && error.cause instanceof Error) {
        errorMapping = errorMappings[error.cause.name];
      }

      if (errorMapping) {
        request.error = createHttpJSendError({
          statusCode: errorMapping.statusCode,
          data: {
            errors: [{ message: errorMapping.message }],
          },
        });
      }
    }

    if (baseErrorHandler.onError) {
      await baseErrorHandler.onError(request);
    }
  };

  return {
    onError,
  };
};
export function createHttpJSendError(props: {
  statusCode: number;
  status?: "fail" | "error";
  message?: string;
  data?: JSendData;
}) {
  const { statusCode, status, message, data } = props;
  return createHttpError(
    statusCode,
    JSON.stringify({
      status: status ?? (statusCode >= 500 ? "error" : "fail"),
      message,
      data,
    }),
  );
}

export function createHttpJSendValidationError(zodErrors: ZodError) {
  return createHttpJSendError({
    statusCode: 400,
    status: "fail",
    data: {
      errors: zodErrors.errors.map((error) => ({
        field: error.path.join(".") || "input",
        message: error.message,
      })),
    },
  });
}


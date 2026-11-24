// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { JSendData } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { MiddlewareObj } from "@middy/core";
import middleHttpErrorHandler from "@middy/http-error-handler";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";
import createHttpError from "http-errors";
import { ZodError } from "zod";

export const modeledErrorTypeHeader = "x-amzn-errortype";

export type ModeledErrorType =
  | "ValidationError"
  | "UnauthenticatedError"
  | "AccessDeniedError"
  | "ConflictError"
  | "UnsupportedMediaTypeError"
  | "InternalServerError";

const modeledErrorTypesByStatus: Partial<Record<number, ModeledErrorType>> = {
  400: "ValidationError",
  401: "UnauthenticatedError",
  403: "AccessDeniedError",
  409: "ConflictError",
  415: "UnsupportedMediaTypeError",
  500: "InternalServerError",
};

const modeledErrorStatusesByType: Record<ModeledErrorType, number> = {
  ValidationError: 400,
  UnauthenticatedError: 401,
  AccessDeniedError: 403,
  ConflictError: 409,
  UnsupportedMediaTypeError: 415,
  InternalServerError: 500,
};

function isModeledErrorType(value: unknown): value is ModeledErrorType {
  return (
    typeof value === "string" &&
    Object.hasOwn(modeledErrorStatusesByType, value)
  );
}

const errorMappings: Record<
  string,
  { statusCode: number; message: string; errorType?: ModeledErrorType }
> = {
  AccountNotFoundException: {
    statusCode: 409,
    message:
      "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
    errorType: "ConflictError",
  },
  ConcurrentModificationException: {
    statusCode: 409,
    message:
      "Could not move account due to concurrent modification of the organization. Please try again.",
    errorType: "ConflictError",
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
    errorType: "ConflictError",
  },
  StackSetNotFoundError: {
    statusCode: 404,
    message: "StackSet not found.",
  },
  UnsupportedPermissionModelError: {
    statusCode: 400,
    message: "StackSet uses unsupported permission model.",
    errorType: "ValidationError",
  },
  ZodError: {
    statusCode: 400,
    message: "Invalid Request.",
    errorType: "ValidationError",
  },
  InvalidPageIdentifierError: {
    statusCode: 400,
    message: "The page identifier is invalid for this request.",
    errorType: "ValidationError",
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

  const onError: MiddlewareFn<
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
    Error,
    Context
  > = async (request) => {
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
          errorType: errorMapping.errorType,
          data: {
            errors: [{ message: errorMapping.message }],
          },
        });
      }
    }

    if (baseErrorHandler.onError) {
      // Cast needed: @middy/http-error-handler expects a broader Request type
      await baseErrorHandler.onError(
        request as Parameters<typeof baseErrorHandler.onError>[0],
      );
    }

    // Middy has converted the error into the legacy HTTP response. To add Smithy
    // dispatch metadata without changing its body or status, accept an explicit
    // x-amzn-errortype only when its modeled status matches the response;
    // otherwise infer the modeled error type from the final HTTP status.
    const statusCode = request.response?.statusCode;
    const explicitErrorType = createHttpError.isHttpError(request.error)
      ? request.error.headers?.[modeledErrorTypeHeader]
      : undefined;
    const validExplicitErrorType =
      isModeledErrorType(explicitErrorType) &&
      modeledErrorStatusesByType[explicitErrorType] === statusCode
        ? explicitErrorType
        : undefined;
    const errorType =
      validExplicitErrorType ??
      (statusCode === undefined
        ? undefined
        : modeledErrorTypesByStatus[statusCode]);
    if (errorType && request.response) {
      request.response.headers = {
        ...request.response.headers,
        [modeledErrorTypeHeader]: errorType,
      };
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
  errorType?: ModeledErrorType;
}) {
  const { statusCode, status, message, data, errorType } = props;
  if (errorType && modeledErrorStatusesByType[errorType] !== statusCode) {
    throw new Error(
      `${errorType} requires HTTP ${modeledErrorStatusesByType[errorType]}, received ${statusCode}`,
    );
  }
  return createHttpError(
    statusCode,
    JSON.stringify({
      status: status ?? (statusCode >= 500 ? "error" : "fail"),
      message,
      data,
    }),
    errorType
      ? {
          headers: {
            [modeledErrorTypeHeader]: errorType,
          },
        }
      : {},
  );
}

export function throwValidationErrorAs400(error: unknown): never {
  if (error instanceof ValidationException) {
    throw createHttpJSendError({
      statusCode: 400,
      data: { errors: [{ field: error.field, message: error.message }] },
    });
  }
  throw error;
}

export function createHttpJSendValidationError(zodErrors: ZodError) {
  return createHttpJSendError({
    statusCode: 400,
    errorType: "ValidationError",
    status: "fail",
    data: {
      errors: zodErrors.issues.map((error) => ({
        field: error.path.join(".") || "input",
        message: error.message,
      })),
    },
  });
}

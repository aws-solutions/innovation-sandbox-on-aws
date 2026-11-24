// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import type { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { MiddlewareObj } from "@middy/core";
import {
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Context,
} from "aws-lambda";

const SENSITIVE_HEADERS = new Set([
  "authorization",
  "x-amz-security-token",
  IDENTITY_HEADER,
]);
const REDACTED_TEXT = "[REDACTED]";

interface ApiGatewayEventSanitizerOptions {
  queryStringParameterAllowlist?: readonly string[];
}

interface LambdaContextOptions {
  logEvent?: boolean;
  resetKeys?: boolean;
}

/**
 * Logs a sanitized event clone, then restores the original event before the
 * remaining middleware and handler run.
 */
export function injectLambdaContextWithEventSanitizer<
  TEvent,
  TResult,
  TContext extends Context,
>(
  logger: any,
  sanitizeEvent: (event: TEvent) => TEvent,
  options?: LambdaContextOptions,
): MiddlewareObj<TEvent, TResult, Error, TContext> {
  const contextInjector = injectLambdaContext(logger, {
    logEvent: true,
    resetKeys: true,
    ...options,
  });

  return {
    ...contextInjector,
    before: async (request) => {
      const originalEvent = request.event;
      request.event = sanitizeEvent(originalEvent);
      try {
        await contextInjector.before?.(request);
      } finally {
        request.event = originalEvent;
      }
    },
  };
}

/**
 * Combined middleware that sanitizes API Gateway events before logging and injects Lambda context.
 * This is a convenience wrapper around AWS Lambda Powertools' injectLambdaContext that ensures
 * sensitive authorization headers are redacted from logs.
 */
export function injectSanitizedLambdaContext<
  T extends BaseApiLambdaEnvironment,
>(
  logger: any,
  options?: LambdaContextOptions,
): MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Error,
  IsbApiContext<T>
> {
  return injectLambdaContextWithEventSanitizer(
    logger,
    sanitizeApiGatewayEvent,
    options,
  );
}

/**
 * Returns a cloned API Gateway event with sensitive headers redacted. Callers
 * can additionally allowlist the query parameters that are safe to log; every
 * other query-string value is then redacted.
 */
export function sanitizeApiGatewayEvent<T>(
  event: T,
  options: ApiGatewayEventSanitizerOptions = {},
): T {
  // Deep clone the event to avoid mutating the original
  const sanitizedEvent = structuredClone(event);
  const sanitizedRecord = sanitizedEvent as Record<string, unknown>;

  const headerLocations = [
    "headers",
    "multiValueHeaders",
    "rawHeaders",
    "rawMultiValueHeaders",
  ] as const;

  for (const key of headerLocations) {
    const headers = sanitizedRecord[key];
    if (headers) {
      sanitizedRecord[key] = sanitizeValues(
        headers as Record<string, string | string[]>,
        (name) => SENSITIVE_HEADERS.has(name.toLowerCase()),
      );
    }
  }

  if (options.queryStringParameterAllowlist) {
    const allowlist = new Set(options.queryStringParameterAllowlist);
    for (const key of [
      "queryStringParameters",
      "multiValueQueryStringParameters",
    ] as const) {
      const queryParameters = sanitizedRecord[key];
      if (queryParameters) {
        sanitizedRecord[key] = sanitizeValues(
          queryParameters as Record<string, string | string[]>,
          (name) => !allowlist.has(name),
        );
      }
    }
  }

  return sanitizedEvent;
}

/**
 * Redacts selected values while preserving the shape of single- and
 * multi-value API Gateway maps.
 */
function sanitizeValues(
  values: Record<string, string | string[]>,
  shouldRedact: (name: string) => boolean,
): Record<string, string | string[]> {
  const sanitized = { ...values };

  for (const [key, value] of Object.entries(sanitized)) {
    if (shouldRedact(key)) {
      if (Array.isArray(value)) {
        sanitized[key] = value.map(() => REDACTED_TEXT);
      } else {
        sanitized[key] = REDACTED_TEXT;
      }
    }
  }

  return sanitized;
}

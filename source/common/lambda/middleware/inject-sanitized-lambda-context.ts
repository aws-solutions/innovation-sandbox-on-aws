// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { MiddlewareFn } from "@aws-lambda-powertools/commons/types";
import { injectLambdaContext } from "@aws-lambda-powertools/logger/middleware";
import { MiddlewareObj } from "@middy/core";
import { APIGatewayProxyEvent, APIGatewayProxyResult } from "aws-lambda";
import { Schema } from "zod";

/**
 * Combined middleware that sanitizes API Gateway events before logging and injects Lambda context.
 * This is a convenience wrapper around AWS Lambda Powertools' injectLambdaContext that ensures
 * sensitive authorization headers are redacted from logs.
 */
export function injectSanitizedLambdaContext<T extends Schema>(
  logger: any,
  options?: { logEvent?: boolean; resetKeys?: boolean },
): MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Error,
  IsbApiContext<T>
> {
  const sanitizer = eventLoggingSanitizer<T>();
  const contextInjector = injectLambdaContext(logger, {
    logEvent: true,
    resetKeys: true,
    ...options,
  });

  return {
    ...contextInjector,
    before: (request) => {
      // First sanitize the event
      if (sanitizer.before) {
        sanitizer.before(request);
      }
      // Then inject the context (which will log the sanitized event)
      if (contextInjector.before) {
        contextInjector.before(request);
      }
    },
  };
}

/**
 * Sanitizes API Gateway events by removing sensitive information like authorization headers
 * before logging to prevent security vulnerabilities.
 */
function sanitizeApiGatewayEvent(
  event: APIGatewayProxyEvent,
): APIGatewayProxyEvent {
  // Deep clone the event to avoid mutating the original
  const sanitizedEvent = JSON.parse(
    JSON.stringify(event),
  ) as APIGatewayProxyEvent;

  const headerLocations = [
    "headers",
    "multiValueHeaders",
    "rawHeaders",
    "rawMultiValueHeaders",
  ] as const;

  for (const key of headerLocations) {
    const headers = (sanitizedEvent as any)[key];
    if (headers) {
      (sanitizedEvent as any)[key] = sanitizeHeaders(headers);
    }
  }

  return sanitizedEvent;
}

/**
 * Generic header sanitization function that automatically handles both single and multi-value headers
 */
function sanitizeHeaders(
  headers: Record<string, string | string[]>,
): Record<string, string | string[]> {
  const sanitized = { ...headers };

  const REDACTED_TEXT = "[REDACTED]";

  for (const [key, value] of Object.entries(sanitized)) {
    if (key.toLowerCase() === "authorization") {
      if (Array.isArray(value)) {
        // Handle array of strings (multiValueHeaders)
        sanitized[key] = value.map(() => REDACTED_TEXT);
      } else {
        // Handle single string (headers)
        sanitized[key] = REDACTED_TEXT;
      }
    }
  }

  return sanitized;
}

/**
 * Middy middleware that sanitizes API Gateway events before logging and restores them afterward.
 * This prevents sensitive authorization headers from being logged by AWS Lambda Powertools.
 */
export function eventLoggingSanitizer<T extends Schema>(): MiddlewareObj<
  APIGatewayProxyEvent,
  APIGatewayProxyResult,
  Error,
  IsbApiContext<T>
> {
  const sanitizeEventBefore: MiddlewareFn<
    APIGatewayProxyEvent,
    APIGatewayProxyResult,
    Error,
    IsbApiContext<T>
  > = (request): void => {
    const originalEvent = request.event;
    const sanitizedEvent = sanitizeApiGatewayEvent(originalEvent);

    (request as any)._originalEvent = originalEvent;

    request.event = sanitizedEvent;
  };

  return {
    before: sanitizeEventBefore,
  };
}

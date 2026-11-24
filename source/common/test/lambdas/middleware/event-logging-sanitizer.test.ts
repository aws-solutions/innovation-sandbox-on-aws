// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  injectLambdaContextWithEventSanitizer,
  injectSanitizedLambdaContext,
  sanitizeApiGatewayEvent,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/inject-sanitized-lambda-context.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { APIGatewayProxyEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

describe("injectSanitizedLambdaContext", () => {
  /**
   * Creates a mock API Gateway event for testing
   */
  const mockBearerToken = "Bearer a.b.c";

  const createMockEvent = (authHeader?: string): APIGatewayProxyEvent =>
    createAPIGatewayProxyEvent({
      headers: authHeader ? { authorization: authHeader } : {},
      multiValueHeaders: authHeader ? { authorization: [authHeader] } : {},
    } as any);

  let logger: Logger;
  let mockRequest: any;

  beforeEach(() => {
    logger = new Logger({ serviceName: "test" });
    mockRequest = {
      event: createMockEvent(mockBearerToken),
      context: {},
      response: {},
    };
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  it("should sanitize authorization headers before logging", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(mockRequest);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

    // Verify that the logged event has sanitized authorization headers
    expect(loggedEvent.headers.authorization).toBe("[REDACTED]");
    if (loggedEvent.multiValueHeaders?.authorization) {
      expect(loggedEvent.multiValueHeaders.authorization).toEqual([
        "[REDACTED]",
      ]);
    }

    // Verify that the original token is NOT present in the logged event
    expect(JSON.stringify(loggedEvent)).not.toContain(mockBearerToken);

    // The handler receives the original event after logging completes.
    expect(mockRequest.event.headers.authorization).toBe(mockBearerToken);
  });

  it.each([
    { auth: "Basic dXNlcjpwYXNzd29yZA==", description: "Basic auth" },
    { auth: "Bearer simple-token", description: "Simple Bearer token" },
  ])(
    "should handle different authorization header types: $description",
    async ({ auth }) => {
      const loggerInfoSpy = vi.spyOn(logger, "info");
      const request = {
        event: createMockEvent(auth),
        context: {},
        response: {},
      } as any;

      const middleware = injectSanitizedLambdaContext(logger);
      await middleware.before!(request);

      const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

      // All authorization headers should be redacted
      expect(loggedEvent.headers.authorization).toBe("[REDACTED]");
      expect(loggedEvent.multiValueHeaders.authorization).toEqual([
        "[REDACTED]",
      ]);
      expect(request.event.headers.authorization).toBe(auth);
    },
  );

  it("should handle case-insensitive authorization headers and rawHeaders", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const event = createMockEvent() as APIGatewayProxyEvent & {
      rawHeaders: Record<string, string>;
      rawMultiValueHeaders: Record<string, string[]>;
    };
    event.headers = { Authorization: mockBearerToken };
    event.multiValueHeaders = { Authorization: [mockBearerToken] };
    // Test rawHeaders and rawMultiValueHeaders as well
    event.rawHeaders = { Authorization: mockBearerToken };
    event.rawMultiValueHeaders = { Authorization: [mockBearerToken] };

    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

    expect(loggedEvent.headers.Authorization).toBe("[REDACTED]");
    expect(loggedEvent.multiValueHeaders.Authorization).toEqual(["[REDACTED]"]);
    // Verify rawHeaders are also sanitized
    expect(loggedEvent.rawHeaders.Authorization).toBe("[REDACTED]");
    expect(loggedEvent.rawMultiValueHeaders.Authorization).toEqual([
      "[REDACTED]",
    ]);
    expect(request.event).toBe(event);
  });

  it("should handle events without authorization headers", async () => {
    const request = {
      event: createMockEvent(), // No auth header
      context: {},
      response: {},
    } as any;

    const middleware = injectSanitizedLambdaContext(logger);
    await middleware.before!(request);

    expect(request.event.headers).toEqual({});
    expect(request.event.multiValueHeaders).toEqual({});
  });

  it("should handle multiple authorization values", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const event = createMockEvent();
    event.multiValueHeaders = {
      authorization: [
        mockBearerToken,
        "Basic dXNlcjpwYXNzd29yZA==",
        "Bearer simple-token",
      ],
    };

    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;
    expect(loggedEvent.multiValueHeaders.authorization).toEqual([
      "[REDACTED]",
      "[REDACTED]",
      "[REDACTED]",
    ]);
    expect(request.event).toBe(event);
  });

  it("should sanitize x-isb-identity headers (Cognito ID token)", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const idToken = "eyJ.fake.idtoken";
    const event = createAPIGatewayProxyEvent({
      headers: { [IDENTITY_HEADER]: idToken, Authorization: "Bearer x" },
    } as any);
    (event as any).multiValueHeaders = {
      "X-ISB-Identity": [idToken],
    };
    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;
    expect(loggedEvent.headers[IDENTITY_HEADER]).toBe("[REDACTED]");
    expect(loggedEvent.multiValueHeaders["X-ISB-Identity"]).toEqual([
      "[REDACTED]",
    ]);
    expect(JSON.stringify(loggedEvent)).not.toContain(idToken);
    expect(request.event).toBe(event);
  });

  it("should sanitize x-amz-security-token headers (SigV4 session token)", async () => {
    const sessionToken = "IQoJb3JpZ2luX2VjEXAMPLEsessiontoken";
    const signedAt = "20260727T000000Z";
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const event = createAPIGatewayProxyEvent({
      headers: {
        authorization: "AWS4-HMAC-SHA256 Credential=AKIAEXAMPLE/20260727",
        "x-amz-security-token": sessionToken,
        "x-amz-date": signedAt,
      },
    } as any);
    (event as any).multiValueHeaders = {
      "X-Amz-Security-Token": [sessionToken],
    };
    (event as any).rawHeaders = { "X-Amz-Security-Token": sessionToken };
    (event as any).rawMultiValueHeaders = {
      "X-Amz-Security-Token": [sessionToken],
    };
    const request = { event, context: {}, response: {} } as any;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;

    expect(loggedEvent.headers["x-amz-security-token"]).toBe("[REDACTED]");
    expect(loggedEvent.multiValueHeaders["X-Amz-Security-Token"]).toEqual([
      "[REDACTED]",
    ]);
    expect(loggedEvent.rawHeaders["X-Amz-Security-Token"]).toBe("[REDACTED]");
    expect(loggedEvent.rawMultiValueHeaders["X-Amz-Security-Token"]).toEqual([
      "[REDACTED]",
    ]);
    expect(JSON.stringify(loggedEvent)).not.toContain(sessionToken);

    // Non-credential SigV4 headers stay readable for log debugging.
    expect(loggedEvent.headers["x-amz-date"]).toBe(signedAt);
  });

  it("should restore the original event after logging", async () => {
    const originalEvent = mockRequest.event;
    const originalAuth = mockRequest.event.headers.authorization;
    const middleware = injectSanitizedLambdaContext(logger);

    await middleware.before!(mockRequest);

    expect(mockRequest.event).toBe(originalEvent);
    expect(mockRequest.event.headers.authorization).toBe(originalAuth);
    expect(mockRequest.event.headers.authorization).toContain(mockBearerToken);
  });

  it("should redact all non-allowlisted query parameters before logging", async () => {
    const loggerInfoSpy = vi.spyOn(logger, "info");
    const idToken = "eyJ.websocket.id-token";
    const signature = "secret-signature";
    const sessionToken = "secret-session-token";
    const event = createMockEvent();
    event.queryStringParameters = {
      "x-isb-identity": idToken,
      "x-isb-protocol-version": "1",
      "X-ISB-PROTOCOL-VERSION": "must-be-redacted",
      "X-Amz-Signature": signature,
      "X-Amz-Security-Token": sessionToken,
    };
    event.multiValueQueryStringParameters = {
      "x-isb-protocol-version": ["1"],
      "X-ISB-PROTOCOL-VERSION": ["must-be-redacted"],
      "X-Amz-Signature": [signature],
    };
    const request = { event, context: {}, response: {} } as any;
    const middleware = injectLambdaContextWithEventSanitizer(
      logger,
      (eventToLog) =>
        sanitizeApiGatewayEvent(eventToLog, {
          queryStringParameterAllowlist: ["x-isb-protocol-version"],
        }),
    );

    await middleware.before!(request);

    const loggedEvent = (loggerInfoSpy.mock.calls[0]![1] as any).event;
    expect(loggedEvent.queryStringParameters).toEqual({
      "x-isb-identity": "[REDACTED]",
      "x-isb-protocol-version": "1",
      "X-ISB-PROTOCOL-VERSION": "[REDACTED]",
      "X-Amz-Signature": "[REDACTED]",
      "X-Amz-Security-Token": "[REDACTED]",
    });
    expect(loggedEvent.multiValueQueryStringParameters).toEqual({
      "x-isb-protocol-version": ["1"],
      "X-ISB-PROTOCOL-VERSION": ["[REDACTED]"],
      "X-Amz-Signature": ["[REDACTED]"],
    });
    expect(JSON.stringify(loggedEvent)).not.toContain(idToken);
    expect(JSON.stringify(loggedEvent)).not.toContain(signature);
    expect(JSON.stringify(loggedEvent)).not.toContain(sessionToken);
    expect(request.event).toBe(event);
    expect(request.event.queryStringParameters["x-isb-identity"]).toBe(idToken);
  });
});

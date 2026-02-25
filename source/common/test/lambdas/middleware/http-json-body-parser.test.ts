// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for JSON body parser middleware
 * Tests core JSON parsing logic only.
 * Integration tests verify middleware is properly applied to handlers.
 */

import { httpJsonBodyParser } from "@amzn/innovation-sandbox-commons/lambda/middleware/http-json-body-parser.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { describe, expect, it } from "vitest";

describe("httpJsonBodyParser", () => {
  const middleware = httpJsonBodyParser();

  it("should parse valid JSON", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/test",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ name: "test", value: 123 }),
      }),
    };

    await middleware.before!(request as any);
    expect(request.event.body).toEqual({ name: "test", value: 123 });
  });

  it("should return 415 for malformed JSON", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/test",
        headers: { "content-type": "application/json" },
        body: '{"name": "test"', // Unclosed brace
      }),
    };

    await expect(middleware.before!(request as any)).rejects.toMatchObject({
      statusCode: 415,
      message: expect.stringContaining("Invalid JSON"),
    });
  });

  it("should return 415 for non-JSON content type", async () => {
    const request = {
      event: createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/test",
        headers: { "content-type": "text/plain" },
        body: "plain text",
      }),
    };

    await expect(middleware.before!(request as any)).rejects.toMatchObject({
      statusCode: 415,
    });
  });
});


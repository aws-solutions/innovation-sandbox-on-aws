// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for HTTP error handler middleware
 * Tests Zod error message enhancements and throttling error mappings.
 * Integration tests verify complete error handling flow through handlers.
 */

import {
  createHttpJSendValidationError,
  httpErrorHandler,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/http-error-handler.js";
import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("createHttpJSendValidationError", () => {
  it("should handle type mismatch errors", () => {
    const schema = z.object({ age: z.number() });
    const result = schema.safeParse({ age: "not-a-number" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = createHttpJSendValidationError(result.error);
      expect(error.statusCode).toBe(400);
      expect(JSON.parse(error.message)).toMatchObject({
        status: "fail",
        data: {
          errors: [
            {
              field: "age",
              message: "Expected number, received string",
            },
          ],
        },
      });
    }
  });

  it("should handle string length violations", () => {
    const schema = z.object({ name: z.string().min(3) });
    const result = schema.safeParse({ name: "ab" });

    expect(result.success).toBe(false);
    if (!result.success) {
      const error = createHttpJSendValidationError(result.error);
      const parsed = JSON.parse(error.message);
      expect(parsed.data.errors[0]).toMatchObject({
        field: "name",
        message: "String must contain at least 3 character(s)",
      });
    }
  });
});

describe("httpErrorHandler - Error Mappings", () => {
  const middleware = httpErrorHandler({ logger: false });

  describe("AWS Service Throttling (429)", () => {
    it("should map ThrottlingException to 429", async () => {
      const error = new Error("Rate exceeded");
      error.name = "ThrottlingException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Too many requests");
    });

    it("should map ProvisionedThroughputExceededException to 429", async () => {
      const error = new Error("Throughput exceeded");
      error.name = "ProvisionedThroughputExceededException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Request rate limit exceeded");
    });

    it("should map LimitExceededException to 429", async () => {
      const error = new Error("Limit exceeded");
      error.name = "LimitExceededException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Rate limit exceeded");
    });

    it("should map RequestLimitExceeded to 429", async () => {
      const error = new Error("Request limit exceeded");
      error.name = "RequestLimitExceeded";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Too many requests");
    });

    it("should map TooManyRequestsException to 429", async () => {
      const error = new Error("Too many requests");
      error.name = "TooManyRequestsException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Could not move account");
    });
  });

  describe("Conflict Errors (409)", () => {
    it("should map AccountNotFoundException to 409", async () => {
      const error = new Error("Account not found");
      error.name = "AccountNotFoundException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 409,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("account could not be found");
    });

    it("should map ConcurrentModificationException to 409", async () => {
      const error = new Error("Concurrent modification");
      error.name = "ConcurrentModificationException";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 409,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("concurrent modification");
    });

    it("should map BlueprintInUseError to 409", async () => {
      const error = new Error("Blueprint in use");
      error.name = "BlueprintInUseError";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 409,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Cannot delete blueprint");
    });
  });

  describe("Not Found Errors (404)", () => {
    it("should map StackSetNotFoundError to 404", async () => {
      const error = new Error("StackSet not found");
      error.name = "StackSetNotFoundError";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 404,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("StackSet not found");
    });
  });

  describe("Bad Request Errors (400)", () => {
    it("should map UnsupportedPermissionModelError to 400", async () => {
      const error = new Error("Unsupported permission model");
      error.name = "UnsupportedPermissionModelError";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 400,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("unsupported permission model");
    });

    it("should map ZodError to 400", async () => {
      const error = new Error("Validation failed");
      error.name = "ZodError";

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 400,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toBe("Invalid Request.");
    });
  });

  describe("Transaction Error Handling", () => {
    it("should handle throttling error in transaction cause", async () => {
      const cause = new Error("Rate exceeded");
      cause.name = "ThrottlingException";

      const error = new Error("Transaction failed");
      (error as any).cause = cause;

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 429,
      });

      const parsed = JSON.parse((request.error as any).message);
      expect(parsed.data.errors[0].message).toContain("Too many requests");
    });

    it("should handle conflict error in transaction cause", async () => {
      const cause = new Error("Account not found");
      cause.name = "AccountNotFoundException";

      const error = new Error("Transaction failed");
      (error as any).cause = cause;

      const request = {
        error,
        response: {},
      };

      await middleware.onError!(request as any);

      expect(request.error).toMatchObject({
        statusCode: 409,
      });
    });
  });
});


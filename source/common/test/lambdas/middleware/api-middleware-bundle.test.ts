// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for API middleware bundle
 * Tests JWT secret fetching from Secrets Manager and user authentication flow.
 */

import {
  GetSecretValueCommand,
  SecretsManagerClient,
} from "@aws-sdk/client-secrets-manager";
import { mockClient } from "aws-sdk-client-mock";
import jwt from "jsonwebtoken";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BaseApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import apiMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { createAPIGatewayProxyEvent } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";

const secretsManagerMock = mockClient(SecretsManagerClient);

const testEnv = generateSchemaData(BaseApiLambdaEnvironmentSchema);

const testUser: IsbUser = {
  email: "test@example.com",
  userId: "test-user-id",
  roles: ["Admin"],
};

const jwtSecret = "test-secret-key";

describe("apiMiddlewareBundle", () => {
  let logger: Logger;
  let tracer: Tracer;

  beforeEach(() => {
    logger = new Logger({ serviceName: "test" });
    tracer = new Tracer({ serviceName: "test" });
    bulkStubEnv(testEnv);
  });

  /**
   * Helper function to create a middleware handler with test configuration
   */
  const createHandler = (
    handlerFn: (event: any, context: any) => Promise<any>,
  ) => {
    return apiMiddlewareBundle({
      logger,
      tracer,
      environmentSchema: BaseApiLambdaEnvironmentSchema,
    }).handler(handlerFn);
  };

  afterEach(() => {
    secretsManagerMock.reset();
    IsbClients.secretsProvider(testEnv).clearCache();
    vi.clearAllMocks();
    vi.unstubAllEnvs();
  });

  describe("Successful JWT validation", () => {
    it("should fetch JWT secret from Secrets Manager and validate token", async () => {
      // Mock Secrets Manager to return JWT secret
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const token = jwt.sign({ user: testUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async (_event, context) => {
        // Verify user is attached to context
        expect(context.user).toEqual(testUser);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(200);
      expect(secretsManagerMock.calls()).toHaveLength(1);
      expect(secretsManagerMock.call(0).args[0].input).toMatchObject({
        SecretId: testEnv.JWT_SECRET_NAME,
      });
    });

    it("should handle valid token with minimal user roles", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const minimalUser: IsbUser = {
        email: "user@example.com",
        userId: "user-id",
        roles: ["User"],
      };

      const token = jwt.sign({ user: minimalUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async (_event, context) => {
        expect(context.user).toEqual(minimalUser);
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(200);
    });
  });

  describe("Missing Authorization header", () => {
    it("should return 400 when Authorization header is missing", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {},
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain(
        "Authorization header is missing",
      );
    });
  });

  describe("Invalid Authorization header format", () => {
    it("should return 400 when Authorization header is not in Bearer format", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: "InvalidFormat token123",
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain("Bearer <token>");
    });

    it("should return 400 when Bearer token is empty", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: "Bearer ",
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain("Bearer <token>");
    });
  });

  describe("Secrets Manager failures", () => {
    it("should return 500 when Secrets Manager returns non-string value", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretBinary: new Uint8Array([1, 2, 3]),
      });

      const token = jwt.sign({ user: testUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("error");
      expect(body.message).toContain("An unexpected error occurred");
    });

    it("should return 500 when Secrets Manager throws error", async () => {
      secretsManagerMock
        .on(GetSecretValueCommand)
        .rejects(new Error("Secrets Manager unavailable"));

      const token = jwt.sign({ user: testUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(500);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("error");
      expect(body.message).toContain("An unexpected error occurred");
    });
  });

  describe("Invalid JWT tokens", () => {
    it("should return 401 when token signature is invalid", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const token = jwt.sign({ user: testUser }, "wrong-secret");
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain("Invalid bearer token");
    });

    it("should return 401 when token is expired", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const token = jwt.sign({ user: testUser }, jwtSecret, {
        expiresIn: "-1h",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain("Invalid bearer token");
    });

    it("should return 401 when token is malformed", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: "Bearer not.a.valid.jwt",
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(401);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain("Invalid bearer token");
    });
  });

  describe("Invalid user payload", () => {
    it("should return 400 when user email is missing", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const invalidUser = {
        userId: "test-id",
        roles: ["User"],
        // email is missing
      };

      const token = jwt.sign({ user: invalidUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.status).toBe("fail");
      expect(body.data.errors[0].message).toContain(
        "Token payload has invalid user object.",
      );
    });

    it("should return 400 when user object is missing entirely", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const token = jwt.sign({ someOtherData: "value" }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain(
        "Token payload has invalid user object.",
      );
    });

    it("should return 400 when user roles is not an array", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const invalidUser = {
        email: "test@example.com",
        userId: "test-id",
        roles: "User", // Should be array
      };

      const token = jwt.sign({ user: invalidUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      const response = await handler(event, {} as any);

      expect(response.statusCode).toBe(400);
      const body = JSON.parse(response.body);
      expect(body.data.errors[0].message).toContain(
        "Token payload has invalid user object.",
      );
    });
  });

  describe("Logger context enrichment", () => {
    it("should append user and request details to logger", async () => {
      secretsManagerMock.on(GetSecretValueCommand).resolves({
        SecretString: jwtSecret,
      });

      const token = jwt.sign({ user: testUser }, jwtSecret);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/api/test",
        headers: {
          authorization: `Bearer ${token}`,
        },
      });

      const appendKeysSpy = vi.spyOn(logger, "appendKeys");

      const handler = createHandler(async () => {
        return {
          statusCode: 200,
          body: JSON.stringify({ message: "success" }),
        };
      });

      await handler(event, {} as any);

      expect(appendKeysSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          path: "/api/test",
          httpMethod: "POST",
          user: testUser.email,
          userGroups: testUser.roles,
        }),
      );
    });
  });
});

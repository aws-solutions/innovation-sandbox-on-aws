// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import jwt from "jsonwebtoken";
import { describe, expect, it, vi } from "vitest";

import {
  extractMethodAndPathFromArn,
  extractMethodAndPathFromArnWithPathParameterEnd,
  extractMethodAndPathFromArnWithPathParameterMiddle,
  isAuthorized,
} from "@amzn/innovation-sandbox-authorizer/authorization.js";
import { AuthorizerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/authorizer-lambda-environment.js";
import { IsbSecretsManagerClient } from "@amzn/innovation-sandbox-commons/sdk-clients/secrets-manager-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";

const testEnv = generateSchemaData(AuthorizerLambdaEnvironmentSchema);
const testContext = {
  logger: new Logger(),
  tracer: new Tracer(),
  env: testEnv,
};

describe("authorization", () => {
  const methodArnPrefix =
    "arn:aws:execute-api:us-east-1:123456789012:aaaaaaaaaa/prod";
  const jwtSecret = "testJwtSecret";
  vi.spyOn(
    IsbSecretsManagerClient.prototype,
    "getStringSecret",
  ).mockReturnValue(Promise.resolve(jwtSecret));
  const testUserBase: IsbUser = {
    userId: "testUserId",
    email: "test@example.com",
    roles: [],
  };

  it("extract method and path from method ARN", () => {
    let result = extractMethodAndPathFromArn(methodArnPrefix + "/GET/leases");
    expect(result).toEqual({
      method: "GET",
      path: "/leases",
    });

    result = extractMethodAndPathFromArn(methodArnPrefix + "/GET/leases/");
    expect(result).toEqual({
      method: "GET",
      path: "/leases",
    });

    result = extractMethodAndPathFromArn(methodArnPrefix + "/POST/v2/leases");
    expect(result).toEqual({
      method: "POST",
      path: "/v2/leases",
    });

    result = extractMethodAndPathFromArn("Invalid value");
    expect(result).toBeNull();

    result = extractMethodAndPathFromArn(methodArnPrefix + "/GET/");
    expect(result).toBeNull();
  });

  it("extract method and path from method ARN with path parameter at the end", () => {
    let result = extractMethodAndPathFromArnWithPathParameterEnd(
      methodArnPrefix + "/PUT/leases/Lease101",
    );
    expect(result).toEqual({
      method: "PUT",
      path: "/leases/{param}",
    });
    result = extractMethodAndPathFromArnWithPathParameterEnd(
      methodArnPrefix + "/GET/v2/leases/Lease101",
    );
    expect(result).toEqual({
      method: "GET",
      path: "/v2/leases/{param}",
    });
    result = extractMethodAndPathFromArnWithPathParameterEnd(
      methodArnPrefix + "/GET/v2/accounts/1234/eject",
    );
    expect(result).toEqual({
      method: "GET",
      path: "/v2/accounts/1234/{param}",
    });
    result = extractMethodAndPathFromArnWithPathParameterEnd(
      methodArnPrefix + "/PUT/leases",
    );
    expect(result).toBeNull();
  });

  it("extract method and path from method ARN with path parameter in the middle", () => {
    let result = extractMethodAndPathFromArnWithPathParameterMiddle(
      methodArnPrefix + "/POST/accounts/1234/recyle",
    );
    expect(result).toEqual({
      method: "POST",
      path: "/accounts/{param}/recyle",
    });
    result = extractMethodAndPathFromArnWithPathParameterMiddle(
      methodArnPrefix + "/POST/V2/accounts/1234/recyle",
    );
    expect(result).toEqual({
      method: "POST",
      path: "/V2/accounts/{param}/recyle",
    });
    result = extractMethodAndPathFromArnWithPathParameterMiddle(
      methodArnPrefix + "/PUT/accounts",
    );
    expect(result).toBeNull();
  });

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: true },
  ] as const)(
    "GET /leases authorization for $role",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/leases";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: role ? [role] : [],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: true },
  ] as const)(
    "POST /leases authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/leases";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: true },
  ] as const)(
    "GET /configurations authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/configurations";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: role ? [role] : [],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: true },
  ] as const)(
    "GET /leases/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/leases/Lease101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: role ? [role] : [],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "PATCH /leases/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/PATCH/leases/Lease101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: role ? [role] : [],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "User", authorized: false },
    { role: "Manager", authorized: false },
    { role: "Admin", authorized: false },
  ] as const)(
    "PUT /leases/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/PUT/leases/Lease101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Manager", authorized: true },
    { role: "Admin", authorized: true },
    { role: "User", authorized: true },
  ] as const)(
    "GET /leaseTemplates/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/leaseTemplates/Lease101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "User", authorized: false },
    { role: "Manager", authorized: true },
  ] as const)(
    "PUT /leaseTemplates/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/PUT/leaseTemplates/Lease101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([{ role: "Admin", authorized: true }] as const)(
    "POST /accounts/{param}/eject authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/accounts/123456789012/eject";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([{ role: "Admin", authorized: false }] as const)(
    "PUT /accounts/{param}/eject authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/PUT/accounts/123456789012/eject";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([{ role: "Manager", authorized: false }] as const)(
    "POST /accounts/{param}/eject authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/accounts/123456789012/eject";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "POST /leases/{param}/unfreeze authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/leases/Lease101/unfreeze";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "POST /leases/{param}/review authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/leases/Lease101/review";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "POST /leases/{param}/terminate authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/leases/Lease101/terminate";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "POST /leases/{param}/freeze authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/leases/Lease101/freeze";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Manager", authorized: true },
    { role: "Admin", authorized: true },
  ] as const)(
    "DELETE /leaseTemplates/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/DELETE/leaseTemplates/Template101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  // Blueprint endpoint authorization tests
  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "GET /blueprints authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/blueprints";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: false },
    { role: "User", authorized: false },
  ] as const)(
    "POST /blueprints authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/POST/blueprints";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "GET /blueprints/stacksets authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/blueprints/stacksets";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: true },
    { role: "User", authorized: false },
  ] as const)(
    "GET /blueprints/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/GET/blueprints/Blueprint101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: false },
    { role: "User", authorized: false },
  ] as const)(
    "PUT /blueprints/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/PUT/blueprints/Blueprint101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it.each([
    { role: "Admin", authorized: true },
    { role: "Manager", authorized: false },
    { role: "User", authorized: false },
  ] as const)(
    "DELETE /blueprints/{param} authorization for $role -> expected: $authorized",
    async ({ role, authorized }) => {
      const methodArn = methodArnPrefix + "/DELETE/blueprints/Blueprint101";
      const testUser: IsbUser = {
        ...testUserBase,
        roles: [role],
      };
      const authorizationToken = jwt.sign({ user: testUser }, jwtSecret);
      expect(
        await isAuthorized({ methodArn, authorizationToken }, testContext),
      ).toEqual(authorized);
    },
  );

  it("should not authorize if token is invalid", async () => {
    const methodArn = methodArnPrefix + "/GET/leases";
    const authorizationToken = "invalid token";
    expect(
      await isAuthorized({ methodArn, authorizationToken }, testContext),
    ).toEqual(false);
  });
});

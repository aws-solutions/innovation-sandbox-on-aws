// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
} from "@aws-sdk/client-appconfigdata";
import { Uint8ArrayBlobAdapter } from "@smithy/util-stream";
import { mockClient } from "aws-sdk-client-mock";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { GlobalConfigSchema } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { AuthorizerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/authorizer-lambda-environment.js";
import { EnvironmentValidatorError } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  isbAuthorizedUser,
  mockContext,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { APIGatewayRequestAuthorizerEvent } from "aws-lambda";
import yaml from "js-yaml";
import jwt from "jsonwebtoken";

vi.mock("@amzn/innovation-sandbox-authorizer/authorization.js");

let testEnv = generateSchemaData(AuthorizerLambdaEnvironmentSchema);
let handler: typeof import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js").handler;

const mockedGlobalConfig = generateSchemaData(GlobalConfigSchema, {
  maintenanceMode: false,
});

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig);
});

afterEach(() => {
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("handler", async () => {
  const event: Omit<APIGatewayRequestAuthorizerEvent, "requestContext"> = {
    type: "REQUEST",
    headers: {
      Authorization: `Bearer ${isbAuthorizedUser.token}`,
    },
    path: "abcdef123/test",
    httpMethod: "GET",
    multiValueHeaders: null,
    multiValueQueryStringParameters: null,
    queryStringParameters: null,
    stageVariables: null,
    pathParameters: null,
    resource: "abcdef123/test",
    methodArn: "arn:aws:execute-api:us-west-2:123456789012:abcdef123/test/GET/",
  };

  it("should throw error when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();

    await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
      EnvironmentValidatorError,
    );
  });

  it("returns authorized response when authorization succeeds", async () => {
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(true);
    expect(await handler(event, mockContext(testEnv))).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
          },
        ],
      },
    });
  });
  it("returns unauthorized response when authorization fails", async () => {
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(false);
    expect(await handler(event, mockContext(testEnv))).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
          },
        ],
      },
    });
  });
  it("returns unauthorized response when decoding the token fails", async () => {
    expect(await handler(event, mockContext(testEnv))).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
          },
        ],
      },
    });
  });
  it("always returns unauthorized response when maintenance mode is true, is admin and unauthorized", async () => {
    const mockedClient = mockClient(AppConfigDataClient);
    mockedClient.on(GetLatestConfigurationCommand).resolves(
      Promise.resolve({
        ContentType: "application/json",
        Configuration: Uint8ArrayBlobAdapter.fromString(
          JSON.stringify(
            generateSchemaData(GlobalConfigSchema, {
              maintenanceMode: true,
            }),
          ),
        ),
        NextPollConfigurationToken: "nextPollConfigurationToken",
      }),
    );
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(false);
    handler = (
      await import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js")
    ).handler;
    expect(await handler(event, mockContext(testEnv))).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
          },
        ],
      },
    });
  });
  it("always returns unauthorized response when maintenance mode is true, is non admin and not GET /configurations", async () => {
    global.fetch = vi.fn().mockImplementation(() => {
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(
            yaml.dump({
              ...mockedGlobalConfig,
              maintenanceMode: true,
            }),
          ),
      } as unknown as Response);
    });
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(true);
    handler = (
      await import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js")
    ).handler;

    const nonAdminUser: IsbUser = {
      email: "test@example.com",
      userId: "testUserId",
      roles: ["Manager", "User"],
    };
    const token = jwt.sign({ user: nonAdminUser }, "testSecret");
    expect(
      await handler(
        {
          ...event,
          headers: { Authorization: `Bearer ${token}` },
        },
        mockContext(testEnv),
      ),
    ).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
          },
        ],
      },
    });
  });
  it("always returns authorized response when maintenance mode is true and GET /configurations", async () => {
    const mockedClient = mockClient(AppConfigDataClient);
    mockedClient.on(GetLatestConfigurationCommand).resolves(
      Promise.resolve({
        ContentType: "application/json",
        Configuration: Uint8ArrayBlobAdapter.fromString(
          JSON.stringify(
            generateSchemaData(GlobalConfigSchema, {
              maintenanceMode: true,
            }),
          ),
        ),
        NextPollConfigurationToken: "nextPollConfigurationToken",
      }),
    );
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(true);
    authorization.extractMethodAndPathFromArn = vi.fn().mockReturnValue({
      method: "GET",
      path: "/configurations",
    });
    handler = (
      await import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js")
    ).handler;

    const nonAdminUser: IsbUser = {
      email: "test@example.com",
      userId: "testUserId",
      roles: ["Manager", "User"],
    };
    const token = jwt.sign({ user: nonAdminUser }, "testSecret");
    expect(
      await handler(
        {
          ...event,
          methodArn:
            "arn:aws:execute-api:us-west-2:123456789012:abcdef123/test/GET/configurations",
          authorizationToken: `Bearer ${token}`,
        },
        mockContext(testEnv),
      ),
    ).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
          },
        ],
      },
    });
  });
  it("always returns authorized response when maintenance mode is true, is admin and authorized", async () => {
    const mockedClient = mockClient(AppConfigDataClient);
    mockedClient.on(GetLatestConfigurationCommand).resolves(
      Promise.resolve({
        ContentType: "application/json",
        Configuration: Uint8ArrayBlobAdapter.fromString(
          JSON.stringify(
            generateSchemaData(GlobalConfigSchema, {
              maintenanceMode: true,
            }),
          ),
        ),
        NextPollConfigurationToken: "nextPollConfigurationToken",
      }),
    );
    const authorization =
      await import("@amzn/innovation-sandbox-authorizer/authorization.js");
    authorization.isAuthorized = vi.fn().mockReturnValue(true);
    handler = (
      await import("@amzn/innovation-sandbox-authorizer/authorizer-handler.js")
    ).handler;
    expect(await handler(event, mockContext(testEnv))).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Allow",
          },
        ],
      },
    });
  });
  it("always returns unauthorized response when Bearer prefix is invalid", async () => {
    expect(
      await handler(
        {
          ...event,
          authorizationToken: "InvalidPrefix token123",
        },
        mockContext(testEnv),
      ),
    ).toMatchObject({
      policyDocument: {
        Statement: [
          {
            Action: "execute-api:Invoke",
            Effect: "Deny",
          },
        ],
      },
    });
  });
});

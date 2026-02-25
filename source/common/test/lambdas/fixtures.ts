// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Event as NormalizedEvent } from "@middy/http-event-normalizer";
import { Event as NormalizedHeaderEvent } from "@middy/http-header-normalizer";
import jwt from "jsonwebtoken";

import {
  GlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import {
  ReportingConfig,
  ReportingConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/reporting-config/reporting-config.js";
import { BaseApiLambdaEnvironment } from "@amzn/innovation-sandbox-commons/lambda/environments/base-api-lambda-environment.js";
import { IsbApiContext } from "@amzn/innovation-sandbox-commons/lambda/middleware/api-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  ContextWithGlobalAndReportingConfig,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  IsbUser,
  JSendErrorObject,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  APIGatewayEventIdentity,
  APIGatewayRequestAuthorizerEvent,
  CognitoIdentity,
} from "aws-lambda";
import { randomUUID } from "crypto";

interface CreateAPIGatewayProxyEventProps {
  httpMethod: string;
  path: string;
  body?: string;
  pathParameters?: { [key: string]: string };
  queryStringParameters?: { [key: string]: string };
  headers?: { [key: string]: string };
}

export const createAPIGatewayProxyEvent = (
  props: CreateAPIGatewayProxyEventProps,
): NormalizedEvent & NormalizedHeaderEvent => {
  return {
    body: null,
    headers: {},
    rawHeaders: {},
    multiValueHeaders: {},
    pathParameters: {},
    stageVariables: null,
    isBase64Encoded: false,
    queryStringParameters: {},
    multiValueQueryStringParameters: {},
    resource: "resource",
    requestContext: {
      accountId: "000000000000",
      apiId: "apiId",
      authorizer: null,
      httpMethod: props.httpMethod,
      identity: {
        accessKey: null,
        accountId: null,
        caller: null,
        cognitoAuthenticationProvider: null,
        cognitoAuthenticationType: null,
        cognitoIdentityId: null,
        cognitoIdentityPoolId: null,
        principalOrgId: null,
        sourceIp: "0.0.0.0",
        user: null,
        userAgent: null,
        userArn: null,
        clientCert: null,
        apiKey: null,
        apiKeyId: null,
      },
      protocol: "protocol",
      path: "path",
      stage: "stage",
      requestId: "requestId",
      requestTime: "requestTime",
      requestTimeEpoch: 1,
      resourceId: "resourceId",
      resourcePath: "resourcePath",
    },
    ...props,
  };
};

export const responseHeaders = {
  "Origin-Agent-Cluster": "?1",
  "Referrer-Policy": "no-referrer",
  "Strict-Transport-Security": "max-age=15552000; includeSubDomains; preload",
  "X-Content-Type-Options": "nosniff",
  "X-DNS-Prefetch-Control": "off",
  "X-Download-Options": "noopen",
  "X-Permitted-Cross-Domain-Policies": "none",
  "Content-Type": "application/json",
};

const isbUser: IsbUser = {
  email: "test@example.com",
  userId: "testUserId",
  roles: ["Admin", "Manager", "User"],
};

export const isbAuthorizedUser = {
  user: isbUser,
  token: jwt.sign({ user: isbUser }, "testSecret"),
};

const isbUserUserRoleOnly: IsbUser = {
  email: "test@example.com",
  userId: "testUserId",
  roles: ["User"],
};

export const isbAuthorizedUserUserRoleOnly = {
  user: isbUserUserRoleOnly,
  token: jwt.sign({ user: isbUserUserRoleOnly }, "testSecret"),
};

export function mockContext<T>(
  env: T,
  globalConfig?: GlobalConfig,
): ContextWithConfig & ValidatedEnvironment<T> {
  return {
    env,
    globalConfig: globalConfig ?? generateSchemaData(GlobalConfigSchema),
    functionName: "testFunc",
    awsRequestId: "",
    callbackWaitsForEmptyEventLoop: false,
    functionVersion: "test",
    invokedFunctionArn: "myFuncArn",
    logGroupName: "myLogGroup",
    logStreamName: "myLogStream",
    memoryLimitInMB: "200",
    done(_error?: Error, _result?: any): void {},
    fail(_error: Error | string): void {},
    getRemainingTimeInMillis(): number {
      return 100;
    },
    succeed(_message: any, _object?: any): void {},
  };
}

export function mockAuthorizedContext<T extends BaseApiLambdaEnvironment>(
  env: T,
  globalConfig?: GlobalConfig,
  reportingConfig?: ReportingConfig,
): IsbApiContext<T> & ContextWithGlobalAndReportingConfig {
  return {
    ...mockContext(env, globalConfig),
    ...isbAuthorizedUser,
    reportingConfig:
      reportingConfig ?? generateSchemaData(ReportingConfigSchema),
    accountId: "000000000000",
    apiId: "test-api-id",
    protocol: "HTTP/1.1",
    httpMethod: "GET",
    path: "/test-path",
    stage: "test-stage",
    requestId: "test-request-id",
    requestTimeEpoch: 0,
    resourceId: "test-resource-id",
    resourcePath: "/test-resource-path",
    authorizer: {} as APIGatewayRequestAuthorizerEvent,
    identity: {} as CognitoIdentity & APIGatewayEventIdentity,
  };
}

export function createFailureResponseBody(...errors: JSendErrorObject[]) {
  return JSON.stringify({
    status: "fail",
    data: {
      errors,
    },
  });
}

export function createErrorResponseBody(message: string) {
  return JSON.stringify({
    status: "error",
    message,
  });
}

export function createEventBridgeEvent(detailType: string, detail: object) {
  return {
    version: "0",
    id: randomUUID(),
    "detail-type": detailType,
    source: "InnovationSandbox-myisb",
    account: "123456789012",
    time: nowAsIsoDatetimeString(),
    region: "us-east-1",
    resources: [],
    detail: {
      ...detail,
    },
  };
}

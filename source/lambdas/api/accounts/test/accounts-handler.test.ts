// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  Account,
  AccountNotFoundException,
  ConcurrentModificationException,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import {
  GlobalConfig,
  GlobalConfigSchema,
} from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  AccountInCleanUpError,
  AccountNotInQuarantineError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  mockAuthorizedContext,
  responseHeaders,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";

const testEnv = generateSchemaData(AccountLambdaEnvironmentSchema, {
  ORG_MGT_ACCOUNT_ID: "000000000000",
  IDC_ACCOUNT_ID: "111111111111",
  HUB_ACCOUNT_ID: "222222222222",
});
let mockedGlobalConfig: GlobalConfig;
let handler: typeof import("@amzn/innovation-sandbox-accounts/accounts-handler.js").handler;

beforeAll(async () => {
  handler = (
    await import("@amzn/innovation-sandbox-accounts/accounts-handler.js")
  ).handler;
  mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);
  mockedGlobalConfig.leases.ttl = 0;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig);
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("Accounts Handler", () => {
  it("should return 500 response when environment variables are misconfigured", async () => {
    vi.unstubAllEnvs();
    const event = createAPIGatewayProxyEvent({
      httpMethod: "GET",
      path: "/accounts",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${isbAuthorizedUser.token}`,
      },
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeaders,
    });
  });

  describe("GET /accounts", () => {
    const allAccounts: SandboxAccount[] = [
      generateSchemaData(SandboxAccountSchema, {
        awsAccountId: "000000000000",
      }),
      generateSchemaData(SandboxAccountSchema, {
        awsAccountId: "111111111111",
      }),
    ];

    it("should return 200 with all accounts", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allAccounts,
          nextPageIdentifier: null,
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allAccounts,
            nextPageIdentifier: null,
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 with all accounts even when error is set", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allAccounts,
          nextPageIdentifier: null,
          error: "Some validation error",
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allAccounts,
            nextPageIdentifier: null,
            error: "Some validation error",
          },
        }),
        headers: responseHeaders,
      });
    });

    it("should return 200 with first page of accounts when pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const pageSize = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        queryStringParameters: {
          pageIdentifier,
          pageSize,
        },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const findAllMethod = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allAccounts,
            nextPageIdentifier: null,
          }),
        );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: allAccounts,
            nextPageIdentifier: null,
          },
        }),
        headers: responseHeaders,
      });
      expect(findAllMethod.mock.calls).toHaveLength(1);
      expect(findAllMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier: pageIdentifier,
          pageSize: Number(pageSize),
        },
      ]);
    });

    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const pageSize = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        queryStringParameters: {
          pageIdentifier,
          pageSize,
        },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const findAllMethod = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "findAll")
        .mockReturnValue(
          Promise.resolve({
            result: allAccounts,
            nextPageIdentifier: null,
          }),
        );

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "pageSize",
          message: "Expected number, received nan",
        }),
        headers: responseHeaders,
      });
      expect(findAllMethod.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(
        DynamoSandboxAccountStore.prototype,
        "findAll",
      ).mockImplementation(() => {
        throw new Error();
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });
  });

  describe("POST /accounts", () => {
    it("should return 400 when no body in the request", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({ message: "Body not provided." }),
        headers: responseHeaders,
      });
    });

    it("should return 415 when the body is malformed json string", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: "just string",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 415,
        body: createFailureResponseBody({
          message: "Invalid or malformed JSON was provided.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 400 when the body is not a valid sandbox account object", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify({
          ...generateSchemaData(SandboxAccountSchema, {
            awsAccountId: "000000000000",
          }),
          extra: "Something extra",
        }),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message:
            "Unrecognized key(s) in object: 'cleanupExecutionContext', 'status', 'driftAtLastScan', 'extra'",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 201 with valid input", async () => {
      const account = generateSchemaData(SandboxAccountSchema, {
        awsAccountId: "000000000000",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(SandboxAccountSchema.pick({ awsAccountId: true })),
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(InnovationSandbox, "registerAccount").mockResolvedValue(account);
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 201,
        body: JSON.stringify({
          status: "success",
          data: account,
        }),
        headers: responseHeaders,
      });
    });

    it.each([
      { accountId: testEnv.ORG_MGT_ACCOUNT_ID },
      { accountId: testEnv.IDC_ACCOUNT_ID },
      { accountId: testEnv.HUB_ACCOUNT_ID },
    ])(
      "should return 400 when a control plane account (%s) is provided",
      async ({ accountId }) => {
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: "/accounts",
          body: JSON.stringify({
            awsAccountId: accountId,
          }),
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${isbAuthorizedUser.token}`,
          },
        });

        const registerAccountSpy = vi.spyOn(
          InnovationSandbox,
          "registerAccount",
        );

        expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
          statusCode: 400,
          body: createFailureResponseBody({
            message: `Account is an ISB administration account. Aborting registration.`,
          }),
          headers: responseHeaders,
        });

        expect(registerAccountSpy).not.toHaveBeenCalled();
      },
    );

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(SandboxAccountSchema.pick({ awsAccountId: true })),
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(InnovationSandbox, "registerAccount").mockRejectedValue(
        new AccountNotFoundException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(SandboxAccountSchema.pick({ awsAccountId: true })),
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(InnovationSandbox, "registerAccount").mockRejectedValue(
        new ConcurrentModificationException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(SandboxAccountSchema.pick({ awsAccountId: true })),
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(InnovationSandbox, "registerAccount").mockRejectedValue(
        new TooManyRequestsException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 429,
        body: createFailureResponseBody({
          message:
            "Could not move account due to too many requests. Please try again momentarily.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 the the data store api fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(SandboxAccountSchema.pick({ awsAccountId: true })),
        ),
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "put").mockImplementation(
        () => {
          throw new Error();
        },
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });
  });

  describe("GET /accounts/{awsAccountId}", () => {
    it("should return 200 with the account", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${mockedAccount.awsAccountId}`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: mockedAccount,
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: mockedAccount,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 404 when the account doesn't exist", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: undefined,
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Account not found.`,
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 when the data store api fails", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockImplementation(
        () => {
          throw new Error();
        },
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });
  });

  describe("POST /accounts/{awsAccountId}/eject", () => {
    it("should return 200 and invoke ejectAccount", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });
      const ejectAccountSpy = vi
        .spyOn(InnovationSandbox, "ejectAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
        }),
        headers: responseHeaders,
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });

    it("should return 404 when the account not found", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });
      const ejectAccountSpy = vi
        .spyOn(InnovationSandbox, "ejectAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Account not found.`,
        }),
        headers: responseHeaders,
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).not.toHaveBeenCalledOnce();
    });

    it("should return 409 when eject call returns validation error", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "CleanUp",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });
      const ejectAccountSpy = vi
        .spyOn(InnovationSandbox, "ejectAccount")
        .mockRejectedValue(
          new AccountInCleanUpError(
            "Accounts cannot be ejected while in the CleanUp state",
          ),
        );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "Accounts cannot be ejected while in the CleanUp state",
        }),
        headers: responseHeaders,
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "ejectAccount").mockRejectedValue(
        new AccountNotFoundException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "ejectAccount").mockRejectedValue(
        new ConcurrentModificationException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "ejectAccount").mockRejectedValue(
        new TooManyRequestsException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 429,
        body: createFailureResponseBody({
          message:
            "Could not move account due to too many requests. Please try again momentarily.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 when the ejectAccount action fails", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });
      const ejectAccountSpy = vi
        .spyOn(InnovationSandbox, "ejectAccount")
        .mockImplementation(() => {
          throw new Error();
        });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });
  });

  describe("POST /accounts/{awsAccountId}/retryCleanup", () => {
    it("should return 200 and invoke retryCleanup", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const getAccountByIdSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });

      const retryCleanupSpy = vi
        .spyOn(InnovationSandbox, "retryCleanup")
        .mockResolvedValue();

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
        }),
        headers: responseHeaders,
      });

      expect(getAccountByIdSpy.mock.calls).toHaveLength(1);
      expect(retryCleanupSpy.mock.calls).toHaveLength(1);
    });

    it("should return 404 when account not found", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const getAccountByIdSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });

      const retryCleanupSpy = vi
        .spyOn(InnovationSandbox, "retryCleanup")
        .mockResolvedValue();

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Account not found.`,
        }),
        headers: responseHeaders,
      });

      expect(getAccountByIdSpy).toHaveBeenCalledOnce();
      expect(retryCleanupSpy).not.toHaveBeenCalledOnce();
    });

    it("should return 409 when retryCleanup call returns validation error", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const getAccountByIdSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });

      const retryCleanupSpy = vi
        .spyOn(InnovationSandbox, "retryCleanup")
        .mockRejectedValue(
          new AccountNotInQuarantineError(
            `Only Quarantined accounts can retry cleanup. Received (${mockedAccount.awsAccountId}) in state (${mockedAccount.status}).`,
          ),
        );

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: `Only Quarantined accounts can retry cleanup. Received (${mockedAccount.awsAccountId}) in state (${mockedAccount.status}).`,
        }),
        headers: responseHeaders,
      });

      expect(getAccountByIdSpy.mock.calls).toHaveLength(1);
      expect(retryCleanupSpy.mock.calls).toHaveLength(1);
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "retryCleanup").mockRejectedValue(
        new AccountNotFoundException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "The account could not be found where it was expected to be located. Someone else may have recently moved it.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "retryCleanup").mockRejectedValue(
        new ConcurrentModificationException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Could not move account due to concurrent modification of the organization. Please try again.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "retryCleanup").mockRejectedValue(
        new TooManyRequestsException({
          message: "mock exception",
          $metadata: {},
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 429,
        body: createFailureResponseBody({
          message:
            "Could not move account due to too many requests. Please try again momentarily.",
        }),
        headers: responseHeaders,
      });
    });

    it("should return 500 when retryCleanup action fails", async () => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const getAccountByIdSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });

      const retryCleanupSpy = vi
        .spyOn(InnovationSandbox, "retryCleanup")
        .mockImplementation(() => {
          throw new Error();
        });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });

      expect(getAccountByIdSpy).toHaveBeenCalledOnce();
      expect(retryCleanupSpy).toHaveBeenCalledOnce();
    });
  });

  describe("GET /accounts/unregistered", () => {
    const unregisteredAccounts: Account[] = [
      {
        Id: "000000000000",
        Email: "test@example.com",
        Name: "test-account-1",
      },
      {
        Id: "111111111111",
        Email: "test@example.com",
        Name: "test-account-2",
      },
    ];
    it("should return 200 with all unregistered accounts", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const listAccountsInOUSpy = vi
        .spyOn(SandboxOuService.prototype, "listAccountsInOU")
        .mockResolvedValue({
          accounts: unregisteredAccounts,
          nextPageIdentifier: undefined,
        });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: JSON.stringify({
          status: "success",
          data: {
            result: unregisteredAccounts,
          },
        }),
        headers: responseHeaders,
      });
      expect(listAccountsInOUSpy.mock.calls).toHaveLength(1);
    });

    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const pageSize = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        queryStringParameters: {
          pageIdentifier,
          pageSize,
        },
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });

      const listAccountsInOUSpy = vi
        .spyOn(SandboxOuService.prototype, "listAccountsInOU")
        .mockResolvedValue({
          accounts: unregisteredAccounts,
          nextPageIdentifier: undefined,
        });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "pageSize",
          message: "Expected number, received nan",
        }),
        headers: responseHeaders,
      });
      expect(listAccountsInOUSpy.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${isbAuthorizedUser.token}`,
        },
      });
      vi.spyOn(
        SandboxOuService.prototype,
        "listAccountsInOU",
      ).mockImplementation(() => {
        throw new Error();
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeaders,
      });
    });
  });
});

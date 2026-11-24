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

import { PersistedCleanupReport } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { DynamoCleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/dynamo-cleanup-report-store.js";
import { InvalidPageIdentifierError } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { PersistedMonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import {
  PersistedSandboxAccount,
  PersistedSandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { DynamoSandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/dynamo-sandbox-spaces-usage-store.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import {
  AccountInCleanUpError,
  AccountNotInQuarantineError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { BlueprintDeploymentService } from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { AccountLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lambda-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createAPIGatewayProxyEvent,
  createErrorResponseBody,
  createFailureResponseBody,
  isbAuthorizedUser,
  isbAuthorizedUserUserRoleOnly,
  jsendFailBodyLike,
  mockAuthorizedContext,
  mockGlobalConfig,
  rawBodyLike,
  responseHeaders,
  responseHeadersWithErrorType,
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
// acquireLock returns the persisted lock so callers can carry it onto a
// full-item put; mocks must resolve a lock rather than undefined.
const MOCK_ACQUIRED_LOCK = {
  ownerId: "mock-lock-owner",
  acquiredAt: "2024-06-01T12:00:00.000Z",
  expiresAt: "2024-06-01T12:15:00.000Z",
};

// The generated restJson1 serializer projects each account to its modeled shape:
// only `meta.schemaVersion` is dropped from the wire (documented accepted
// deviation, see accounts.smithy). `resourceLock` IS on the wire — the frontend
// reads `resourceLock.expiresAt` — so it passes through unchanged. Expected
// success bodies are matched with the shared `rawBodyLike` matcher
// (order-insensitive, null/undefined dropped, timestamps NOT canonicalized since
// accounts models them as raw `String`) against this projection.
function projectAccount(account: PersistedSandboxAccount) {
  const { meta, ...rest } = account;
  return {
    ...rest,
    ...(meta
      ? {
          meta: {
            createdTime: meta.createdTime,
            lastEditTime: meta.lastEditTime,
          },
        }
      : {}),
  };
}

let mockedGlobalConfig: GlobalConfig;
let handler: typeof import("@amzn/innovation-sandbox-accounts/accounts-handler.js").handler;
beforeAll(async () => {
  handler = (
    await import("@amzn/innovation-sandbox-accounts/accounts-handler.js")
  ).handler;
  mockedGlobalConfig = mockGlobalConfig();
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
      },
      isbUser: isbAuthorizedUser.user,
    });
    expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
      statusCode: 500,
      body: createErrorResponseBody("An unexpected error occurred."),
      headers: responseHeadersWithErrorType("InternalServerError"),
    });
  });

  describe("GET /accounts", () => {
    const allAccounts: PersistedSandboxAccount[] = [
      generateSchemaData(PersistedSandboxAccountSchema, {
        awsAccountId: "000000000000",
      }),
      generateSchemaData(PersistedSandboxAccountSchema, {
        awsAccountId: "111111111111",
      }),
    ];

    it("should return 200 with all accounts", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "findAll").mockReturnValue(
        Promise.resolve({
          result: allAccounts,
          nextPageIdentifier: null,
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: allAccounts.map(projectAccount),
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with all accounts even when error is set", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        body: rawBodyLike({
          status: "success",
          data: {
            result: allAccounts.map(projectAccount),
            nextPageIdentifier: null,
            error: "Some validation error",
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 200 with first page of accounts when pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "2";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        body: rawBodyLike({
          status: "success",
          data: {
            result: allAccounts.map(projectAccount),
            nextPageIdentifier: null,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(findAllMethod.mock.calls).toHaveLength(1);
      expect(findAllMethod.mock.calls[0]).toEqual([
        {
          pageIdentifier: pageIdentifier,
          pageSize: Number(maxResults),
        },
      ]);
    });

    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        // Accepted deviation: a malformed integer query param now surfaces as the
        // framework's SerializationException→400 (a generic message) instead of
        // the pre-Smithy Zod field error. Still a 400.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(findAllMethod.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("InternalServerError"),
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
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        // Accepted deviation: with no body the model rejects the required
        // awsAccountId (generated ValidationError, alphabetized envelope) rather
        // than the pre-Smithy "Body not provided." message.
        body: jsendFailBodyLike({
          field: "awsAccountId",
          message:
            "Value at '/awsAccountId' failed to satisfy constraint: Member must not be null",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the body is malformed json string", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: "just string",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 when the registration body carries unknown keys", async () => {
      // The registration schema is standalone and strict (Task 3.4a/b): it accepts
      // only awsAccountId and rejects any other key — including former
      // PersistedSandboxAccount fields, which are no longer implicitly accepted.
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify({
          awsAccountId: "000000000000",
          status: "Available",
          extra: "Something extra",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized keys: "status", "extra"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 400 for a field the pre-Smithy schema accepted (narrowing)", async () => {
      // `name` is a valid PersistedSandboxAccount field the pre-Smithy omit-schema accepted
      // (and ignored). The standalone schema narrows acceptance to awsAccountId, so
      // it now rejects `name` — this is the documented contract narrowing.
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify({
          awsAccountId: "000000000000",
          name: "Previously accepted",
        }),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          field: "input",
          message: 'Unrecognized key: "name"',
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should return 403 when the user has only 'User' role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify({ awsAccountId: "000000000000" }),
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      const registerAccountSpy = vi
        .spyOn(InnovationSandbox, "registerAccount")
        .mockResolvedValue({} as never);
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({ message: "Access denied." }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
      expect(registerAccountSpy).not.toHaveBeenCalled();
    });

    it("should return 201 with valid input", async () => {
      const account = generateSchemaData(PersistedSandboxAccountSchema, {
        awsAccountId: "000000000000",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(
            PersistedSandboxAccountSchema.pick({ awsAccountId: true }),
          ),
        ),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(InnovationSandbox, "registerAccount").mockResolvedValue(account);
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 201,
        body: rawBodyLike({
          status: "success",
          data: projectAccount(account),
        }),
        headers: expect.objectContaining(responseHeaders),
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
          },
          isbUser: isbAuthorizedUser.user,
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
          headers: responseHeadersWithErrorType("ValidationError"),
        });

        expect(registerAccountSpy).not.toHaveBeenCalled();
      },
    );

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(
            PersistedSandboxAccountSchema.pick({ awsAccountId: true }),
          ),
        ),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(
            PersistedSandboxAccountSchema.pick({ awsAccountId: true }),
          ),
        ),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(
            PersistedSandboxAccountSchema.pick({ awsAccountId: true }),
          ),
        ),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 the the data store api fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: "/accounts",
        body: JSON.stringify(
          generateSchemaData(
            PersistedSandboxAccountSchema.pick({ awsAccountId: true }),
          ),
        ),
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "put").mockImplementation(
        () => {
          throw new Error();
        },
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  describe("GET /accounts/{awsAccountId}", () => {
    it("should return 200 with the account", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema);
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${mockedAccount.awsAccountId}`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockReturnValue(
        Promise.resolve({
          result: mockedAccount,
        }),
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: projectAccount(mockedAccount),
        }),
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 404 when the account doesn't exist", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 when the data store api fails", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockImplementation(
        () => {
          throw new Error();
        },
      );
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 500,
        body: createErrorResponseBody("An unexpected error occurred."),
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  describe("POST /accounts/{awsAccountId}/eject", () => {
    it("should return 200 and invoke ejectAccount", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });

    it("should return 404 when the account not found", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).not.toHaveBeenCalledOnce();
    });

    it("should return 409 when eject call returns validation error", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "CleanUp",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 when the ejectAccount action fails", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/eject`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(ejectAccountSpy).toHaveBeenCalledOnce();
    });

    it("should return 403 when the user has only 'User' role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/000000000000/eject`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      const ejectAccountSpy = vi
        .spyOn(InnovationSandbox, "ejectAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({ message: "Access denied." }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
      expect(ejectAccountSpy).not.toHaveBeenCalled();
    });
  });

  describe("POST /accounts/{awsAccountId}/quarantine", () => {
    it.each(["Available", "Active", "Frozen"] as const)(
      "should return 200 and invoke quarantineAccount for %s account",
      async (status) => {
        const mockedAccount = generateSchemaData(
          PersistedSandboxAccountSchema,
          {
            status,
          },
        );
        const event = createAPIGatewayProxyEvent({
          httpMethod: "POST",
          path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
          headers: {
            "Content-Type": "application/json",
          },
          isbUser: isbAuthorizedUser.user,
        });
        const getAccountSpy = vi
          .spyOn(DynamoSandboxAccountStore.prototype, "get")
          .mockResolvedValue({
            result: mockedAccount,
          });
        const quarantineAccountSpy = vi
          .spyOn(InnovationSandbox, "quarantineAccount")
          .mockResolvedValue();
        expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
          statusCode: 200,
          body: JSON.stringify({
            status: "success",
          }),
          headers: expect.objectContaining(responseHeaders),
        });
        expect(getAccountSpy).toHaveBeenCalledOnce();
        expect(quarantineAccountSpy).toHaveBeenCalledOnce();
        expect(quarantineAccountSpy.mock.calls[0]![0]).toEqual({
          accountId: mockedAccount.awsAccountId,
          currentOu: status,
          reason: "Manually quarantined by administrator",
          reasonForQuarantine: "MANUAL",
        });
      },
    );

    it("should return 404 when the account not found", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/quarantine`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: undefined,
        });
      const quarantineAccountSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 404,
        body: createFailureResponseBody({
          message: `Account not found.`,
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(quarantineAccountSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when the account is already quarantined", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });
      const quarantineAccountSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message: "Account is already quarantined.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(quarantineAccountSpy).not.toHaveBeenCalled();
    });

    it("should return 403 when the user has only 'User' role", async () => {
      const accountId = "000000000000";
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/quarantine`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });
      const quarantineAccountSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 403,
        body: createFailureResponseBody({ message: "Access denied." }),
        headers: responseHeadersWithErrorType("AccessDeniedError"),
      });
      expect(quarantineAccountSpy).not.toHaveBeenCalled();
    });

    it("should return 409 when the account is in CleanUp", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "CleanUp",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });
      const quarantineAccountSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();
      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "Account cannot be quarantined while cleanup is in progress.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
      expect(getAccountSpy).toHaveBeenCalledOnce();
      expect(quarantineAccountSpy).not.toHaveBeenCalled();
    });
  });

  // Handler-chain tests: the facade runs for real (no spy on InnovationSandbox.quarantineAccount).
  // AWS dependencies are mocked at the SDK-client boundary so we can assert the
  // terminate-lease, revoke-SSO, move-OU, and publish-event chain end-to-end.
  describe("POST /accounts/{awsAccountId}/quarantine handler chain", () => {
    function spyOnQuarantineDependencies() {
      const moveAccountSpy = vi
        .spyOn(SandboxOuService.prototype, "moveAccount")
        .mockImplementation(async (account) => ({ newItem: account }));
      const getUserFromEmailSpy = vi
        .spyOn(IdcService.prototype, "getUserFromEmail")
        .mockResolvedValue(undefined);
      const sendIsbEventSpy = vi
        .spyOn(IsbEventBridgeClient.prototype, "sendIsbEvent")
        .mockResolvedValue();
      const sendIsbEventsSpy = vi
        .spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents")
        .mockResolvedValue();
      const leaseUpdateSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "update")
        .mockImplementation(async (lease) => ({ newItem: lease }));
      // BlueprintDeploymentService is invoked when terminating leases that have
      // a blueprintId. Stub it so we don't try to talk to CloudFormation.
      vi.spyOn(
        BlueprintDeploymentService.prototype,
        "deleteStackInstancesMetadata",
      ).mockResolvedValue();
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "updateStatusTag",
      ).mockResolvedValue();
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "untagAccount",
      ).mockResolvedValue();
      vi.spyOn(DynamoLeaseStore.prototype, "acquireLock").mockResolvedValue(
        MOCK_ACQUIRED_LOCK,
      );
      vi.spyOn(DynamoLeaseStore.prototype, "releaseLock").mockResolvedValue(
        undefined,
      );
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "stampLeaseTtl",
      ).mockResolvedValue();
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "listLeaseUserUsage",
      ).mockResolvedValue({ usage: [] });
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "recordLifecycleDispatch",
      ).mockResolvedValue();
      return {
        moveAccountSpy,
        getUserFromEmailSpy,
        sendIsbEventSpy,
        sendIsbEventsSpy,
        leaseUpdateSpy,
      };
    }

    it("Available account moves to Quarantine OU and publishes AccountQuarantined event without terminating any lease", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Available",
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      // No active leases for this account
      const findLeasesByStatusSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "findByStatusAndAccountID")
        .mockResolvedValue({ result: [], nextPageIdentifier: null });
      const {
        moveAccountSpy,
        sendIsbEventSpy,
        sendIsbEventsSpy,
        leaseUpdateSpy,
      } = spyOnQuarantineDependencies();

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response).toEqual({
        statusCode: 200,
        body: JSON.stringify({ status: "success" }),
        headers: expect.objectContaining(responseHeaders),
      });
      // Lease store queried for each monitored status, but no lease found
      expect(findLeasesByStatusSpy).toHaveBeenCalled();
      expect(leaseUpdateSpy).not.toHaveBeenCalled();
      // Account moved from Available to Quarantine
      expect(moveAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({ awsAccountId: mockedAccount.awsAccountId }),
        "Available",
        "Quarantine",
      );
      // AccountQuarantined event published
      expect(sendIsbEventSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          DetailType: EventDetailTypes.AccountQuarantined,
          Detail: {
            awsAccountId: mockedAccount.awsAccountId,
            reason: "Manually quarantined by administrator",
          },
        }),
      );
      // No LeaseTerminated event (sendIsbEvents is the batch path used by terminateLease)
      expect(sendIsbEventsSpy).not.toHaveBeenCalled();
    });

    it("Active account with active lease terminates lease, revokes SSO access, moves to Quarantine OU, publishes events", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const activeLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        awsAccountId: mockedAccount.awsAccountId,
        status: "Active",
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      // Return the active lease only when the facade asks for "Active" status;
      // empty for other monitored statuses.
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByStatusAndAccountID",
      ).mockImplementation(async ({ status }) =>
        status === "Active"
          ? { result: [activeLease], nextPageIdentifier: null }
          : { result: [], nextPageIdentifier: null },
      );
      const {
        moveAccountSpy,
        sendIsbEventSpy,
        sendIsbEventsSpy,
        leaseUpdateSpy,
      } = spyOnQuarantineDependencies();

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      // Lease persisted with terminated status
      expect(leaseUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: activeLease.uuid,
          status: "AccountQuarantined",
        }),
      );
      // Account moved from Active to Quarantine
      expect(moveAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({ awsAccountId: mockedAccount.awsAccountId }),
        "Active",
        "Quarantine",
      );
      // LeaseTerminated event published via the batch path. sendIsbEvents
      // receives (tracer, ...events), so check that one of the rest args carries
      // the LeaseTerminated detail type.
      expect(sendIsbEventsSpy).toHaveBeenCalledTimes(1);
      const sendIsbEventsArgs = sendIsbEventsSpy.mock.calls[0]!.slice(1);
      expect(sendIsbEventsArgs).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            DetailType: EventDetailTypes.LeaseTerminated,
          }),
        ]),
      );
      // AccountQuarantined event published
      expect(sendIsbEventSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          DetailType: EventDetailTypes.AccountQuarantined,
          Detail: expect.objectContaining({
            awsAccountId: mockedAccount.awsAccountId,
            reason: "Manually quarantined by administrator",
          }),
        }),
      );
    });

    it("Frozen account with frozen lease terminates lease and moves to Quarantine OU", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Frozen",
      });
      const frozenLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        awsAccountId: mockedAccount.awsAccountId,
        status: "Frozen",
      });
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(
        DynamoLeaseStore.prototype,
        "findByStatusAndAccountID",
      ).mockImplementation(async ({ status }) =>
        status === "Frozen"
          ? { result: [frozenLease], nextPageIdentifier: null }
          : { result: [], nextPageIdentifier: null },
      );
      const { moveAccountSpy, sendIsbEventSpy, leaseUpdateSpy } =
        spyOnQuarantineDependencies();

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/quarantine`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response.statusCode).toBe(200);
      expect(leaseUpdateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: frozenLease.uuid,
          status: "AccountQuarantined",
        }),
      );
      // Account moved from Frozen to Quarantine (asserts the handler derives currentOu
      // from the account's status)
      expect(moveAccountSpy).toHaveBeenCalledWith(
        expect.objectContaining({ awsAccountId: mockedAccount.awsAccountId }),
        "Frozen",
        "Quarantine",
      );
      expect(sendIsbEventSpy).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          DetailType: EventDetailTypes.AccountQuarantined,
        }),
      );
    });
  });

  describe("POST /accounts/{awsAccountId}/retryCleanup", () => {
    it("should return 200 and invoke retryCleanup", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });

      expect(getAccountByIdSpy.mock.calls).toHaveLength(1);
      expect(retryCleanupSpy.mock.calls).toHaveLength(1);
    });

    it("should return 404 when account not found", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });

      expect(getAccountByIdSpy).toHaveBeenCalledOnce();
      expect(retryCleanupSpy).not.toHaveBeenCalledOnce();
    });

    it("should return 409 when retryCleanup call returns validation error", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Active",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });

      expect(getAccountByIdSpy.mock.calls).toHaveLength(1);
      expect(retryCleanupSpy.mock.calls).toHaveLength(1);
    });

    it("should return 409 when a cleanup execution is already running (active lock)", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "CleanUp",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: mockedAccount,
      });
      vi.spyOn(InnovationSandbox, "retryCleanup").mockRejectedValue(
        new AccountInCleanUpError(
          "A cleanup execution is already running for this account. Wait for it to finish before retrying.",
        ),
      );

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 409,
        body: createFailureResponseBody({
          message:
            "A cleanup execution is already running for this account. Wait for it to finish before retrying.",
        }),
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws AccountNotFoundException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 409 when org api throws ConcurrentModificationException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("ConflictError"),
      });
    });

    it("should return 429 when org api throws TooManyRequestsException", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: expect.objectContaining(responseHeaders),
      });
    });

    it("should return 500 when retryCleanup action fails", async () => {
      const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
        status: "Quarantine",
      });
      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${mockedAccount.awsAccountId}/retryCleanup`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("InternalServerError"),
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
    it("should map maxResults when listing unregistered accounts", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        queryStringParameters: { maxResults: "7" },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const listAccountsInOUSpy = vi
        .spyOn(SandboxOuService.prototype, "listAccountsInOU")
        .mockResolvedValue({
          accounts: unregisteredAccounts,
          nextPageIdentifier: undefined,
        });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 200,
        body: rawBodyLike({
          status: "success",
          data: {
            result: unregisteredAccounts,
          },
        }),
        headers: expect.objectContaining(responseHeaders),
      });
      expect(listAccountsInOUSpy).toHaveBeenCalledWith({
        ouName: "Entry",
        pageIdentifier: undefined,
        pageSize: 7,
      });
    });

    it("should return 400 when invalid pagination query parameters are passed in", async () => {
      const pageIdentifier = "eyAidGVzdCI6ICJ0ZXN0IiB9";
      const maxResults = "NaN";

      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        queryStringParameters: {
          pageIdentifier,
          maxResults,
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const listAccountsInOUSpy = vi
        .spyOn(SandboxOuService.prototype, "listAccountsInOU")
        .mockResolvedValue({
          accounts: unregisteredAccounts,
          nextPageIdentifier: undefined,
        });

      expect(await handler(event, mockAuthorizedContext(testEnv))).toEqual({
        statusCode: 400,
        // Accepted deviation: a malformed integer query param now surfaces as the
        // framework's SerializationException→400 (a generic message) instead of
        // the pre-Smithy Zod field error. Still a 400.
        body: createFailureResponseBody({
          message:
            "Invalid JSON in request body. Please check your JSON syntax.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
      expect(listAccountsInOUSpy.mock.calls).toHaveLength(0);
    });

    it("should return 500 when data store calls fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: "/accounts/unregistered",
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
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
        headers: responseHeadersWithErrorType("InternalServerError"),
      });
    });
  });

  function createMockCleanupReport(
    overrides: Partial<PersistedCleanupReport> = {},
  ): PersistedCleanupReport {
    const accountId = overrides.pk ?? "123456789012";
    return {
      pk: accountId,
      sk: "CleanupReport#2026-03-25T14:30:00.000Z",
      accountId,
      durableExecutionArn:
        "arn:aws:lambda:us-east-1:123456789012:function:cleanup:exec-1",
      status: "COMPLETED",
      cleanupStatus: "COMPLETED",
      startedAt: "2026-03-25T14:30:00.000Z",
      completedAt: "2026-03-25T15:05:00.000Z",
      reasonForCleanup: "LEASE_TERMINATION",
      steps: [
        {
          name: "initialize-cleanup",
          startedAt: "2026-03-25T14:30:05.000Z",
        },
        {
          name: "cleanup-complete",
          startedAt: "2026-03-25T15:05:00.000Z",
        },
      ],
      skipCooldownCallbackId: "secret-callback-id-123",
      ttl: 1774569000,
      meta: {
        schemaVersion: 1,
        createdTime: "2026-03-25T14:30:00.000Z",
        lastEditTime: "2026-03-25T15:05:00.000Z",
      },
      ...overrides,
    };
  }

  describe("GET /accounts/{awsAccountId}/cleanup-reports", () => {
    const accountId = "123456789012";

    const mockReport = createMockCleanupReport();

    it("should return 200 with recent reports and strip skipCooldownCallbackId", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "listRecentReports",
      ).mockResolvedValue({
        result: [mockReport],
        nextPageIdentifier: null,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.result).toHaveLength(1);
      expect(body.data.result[0].skipCooldownCallbackId).toBeUndefined();
      expect(body.data.result[0].pk).toBeUndefined();
      expect(body.data.result[0].sk).toBeUndefined();
      expect(body.data.result[0].ttl).toBeUndefined();
      expect(body.data.result[0].meta).toBeUndefined();
      expect(body.data.result[0].accountId).toBe(accountId);
      expect(body.data.result[0].cleanupStatus).toBe("COMPLETED");
      // The serializer drops a null member; the frontend adapter re-coalesces it
      // to null (accepted wire deviation).
      expect(body.data.nextPageIdentifier).toBeUndefined();
    });

    it("should return 200 with empty results when no reports exist", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "listRecentReports",
      ).mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");
      expect(body.data.result).toHaveLength(0);
    });

    it("should return 403 when user has only User role", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUserUserRoleOnly.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(403);
    });

    it("should return 500 when data store call fails", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "listRecentReports",
      ).mockImplementation(() => {
        throw new Error();
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(500);
    });

    it("should return 400 when the page identifier is invalid", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        queryStringParameters: {
          pageIdentifier: "invalid-token",
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "listRecentReports",
      ).mockRejectedValue(new InvalidPageIdentifierError());

      const response = await handler(event, mockAuthorizedContext(testEnv));

      expect(response).toEqual({
        statusCode: 400,
        body: createFailureResponseBody({
          message: "The page identifier is invalid for this request.",
        }),
        headers: responseHeadersWithErrorType("ValidationError"),
      });
    });

    it("should map maxResults and pageIdentifier to the store", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        queryStringParameters: {
          maxResults: "3",
          pageIdentifier: "some-token",
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const listSpy = vi
        .spyOn(DynamoCleanupReportStore.prototype, "listRecentReports")
        .mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

      await handler(event, mockAuthorizedContext(testEnv));

      expect(listSpy).toHaveBeenCalledWith({
        accountId,
        limit: 3,
        pageIdentifier: "some-token",
      });
    });

    it("should use default maxResults of 5 when not specified", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });
      const listSpy = vi
        .spyOn(DynamoCleanupReportStore.prototype, "listRecentReports")
        .mockResolvedValue({
          result: [],
          nextPageIdentifier: null,
        });

      await handler(event, mockAuthorizedContext(testEnv));

      expect(listSpy).toHaveBeenCalledWith({
        accountId,
        limit: 5,
        pageIdentifier: undefined,
      });
    });

    it("should return 400 when maxResults exceeds max of 10", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/${accountId}/cleanup-reports`,
        queryStringParameters: {
          maxResults: "11",
        },
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(400);
    });

    it("should return 400 for invalid awsAccountId format", async () => {
      const event = createAPIGatewayProxyEvent({
        httpMethod: "GET",
        path: `/accounts/invalid-id/cleanup-reports`,
        headers: {
          "Content-Type": "application/json",
        },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(400);
    });
  });

  describe("POST /accounts/{awsAccountId}/skipCooldown", () => {
    const accountId = "123456789012";

    function createCooldownReport(
      overrides: Partial<PersistedCleanupReport> = {},
    ): PersistedCleanupReport {
      return createMockCleanupReport({
        status: "IN_PROGRESS",
        cleanupStatus: "COOLING_DOWN",
        completedAt: undefined,
        skipCooldownCallbackId: "callback-id-abc",
        ...overrides,
      });
    }

    it("should return 200 and call SendDurableExecutionCallbackSuccess", async () => {
      const report = createCooldownReport();
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "getLatestReport",
      ).mockResolvedValue({ result: report });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "updateReport",
      ).mockResolvedValue({} as any);

      const { LambdaClient } = await import("@aws-sdk/client-lambda");
      const sendSpy = vi
        .spyOn(LambdaClient.prototype, "send")
        .mockResolvedValue({} as any);

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/skipCooldown`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(200);

      const body = JSON.parse(response.body);
      expect(body.status).toBe("success");

      expect(sendSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          input: { CallbackId: "callback-id-abc" },
        }),
      );
    });

    it("should return 409 when no report exists", async () => {
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "getLatestReport",
      ).mockResolvedValue({ result: undefined });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/skipCooldown`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(409);
    });

    it("should return 409 when account is not in cooldown", async () => {
      const report = createMockCleanupReport({
        status: "COMPLETED",
        cleanupStatus: "COMPLETED",
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "getLatestReport",
      ).mockResolvedValue({ result: report });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/skipCooldown`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(409);
    });

    it("should return 409 when no callback ID is stored", async () => {
      const report = createCooldownReport({
        skipCooldownCallbackId: undefined,
      });
      vi.spyOn(
        DynamoCleanupReportStore.prototype,
        "getLatestReport",
      ).mockResolvedValue({ result: report });

      const event = createAPIGatewayProxyEvent({
        httpMethod: "POST",
        path: `/accounts/${accountId}/skipCooldown`,
        headers: { "Content-Type": "application/json" },
        isbUser: isbAuthorizedUser.user,
      });

      const response = await handler(event, mockAuthorizedContext(testEnv));
      expect(response.statusCode).toBe(409);
    });
  });
});

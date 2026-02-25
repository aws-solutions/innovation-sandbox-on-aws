// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
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
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { InitializeCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/initialize-cleanup-lambda-environment.js";
import { EnvironmentValidatorError } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { InitializeCleanupLambdaEvent } from "@amzn/innovation-sandbox-initialize-cleanup/initialize-cleanup-handler.js";
import {
  DescribeExecutionCommand,
  ExecutionDoesNotExist,
  SFNClient,
} from "@aws-sdk/client-sfn";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";

const testEnv = generateSchemaData(InitializeCleanupLambdaEnvironmentSchema);
let handler: typeof import("@amzn/innovation-sandbox-initialize-cleanup/initialize-cleanup-handler.js").handler;
const sfnClient = mockClient(SFNClient);
const stsClient = mockClient(STSClient);
const mockedGlobalConfig = generateSchemaData(GlobalConfigSchema);

beforeAll(async () => {
  bulkStubEnv(testEnv);

  handler = (
    await import("@amzn/innovation-sandbox-initialize-cleanup/initialize-cleanup-handler.js")
  ).handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  mockAppConfigMiddleware(mockedGlobalConfig);
});

afterEach(() => {
  sfnClient.reset();
  stsClient.reset();
  vi.resetAllMocks();
  vi.unstubAllEnvs();
});

describe("InitializeCleanup Handler", async () => {
  it("should throw error when environment variables are misconfigured", async () => {
    const event: InitializeCleanupLambdaEvent = {
      accountId: "000000000000",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    };

    vi.unstubAllEnvs();

    await expect(
      handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).rejects.toThrow(EnvironmentValidatorError);
  });

  it("should update account with execution data if no cleanup execution is in progress", async () => {
    const mockedAccount = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      cleanupExecutionContext: undefined,
    });

    const event: InitializeCleanupLambdaEvent = {
      accountId: mockedAccount.awsAccountId,
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: mockedAccount,
      });

    const putAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "put")
      .mockResolvedValue({
        newItem: {
          ...mockedAccount,
          cleanupExecutionContext: {
            stateMachineExecutionArn:
              event.cleanupExecutionContext.stateMachineExecutionArn,
            stateMachineExecutionStartTime:
              event.cleanupExecutionContext.stateMachineExecutionStartTime,
          },
        },
        oldItem: mockedAccount,
      });

    sfnClient.on(DescribeExecutionCommand).resolves({ status: "SUCCEEDED" });
    stsClient.on(GetCallerIdentityCommand).resolves({
      Account: mockedAccount.awsAccountId,
      UserId: "test-user",
      Arn: `arn:aws:iam::${mockedAccount.awsAccountId}:role/${testEnv.CLEANUP_SPOKE_ROLE_NAME}`,
    });

    expect(
      await handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      cleanupAlreadyInProgress: false,
      globalConfig: mockedGlobalConfig,
    });

    expect(getAccountSpy).toHaveBeenCalledOnce();
    expect(putAccountSpy).toHaveBeenCalledOnce();
  });

  it("should detect inprogress execution", async () => {
    const mockedAccount = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
    });

    const event: InitializeCleanupLambdaEvent = {
      accountId: mockedAccount.awsAccountId,
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: mockedAccount,
      });

    sfnClient.on(DescribeExecutionCommand).resolves({ status: "RUNNING" });
    // STS client should not be called when cleanup is already in progress
    stsClient
      .on(GetCallerIdentityCommand)
      .rejects(new Error("Should not be called"));

    expect(
      await handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).toEqual({ cleanupAlreadyInProgress: true });

    expect(getAccountSpy).toHaveBeenCalledOnce();
  });

  it("should proceed with cleanup when execution no longer exists (ExecutionDoesNotExist error)", async () => {
    const mockedAccount = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:old-execution-id",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    });

    const event: InitializeCleanupLambdaEvent = {
      accountId: mockedAccount.awsAccountId,
      cleanupExecutionContext: mockedAccount.cleanupExecutionContext!,
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: mockedAccount,
      });

    const putAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "put")
      .mockResolvedValue({
        newItem: {
          ...mockedAccount,
          cleanupExecutionContext: event.cleanupExecutionContext,
        },
        oldItem: mockedAccount,
      });

    // Simulate ExecutionDoesNotExist error (execution history deleted after 90 days)
    sfnClient.on(DescribeExecutionCommand).rejects(
      new ExecutionDoesNotExist({
        message: "Execution does not exist",
        $metadata: {},
      }),
    );

    stsClient.on(GetCallerIdentityCommand).resolves({
      Account: mockedAccount.awsAccountId,
      UserId: "test-user",
      Arn: `arn:aws:iam::${mockedAccount.awsAccountId}:role/${testEnv.CLEANUP_SPOKE_ROLE_NAME}`,
    });

    expect(
      await handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).toEqual({
      cleanupAlreadyInProgress: false,
      globalConfig: mockedGlobalConfig,
    });

    expect(getAccountSpy).toHaveBeenCalledOnce();
    expect(putAccountSpy).toHaveBeenCalledOnce();
  });

  it.each([
    { accountId: testEnv.ORG_MGT_ACCOUNT_ID },
    { accountId: testEnv.IDC_ACCOUNT_ID },
    { accountId: testEnv.HUB_ACCOUNT_ID },
  ])(
    "should throw error when a control plane account is provided to the account cleaner",
    async ({ accountId }) => {
      const mockedAccount = generateSchemaData(SandboxAccountSchema, {
        awsAccountId: accountId,
        status: "CleanUp",
        cleanupExecutionContext: undefined,
      });

      const event: InitializeCleanupLambdaEvent = {
        accountId: mockedAccount.awsAccountId,
        cleanupExecutionContext: {
          stateMachineExecutionArn:
            "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
          stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
        },
      };

      const getAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "get")
        .mockResolvedValue({
          result: mockedAccount,
        });

      const putAccountSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "put")
        .mockResolvedValue({
          newItem: {
            ...mockedAccount,
            cleanupExecutionContext: {
              stateMachineExecutionArn:
                event.cleanupExecutionContext.stateMachineExecutionArn,
              stateMachineExecutionStartTime:
                event.cleanupExecutionContext.stateMachineExecutionStartTime,
            },
          },
          oldItem: mockedAccount,
        });

      sfnClient.on(DescribeExecutionCommand).resolves({ status: "SUCCEEDED" });
      // STS client should not be called for control plane accounts
      stsClient
        .on(GetCallerIdentityCommand)
        .rejects(new Error("Should not be called"));

      await expect(
        handler(event, mockContext(testEnv, mockedGlobalConfig)),
      ).rejects.toThrow(
        `Account ${event.accountId} is an ISB administration account. Aborting cleanup.`,
      );

      expect(getAccountSpy).not.toHaveBeenCalled();
      expect(putAccountSpy).not.toHaveBeenCalled();
      expect(sfnClient.calls()).toHaveLength(0);
    },
  );

  it("should throw error when cleanup spoke role cannot be assumed", async () => {
    const mockedAccount = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      cleanupExecutionContext: undefined,
    });

    const event: InitializeCleanupLambdaEvent = {
      accountId: mockedAccount.awsAccountId,
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: mockedAccount,
      });

    const putAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "put")
      .mockResolvedValue({
        newItem: {
          ...mockedAccount,
          cleanupExecutionContext: event.cleanupExecutionContext,
        },
        oldItem: mockedAccount,
      });

    sfnClient.on(DescribeExecutionCommand).resolves({ status: "SUCCEEDED" });

    // Simulate role not existing or not assumable
    stsClient
      .on(GetCallerIdentityCommand)
      .rejects(
        new Error(
          "AccessDenied: User is not authorized to perform: sts:AssumeRole",
        ),
      );

    const expectedRoleArn = `arn:aws:iam::${mockedAccount.awsAccountId}:role/${testEnv.CLEANUP_SPOKE_ROLE_NAME}`;

    await expect(
      handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).rejects.toThrow(
      `Cleanup spoke role ${expectedRoleArn} not found in account ${event.accountId}`,
    );

    expect(getAccountSpy).toHaveBeenCalledOnce();
    expect(putAccountSpy).not.toHaveBeenCalled();
  });

  it("should throw error when account is not found in database", async () => {
    const event: InitializeCleanupLambdaEvent = {
      accountId: "999999999999",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:00000000-0000-0000-0000-000000000000",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: undefined,
      });

    await expect(
      handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).rejects.toThrow("Unable to find account.");

    expect(getAccountSpy).toHaveBeenCalledOnce();
  });

  it("should re-throw unexpected errors from Step Functions DescribeExecution", async () => {
    const mockedAccount = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
      cleanupExecutionContext: {
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:000000000000:execution:00000000-0000-0000-0000-000000000000:old-execution-id",
        stateMachineExecutionStartTime: "2024-01-01T00:00:00.000Z",
      },
    });

    const event: InitializeCleanupLambdaEvent = {
      accountId: mockedAccount.awsAccountId,
      cleanupExecutionContext: mockedAccount.cleanupExecutionContext!,
    };

    const getAccountSpy = vi
      .spyOn(DynamoSandboxAccountStore.prototype, "get")
      .mockResolvedValue({
        result: mockedAccount,
      });

    // Simulate an unexpected error (not ExecutionDoesNotExist)
    const unexpectedError = new Error("InternalServerError");
    unexpectedError.name = "InternalServerError";
    sfnClient.on(DescribeExecutionCommand).rejects(unexpectedError);

    await expect(
      handler(event, mockContext(testEnv, mockedGlobalConfig)),
    ).rejects.toThrow("InternalServerError");

    expect(getAccountSpy).toHaveBeenCalledOnce();
  });
});

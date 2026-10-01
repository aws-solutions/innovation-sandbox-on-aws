// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock the account access cleanup step — it has its own dedicated test file
vi.mock(
  "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/cleanup-account-access.js",
  () => ({
    cleanupAccountAccess: vi.fn().mockResolvedValue({
      assignmentsFound: 0,
      assignmentsDeleted: 0,
      principalRecordsCleaned: 0,
    }),
  }),
);

// Mock triggerAssignmentProcessing — the actual IDC throttling is tested in the
// lease-assignment service tests; here we verify the cleanup orchestration calls it.
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js",
  () => ({
    triggerAssignmentProcessing: vi
      .fn()
      .mockResolvedValue({ lockOwnerId: "terminate-cleanup-mock" }),
  }),
);

import { SsmAccountPoolStackConfigStore } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js";
import { DynamoCleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/dynamo-cleanup-report-store.js";
import { PersistedConfigSectionData } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { ResourceExplorerService } from "@amzn/innovation-sandbox-commons/isb-services/resource-explorer-service.js";
import { DurableCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/durable-cleanup-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { ConfigSchemas } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  AppConfigDataClient,
  GetLatestConfigurationCommand,
  StartConfigurationSessionCommand,
} from "@aws-sdk/client-appconfigdata";
import { CodeBuildClient, StartBuildCommand } from "@aws-sdk/client-codebuild";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  EventBridgeClient,
  PutEventsCommand,
} from "@aws-sdk/client-eventbridge";
import { ExecutionStatus } from "@aws-sdk/client-lambda";
import { GetCallerIdentityCommand, STSClient } from "@aws-sdk/client-sts";
import {
  LocalDurableTestRunner,
  WaitingOperationStatus,
} from "@aws/durable-execution-sdk-js-testing";
import { mockClient } from "aws-sdk-client-mock";
import yaml from "js-yaml";
import path from "node:path";

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { handler } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/durable-cleanup-handler.js";
import { initializeCleanup } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/index.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

const testEnv = generateSchemaData(DurableCleanupLambdaEnvironmentSchema, {
  CODEBUILD_TIMEOUT_MINUTES: "60",
});
const mockedCleanupConfig: PersistedConfigSectionData<"cleanup"> = {
  ...ConfigSchemas.cleanup.parse({
    numberOfSuccessfulAttemptsToFinishCleanup: 2,
    numberOfFailedAttemptsToCancelCleanup: 3,
    waitBeforeRerunSuccessfulAttemptSeconds: 1,
    waitBeforeRetryFailedAttemptSeconds: 1,
  }),
  // Pin cooldown to 0 (disabled) explicitly rather than inheriting the schema
  // default: these flow tests exercise lock/init/nuke/finalize with cooldown
  // skipped, so they must not follow the durable cooldown-wait path. Tests that
  // exercise a non-zero cooldown use mockConfigStoreWithCooldown() instead.
  cooldownPeriodHours: 0,
  lastSavedBy: "admin@example.com",
  meta: {
    createdTime: "2026-01-01T00:00:00.000Z",
    lastEditTime: "2026-01-01T00:00:00.000Z",
    schemaVersion: 1,
  },
};

const stsClient = mockClient(STSClient);
const eventBridgeClient = mockClient(EventBridgeClient);
const codeBuildClient = mockClient(CodeBuildClient);
const appConfigDataClient = mockClient(AppConfigDataClient);

let runner: LocalDurableTestRunner;

function mockConfigStore() {
  vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
    mockedCleanupConfig,
  );
}

function mockAccountStoreDefaults(
  accountOverrides: Record<string, unknown> = {},
) {
  const mockedAccount = generateSchemaData(PersistedSandboxAccountSchema, {
    awsAccountId: "123456789012",
    status: "CleanUp",
    activeCleanup: undefined,
    resourceLock: undefined,
    ...accountOverrides,
  });

  vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
    result: mockedAccount,
  });
  vi.spyOn(
    DynamoSandboxAccountStore.prototype,
    "acquireLock",
  ).mockResolvedValue(mockedAccount);
  vi.spyOn(DynamoSandboxAccountStore.prototype, "put").mockResolvedValue({
    newItem: {
      ...mockedAccount,
      activeCleanup: {
        status: "INITIALIZING",
        executionArn: "test-arn",
        startedAt: "2026-01-01T00:00:00.000Z",
      },
    },
    oldItem: mockedAccount,
  });
  vi.spyOn(DynamoSandboxAccountStore.prototype, "update").mockResolvedValue(
    undefined,
  );
  // Default: this execution owns the lock, so releaseLock succeeds (true).
  vi.spyOn(
    DynamoSandboxAccountStore.prototype,
    "releaseLock",
  ).mockResolvedValue(true);

  return mockedAccount;
}

/**
 * Sends callback success for each nuke iteration as they become SUBMITTED.
 * Must be called concurrently with runner.run().
 */
async function completeNukeCallbacks(
  iterationCount: number,
  failAtIteration?: number,
) {
  for (let i = 1; i <= iterationCount; i++) {
    const callback = runner.getOperation(`nuke-phase-${i}-build`);
    await callback.waitForData(WaitingOperationStatus.SUBMITTED);
    if (failAtIteration === i) {
      await callback.sendCallbackFailure({
        ErrorMessage: "CodeBuild build failed",
      });
    } else {
      await callback.sendCallbackSuccess(JSON.stringify("SUCCEEDED"));
    }
  }
}

function createCleanAccountEvent(accountId: string, reason: string) {
  return {
    id: "test-event-id",
    version: "0",
    account: "123456789012",
    time: new Date().toISOString(),
    region: "us-east-1",
    resources: [],
    source: "InnovationSandbox-test",
    "detail-type": "CleanAccountRequest",
    detail: { accountId, reason },
  };
}

beforeAll(async () => {
  await LocalDurableTestRunner.setupTestEnvironment({ skipTime: true });
});

afterAll(async () => {
  await LocalDurableTestRunner.teardownTestEnvironment();
});

beforeEach(async () => {
  bulkStubEnv(testEnv);
  vi.stubEnv("AWS_REGION", "us-east-1");
  vi.stubEnv(
    "ISB_VALIDATOR_OVERLAY_PATH",
    path.join(__dirname, "../src/validator-exclusion-config.isb-overlay.yaml"),
  );

  stsClient.reset();
  stsClient.on(GetCallerIdentityCommand).resolves({
    Account: "123456789012",
    Arn: "arn:aws:sts::123456789012:assumed-role/cleanup-spoke/session",
    UserId: "AROA123456789:session",
  });

  eventBridgeClient.reset();
  eventBridgeClient.on(PutEventsCommand).resolves({
    FailedEntryCount: 0,
    Entries: [{ EventId: "test-event-id" }],
  });

  codeBuildClient.reset();
  codeBuildClient.on(StartBuildCommand).resolves({
    build: {
      id: "test-build-id",
      arn: "arn:aws:codebuild:us-east-1:123456789012:build/cleanup-project:test-build-id",
    },
  });

  const crossAccountRoles =
    await import("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js");
  vi.spyOn(
    crossAccountRoles,
    "fromTemporaryIsbSandboxAccountCredentials",
  ).mockReturnValue(async () => ({
    accessKeyId: "AKIAIOSFODNN7EXAMPLE",
    secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    sessionToken: "test-session-token",
    expiration: new Date(Date.now() + 3600000),
  }));

  // Mock cleanup report store — all operations are no-ops in tests
  vi.spyOn(DynamoCleanupReportStore.prototype, "create").mockResolvedValue({
    pk: "123456789012",
    sk: "CleanupReport#2026-01-01T00:00:00.000Z",
    accountId: "123456789012",
    durableExecutionArn: "test-arn",
    status: "IN_PROGRESS",
    cleanupStatus: "INITIALIZING",
    startedAt: "2026-01-01T00:00:00.000Z",
    reasonForCleanup: "LEASE_TERMINATION",
    steps: [],
    ttl: 0,
    meta: {
      schemaVersion: 1,
      createdTime: "2026-01-01T00:00:00.000Z",
      lastEditTime: "2026-01-01T00:00:00.000Z",
    },
  } as any);
  vi.spyOn(DynamoCleanupReportStore.prototype, "addStep").mockResolvedValue(0);
  vi.spyOn(
    DynamoCleanupReportStore.prototype,
    "updateStepAtIndex",
  ).mockResolvedValue(undefined);
  vi.spyOn(
    DynamoCleanupReportStore.prototype,
    "updateReport",
  ).mockResolvedValue({} as any);
  vi.spyOn(DynamoCleanupReportStore.prototype, "getReport").mockResolvedValue({
    result: {
      steps: [
        {
          name: "nuke-phase-1-start",
          startedAt: "2026-01-01T00:01:00.000Z",
          meta: {
            codeBuildExecutionArn:
              "arn:aws:codebuild:us-east-1:123456789012:build/cleanup-project:test-build-id",
          },
        },
        {
          name: "nuke-phase-2-start",
          startedAt: "2026-01-01T00:02:00.000Z",
          meta: {
            codeBuildExecutionArn:
              "arn:aws:codebuild:us-east-1:123456789012:build/cleanup-project:test-build-id",
          },
        },
        {
          name: "nuke-phase-3-start",
          startedAt: "2026-01-01T00:03:00.000Z",
          meta: {
            codeBuildExecutionArn:
              "arn:aws:codebuild:us-east-1:123456789012:build/cleanup-project:test-build-id",
          },
        },
      ],
    },
  } as any);

  // Mock AccountPoolStackConfigStore — provides ISB managed regions
  vi.spyOn(SsmAccountPoolStackConfigStore.prototype, "get").mockResolvedValue({
    sandboxOuId: "ou-sandbox",
    availableOuId: "ou-available",
    activeOuId: "ou-active",
    frozenOuId: "ou-frozen",
    cleanupOuId: "ou-cleanup",
    quarantineOuId: "ou-quarantine",
    entryOuId: "ou-entry",
    exitOuId: "ou-exit",
    solutionVersion: "1.0.0",
    supportedSchemas: "1",
    isbManagedRegions: ["us-east-1"],
  } as any);

  // Mock AppConfigData client — used for fetching validator exclusion config
  appConfigDataClient.reset();
  appConfigDataClient.on(StartConfigurationSessionCommand).resolves({
    InitialConfigurationToken: "test-token",
  });
  const exclusionConfigYaml = yaml.dump({
    validation: {
      excludedArnPatterns: ["arn:aws:iam::*:role/aws-service-role/*"],
    },
  });
  appConfigDataClient.on(GetLatestConfigurationCommand).resolves({
    Configuration: new TextEncoder().encode(exclusionConfigYaml) as any,
    NextPollConfigurationToken: "next-token",
  });

  // Mock ResourceExplorerService — returns empty results by default
  vi.spyOn(
    ResourceExplorerService.prototype,
    "listResources",
  ).mockResolvedValue({
    remainingResources: [],
    ignoredResources: [],
    errors: [],
    exhaustive: true,
  });

  // Stub index creation so the pre-cleanup step doesn't call AWS.
  vi.spyOn(
    ResourceExplorerService.prototype,
    "ensureIndexes",
  ).mockResolvedValue({ indexes: [] });

  // Mock DynamoLeaseStore.get — the waitForCondition check reads the lease to
  // check if the resourceLock is released. Default: no lock (condition passes immediately).
  vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
    result: { resourceLock: undefined },
  } as any);

  runner = new LocalDurableTestRunner({ handlerFunction: handler });
});

afterEach(() => {
  runner.reset();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
});

describe("Acquire-Cleanup-Lock Step", () => {
  it("should acquire lock and set cleanupStatus to INITIALIZING", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    // Complete the 2 nuke iterations via callbacks
    await completeNukeCallbacks(2);

    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(
      DynamoSandboxAccountStore.prototype.acquireLock,
    ).toHaveBeenCalledWith(
      "123456789012",
      expect.any(String),
      300,
      expect.objectContaining({ step: "acquire-account-lock" }),
    );
  });

  it("should fail when account does not exist in DynamoDB", async () => {
    vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
      result: undefined,
    });
    vi.spyOn(
      DynamoSandboxAccountStore.prototype,
      "releaseLock",
    ).mockResolvedValue(false);

    const result = await runner.run({
      payload: createCleanAccountEvent("999999999999", "LEASE_TERMINATION"),
    });

    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError()?.errorMessage).toContain("not found in DynamoDB");
  });

  it("should fail when another owner holds the lock", async () => {
    mockAccountStoreDefaults();

    vi.spyOn(
      DynamoSandboxAccountStore.prototype,
      "acquireLock",
    ).mockRejectedValue(
      new ConditionalCheckFailedException({
        message: "The conditional request failed",
        $metadata: {},
      }),
    );

    const result = await runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
  });
});

describe("Initialize-Cleanup Step", () => {
  it("should fetch the cleanup config section and validate spoke role", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    expect(DynamoConfigStore.prototype.getSection).toHaveBeenCalledWith(
      "cleanup",
    );
  });

  it("should fail when spoke role is not assumable", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    stsClient.reset();
    stsClient.on(GetCallerIdentityCommand).rejects(new Error("Access denied"));

    const result = await runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(result.getError()?.errorMessage).toContain("is not assumable");
  });
});

describe("Validator Exclusion Overlay", () => {
  it("merges the ISB overlay into the customer's exclusion patterns", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const resourceExplorerSpy = vi.spyOn(IsbServices, "resourceExplorer");

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });
    await completeNukeCallbacks(2);
    await runPromise;

    expect(resourceExplorerSpy).toHaveBeenCalled();
    const patterns =
      resourceExplorerSpy.mock.calls[0]![1].exclusionConfig.excludedArnPatterns;

    // ISB-required entries from validator-exclusion-config.isb-overlay.yaml
    expect(patterns).toContain("arn:aws:elasticache:*:*:user:default.iam-user");
    expect(patterns).toContain(
      "arn:aws:elasticache:*:*:usergroup:default.iam-user-group",
    );
    // the customer's own AppConfig pattern survives the merge
    expect(patterns).toContain("arn:aws:iam::*:role/aws-service-role/*");
  });

  it("does not duplicate a pattern the customer already declared", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    appConfigDataClient.on(GetLatestConfigurationCommand).resolves({
      Configuration: new TextEncoder().encode(
        yaml.dump({
          validation: {
            excludedArnPatterns: [
              "arn:aws:elasticache:*:*:user:default.iam-user",
            ],
          },
        }),
      ) as any,
      NextPollConfigurationToken: "next-token",
    });

    const resourceExplorerSpy = vi.spyOn(IsbServices, "resourceExplorer");

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });
    await completeNukeCallbacks(2);
    await runPromise;

    const patterns =
      resourceExplorerSpy.mock.calls[0]![1].exclusionConfig.excludedArnPatterns;

    expect(
      patterns.filter(
        (p) => p === "arn:aws:elasticache:*:*:user:default.iam-user",
      ),
    ).toHaveLength(1);
  });
});

describe("Initialize-Cleanup PII Projection", () => {
  it("strips the audit envelope (lastSavedBy/meta) from the returned cleanup config", async () => {
    mockAccountStoreDefaults();
    // getSection returns the stored section WITH the audit envelope present.
    mockConfigStore();

    const ctx = {
      accountId: "123456789012",
      executionArn: "test-arn",
      cleanupReason: "LEASE_TERMINATION",
      accountStore: IsbServices.sandboxAccountStore(testEnv),
      env: testEnv,
      durableContext: {
        logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
      },
      reportWriter: { updateRetentionTtl: vi.fn() },
      reportKey: {},
    } as unknown as CleanupContext;

    const cleanup = await initializeCleanup(ctx);

    // Exactly the cleanup section fields — no audit envelope leaks into the
    // value handed to the durable orchestration (and thus the durable history).
    expect(Object.keys(cleanup).sort()).toEqual(
      [
        "cooldownPeriodHours",
        "numberOfFailedAttemptsToCancelCleanup",
        "numberOfSuccessfulAttemptsToFinishCleanup",
        "reportRetentionDays",
        "validation",
        "waitBeforeRerunSuccessfulAttemptSeconds",
        "waitBeforeRetryFailedAttemptSeconds",
      ].sort(),
    );
    expect(cleanup).not.toHaveProperty("lastSavedBy");
    expect(cleanup).not.toHaveProperty("meta");

    // Stored section values are preserved through the projection.
    expect(cleanup).toEqual({
      numberOfSuccessfulAttemptsToFinishCleanup: 2,
      numberOfFailedAttemptsToCancelCleanup: 3,
      waitBeforeRerunSuccessfulAttemptSeconds: 1,
      waitBeforeRetryFailedAttemptSeconds: 1,
      validation: {
        failureAction: "Silent",
      },
      cooldownPeriodHours: 0,
      reportRetentionDays: 730,
    });
  });
});

describe("Initialize-Cleanup Defaults Fallback", () => {
  it("uses code defaults and warns when the cleanup section has never been saved", async () => {
    mockAccountStoreDefaults();
    // Never-saved section: the store returns null.
    vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(null);

    const warn = vi.fn();
    const ctx = {
      accountId: "123456789012",
      executionArn: "test-arn",
      cleanupReason: "LEASE_TERMINATION",
      accountStore: IsbServices.sandboxAccountStore(testEnv),
      env: testEnv,
      durableContext: {
        logger: { info: vi.fn(), warn, error: vi.fn() },
      },
      reportWriter: { updateRetentionTtl: vi.fn() },
      reportKey: {},
    } as unknown as CleanupContext;

    const cleanup = await initializeCleanup(ctx);

    // Falls back to the schema's code defaults, with no audit envelope.
    expect(cleanup).toEqual(ConfigSchemas.cleanup.parse({}));
    expect(cleanup).not.toHaveProperty("lastSavedBy");
    expect(cleanup).not.toHaveProperty("meta");

    // The never-saved fallback is surfaced at warn level for observability.
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("never been saved"),
      expect.objectContaining({ executionArn: "test-arn" }),
    );
  });
});

describe("Nuke Iteration Loop", () => {
  it("should start CodeBuild with correct env vars", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    const startBuildCalls = codeBuildClient.commandCalls(StartBuildCommand);
    expect(startBuildCalls.length).toBe(2);

    const envVars =
      startBuildCalls[0]!.args[0].input.environmentVariablesOverride;
    const envVarNames = envVars?.map((v) => v.name);

    expect(envVarNames).toContain("DURABLE_CALLBACK_ID");
    expect(envVarNames).toContain("CLEANUP_ACCOUNT_ID");
    expect(envVarNames).toContain("APPCONFIG_APPLICATION_ID");
  });

  it("should store codeBuildExecutionArn in nuke phase step entries", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    const addStepCalls = vi.mocked(DynamoCleanupReportStore.prototype.addStep)
      .mock.calls;

    // Find the nuke phase step entries (those with "nuke-phase-" in the step name)
    const nukeStepCalls = addStepCalls.filter((call) =>
      (call[0] as { step: { name: string } }).step.name.startsWith(
        "nuke-phase-",
      ),
    );

    expect(nukeStepCalls.length).toBe(2);

    for (const call of nukeStepCalls) {
      const stepArg = (call[0] as { step: { meta?: Record<string, unknown> } })
        .step;
      expect(stepArg.meta).toBeDefined();
      expect(stepArg.meta!.codeBuildExecutionArn).toBe(
        "arn:aws:codebuild:us-east-1:123456789012:build/cleanup-project:test-build-id",
      );
    }
  });

  it("should set cleanupStatus to NUKE_PHASE_N for each iteration", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    await runPromise;

    const updateCalls = vi.mocked(DynamoSandboxAccountStore.prototype.update)
      .mock.calls;
    const statusUpdates = updateCalls.map(
      (call) =>
        (call[1] as { set?: { activeCleanup?: { status?: string } } }).set
          ?.activeCleanup?.status,
    );

    expect(statusUpdates).toContain("NUKE_PHASE_1");
    expect(statusUpdates).toContain("NUKE_PHASE_2");
  });

  it("should record SUCCEEDED outcome for each nuke iteration via updateStepAtIndex", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    const updateStepCalls = vi.mocked(
      DynamoCleanupReportStore.prototype.updateStepAtIndex,
    ).mock.calls;

    // Should be called once per nuke iteration (2 iterations)
    expect(updateStepCalls.length).toBe(2);

    for (const call of updateStepCalls) {
      const input = call[0] as {
        index: number;
        completedAt: string;
        meta?: Record<string, unknown>;
      };
      expect(input.completedAt).toBeDefined();
      expect(input.meta).toEqual(
        expect.objectContaining({ outcome: "SUCCEEDED" }),
      );
      // Should preserve the codeBuildExecutionArn from the original step meta
      expect(input.meta).toHaveProperty("codeBuildExecutionArn");
    }
  });
});

describe("Top-Level Error Handling", () => {
  it("should release lock and publish failure event on error", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    stsClient.reset();
    stsClient.on(GetCallerIdentityCommand).rejects(new Error("Access denied"));

    const result = await runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(DynamoSandboxAccountStore.prototype.releaseLock).toHaveBeenCalled();
    expect(eventBridgeClient.commandCalls(PutEventsCommand)).toHaveLength(1);
  });

  it("does NOT publish a failure event when the lock was taken over by another execution", async () => {
    // releaseLock returns false => a concurrent execution preempted this one.
    // Publishing the failure event would spuriously quarantine an account the
    // other execution is actively cleaning, so it must be suppressed.
    mockAccountStoreDefaults();
    mockConfigStore();
    vi.spyOn(
      DynamoSandboxAccountStore.prototype,
      "releaseLock",
    ).mockResolvedValue(false);

    stsClient.reset();
    stsClient.on(GetCallerIdentityCommand).rejects(new Error("Access denied"));

    const result = await runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    expect(result.getStatus()).toBe(ExecutionStatus.FAILED);
    expect(DynamoSandboxAccountStore.prototype.releaseLock).toHaveBeenCalled();
    expect(eventBridgeClient.commandCalls(PutEventsCommand)).toHaveLength(0);
  });
});

describe("revoke-access Step", () => {
  const CURRENT_LEASE = {
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    ownerEmail: "owner@example.com",
  };

  it("resolves immediately when the lease lock is already cleared", async () => {
    mockAccountStoreDefaults({ currentLease: CURRENT_LEASE });
    mockConfigStore();

    // Lease has no resourceLock → condition passes on first poll
    vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
      result: { resourceLock: undefined },
    } as any);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    // REVOKING_ACCESS status was set
    const statusUpdates = vi
      .mocked(DynamoSandboxAccountStore.prototype.update)
      .mock.calls.map(
        (call) =>
          (call[1] as { set?: { activeCleanup?: { status?: string } } }).set
            ?.activeCleanup?.status,
      );
    expect(statusUpdates).toContain("REVOKING_ACCESS");
  });

  it("resolves immediately when the lease lock is expired (orphaned)", async () => {
    mockAccountStoreDefaults({ currentLease: CURRENT_LEASE });
    mockConfigStore();

    // Lease has an expired resourceLock
    vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
      result: {
        resourceLock: {
          ownerId: "terminate-dead",
          acquiredAt: "2025-01-01T00:00:00.000Z",
          expiresAt: "2025-01-01T00:15:00.000Z", // Well in the past
        },
      },
    } as any);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
  });

  it("skips the lease lock poll when the account has no currentLease", async () => {
    mockAccountStoreDefaults({ currentLease: undefined });
    mockConfigStore();
    const leaseGetSpy = vi.spyOn(DynamoLeaseStore.prototype, "get");

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
    // No lease read when the account has no currentLease
    expect(leaseGetSpy).not.toHaveBeenCalled();
  });

  it("proceeds to sweep after max poll attempts when lock is never released", async () => {
    mockAccountStoreDefaults({ currentLease: CURRENT_LEASE });
    mockConfigStore();

    // Lease lock is always held (never released) — simulates a stuck processor
    vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
      result: {
        resourceLock: {
          ownerId: "terminate-stuck",
          acquiredAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z", // Far in the future
        },
      },
    } as any);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    // The flow does NOT quarantine — it proceeds past the poll to the sweep and nuke.
    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);
  });

  it("renews the account lock on each poll iteration so it cannot expire mid-poll", async () => {
    mockAccountStoreDefaults({ currentLease: CURRENT_LEASE });
    mockConfigStore();

    // Lease lock is held for the first two polls, then released. This forces
    // the poll loop to iterate rather than resolve immediately, so we can
    // observe the per-iteration account-lock renewal.
    const heldLock = {
      result: {
        resourceLock: {
          ownerId: "terminate-stuck",
          acquiredAt: "2026-07-01T00:00:00.000Z",
          expiresAt: "2027-01-01T00:00:00.000Z",
        },
      },
    } as any;
    vi.spyOn(DynamoLeaseStore.prototype, "get")
      .mockResolvedValueOnce(heldLock)
      .mockResolvedValueOnce(heldLock)
      .mockResolvedValue({ result: { resourceLock: undefined } } as any);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    await runPromise;

    // The account lock must be renewed during the revoke-access poll, so a slow
    // poll cannot let the 300s lock expire and be stolen by a concurrent retry.
    const renewals = vi
      .mocked(DynamoSandboxAccountStore.prototype.acquireLock)
      .mock.calls.filter((call) => call[3]?.step === "revoke-access");
    expect(renewals.length).toBeGreaterThan(0);
  });

  it("uses consistentRead when polling the lease store", async () => {
    mockAccountStoreDefaults({ currentLease: CURRENT_LEASE });
    mockConfigStore();

    const leaseGetSpy = vi
      .spyOn(DynamoLeaseStore.prototype, "get")
      .mockResolvedValue({
        result: { resourceLock: undefined },
      } as any);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    await runPromise;

    // Verify consistentRead: true was passed
    expect(leaseGetSpy).toHaveBeenCalledWith(
      { userEmail: CURRENT_LEASE.ownerEmail, uuid: CURRENT_LEASE.leaseId },
      { consistentRead: true },
    );
  });
});

describe("Finalize-Cleanup Step", () => {
  it("should release lock, update account status, and publish success event", async () => {
    mockAccountStoreDefaults();
    mockConfigStore();

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    // Lock should be released
    expect(DynamoSandboxAccountStore.prototype.releaseLock).toHaveBeenCalled();

    // Cleanup fields should be removed from the account record
    const updateCalls = vi.mocked(DynamoSandboxAccountStore.prototype.update)
      .mock.calls;
    const removeUpdate = updateCalls.find((call) =>
      (call[1] as { remove?: string[] }).remove?.includes("activeCleanup"),
    );
    expect(removeUpdate).toBeDefined();

    // currentLease should be cleared only on successful cleanup
    const currentLeaseRemove = updateCalls.find((call) =>
      (call[1] as { remove?: string[] }).remove?.includes("currentLease"),
    );
    expect(currentLeaseRemove).toBeDefined();

    // lastCleanupCompletedAt should be set
    const setUpdate = updateCalls.find(
      (call) =>
        (call[1] as { set?: { lastCleanupCompletedAt?: string } }).set
          ?.lastCleanupCompletedAt !== undefined,
    );
    expect(setUpdate).toBeDefined();

    // Success event should be published (not failure event)
    const putEventsCalls = eventBridgeClient.commandCalls(PutEventsCommand);
    expect(putEventsCalls).toHaveLength(1);

    const eventDetail = JSON.parse(
      putEventsCalls[0]!.args[0].input.Entries![0]!.Detail!,
    );
    expect(eventDetail.accountId).toBe("123456789012");
    expect(eventDetail.reason).toBe("LEASE_TERMINATION");
    expect(eventDetail.cleanupExecutionContext.executionArn).toBeDefined();
  });
});

describe("Account Cooldown Step", () => {
  function mockConfigStoreWithCooldown(cooldownPeriodHours: number) {
    const configWithCooldown: PersistedConfigSectionData<"cleanup"> = {
      ...ConfigSchemas.cleanup.parse({
        numberOfSuccessfulAttemptsToFinishCleanup: 2,
        numberOfFailedAttemptsToCancelCleanup: 3,
        waitBeforeRerunSuccessfulAttemptSeconds: 1,
        waitBeforeRetryFailedAttemptSeconds: 1,
        validation: {
          failureAction: "Quarantine",
        },
        cooldownPeriodHours,
        reportRetentionDays: 730,
      }),
      lastSavedBy: "admin@example.com",
      meta: {
        createdTime: "2026-01-01T00:00:00.000Z",
        lastEditTime: "2026-01-01T00:00:00.000Z",
        schemaVersion: 1,
      },
    };
    vi.spyOn(DynamoConfigStore.prototype, "getSection").mockResolvedValue(
      configWithCooldown,
    );
  }

  it("should skip cooldown when cooldownPeriodHours is 0", async () => {
    mockAccountStoreDefaults();
    mockConfigStore(); // uses cooldownPeriodHours: 0

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);
    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    // Verify COOLING_DOWN status was never set
    const updateCalls = vi.mocked(DynamoSandboxAccountStore.prototype.update)
      .mock.calls;
    const statusUpdates = updateCalls.map(
      (call) =>
        (call[1] as { set?: { activeCleanup?: { status?: string } } }).set
          ?.activeCleanup?.status,
    );
    expect(statusUpdates).not.toContain("COOLING_DOWN");
  });

  it("should enter cooldown and complete naturally on timeout", async () => {
    mockAccountStoreDefaults();
    mockConfigStoreWithCooldown(1);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);

    // Wait for cooldown callback to be submitted, then send failure (simulates timeout expiry)
    const cooldownCallback = runner.getOperation("account-cooldown-wait");
    await cooldownCallback.waitForData(WaitingOperationStatus.SUBMITTED);
    await cooldownCallback.sendCallbackFailure({
      ErrorMessage: "Callback timed out",
    });

    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    // Verify COOLING_DOWN status was set
    const updateCalls = vi.mocked(DynamoSandboxAccountStore.prototype.update)
      .mock.calls;
    const statusUpdates = updateCalls.map(
      (call) =>
        (call[1] as { set?: { activeCleanup?: { status?: string } } }).set
          ?.activeCleanup?.status,
    );
    expect(statusUpdates).toContain("COOLING_DOWN");

    // Verify skipCooldownCallbackId was stored in the report
    const updateReportCalls = vi.mocked(
      DynamoCleanupReportStore.prototype.updateReport,
    ).mock.calls;
    const cooldownUpdate = updateReportCalls.find(
      (call) =>
        (call[0] as { skipCooldownCallbackId?: string })
          .skipCooldownCallbackId !== undefined,
    );
    expect(cooldownUpdate).toBeDefined();
  });

  it("should resume immediately when admin skips cooldown via callback", async () => {
    mockAccountStoreDefaults();
    mockConfigStoreWithCooldown(24);

    const runPromise = runner.run({
      payload: createCleanAccountEvent("123456789012", "LEASE_TERMINATION"),
    });

    await completeNukeCallbacks(2);

    // Wait for cooldown callback to be submitted, then send success (admin skip)
    const cooldownCallback = runner.getOperation("account-cooldown-wait");
    await cooldownCallback.waitForData(WaitingOperationStatus.SUBMITTED);
    await cooldownCallback.sendCallbackSuccess(JSON.stringify("skipped"));

    const result = await runPromise;

    expect(result.getStatus()).toBe(ExecutionStatus.SUCCEEDED);

    // Verify lock was renewed with correct timeout for cooldown
    const acquireLockCalls = vi.mocked(
      DynamoSandboxAccountStore.prototype.acquireLock,
    ).mock.calls;
    const cooldownLockCall = acquireLockCalls.find(
      (call) =>
        (call[3] as { step?: string } | undefined)?.step === "account-cooldown",
    );
    expect(cooldownLockCall).toBeDefined();
    // Timeout = cooldownPeriodHours * 3600 + 3600 = 24*3600 + 3600 = 90000
    expect(cooldownLockCall![2]).toBe(24 * 3600 + 3600);
  });
});

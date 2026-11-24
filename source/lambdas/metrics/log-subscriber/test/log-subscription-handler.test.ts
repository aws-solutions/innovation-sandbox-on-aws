// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";

import { LogSubscriberLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/log-subscriber-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { CloudWatchLogsEvent } from "aws-lambda";
import * as zlib from "node:zlib";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// Mock fetch globally
global.fetch = vi.fn();

const testEnv = generateSchemaData(LogSubscriberLambdaEnvironmentSchema);
let handler: typeof import("@amzn/innovation-sandbox-log-subscriber/log-subscription-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);
  handler = (
    await import("@amzn/innovation-sandbox-log-subscriber/log-subscription-handler.js")
  ).handler;
});

afterEach(() => {
  vi.clearAllMocks();
});

afterAll(() => {
  vi.unstubAllEnvs();
});

describe("log-subscription-handler", () => {
  const createCloudWatchLogsEvent = (
    logEvents: Array<{ message: string }>,
  ): CloudWatchLogsEvent => {
    const logData = {
      logEvents,
    };

    const compressed = zlib.gzipSync(JSON.stringify(logData));
    const base64Data = compressed.toString("base64");

    return {
      awslogs: {
        data: base64Data,
      },
    };
  };

  it("should process LeasePublished log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "LeasePublished",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
      maxBudget: 100,
      maxDurationHours: 24,
      autoApproved: true,
      creationMethod: "REQUESTED",
      hasBlueprint: false,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(testEnv.METRICS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: expect.stringContaining('"event_name":"LeasePublished"'),
    });

    // Verify the body contains expected data
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      uuid: testEnv.METRICS_UUID,
      hub_account_id: testEnv.HUB_ACCOUNT_ID,
      solution: testEnv.SOLUTION_ID,
      version: testEnv.SOLUTION_VERSION,
      event_name: "LeasePublished",
      context_version: 4,
      context: {
        maxBudget: 100,
        maxDurationHours: 24,
        autoApproved: true,
        creationMethod: "REQUESTED",
        hasBlueprint: false,
        numDesiredAssignments: 0,
      },
    });
    expect(bodyData.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("should process LeaseTerminated log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "LeaseTerminated",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
      startDate: "2024-01-01T00:00:00.000Z",
      terminationDate: "2024-01-02T00:00:00.000Z",
      maxBudget: 200,
      actualSpend: 150,
      maxDurationHours: 48,
      actualDurationHours: 36,
      reasonForTermination: "BudgetExceeded",
      agentSpend: 12.5,
      budgetExceededBy: "TOKEN_POLL",
      budgetTotalSpend: 162.5,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(testEnv.METRICS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: expect.stringContaining('"event_name":"LeaseTerminated"'),
    });

    // Verify the body contains expected data
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      uuid: testEnv.METRICS_UUID,
      hub_account_id: testEnv.HUB_ACCOUNT_ID,
      solution: testEnv.SOLUTION_ID,
      version: testEnv.SOLUTION_VERSION,
      event_name: "LeaseTerminated",
      context_version: 3,
      context: {
        maxBudget: 200,
        actualSpend: 150,
        maxDurationHours: 48,
        actualDurationHours: 36,
        reasonForTermination: "BudgetExceeded",
        agentSpend: 12.5,
        budgetExceededBy: "TOKEN_POLL",
        budgetTotalSpend: 162.5,
      },
    });
    expect(bodyData.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
  });

  it("omits agentSpend, budgetExceededBy and budgetTotalSpend on a LeaseTerminated log without them", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "LeaseTerminated",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
      startDate: "2024-01-01T00:00:00.000Z",
      terminationDate: "2024-01-02T00:00:00.000Z",
      actualSpend: 150,
      actualDurationHours: 36,
      reasonForTermination: "Expired",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const bodyData = JSON.parse(
      vi.mocked(fetch).mock.calls[0]![1]!.body as string,
    );
    expect(bodyData.context).not.toHaveProperty("agentSpend");
    expect(bodyData.context).not.toHaveProperty("budgetExceededBy");
    expect(bodyData.context).not.toHaveProperty("budgetTotalSpend");
  });

  it("should skip non-subscribable logs", async () => {
    const logMessage = JSON.stringify({
      level: "INFO",
      message: "Regular log message",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).not.toHaveBeenCalled();
  });

  it("should handle invalid JSON in log events", async () => {
    const event = createCloudWatchLogsEvent([{ message: "invalid json" }]);

    await expect(handler(event, mockContext(testEnv))).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("should handle malformed CloudWatch event", async () => {
    const malformedEvent = {
      awslogs: {
        data: "invalid-base64-data",
      },
    } as CloudWatchLogsEvent;

    await expect(
      handler(malformedEvent, mockContext(testEnv)),
    ).rejects.toThrow();
  });

  it("should handle invalid CloudWatch event structure", async () => {
    const invalidStructure = { invalidField: "test" };
    const compressed = zlib.gzipSync(JSON.stringify(invalidStructure));
    const base64Data = compressed.toString("base64");

    const event = {
      awslogs: {
        data: base64Data,
      },
    } as CloudWatchLogsEvent;

    await handler(event, mockContext(testEnv));
    expect(fetch).not.toHaveBeenCalled();
  });

  it("forwards a failed memory cleanup without lease id, attempt, or error message", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const log = {
      logDetailType: "MemoryCleanupFailed",
      leaseId: "11111111-1111-4111-8111-111111111111",
      phase: "verify",
      attempt: 3,
      errorName: "MemoryCleanupError",
      errorMessage: "Verification found 2 residual LTM records.",
    };
    await handler(
      createCloudWatchLogsEvent([{ message: JSON.stringify(log) }]),
      mockContext(testEnv),
    );

    const bodyData = JSON.parse(
      vi.mocked(fetch).mock.calls[0]![1]!.body as string,
    );
    expect(bodyData).toMatchObject({
      event_name: "MemoryCleanupFailed",
      context_version: 1,
    });
    expect(bodyData.context).toEqual({
      failedPhase: "verify",
      errorName: "MemoryCleanupError",
    });
  });

  it("does not forward a successful memory cleanup", async () => {
    const log = {
      logDetailType: "MemoryCleanupComplete",
      leaseId: "11111111-1111-4111-8111-111111111111",
      ltmDeleted: 7,
      attempt: 1,
    };
    await handler(
      createCloudWatchLogsEvent([{ message: JSON.stringify(log) }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("should process LeaseUnfrozen log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "LeaseUnfrozen",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"LeaseUnfrozen"'),
      }),
    );
  });

  it("should process LeaseReset log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "LeaseReset",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
      blueprintId: "bp-456",
      blueprintName: "Test-Blueprint",
      reasonForReset: "ProvisioningFailed",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"LeaseReset"'),
      }),
    );
  });

  it("should process DeploymentSummary log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "DeploymentSummary",
      numM2mClients: 4,
      numLeaseTemplates: 5,
      numLeaseTemplatesWithBlueprint: 3,
      numBlueprints: 2,
      blueprintServiceCounts: { S3: 1 },
      config: {
        numCostReportGroups: 2,
        requireMaxBudget: true,
        maxBudget: 1000,
        requireMaxDuration: true,
        maxDurationHours: 168,
        maxLeasesPerUser: 3,
        requireCostReportGroup: false,
        numberOfFailedAttemptsToCancelCleanup: 3,
        waitBeforeRetryFailedAttemptSeconds: 300,
        numberOfSuccessfulAttemptsToFinishCleanup: 2,
        waitBeforeRerunSuccessfulAttemptSeconds: 60,
        isStableTaggingEnabled: true,
        isMultiAccountDeployment: false,
        allowUserLeaseTermination: true,
        leaseRequestWindowHours: 168,
        maxLeaseRequestsPerWindow: 10,
        leaseSharingEnabled: true,
        enablePrincipalSearch: true,
        allowPredictiveBudgetControls: true,
        serviceBreakdownEnabled: false,
        allowBedrockTokenMonitoring: true,
        sandboxSpacesEnabled: true,
      },
      accountPool: {
        available: 10,
        active: 5,
        frozen: 2,
        cleanup: 1,
        quarantine: 0,
      },
      additionalAllowedServicesList: ["sts:*", "support:*"],
      bedrockInferenceProfilePatternsList: ["*", "us.*"],
      numTemplatesWithSharing: 2,
      numLeasesWithAssignments: 3,
      totalUserAssignments: 5,
      totalGroupAssignments: 2,
      avgAssignmentsPerLease: 2.33,
      maxAssignmentsPerLease: 4,
      dailyApiCallsByAuthType: { m2m: 7, user: 42 },
      predictiveBudget: {
        enabledTemplates: 3,
        enabledActiveLeases: 8,
        rateLimitTemplates: 2,
        rateLimitActiveLeases: 5,
      },
      bedrockTokenMonitoring: { enabledTemplates: 4, enabledActiveLeases: 7 },
      sandboxSpaces: { enabledActiveLeases: 6 },
      permissionProfiles: {
        numTaggedPermissionSets: 6,
        numAssignmentsWithCustomPermissionSet: 8,
        numLeasesWithCustomPermissionSet: 3,
        maxUniquePermissionSetsPerLease: 4,
        avgUniquePermissionSetsPerLease: 2.5,
        maxAllowedPermissionSetsPerTemplate: 5,
        avgAllowedPermissionSetsPerTemplate: 2.75,
        maxAllowedPermissionSetsPerLease: 4,
        avgAllowedPermissionSetsPerLease: 2.25,
      },
      notificationSesEnabled: true,
      notificationSnsEnabled: true,
      notificationUsingDelegatedSesIdentity: false,
      notificationSnsSubscriptionCount: 2,
      notificationFailuresSes: 0,
      notificationFailuresSns: 1,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"DeploymentSummary"'),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "DeploymentSummary",
      context_version: 5,
      context: {
        numM2mClients: 4,
        allowUserLeaseTermination: true,
        leaseRequestWindowHours: 168,
        maxLeaseRequestsPerWindow: 10,
        additionalAllowedServicesList: ["sts:*", "support:*"],
        bedrockInferenceProfilePatternsList: ["*", "us.*"],
        leaseSharingEnabled: true,
        enablePrincipalSearch: true,
        numTemplatesWithSharing: 2,
        numLeasesWithAssignments: 3,
        totalUserAssignments: 5,
        totalGroupAssignments: 2,
        avgAssignmentsPerLease: 2.33,
        maxAssignmentsPerLease: 4,
        dailyM2mApiCalls: 7,
        dailyUserApiCalls: 42,
        allowPredictiveBudgetControls: true,
        serviceBreakdownEnabled: false,
        allowBedrockTokenMonitoring: true,
        predictiveBudgetEnabledTemplates: 3,
        predictiveBudgetEnabledActiveLeases: 8,
        predictiveBudgetRateLimitTemplates: 2,
        predictiveBudgetRateLimitActiveLeases: 5,
        bedrockTokenMonitoringEnabledTemplates: 4,
        bedrockTokenMonitoringEnabledActiveLeases: 7,
        sandboxSpacesEnabled: true,
        sandboxSpacesEnabledActiveLeases: 6,
        numTaggedPermissionSets: 6,
        numAssignmentsWithCustomPermissionSet: 8,
        numLeasesWithCustomPermissionSet: 3,
        maxUniquePermissionSetsPerLease: 4,
        avgUniquePermissionSetsPerLease: 2.5,
        maxAllowedPermissionSetsPerTemplate: 5,
        avgAllowedPermissionSetsPerTemplate: 2.75,
        maxAllowedPermissionSetsPerLease: 4,
        avgAllowedPermissionSetsPerLease: 2.25,
        notificationSesEnabled: true,
        notificationSnsEnabled: true,
        notificationUsingDelegatedSesIdentity: false,
        notificationSnsSubscriptionCount: 2,
        notificationFailuresSes: 0,
        notificationFailuresSns: 1,
      },
    });
  });

  it("should process CostReporting log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "CostReporting",
      startDate: "2024-01-01",
      endDate: "2024-01-31",
      sandboxAccountsCost: 500.5,
      solutionOperatingCost: 100.25,
      numAccounts: 15,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"CostReporting"'),
      }),
    );
  });

  it("should process AccountCleanupCompleted log and send metric with full context", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "AccountCleanupCompleted",
      outcome: "SUCCESS",
      durationMinutes: 105,
      reason: "LEASE_TERMINATION",
      failedStep: null,
      validationMode: "Quarantine",
      totalResourcesBefore: 42,
      totalResourcesIgnored: 5,
      resourcesBefore: { "ec2:instance": 3, "s3:bucket": 2 },
      resourcesRemaining: {},
      resourcesClearedDuringCooldown: { "ec2:instance": 3, "s3:bucket": 2 },
      cooldownConfiguredHours: 24,
      cooldownActualSeconds: 3600,
      cooldownSkipped: false,
      steps: [
        { name: "initialize-cleanup", durationSeconds: 5 },
        { name: "summarize-account-before-cleanup", durationSeconds: 12 },
        { name: "nuke-phase-1", durationSeconds: 2700 },
        { name: "validate-cleanup", durationSeconds: 630 },
        {
          name: "account-cooldown",
          durationSeconds: 3600,
          configuredHours: 24,
          skipped: false,
        },
        { name: "finalize-cleanup", durationSeconds: 2 },
      ],
      idcAssignmentsFound: 3,
      idcAssignmentsDeleted: 3,
      principalRecordsFound: 2,
      principalRecordsDeleted: 2,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"AccountCleanupCompleted"'),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "AccountCleanupCompleted",
      context_version: 1,
      context: {
        outcome: "SUCCESS",
        durationMinutes: 105,
        reason: "LEASE_TERMINATION",
        failedStep: null,
        validationMode: "Quarantine",
        totalResourcesBefore: 42,
        totalResourcesIgnored: 5,
        resourcesBefore: { "ec2:instance": 3, "s3:bucket": 2 },
        resourcesRemaining: {},
        resourcesClearedDuringCooldown: { "ec2:instance": 3, "s3:bucket": 2 },
        cooldownConfiguredHours: 24,
        cooldownActualSeconds: 3600,
        cooldownSkipped: false,
        steps: [
          { name: "initialize-cleanup", durationSeconds: 5 },
          { name: "summarize-account-before-cleanup", durationSeconds: 12 },
          { name: "nuke-phase-1", durationSeconds: 2700 },
          { name: "validate-cleanup", durationSeconds: 630 },
          {
            name: "account-cooldown",
            durationSeconds: 3600,
            configuredHours: 24,
            skipped: false,
          },
          { name: "finalize-cleanup", durationSeconds: 2 },
        ],
        idcAssignmentsFound: 3,
        idcAssignmentsDeleted: 3,
        principalRecordsFound: 2,
        principalRecordsDeleted: 2,
      },
    });
  });

  it("should handle AccountDrift log without sending metric", async () => {
    const logMessage = JSON.stringify({
      logDetailType: "AccountDrift",
      accountId: "123456789012",
      expectedOu: "sandbox",
      actualOu: "root",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(["MANUAL", "DRIFT", "CLEANUP_FAILED"] as const)(
    "should process AccountQuarantined log with reasonForQuarantine=%s and send metric",
    async (reasonForQuarantine) => {
      const mockResponse = new Response(JSON.stringify({ success: true }), {
        status: 200,
      });
      vi.mocked(fetch).mockResolvedValue(mockResponse);

      const logMessage = JSON.stringify({
        logDetailType: "AccountQuarantined",
        accountId: "123456789012",
        reasonForQuarantine,
      });

      const event = createCloudWatchLogsEvent([{ message: logMessage }]);

      await handler(event, mockContext(testEnv));

      expect(fetch).toHaveBeenCalledWith(testEnv.METRICS_URL, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: expect.stringContaining('"event_name":"AccountQuarantined"'),
      });

      const callArgs = vi.mocked(fetch).mock.calls[0];
      const bodyData = JSON.parse(callArgs![1]!.body as string);
      expect(bodyData).toMatchObject({
        uuid: testEnv.METRICS_UUID,
        hub_account_id: testEnv.HUB_ACCOUNT_ID,
        solution: testEnv.SOLUTION_ID,
        version: testEnv.SOLUTION_VERSION,
        event_name: "AccountQuarantined",
        context_version: 1,
        context: {
          reasonForQuarantine,
        },
      });
    },
  );

  it("should process AssignmentExecutionCompleted log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "AssignmentExecutionCompleted",
      leaseId: "lease-123",
      accountId: "123456789012",
      intent: "UPDATE",
      principalsProcessed: 5,
      succeeded: 4,
      failed: 1,
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining(
          '"event_name":"AssignmentExecutionCompleted"',
        ),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "AssignmentExecutionCompleted",
      context_version: 1,
      context: {
        intent: "UPDATE",
        principalsProcessed: 5,
        succeeded: 4,
        failed: 1,
      },
    });
  });

  it("should process TagResourceFailed log and send metric without PII", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "TagResourceFailed",
      reason: "TagSpaceExhausted",
      accountId: "123456789012",
      tagKeys: [
        "LeaseId",
        "CostReportGroup",
        "LeaseTemplate",
        "User",
        "Status",
      ],
      errorName: "ConstraintViolationException",
      errorMessage: "Tag limit exceeded on 123456789012",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        body: expect.stringContaining('"event_name":"TagResourceFailed"'),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "TagResourceFailed",
      context_version: 1,
      context: {
        reason: "TagSpaceExhausted",
        tagKeyCount: 5,
        errorName: "ConstraintViolationException",
      },
    });
    // PII must NOT be shipped
    expect(bodyData.context).not.toHaveProperty("accountId");
    expect(bodyData.context).not.toHaveProperty("errorMessage");
    expect(bodyData.context).not.toHaveProperty("tagKeys");
  });

  it("should process TagResourceFailed with ApiError reason (single-key update path)", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "TagResourceFailed",
      reason: "ApiError",
      accountId: "111111111111",
      tagKeys: ["CostReportGroup"],
      errorName: "ThrottlingException",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "TagResourceFailed",
      context_version: 1,
      context: {
        reason: "ApiError",
        tagKeyCount: 1,
        errorName: "ThrottlingException",
      },
    });
  });

  it("should process TagActivationFailed log and send metric", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "TagActivationFailed",
      reason: "MaxAttemptsReached",
      attempt: 24,
      maxAttempts: 24,
      tagsInactive: ["LeaseId", "CostReportGroup"],
      tagsMissing: ["Status"],
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        body: expect.stringContaining('"event_name":"TagActivationFailed"'),
      }),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "TagActivationFailed",
      context_version: 1,
      context: {
        reason: "MaxAttemptsReached",
        tagsInactiveCount: 2,
        tagsMissingCount: 1,
      },
    });
    // Arrays are shipped as counts, not values, to avoid leaking internal
    // tag schema. `attempt` and `maxAttempts` are stripped because they
    // carry no signal (attempt always equals maxAttempts here, and
    // maxAttempts is a compile-time CDK constant).
    expect(bodyData.context).not.toHaveProperty("tagsInactive");
    expect(bodyData.context).not.toHaveProperty("tagsMissing");
    expect(bodyData.context).not.toHaveProperty("attempt");
    expect(bodyData.context).not.toHaveProperty("maxAttempts");
  });

  it("should process BudgetThresholdFired log and send metric", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    // Emitted with the lease's searchable properties, none of which may leave
    // the account.
    const logMessage = JSON.stringify({
      logDetailType: "BudgetThresholdFired",
      endUser: "user@example.com",
      leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseTemplateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      leaseTemplateName: "Standard Sandbox",
      createdBy: "admin@example.com",
      accountId: "222222222222",
      thresholdDollars: 80,
      action: "FREEZE_ACCOUNT",
      triggeredBy: "PREDICTED",
      evaluatedBy: "LEASE_MONITORING",
      spendAtFire: 66.5,
      billedCostAtFire: 66.5,
      predictedCostAtFire: 81.2,
      hoursSinceLastRefresh: 3.5,
      costAtFreezeDecision: 66.5,
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "BudgetThresholdFired",
      context_version: 1,
    });
    expect(bodyData.context).toEqual({
      thresholdDollars: 80,
      action: "FREEZE_ACCOUNT",
      triggeredBy: "PREDICTED",
      evaluatedBy: "LEASE_MONITORING",
      spendAtFire: 66.5,
      billedCostAtFire: 66.5,
      predictedCostAtFire: 81.2,
      hoursSinceLastRefresh: 3.5,
      costAtFreezeDecision: 66.5,
    });
  });

  it("forwards a dollar BudgetThresholdFired with only dollar context fields", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    // Stray spend-rate fields must not reach the metric.
    const logMessage = JSON.stringify({
      logDetailType: "BudgetThresholdFired",
      thresholdDollars: 50,
      thresholdRate: 10,
      thresholdRateBasis: "HOURLY",
      action: "ALERT",
      triggeredBy: "REPORTED",
      evaluatedBy: "LEASE_MONITORING",
      spendAtFire: 52,
      billedCostAtFire: 52,
      predictedCostAtFire: null,
      hoursSinceLastRefresh: null,
      costAtFreezeDecision: null,
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "BudgetThresholdFired",
      context_version: 1,
    });
    expect(bodyData.context).toEqual({
      thresholdDollars: 50,
      action: "ALERT",
      triggeredBy: "REPORTED",
      evaluatedBy: "LEASE_MONITORING",
      spendAtFire: 52,
      billedCostAtFire: 52,
      predictedCostAtFire: null,
      hoursSinceLastRefresh: null,
      costAtFreezeDecision: null,
    });
  });

  it.each([
    {
      action: "ALERT",
      log: {
        rateBasis: "HOURLY",
        thresholdRate: 10,
        measuredRate: 14.2,
        action: "ALERT",
        evaluatedBy: "LEASE_MONITORING",
        spendAtFire: 12,
        billedCostAtFire: 12,
        predictedCostAtFire: null,
        hoursSinceLastRefresh: null,
        costAtFreezeDecision: null,
      },
    },
    {
      action: "FREEZE_ACCOUNT",
      log: {
        rateBasis: "DAILY",
        thresholdRate: 200,
        measuredRate: 260,
        action: "FREEZE_ACCOUNT",
        evaluatedBy: "TOKEN_POLL",
        spendAtFire: 91,
        billedCostAtFire: 90,
        predictedCostAtFire: 140,
        hoursSinceLastRefresh: 2.5,
        costAtFreezeDecision: 91,
      },
    },
  ])(
    "forwards a $action SpendRateThresholdFired log as SpendRateThresholdFired",
    async ({ log }) => {
      vi.mocked(fetch).mockResolvedValue(
        new Response(JSON.stringify({ success: true }), { status: 200 }),
      );

      // Emitted with the lease's searchable properties, none of which may
      // leave the account.
      const logMessage = JSON.stringify({
        logDetailType: "SpendRateThresholdFired",
        endUser: "user@example.com",
        leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        accountId: "222222222222",
        ...log,
      });

      await handler(
        createCloudWatchLogsEvent([{ message: logMessage }]),
        mockContext(testEnv),
      );

      expect(fetch).toHaveBeenCalledTimes(1);
      const callArgs = vi.mocked(fetch).mock.calls[0];
      const bodyData = JSON.parse(callArgs![1]!.body as string);
      expect(bodyData).toMatchObject({
        event_name: "SpendRateThresholdFired",
        context_version: 1,
      });
      expect(bodyData.context).toEqual(log);
    },
  );

  it("drops an invalid SpendRateThresholdFired log with a warning and sends no metric", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    // A freeze figure on an ALERT is a state the system cannot produce.
    const logMessage = JSON.stringify({
      logDetailType: "SpendRateThresholdFired",
      rateBasis: "HOURLY",
      thresholdRate: 10,
      measuredRate: 14.2,
      action: "ALERT",
      evaluatedBy: "LEASE_MONITORING",
      spendAtFire: 12,
      billedCostAtFire: 12,
      costAtFreezeDecision: 12,
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining("failed to parse CW Log"),
      expect.anything(),
    );
    warn.mockRestore();
  });

  it("should process ProjectionAccuracy log and send metric", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "ProjectionAccuracy",
      endUser: "user@example.com",
      leaseId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      leaseTemplateId: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
      leaseTemplateName: "Standard Sandbox",
      createdBy: "admin@example.com",
      accountId: "222222222222",
      predictedCost: 70.5,
      billedCostAccrued: 68,
      errorDollars: 2.5,
      errorPercent: 3.676,
      intervalHours: 3,
      rateSource: "HOURLY",
      algorithmId: "linear-max-v1",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      event_name: "ProjectionAccuracy",
      context_version: 1,
    });
    expect(bodyData.context).toEqual({
      predictedCost: 70.5,
      billedCostAccrued: 68,
      errorDollars: 2.5,
      errorPercent: 3.676,
      intervalHours: 3,
      rateSource: "HOURLY",
      algorithmId: "linear-max-v1",
    });
  });

  it("should forward a null errorPercent as null, not zero", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    // Nothing billed yet, so the emitter has no total to divide by.
    const logMessage = JSON.stringify({
      logDetailType: "ProjectionAccuracy",
      predictedCost: 4,
      billedCostAccrued: 0,
      errorDollars: 4,
      errorPercent: null,
      intervalHours: 1,
      rateSource: "HOURLY",
      algorithmId: "linear-max-v1",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData.context.errorPercent).toBeNull();
  });

  it("should parse SpendRateComputed without a warning and NOT forward it", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    const logMessage = JSON.stringify({
      logDetailType: "SpendRateComputed",
      hourlyRate: 2.5,
      dailyRate: 60,
      rateUnavailable: false,
      costExplorerRefreshed: true,
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should parse AgentTurnMeteringFailed without a warning and NOT forward it", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});

    const logMessage = JSON.stringify({
      logDetailType: "AgentTurnMeteringFailed",
      modelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
      estimatedInputTokens: 12,
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("should parse SandboxSpacesUsageRecordingFailed without a warning and NOT forward it", async () => {
    const warn = vi
      .spyOn(Logger.prototype, "warn")
      .mockImplementation(() => {});
    const logMessage = JSON.stringify({
      logDetailType: "SandboxSpacesUsageRecordingFailed",
      leaseId: "11111111-1111-4111-8111-111111111111",
      messageId: "msg-001",
      modelId: "us.anthropic.claude-opus-4-5-20251101-v1:0",
    });
    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });
  it("should NOT send a metric for UntagResourceFailed logs", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "UntagResourceFailed",
      accountId: "123456789012",
      tagKeys: ["LeaseId"],
      errorName: "ApiError",
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
  });

  it("should NOT send a metric for TagActivationSucceeded logs", async () => {
    vi.mocked(fetch).mockResolvedValue(
      new Response(JSON.stringify({ success: true }), { status: 200 }),
    );

    const logMessage = JSON.stringify({
      logDetailType: "TagActivationSucceeded",
      attempt: 3,
      tagsActivated: [
        "LeaseId",
        "CostReportGroup",
        "LeaseTemplate",
        "User",
        "Status",
      ],
    });

    await handler(
      createCloudWatchLogsEvent([{ message: logMessage }]),
      mockContext(testEnv),
    );

    expect(fetch).not.toHaveBeenCalled();
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

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
    await import(
      "@amzn/innovation-sandbox-log-subscriber/log-subscription-handler.js"
    )
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

  it("should process LeaseApproved log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "LeaseApproved",
      leaseId: "lease-123",
      leaseTemplateId: "template-456",
      accountId: "123456789012",
      maxBudget: 100,
      maxDurationHours: 24,
      autoApproved: true,
      creationMethod: "REQUESTED",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(testEnv.METRICS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: expect.stringContaining('"event_name":"LeaseApproved"'),
    });

    // Verify the body contains expected data
    const callArgs = vi.mocked(fetch).mock.calls[0];
    const bodyData = JSON.parse(callArgs![1]!.body as string);
    expect(bodyData).toMatchObject({
      uuid: testEnv.METRICS_UUID,
      hub_account_id: testEnv.HUB_ACCOUNT_ID,
      solution: testEnv.SOLUTION_ID,
      version: testEnv.SOLUTION_VERSION,
      event_name: "LeaseApproved",
      context_version: 2,
      context: {
        maxBudget: 100,
        maxDurationHours: 24,
        autoApproved: true,
        creationMethod: "REQUESTED",
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
      reasonForTermination: "Expired",
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
      context_version: 2,
      context: {
        maxBudget: 200,
        actualSpend: 150,
        maxDurationHours: 48,
        actualDurationHours: 36,
        reasonForTermination: "Expired",
      },
    });
    expect(bodyData.timestamp).toMatch(
      /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
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

  it("should process DeploymentSummary log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "DeploymentSummary",
      numLeaseTemplates: 5,
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
      },
      accountPool: {
        available: 10,
        active: 5,
        frozen: 2,
        cleanup: 1,
        quarantine: 0,
      },
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

  it("should process AccountCleanupSuccess log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "AccountCleanupSuccess",
      accountId: "123456789012",
      durationMinutes: 15,
      stateMachineExecutionArn:
        "arn:aws:states:us-east-1:123456789012:execution:test",
      stateMachineExecutionURL: "https://console.aws.amazon.com/states/home",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"AccountCleanupSuccess"'),
      }),
    );
  });

  it("should process AccountCleanupFailure log and send metric", async () => {
    const mockResponse = new Response(JSON.stringify({ success: true }), {
      status: 200,
    });
    vi.mocked(fetch).mockResolvedValue(mockResponse);

    const logMessage = JSON.stringify({
      logDetailType: "AccountCleanupFailure",
      accountId: "123456789012",
      durationMinutes: 30,
      stateMachineExecutionArn:
        "arn:aws:states:us-east-1:123456789012:execution:test",
      stateMachineExecutionURL: "https://console.aws.amazon.com/states/home",
    });

    const event = createCloudWatchLogsEvent([{ message: logMessage }]);

    await handler(event, mockContext(testEnv));

    expect(fetch).toHaveBeenCalledWith(
      testEnv.METRICS_URL,
      expect.objectContaining({
        method: "POST",
        body: expect.stringContaining('"event_name":"AccountCleanupFailure"'),
      }),
    );
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
});

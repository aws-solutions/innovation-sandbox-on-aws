// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GroupCostReportingLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/group-cost-reporting-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  createEventBridgeEvent,
  mockContext,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { DateTime } from "luxon";
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

const testEnv = generateSchemaData(GroupCostReportingLambdaEnvironmentSchema, {
  REPORT_BUCKET_NAME: "test-bucket",
});

let generateReport: any;

const mockLeaseStore = {
  findByStatus: vi.fn(),
};

const mockCostExplorerService = {
  getDailyCostsByAccount: vi.fn(),
};

const mockEventBridgeClient = {
  sendIsbEvent: vi.fn(),
};

const mockS3Send = vi.fn();
const mockCollect = vi.fn();
const mockBackOff = vi.fn();

const mockMonitoredLease = {
  userEmail: "test@example.com",
  uuid: "test-uuid-1",
  awsAccountId: "123456789012",
  startDate: "2024-01-01T00:00:00.000Z",
  status: "Active",
  approvedBy: "AUTO_APPROVED",
  costReportGroup: "test-group-1",
  leaseTemplateUuid: "template-uuid",
  comments: "Test lease",
  maxBudget: 100,
  maxDurationHours: 24,
  approvedAt: "2024-01-01T00:00:00.000Z",
};

const mockExpiredLease = {
  userEmail: "test2@example.com",
  uuid: "test-uuid-2",
  awsAccountId: "123456789013",
  startDate: "2024-01-01T00:00:00.000Z",
  endDate: "2024-01-02T00:00:00.000Z",
  status: "Expired",
  approvedBy: "AUTO_APPROVED",
  costReportGroup: "test-group-2",
  leaseTemplateUuid: "template-uuid",
  comments: "Test expired lease",
  maxBudget: 50,
  maxDurationHours: 24,
  approvedAt: "2024-01-01T00:00:00.000Z",
};

beforeAll(async () => {
  bulkStubEnv(testEnv);

  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      leaseStore: vi.fn().mockReturnValue(mockLeaseStore),
      costExplorer: vi.fn().mockReturnValue(mockCostExplorerService),
      isbEventBridge: vi.fn().mockReturnValue(mockEventBridgeClient),
    },
  }));

  vi.doMock("@aws-sdk/client-s3", () => ({
    S3Client: vi.fn().mockImplementation(function () {
      return { send: mockS3Send };
    }),
    PutObjectCommand: vi.fn(),
  }));

  vi.doMock("exponential-backoff", () => ({
    backOff: mockBackOff,
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/utils/time-utils.js", () => ({
    now: vi.fn().mockReturnValue(DateTime.fromISO("2024-02-15T12:00:00.000Z")),
  }));

  vi.doMock(
    "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
    () => ({
      fromTemporaryIsbOrgManagementCredentials: vi.fn().mockReturnValue({}),
    }),
  );

  vi.doMock("@amzn/innovation-sandbox-commons/data/utils.js", () => ({
    collect: mockCollect,
    stream: vi.fn().mockReturnValue([]),
  }));

  // Import the handler after mocking dependencies
  const module = await import(
    "@amzn/innovation-sandbox-group-cost-reporting/group-cost-reporting-handler.js"
  );
  generateReport = module.generateReport;
});

afterAll(() => {
  vi.unstubAllEnvs();
});

afterEach(() => {
  vi.clearAllMocks();
  mockCollect.mockResolvedValue([mockMonitoredLease, mockExpiredLease]);
});

describe("group-cost-reporting-handler", () => {
  const mockedContext = mockContext(testEnv);
  const scheduleEvent = createEventBridgeEvent("Scheduled Event", {});

  const mockDailyCosts = {
    "123456789012": {
      "2024-01-01": 10.5,
      "2024-01-02": 15.25,
    },
    "123456789013": {
      "2024-01-01": 5.75,
      "2024-01-02": 8.3,
    },
  };

  beforeEach(() => {
    // Reset mocks with default successful behavior
    mockBackOff.mockImplementation((fn) => fn());
    mockCollect.mockResolvedValue([mockMonitoredLease, mockExpiredLease]);
    mockLeaseStore.findByStatus.mockReturnValue([]);
    mockCostExplorerService.getDailyCostsByAccount.mockResolvedValue(
      mockDailyCosts,
    );
    mockEventBridgeClient.sendIsbEvent.mockResolvedValue(undefined);
    mockS3Send.mockResolvedValue({});
  });

  describe("generateReport", () => {
    it("should successfully generate and upload cost report", async () => {
      await generateReport(scheduleEvent, mockedContext);

      // Verify cost explorer was called with correct account IDs
      expect(
        mockCostExplorerService.getDailyCostsByAccount,
      ).toHaveBeenCalledWith(
        ["123456789012", "123456789013"],
        expect.any(DateTime),
        expect.any(DateTime),
      );

      // Verify S3 upload was called
      expect(mockS3Send).toHaveBeenCalled();

      // Verify success event was sent
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should handle custom report month from event detail", async () => {
      const customEvent = createEventBridgeEvent("Scheduled Event", {
        reportMonth: "2024-01",
      });

      await generateReport(customEvent, mockedContext);

      // Verify cost explorer was called with January 2024 dates
      const [, startDate, endDate] =
        mockCostExplorerService.getDailyCostsByAccount.mock.calls[0] || [];
      expect(startDate.toFormat("yyyy-MM")).toBe("2024-01");
      expect(endDate.toFormat("yyyy-MM")).toBe("2024-01");
    });

    it("should send failure event when lease store fails", async () => {
      const error = new Error("DynamoDB error");
      mockCollect.mockRejectedValue(error);

      await expect(
        generateReport(scheduleEvent, mockedContext),
      ).rejects.toThrow(error);

      // Verify failure event was sent
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should handle empty lease results", async () => {
      // Mock collect to return empty array for all status calls
      mockCollect.mockResolvedValue([]);

      await generateReport(scheduleEvent, mockedContext);

      // Should call cost explorer with empty account list
      expect(
        mockCostExplorerService.getDailyCostsByAccount,
      ).toHaveBeenCalledWith([], expect.any(DateTime), expect.any(DateTime));

      // Should still upload report and send success event
      expect(mockS3Send).toHaveBeenCalled();
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should handle leases without cost report group", async () => {
      const leaseWithoutGroup = {
        ...mockMonitoredLease,
        uuid: "no-group-uuid",
        costReportGroup: undefined,
      };

      // Mock collect to return lease without group
      mockCollect.mockResolvedValue([leaseWithoutGroup]);

      await generateReport(scheduleEvent, mockedContext);

      // Should still process the lease and upload report
      expect(
        mockCostExplorerService.getDailyCostsByAccount,
      ).toHaveBeenCalledWith(
        ["123456789012"],
        expect.any(DateTime),
        expect.any(DateTime),
      );
      expect(mockS3Send).toHaveBeenCalled();
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should send failure event when cost explorer fails", async () => {
      const error = new Error("Cost Explorer error");
      mockCostExplorerService.getDailyCostsByAccount.mockRejectedValue(error);

      await expect(
        generateReport(scheduleEvent, mockedContext),
      ).rejects.toThrow(error);

      // Verify failure event was sent
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should send failure event when S3 upload fails", async () => {
      const error = new Error("S3 upload error");
      mockS3Send.mockRejectedValue(error);

      await expect(
        generateReport(scheduleEvent, mockedContext),
      ).rejects.toThrow(error);

      // Verify failure event was sent
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });
  });

  describe("lease store retry logic", () => {
    beforeEach(() => {
      // Reset backOff to capture retry configuration
      mockBackOff.mockClear();
    });

    it("should configure backOff with correct retry parameters", async () => {
      mockBackOff.mockImplementation((fn, options) => {
        // Verify backOff configuration
        expect(options.numOfAttempts).toBe(5);
        expect(options.jitter).toBe("full");
        expect(options.startingDelay).toBe(1000);
        expect(typeof options.retry).toBe("function");
        return fn();
      });

      await generateReport(scheduleEvent, mockedContext);

      // Verify backOff was called for each lease status (7 statuses)
      expect(mockBackOff).toHaveBeenCalledTimes(7);
    });

    it.each([
      ["ThrottlingException", "Request rate exceeded"],
      [
        "ProvisionedThroughputExceededException",
        "Provisioned throughput exceeded",
      ],
      ["ServiceUnavailableException", "Service temporarily unavailable"],
      ["InternalServerError", "Internal server error"],
    ])("should retry on %s", async (errorName, errorMessage) => {
      const retryableError = new Error(errorMessage);
      retryableError.name = errorName;

      let retryFunction: (error: Error) => boolean;
      mockBackOff.mockImplementation((fn, options) => {
        retryFunction = options.retry;
        return fn();
      });

      await generateReport(scheduleEvent, mockedContext);

      // Test the retry function
      expect(retryFunction!(retryableError)).toBe(true);
    });

    it("should handle successful retry after retryable error", async () => {
      const throttlingError = new Error("Request rate exceeded");
      throttlingError.name = "ThrottlingException";

      let callCount = 0;
      mockBackOff.mockImplementation(async (fn, options) => {
        // Simulate retry behavior
        try {
          return await fn();
        } catch (error) {
          callCount++;
          if (callCount < 3 && options.retry(error)) {
            // Simulate successful retry after 2 failures
            mockCollect.mockResolvedValueOnce([mockMonitoredLease]);
            return await fn();
          }
          throw error;
        }
      });

      // First two calls fail, third succeeds
      mockCollect
        .mockRejectedValueOnce(throttlingError)
        .mockRejectedValueOnce(throttlingError)
        .mockResolvedValue([mockMonitoredLease]);

      await generateReport(scheduleEvent, mockedContext);

      // Should complete successfully after retries
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });

    it("should fail after max retries on persistent retryable error", async () => {
      const throttlingError = new Error("Persistent throttling");
      throttlingError.name = "ThrottlingException";

      mockBackOff.mockImplementation(async () => {
        // Simulate exhausting all retries
        throw throttlingError;
      });

      mockCollect.mockRejectedValue(throttlingError);

      await expect(
        generateReport(scheduleEvent, mockedContext),
      ).rejects.toThrow(throttlingError);

      // Should send failure event
      expect(mockEventBridgeClient.sendIsbEvent).toHaveBeenCalled();
    });
  });
});

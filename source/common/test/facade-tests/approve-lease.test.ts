// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  MonitoredLease,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import {
  searchableAccountProperties,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIdcService,
  mockedLeaseStore,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { IsbUserSchema } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    isbEventBridgeClient: createMockOf(IsbEventBridgeClient),
    orgsService: mockedOrgsService(),
    idcService: mockedIdcService(),
    leaseStore: mockedLeaseStore(),
    sandboxAccountStore: mockedAccountStore(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

const mockUser = generateSchemaData(IsbUserSchema);

describe("InnovationSandbox.approveLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;

  const mockAvailableAccount = generateSchemaData(SandboxAccountSchema, {
    status: "Available",
  });

  beforeEach(() => {
    mockContext = createMockContext();

    mockContext.idcService.getUserFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        } else {
          throw new Error("Invalid ISB User.");
        }
      },
    );

    mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
      result: [mockAvailableAccount],
    } as PaginatedQueryResult<SandboxAccount>);

    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("Writes approved lease to DB", async () => {
    const leaseToApprove = generateSchemaData(PendingLeaseSchema, {
      status: "PendingApproval",
      leaseDurationInHours: 100,
      userEmail: mockUser.email,
    });
    const approver = "HappyManager@managers.com";

    await InnovationSandbox.approveLease(
      {
        lease: leaseToApprove,
        approver: approver,
      },
      mockContext,
    );

    const expectedSavedLease: MonitoredLease = {
      ...leaseToApprove,
      status: "Active",
      approvedBy: approver,
      awsAccountId: mockAvailableAccount.awsAccountId,
      startDate: currentDateTime.toISO(),
      expirationDate: currentDateTime.plus({ hour: 100 }).toISO(),
      lastCheckedDate: currentDateTime.toISO(),
      totalCostAccrued: 0,
    };

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockAvailableAccount,
      "Available",
      "Active",
    );
    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expectedSavedLease,
    );
  });

  test.each([
    {
      scenario: "self-requested lease",
      createdBy: mockUser.email,
      expectedCreationMethod: "REQUESTED",
    },
    {
      scenario: "manager-assigned lease",
      createdBy: "manager@example.com",
      expectedCreationMethod: "ASSIGNED",
    },
    {
      scenario: "lease without createdBy (legacy)",
      createdBy: undefined,
      expectedCreationMethod: "REQUESTED",
    },
  ])(
    "Writes LeaseApproval metric correctly for $scenario",
    async ({ createdBy, expectedCreationMethod }) => {
      const leaseToApprove = generateSchemaData(PendingLeaseSchema, {
        status: "PendingApproval",
        leaseDurationInHours: 100,
        userEmail: mockUser.email,
        createdBy: createdBy,
      });
      const approver = "HappyManager@managers.com";

      await InnovationSandbox.approveLease(
        {
          lease: leaseToApprove,
          approver: approver,
        },
        mockContext,
      );

      expect(mockContext.logger.info).toHaveBeenCalledWith(
        `(${approver}) approved lease for (${mockUser.email})`,
        {
          ...searchableLeaseProperties(leaseToApprove),
          ...searchableAccountProperties(mockAvailableAccount),
          logDetailType: "LeaseApproved",
          maxBudget: leaseToApprove.maxSpend,
          maxDurationHours: leaseToApprove.leaseDurationInHours,
          autoApproved: false,
          creationMethod: expectedCreationMethod,
        },
      );
    },
  );

  describe("Acquire available account", () => {
    const accountWithoutTimestamp = generateSchemaData(SandboxAccountSchema, {
      status: "Available",
      cleanupExecutionContext: undefined,
    });

    const accountWithOldTimestamp = generateSchemaData(SandboxAccountSchema, {
      status: "Available",
      cleanupExecutionContext: {
        stateMachineExecutionStartTime: currentDateTime
          .minus({ hours: 48 })
          .toISO(),
        stateMachineExecutionArn:
          "arn:aws:states:us-east-1:123456789012:execution:cleanup-state-machine:execution-1",
      },
    });

    const accountWithRecentTimestamp = generateSchemaData(
      SandboxAccountSchema,
      {
        status: "Available",
        cleanupExecutionContext: {
          stateMachineExecutionStartTime: currentDateTime
            .minus({ hours: 2 })
            .toISO(),
          stateMachineExecutionArn:
            "arn:aws:states:us-east-1:123456789012:execution:cleanup-state-machine:execution-2",
        },
      },
    );

    test("Selects account with no cleanup timestamp (never used)", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithoutTimestamp, accountWithRecentTimestamp],
      } as PaginatedQueryResult<SandboxAccount>);

      const leaseToApprove = generateSchemaData(PendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: MonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithoutTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).not.toHaveBeenCalled();
    });

    test("Selects account with timestamp > 24 hours old", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithOldTimestamp, accountWithRecentTimestamp],
      } as PaginatedQueryResult<SandboxAccount>);

      const leaseToApprove = generateSchemaData(PendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: MonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithOldTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).not.toHaveBeenCalled();
    });

    test("Falls back to recent account when no preferred accounts available", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithRecentTimestamp],
      } as PaginatedQueryResult<SandboxAccount>);

      const leaseToApprove = generateSchemaData(PendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: MonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithRecentTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).toHaveBeenCalled();
    });
  });
});

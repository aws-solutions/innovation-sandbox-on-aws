// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ExpiredLeaseSchema,
  MonitoredLease,
  MonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseFrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import {
  AccountNotInActiveError,
  CouldNotFindAccountError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  IsbUser,
  IsbUserSchema,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    sandboxAccountStore: mockedAccountStore(),
    idcService: mockedIdcService(),
    orgsService: mockedOrgsService(),
    eventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.freezeLease()", async () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockLease: MonitoredLease;
  let mockUser: IsbUser;

  const mockLeaseAccount = generateSchemaData(SandboxAccountSchema, {
    status: "Active",
  });

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IsbUserSchema);
    mockLease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    mockContext.sandboxAccountStore.get.mockImplementation(
      async (accountId) => {
        return {
          result:
            accountId === mockLeaseAccount.awsAccountId
              ? mockLeaseAccount
              : undefined,
        };
      },
    );

    mockContext.idcService.getUserFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        } else {
          throw new Error("Invalid ISB User.");
        }
      },
    );

    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("Happy Path - Lease Frozen", async () => {
    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: {
          type: "ManuallyFrozen",
          comment: "test suite freeze action",
        },
      },
      mockContext,
    );

    expect(mockContext.idcService.revokeAllUserAccess).toHaveBeenCalledWith(
      mockLeaseAccount.awsAccountId,
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      "Active",
      "Frozen",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...mockLease,
      status: "Frozen",
    });

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      new LeaseFrozenEvent({
        leaseId: {
          userEmail: mockLease.userEmail,
          uuid: mockLease.uuid,
        },
        accountId: mockLeaseAccount.awsAccountId,
        reason: {
          type: "ManuallyFrozen",
          comment: "test suite freeze action",
        },
      }),
    );
  });

  test("Fails when attempting to freeze a lease that is not active", async () => {
    const alreadyExpiredLease = generateSchemaData(ExpiredLeaseSchema);

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: alreadyExpiredLease,
          reason: {
            type: "ManuallyFrozen",
            comment: "test suite freeze action",
          },
        },
        mockContext,
      ),
    ).rejects.toThrow(AccountNotInActiveError);
  });

  test("Fails when account information cannot be recovered", async () => {
    mockContext.sandboxAccountStore.get.mockResolvedValueOnce({
      result: undefined,
    });

    await expect(
      InnovationSandbox.freezeLease(
        {
          lease: mockLease,
          reason: {
            type: "ManuallyFrozen",
            comment: "test suite freeze action",
          },
        },
        mockContext,
      ),
    ).rejects.toThrow(CouldNotFindAccountError);
  });

  test("Succeeds when user is not found in IDC (deleted user)", async () => {
    mockContext.idcService.getUserFromEmail.mockResolvedValue(undefined);

    await InnovationSandbox.freezeLease(
      {
        lease: mockLease,
        reason: {
          type: "ManuallyFrozen",
          comment: "test suite freeze action",
        },
      },
      mockContext,
    );

    expect(mockContext.logger.warn).toHaveBeenCalledWith(
      `User (${mockLease.userEmail}) not found in IDC. Proceeding with freeze operation.`,
    );

    expect(mockContext.idcService.revokeAllUserAccess).toHaveBeenCalledWith(
      mockLeaseAccount.awsAccountId,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...mockLease,
      status: "Frozen",
    });
  });
});

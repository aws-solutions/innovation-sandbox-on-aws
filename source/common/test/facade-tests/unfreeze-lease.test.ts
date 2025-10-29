// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ExpiredLeaseSchema,
  MonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import {
  AccountNotInFrozenError,
  CouldNotFindAccountError,
  CouldNotRetrieveUserError,
  InnovationSandbox,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import {
  searchableAccountProperties,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { IsbUserSchema } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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

describe("InnovationSandbox.unfreezeLease()", async () => {
  const mockContext = createMockContext();
  const mockUser = generateSchemaData(IsbUserSchema);
  const mockLeaseAccount = generateSchemaData(SandboxAccountSchema, {
    status: "Frozen",
  });
  const mockLease = generateSchemaData(MonitoredLeaseSchema, {
    status: "Frozen",
    awsAccountId: mockLeaseAccount.awsAccountId,
    userEmail: mockUser.email,
  });

  beforeEach(() => {
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

  it("Unfreeze lease", async () => {
    await InnovationSandbox.unfreezeLease(
      {
        lease: mockLease,
      },
      mockContext,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...mockLease,
      status: "Active",
    });

    expect(
      mockContext.idcService.transactionalGrantUserAccess,
    ).toHaveBeenCalledWith(mockLeaseAccount.awsAccountId, mockUser);

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      "Frozen",
      "Active",
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      `Lease of type (${mockLease.originalLeaseTemplateName}) for (${mockUser.email}) unfrozen. Account (${mockLeaseAccount.awsAccountId}) Active`,
      {
        ...searchableAccountProperties(mockLeaseAccount),
        ...searchableLeaseProperties(mockLease),
        logDetailType: "LeaseUnfrozen",
      },
    );

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      new LeaseUnfrozenEvent({
        leaseId: {
          userEmail: mockLease.userEmail,
          uuid: mockLease.uuid,
        },
        accountId: mockLeaseAccount.awsAccountId,
        maxBudget: mockLease.maxSpend,
        leaseDurationInHours: mockLease.leaseDurationInHours,
        reason: "Manually unfrozen",
      }),
    );
  });

  it("Fails when attempting to unfreeze a lease that is not frozen", async () => {
    const alreadyExpiredLease = generateSchemaData(ExpiredLeaseSchema);

    await expect(
      InnovationSandbox.unfreezeLease(
        {
          lease: alreadyExpiredLease,
        },
        mockContext,
      ),
    ).rejects.toThrow(AccountNotInFrozenError);
  });

  it("Fails when account information cannot be retrieved", async () => {
    mockContext.sandboxAccountStore.get.mockResolvedValueOnce({
      result: undefined,
    });

    await expect(
      InnovationSandbox.unfreezeLease(
        {
          lease: mockLease,
        },
        mockContext,
      ),
    ).rejects.toThrow(CouldNotFindAccountError);
  });

  it("Fails when user information cannot be recovered", async () => {
    mockContext.idcService.getUserFromEmail.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.unfreezeLease(
        {
          lease: mockLease,
        },
        mockContext,
      ),
    ).rejects.toThrow(CouldNotRetrieveUserError);
  });
});

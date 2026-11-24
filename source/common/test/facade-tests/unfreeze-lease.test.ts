// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ResourceLockConflictError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import {
  AccountNotInFrozenError,
  CouldNotFindAccountError,
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
  mockedOrganizationsTaggingService,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { IdcIdentitySchema } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
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
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    eventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.unfreezeLease()", async () => {
  let mockContext: ReturnType<typeof createMockContext>;
  const mockUser = generateSchemaData(IdcIdentitySchema);
  const mockLeaseAccount = generateSchemaData(PersistedSandboxAccountSchema, {
    status: "Frozen",
  });
  const mockLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
    status: "Frozen",
    awsAccountId: mockLeaseAccount.awsAccountId,
    userEmail: mockUser.email,
    resourceLock: undefined,
  });

  beforeEach(() => {
    mockContext = createMockContext();
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

  it("leaves the lease untouched when the assignment lock cannot be acquired", async () => {
    // Regression: the lock used to be acquired AFTER the status/OU transaction,
    // so a conflict (e.g. an in-flight FREEZE still revoking access) reported
    // failure to the caller while the lease had already flipped Frozen ->
    // Active. That left desired assignments with no records behind them.
    mockContext.leaseStore.acquireLock.mockRejectedValue(
      new ResourceLockConflictError("Lock held by another operation"),
    );

    await expect(
      InnovationSandbox.unfreezeLease({ lease: mockLease }, mockContext),
    ).rejects.toThrow(ResourceLockConflictError);

    expect(mockContext.leaseStore.update).not.toHaveBeenCalled();
    expect(mockContext.leaseStore.transactionalUpdate).not.toHaveBeenCalled();
    expect(mockContext.orgsService.moveAccount).not.toHaveBeenCalled();
    expect(
      mockContext.orgsService.transactionalMoveAccount,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).not.toHaveBeenCalled();
    expect(mockContext.eventBridgeClient.sendIsbEvent).not.toHaveBeenCalled();
  });

  it("carries the acquired lock onto the status write so the put cannot erase it", async () => {
    // See freeze-lease.test.ts: the full-item put must not drop resourceLock.
    const acquiredLock = {
      ownerId: "unfreeze-abc",
      acquiredAt: "2024-12-20T08:45:00.000Z",
      expiresAt: "2024-12-20T08:50:00.000Z",
      meta: { intent: "UNFREEZE" as const },
    };
    mockContext.leaseStore.acquireLock.mockResolvedValue(acquiredLock);

    await InnovationSandbox.unfreezeLease({ lease: mockLease }, mockContext);

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Active",
        resourceLock: acquiredLock,
      }),
    );
  });

  it("releases the lock when the status transition fails", async () => {
    // Nothing was dispatched, so the lease must not be left waiting out the
    // 300s lock timeout.
    mockContext.orgsService.moveAccount.mockRejectedValue(
      new Error("OU move failed"),
    );
    mockContext.leaseStore.releaseLock.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.unfreezeLease({ lease: mockLease }, mockContext),
    ).rejects.toThrow("OU move failed");

    expect(mockContext.leaseStore.releaseLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: mockLease.uuid,
        userEmail: mockLease.userEmail,
      }),
    );
    expect(mockContext.eventBridgeClient.sendIsbEvent).not.toHaveBeenCalled();
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

    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: mockLease.uuid,
        meta: { intent: "UNFREEZE" },
      }),
    );

    // AssignmentRequested event emitted with UNFREEZE intent
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "AssignmentRequested",
        Detail: expect.objectContaining({
          intent: "UNFREEZE",
          leaseId: mockLease.uuid,
          leaseOwnerEmail: mockLease.userEmail,
        }),
      }),
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      "Frozen",
      "Active",
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      `Lease ${mockLease.uuid} owned by ${mockLease.userEmail} unfrozen`,
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
    const alreadyExpiredLease = generateSchemaData(
      PersistedExpiredLeaseSchema,
      {},
    );

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

  it("writes the Status tag as Active after the OU move", async () => {
    await InnovationSandbox.unfreezeLease({ lease: mockLease }, mockContext);

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(mockLeaseAccount.awsAccountId, "Active");
  });

  it("status-tag failure does not block the lifecycle", async () => {
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.unfreezeLease({ lease: mockLease }, mockContext);

    // Lifecycle continues — event still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalled();
  });
});

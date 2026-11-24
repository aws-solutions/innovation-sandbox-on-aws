// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PersistedMonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  PersistedSandboxAccount,
  PersistedSandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import type { LeaseUserSandboxSpacesUsage } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import {
  getLeaseTerminatedReason,
  LeaseTerminatedEvent,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import {
  searchableAccountProperties,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockGlobalConfig } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  mockedAccountStore,
  mockedBlueprintDeploymentService,
  mockedBlueprintStore,
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrganizationsTaggingService,
  mockedOrgsService,
  mockedSandboxSpacesUsageStore,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { datetimeAsString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  type IdcIdentity,
  IdcIdentitySchema,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
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
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    eventBridgeClient: mockedIsbEventBridge(),
    blueprintStore: mockedBlueprintStore(),
    blueprintDeploymentService: mockedBlueprintDeploymentService(),
    sandboxSpacesUsageStore: mockedSandboxSpacesUsageStore(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
    globalConfig: mockGlobalConfig(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.terminateLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IdcIdentity;
  let mockLeaseAccount: PersistedSandboxAccount;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema);
    mockLeaseAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      awsAccountId: "000000000000",
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

  test("HappyPath - terminate active lease acquires lock and triggers Step Function", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockLeaseAccount,
      mockLeaseAccount.status,
      "CleanUp",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...lease,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "ManuallyTerminated",
      endDate: currentDateTime.toISO(),
      lifecycleDispatch: null,
    });

    // Acquires lock with TERMINATE intent (no desiredAssignments — processor handles clearing)
    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        timeoutSeconds: 900,
        meta: { intent: "TERMINATE" },
      }),
    );

    // AssignmentRequested event emitted with TERMINATE intent
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "AssignmentRequested",
        Detail: expect.objectContaining({
          intent: "TERMINATE",
          leaseId: lease.uuid,
          requestedBy: lease.userEmail,
          leaseOwnerEmail: lease.userEmail,
        }),
      }),
    );

    // No synchronous IDC access revocation — handled async by Step Function

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: "LEASE_TERMINATION",
      }),
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: getLeaseTerminatedReason("ManuallyTerminated", lease),
      }),
    );
  });

  test("HappyPath - terminate frozen lease", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Frozen",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      leaseDurationInHours: 48,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "Expired",
      },
      mockContext,
    );

    expect(
      mockContext.orgsService.transactionalMoveAccount,
    ).toHaveBeenCalledWith(
      mockLeaseAccount,
      mockLeaseAccount.status,
      "CleanUp",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...lease,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "Expired",
      endDate: currentDateTime.toISO(),
      lifecycleDispatch: null,
    });

    // No assignment records → backward compat path

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: "LEASE_TERMINATION",
      }),
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: getLeaseTerminatedReason("Expired", lease),
      }),
    );
  });

  test("reports LeaseTermination metric correctly", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      startDate: currentDateTime.minus({ days: 2 }).toISO(),
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      `Lease ${lease.uuid} owned by ${lease.userEmail} terminated: ManuallyTerminated`,
      {
        ...searchableAccountProperties(mockLeaseAccount),
        ...searchableLeaseProperties(lease),
        logDetailType: "LeaseTerminated",
        startDate: lease.startDate,
        terminationDate: datetimeAsString(currentDateTime),
        maxBudget: lease.maxSpend,
        actualSpend: lease.totalCostAccrued,
        maxDurationHours: lease.leaseDurationInHours,
        actualDurationHours: 48,
        reasonForTermination: "ManuallyTerminated",
        // No Sandbox Spaces usage recorded on the lease.
        agentSpend: 0,
        budgetExceededBy: undefined,
      },
    );
  });

  test("reports the budget check that terminated the lease and the lease's agent spend", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });
    mockContext.sandboxSpacesUsageStore.listLeaseUserUsage.mockResolvedValueOnce(
      {
        usage: [
          { sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
          { sandboxSpacesEstimatedTokenCostAccrued: 2.5 },
        ] as LeaseUserSandboxSpacesUsage[],
      },
    );

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "BudgetExceeded",
        budgetExceededBy: "TOKEN_POLL",
        budgetTotalSpend: 160,
      },
      mockContext,
    );

    expect(
      mockContext.sandboxSpacesUsageStore.listLeaseUserUsage,
    ).toHaveBeenCalledWith(lease.uuid);
    expect(mockContext.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("terminated: BudgetExceeded"),
      expect.objectContaining({
        logDetailType: "LeaseTerminated",
        // Billed resource cost only: agent inference is already on the bill.
        actualSpend: lease.totalCostAccrued,
        // Summed across users; an attribution figure, not added to actualSpend.
        agentSpend: 3.75,
        budgetExceededBy: "TOKEN_POLL",
        budgetTotalSpend: 160,
      }),
    );
  });

  test("reports the token poll's total as totalSpend on the LeaseTerminated event when the bill is lower", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      maxSpend: 20,
      // A new lease: nothing is on the bill yet.
      totalCostAccrued: 0,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "BudgetExceeded",
        budgetExceededBy: "TOKEN_POLL",
        budgetTotalSpend: 20,
      },
      mockContext,
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: "LEASE_TERMINATION",
      }),
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: { type: "BudgetExceeded", budget: 20, totalSpend: 20 },
      }),
    );
  });

  test("reports agent spend on an ordinary termination without adding it to actualSpend", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      totalCostAccrued: 150,
      leaseDurationInHours: 24,
    });
    mockContext.sandboxSpacesUsageStore.listLeaseUserUsage.mockResolvedValueOnce(
      {
        usage: [
          { sandboxSpacesEstimatedTokenCostAccrued: 12.5 },
        ] as LeaseUserSandboxSpacesUsage[],
      },
    );

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "Expired" },
      mockContext,
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("terminated: Expired"),
      expect.objectContaining({
        logDetailType: "LeaseTerminated",
        // The agent's inference is billed to the sandbox account, so it is
        // already in totalCostAccrued; adding the estimate would double-count.
        actualSpend: 150,
        agentSpend: 12.5,
        budgetExceededBy: undefined,
        budgetTotalSpend: undefined,
      }),
    );
  });

  test("keeps the budget check's total when the Sandbox Spaces usage read fails", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
      totalCostAccrued: 90,
    });
    mockContext.sandboxSpacesUsageStore.listLeaseUserUsage.mockRejectedValueOnce(
      new Error("read failed"),
    );

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "BudgetExceeded",
        budgetExceededBy: "TOKEN_POLL",
        // Includes live Bedrock token cost not yet on the bill.
        budgetTotalSpend: 101,
      },
      mockContext,
    );

    const [, terminatedLog] = mockContext.logger.info.mock.calls.find(
      ([message]) => String(message).includes("terminated: BudgetExceeded"),
    )!;
    expect(terminatedLog).toMatchObject({
      logDetailType: "LeaseTerminated",
      actualSpend: 90,
      budgetExceededBy: "TOKEN_POLL",
      budgetTotalSpend: 101,
    });
    expect(
      (terminatedLog as Record<string, unknown>).agentSpend,
    ).toBeUndefined();
  });

  test.each([
    [
      "some usage records are unreadable",
      () =>
        mockContext.sandboxSpacesUsageStore.listLeaseUserUsage.mockResolvedValueOnce(
          {
            usage: [
              { sandboxSpacesEstimatedTokenCostAccrued: 1 },
            ] as LeaseUserSandboxSpacesUsage[],
            error: "1 malformed record",
          },
        ),
    ],
    [
      "the usage read fails",
      () =>
        mockContext.sandboxSpacesUsageStore.listLeaseUserUsage.mockRejectedValueOnce(
          new Error("read failed"),
        ),
    ],
  ])("terminates and omits agent spend when %s", async (_case, arrange) => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });
    arrange();

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "ManuallyTerminated" },
      mockContext,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: lease.uuid,
        status: "ManuallyTerminated",
      }),
    );
    const [, terminatedLog] = mockContext.logger.info.mock.calls.find(
      ([message]) => String(message).includes("terminated: ManuallyTerminated"),
    )!;
    // A partial sum is never reported as the lease's agent spend.
    expect(
      (terminatedLog as Record<string, unknown>).agentSpend,
    ).toBeUndefined();
  });

  test("stamps TTL on every lease-scoped Sandbox Spaces usage item", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "ManuallyTerminated" },
      mockContext,
    );

    expect(
      mockContext.sandboxSpacesUsageStore.stampLeaseTtl,
    ).toHaveBeenCalledWith(lease.uuid, expect.any(Number));
  });

  test("writes the Status tag as CleanUp after the OU move when autoCleanup is true", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(mockLeaseAccount.awsAccountId, "CleanUp");
  });

  test("does NOT write the Status tag when autoCleanup is false", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ManuallyTerminated",
        autoCleanup: false,
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).not.toHaveBeenCalled();
  });

  test("status-tag failure does not block the lifecycle", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "ManuallyTerminated" },
      mockContext,
    );

    // Lifecycle continues — events still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalled();
  });

  test("propagates error when acquireLock fails with ResourceLockConflictError", async () => {
    const { ResourceLockConflictError } =
      await import("@amzn/innovation-sandbox-commons/data/errors.js");
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    mockContext.leaseStore.acquireLock.mockRejectedValue(
      new ResourceLockConflictError("Lock held by another operation"),
    );

    await expect(
      InnovationSandbox.terminateLease(
        { lease, expiredStatus: "ManuallyTerminated" },
        mockContext,
      ),
    ).rejects.toThrow("Lock held by another operation");

    // Lease status was updated before lock acquisition attempt
    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "ManuallyTerminated" }),
    );

    // CleanAccountRequest and LeaseTerminatedEvent NOT sent (error thrown before sendIsbEvents)
    expect(mockContext.eventBridgeClient.sendIsbEvents).not.toHaveBeenCalled();
  });

  test("holds lock when sendIsbEvent fails for TERMINATE (critical intent)", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    mockContext.eventBridgeClient.sendIsbEvent.mockRejectedValue(
      new Error("EventBridge throttled"),
    );

    await expect(
      InnovationSandbox.terminateLease(
        { lease, expiredStatus: "ManuallyTerminated" },
        mockContext,
      ),
    ).rejects.toThrow("EventBridge throttled");

    // Lock was acquired but NOT released (critical intent holds lock)
    expect(mockContext.leaseStore.acquireLock).toHaveBeenCalled();
    expect(mockContext.leaseStore.releaseLock).not.toHaveBeenCalled();
  });

  test("records the TERMINATE dispatch last, after the final events", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      rateLimits: [],
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });

    await InnovationSandbox.terminateLease(
      { lease, expiredStatus: "ManuallyTerminated" },
      mockContext,
    );

    expect(mockContext.leaseStore.recordLifecycleDispatch).toHaveBeenCalledWith(
      {
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        intent: "TERMINATE",
      },
    );
    expect(
      vi.mocked(mockContext.leaseStore.recordLifecycleDispatch).mock
        .invocationCallOrder[0],
    ).toBeGreaterThan(
      vi
        .mocked(mockContext.eventBridgeClient.sendIsbEvent)
        .mock.invocationCallOrder.at(-1)!,
    );
  });

  test("does not record the dispatch when the final events fail", async () => {
    // The lifecycle manager then sees a terminated lease with no marker and
    // leaves the retry for the DLQ instead of treating it as done.
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      rateLimits: [],
      status: "Active",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
    });
    mockContext.eventBridgeClient.sendIsbEvent.mockRejectedValue(
      new Error("EventBridge throttled"),
    );

    await expect(
      InnovationSandbox.terminateLease(
        { lease, expiredStatus: "ManuallyTerminated" },
        mockContext,
      ),
    ).rejects.toThrow("EventBridge throttled");

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "ManuallyTerminated",
        lifecycleDispatch: null,
      }),
    );
    expect(
      mockContext.leaseStore.recordLifecycleDispatch,
    ).not.toHaveBeenCalled();
  });
});

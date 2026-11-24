// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConstraintViolationException } from "@aws-sdk/client-organizations";

import { ResourceLockConflictError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { PersistedMonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PersistedPrincipalCacheItemSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  InnovationSandbox,
  M2mAssigneeNotAllowedError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IneligibleLeaseOwnerError } from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { searchableLeaseProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrganizationsTaggingService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  type IdcIdentity,
  IdcIdentitySchema,
  buildM2mSyntheticEmail,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { randomUUID } from "crypto";
import { DateTime, Settings } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    principalStore: createMockOf(PrincipalStore),
    idcService: mockedIdcService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    isbEventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const builtInUserPermissionSetArn =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-builtIn123456789";

describe("InnovationSandbox.publishLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IdcIdentity;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema, {
      displayName: "Test Owner",
      roles: ["User"],
    });
    mockContext.idcService.getBuiltInUserPermissionSetArn.mockResolvedValue(
      builtInUserPermissionSetArn,
    );

    mockContext.idcService.getIsbMemberFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        }
        throw new Error("Invalid ISB User.");
      },
    );

    // Mock the owner resolution used by triggerAssignmentProcessing
    mockContext.idcService.getCachedPrincipalByAttr.mockImplementation(
      async (_type, email) => {
        if (email === mockUser.email) {
          return {
            principalId: mockUser.userId,
            principalType: "USER" as const,
            displayName: mockUser.displayName,
            email: mockUser.email,
          };
        }
        return undefined;
      },
    );

    // Default: return a matching cache entry for every requested principal.
    // zocker may generate random `desiredAssignments` for tests that do not
    // override the field, and enrichment hard-fails on cache miss. Tests that
    // care about specific cache behavior override this.
    mockContext.principalStore.batchGetCacheItems.mockImplementation(
      async (keys) =>
        keys.map((k) =>
          generateSchemaData(PersistedPrincipalCacheItemSchema, {
            sk: `${k.principalType.toLowerCase()}#${k.principalId}`,
            principalId: k.principalId,
            principalType: k.principalType,
            displayName:
              k.principalId === mockUser.userId
                ? mockUser.displayName
                : `${k.principalType} ${k.principalId.slice(0, 8)}`,
            ...(k.principalType === "USER"
              ? {
                  email:
                    k.principalId === mockUser.userId
                      ? mockUser.email
                      : `${k.principalId.slice(0, 8)}@example.com`,
                }
              : {}),
          }),
        ),
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("Rejects an M2M-assignee lease with a logged error (defense-in-depth)", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: buildM2mSyntheticEmail("some-client", "Admin"),
      desiredAssignments: undefined,
    });

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toThrow(M2mAssigneeNotAllowedError);

    expect(mockContext.idcService.getIsbMemberFromEmail).not.toHaveBeenCalled();
    expect(mockContext.leaseStore.update).not.toHaveBeenCalled();
    expect(
      mockContext.leaseStore.acquireLockWithDesiredAssignments,
    ).not.toHaveBeenCalled();
    expect(mockContext.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("IDC-grant code path"),
      expect.objectContaining({ leaseId: lease.uuid }),
    );
  });

  test("should request async assignment processing and send LeaseApprovedEvent for Active lease", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      approvedBy: "manager@example.com",
      desiredAssignments: undefined,
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    // No synchronous IDC mutation — access flows through the Step Function.
    expect(
      mockContext.idcService.transactionalGrantUserAccess,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.idcService.transactionalAssignGroupAccess,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.idcService.transactionalRevokeGroupAccess,
    ).not.toHaveBeenCalled();

    // Optimistic concurrency: update is called with `expected = lease` so a
    // concurrent state-modifying write between read and put fails the condition.
    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({ status: "Active", uuid: lease.uuid }),
      lease,
    );

    // Owner added to desiredAssignments + lock acquired with intent PUBLISH.
    expect(
      mockContext.leaseStore.acquireLockWithDesiredAssignments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        meta: { intent: "PUBLISH" },
        desiredAssignments: [
          {
            principalId: mockUser.userId,
            principalType: "USER",
            permissionSetArn: builtInUserPermissionSetArn,
            email: lease.userEmail,
            displayName: mockUser.displayName,
          },
        ],
      }),
    );

    // The same lockOwnerId flows through acquireLock and the AssignmentRequested event.
    const acquireCall =
      mockContext.leaseStore.acquireLockWithDesiredAssignments.mock
        .calls[0]![0];
    expect(acquireCall.ownerId).toMatch(
      /^publish-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "AssignmentRequested",
        Detail: expect.objectContaining({
          intent: "PUBLISH",
          leaseId: lease.uuid,
          requestedBy: lease.userEmail,
          leaseOwnerEmail: lease.userEmail,
          lockOwnerId: acquireCall.ownerId,
        }),
      }),
    );

    // LeaseApproved event still emitted.
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: "LeaseApproved",
        Detail: {
          leaseId: lease.uuid,
          userEmail: lease.userEmail,
          approvedBy: lease.approvedBy,
        },
      }),
    );
  });

  test("merges enriched pre-approval principals with the owner in desiredAssignments", async () => {
    const userPrincipalId = randomUUID();
    const groupPrincipalId = randomUUID();
    const preApproval = [
      { principalId: groupPrincipalId, principalType: "GROUP" as const },
      { principalId: userPrincipalId, principalType: "USER" as const },
    ];
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: preApproval,
    });

    mockContext.principalStore.batchGetCacheItems.mockResolvedValue([
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        sk: `group#${groupPrincipalId}`,
        principalId: groupPrincipalId,
        principalType: "GROUP",
        displayName: "Engineering Group",
        email: undefined,
      }),
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        sk: `user#${userPrincipalId}`,
        principalId: userPrincipalId,
        principalType: "USER",
        displayName: "Pre-Approved User",
        email: "preapproved@example.com",
      }),
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        sk: `user#${mockUser.userId}`,
        principalId: mockUser.userId,
        principalType: "USER",
        displayName: mockUser.displayName,
        email: mockUser.email,
      }),
    ]);

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(
      mockContext.leaseStore.acquireLockWithDesiredAssignments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        meta: { intent: "PUBLISH" },
        desiredAssignments: expect.arrayContaining([
          expect.objectContaining({
            principalId: groupPrincipalId,
            principalType: "GROUP",
            displayName: "Engineering Group",
          }),
          expect.objectContaining({
            principalId: userPrincipalId,
            principalType: "USER",
            email: "preapproved@example.com",
            displayName: "Pre-Approved User",
          }),
          expect.objectContaining({
            principalId: mockUser.userId,
            principalType: "USER",
            permissionSetArn: builtInUserPermissionSetArn,
            email: lease.userEmail,
            ...(mockUser.displayName
              ? { displayName: mockUser.displayName }
              : {}),
          }),
        ]),
      }),
    );
    const call =
      mockContext.leaseStore.acquireLockWithDesiredAssignments.mock
        .calls[0]![0];
    expect(call.desiredAssignments).toHaveLength(preApproval.length + 1);
  });

  test("does not duplicate the owner when already present in pre-approval assignments", async () => {
    const otherUserId = randomUUID();
    const preApproval = [
      {
        principalId: mockUser.userId,
        principalType: "USER" as const,
      },
      { principalId: otherUserId, principalType: "USER" as const },
    ];
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: preApproval,
    });

    mockContext.principalStore.batchGetCacheItems.mockResolvedValue([
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        sk: `user#${mockUser.userId}`,
        principalId: mockUser.userId,
        principalType: "USER",
        email: mockUser.email,
        displayName: mockUser.displayName,
      }),
      generateSchemaData(PersistedPrincipalCacheItemSchema, {
        sk: `user#${otherUserId}`,
        principalId: otherUserId,
        principalType: "USER",
        email: "other@example.com",
        displayName: "Other User",
      }),
    ]);

    await InnovationSandbox.publishLease({ lease }, mockContext);

    const call =
      mockContext.leaseStore.acquireLockWithDesiredAssignments.mock
        .calls[0]![0];
    const ownerOccurrences = call.desiredAssignments.filter(
      (a) => a.principalId === mockUser.userId,
    );
    expect(ownerOccurrences).toHaveLength(1);
    expect(call.desiredAssignments).toHaveLength(preApproval.length);
  });

  test("treats an empty desiredAssignments array the same as undefined (owner-only)", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: [],
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(
      mockContext.principalStore.batchGetCacheItems,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.idcService.getCachedPrincipalById,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.leaseStore.acquireLockWithDesiredAssignments,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        desiredAssignments: [
          {
            principalId: mockUser.userId,
            principalType: "USER",
            permissionSetArn: builtInUserPermissionSetArn,
            email: lease.userEmail,
            displayName: mockUser.displayName,
          },
        ],
      }),
    );
  });

  test("falls back to the IDC user name when the display name is missing", async () => {
    mockUser = {
      ...mockUser,
      displayName: undefined,
      userName: "test-owner",
    };
    mockContext.idcService.getIsbMemberFromEmail.mockResolvedValue(mockUser);
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: undefined,
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    const call =
      mockContext.leaseStore.acquireLockWithDesiredAssignments.mock
        .calls[0]![0];
    expect(call.desiredAssignments).toEqual([
      {
        principalId: mockUser.userId,
        principalType: "USER",
        permissionSetArn: builtInUserPermissionSetArn,
        email: lease.userEmail,
        displayName: "test-owner",
      },
    ]);
  });

  test("propagates ResourceLockConflictError without releasing the lock or emitting events", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: undefined,
    });
    const conflict = new ResourceLockConflictError("locked");
    mockContext.leaseStore.acquireLockWithDesiredAssignments.mockRejectedValueOnce(
      conflict,
    );

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toBe(conflict);

    expect(mockContext.leaseStore.releaseLock).not.toHaveBeenCalled();
    expect(
      mockContext.isbEventBridgeClient.sendIsbEvent,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.organizationsTaggingService.applyLeaseTags,
    ).not.toHaveBeenCalled();
  });

  test("releases the lock with the same ownerId if publishing the AssignmentRequested event fails", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: undefined,
    });

    const eventError = new Error("EventBridge unavailable");
    mockContext.isbEventBridgeClient.sendIsbEvent.mockRejectedValueOnce(
      eventError,
    );
    mockContext.leaseStore.releaseLock.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toBe(eventError);

    const acquireCall =
      mockContext.leaseStore.acquireLockWithDesiredAssignments.mock
        .calls[0]![0];
    const releaseCall = mockContext.leaseStore.releaseLock.mock.calls[0]![0];
    expect(releaseCall.ownerId).toBe(acquireCall.ownerId);
    expect(releaseCall).toEqual(
      expect.objectContaining({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
      }),
    );

    // Short-circuit: tagging and LeaseApproved must not run.
    expect(
      mockContext.organizationsTaggingService.applyLeaseTags,
    ).not.toHaveBeenCalled();
    expect(
      mockContext.isbEventBridgeClient.sendIsbEvent,
    ).toHaveBeenCalledExactlyOnceWith(
      mockContext.tracer,
      expect.objectContaining({ DetailType: "AssignmentRequested" }),
    );
  });

  test("still propagates the original publish error when releaseLock cleanup also fails", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      desiredAssignments: undefined,
    });

    const eventError = new Error("EventBridge unavailable");
    const releaseError = new Error("DDB throttled");
    mockContext.isbEventBridgeClient.sendIsbEvent.mockRejectedValueOnce(
      eventError,
    );
    mockContext.leaseStore.releaseLock.mockRejectedValueOnce(releaseError);

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toBe(eventError);

    expect(mockContext.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("Failed to release lock during error cleanup"),
      expect.objectContaining({ errorMessage: "DDB throttled" }),
    );
  });

  test("should update lease status from Provisioning to Active and set startDate/expirationDate", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Provisioning",
      userEmail: mockUser.email,
      leaseDurationInHours: 24,
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Active",
        startDate: expect.any(String),
        expirationDate: expect.any(String),
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      }),
      lease,
    );
  });

  test("should set expirationDate exactly leaseDurationInHours after startDate", async () => {
    // Every clock read advances 1 ms, so two separate reads would store a
    // duration 1 ms longer than the lease's.
    let clockMillis = DateTime.fromISO("2024-12-20T08:45:00.000Z").toMillis();
    Settings.now = () => clockMillis++;
    try {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Provisioning",
        userEmail: mockUser.email,
        leaseDurationInHours: 168,
      });

      await InnovationSandbox.publishLease({ lease }, mockContext);

      const updated = PersistedMonitoredLeaseSchema.parse(
        mockContext.leaseStore.update.mock.calls[0]![0],
      );
      expect(
        DateTime.fromISO(updated.expirationDate!)
          .diff(DateTime.fromISO(updated.startDate), "hours")
          .as("hours"),
      ).toBe(168);
    } finally {
      Settings.now = () => Date.now();
    }
  });

  test("should update lease to set startDate and expirationDate even if already Active", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      leaseDurationInHours: 24,
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        status: "Active",
        startDate: expect.any(String),
        expirationDate: expect.any(String),
      }),
      lease,
    );
    expect(
      mockContext.leaseStore.acquireLockWithDesiredAssignments,
    ).toHaveBeenCalled();
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({ DetailType: "AssignmentRequested" }),
    );
  });

  test("should log lease publication with searchable properties", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      approvedBy: "AUTO_APPROVED",
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Published lease"),
      expect.objectContaining({
        ...searchableLeaseProperties(lease),
        logDetailType: "LeasePublished",
        autoApproved: true,
      }),
    );
  });

  test("rejects when the lease owner is not an ISB member", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      userEmail: "nonexistent@example.com",
    });

    mockContext.idcService.getIsbMemberFromEmail.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toThrow(new IneligibleLeaseOwnerError(lease.userEmail));
  });

  test("calls applyLeaseTags with the published lease and the IDC userId", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      costReportGroup: "team-alpha",
      originalLeaseTemplateUuid: "template-uuid-xyz",
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(
      mockContext.organizationsTaggingService.applyLeaseTags,
    ).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: lease.uuid,
        awsAccountId: lease.awsAccountId,
        costReportGroup: "team-alpha",
        originalLeaseTemplateUuid: "template-uuid-xyz",
        status: "Active",
      }),
      mockUser.userId,
    );
  });

  test("classifies MAX_TAG_LIMIT_EXCEEDED as TagSpaceExhausted and still emits LeaseApprovedEvent", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
    });
    mockContext.organizationsTaggingService.applyLeaseTags.mockRejectedValue(
      new ConstraintViolationException({
        $metadata: {},
        Reason: "MAX_TAG_LIMIT_EXCEEDED",
        message: "tag limit exceeded",
      }),
    );

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(mockContext.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to tag account"),
      expect.objectContaining({
        logDetailType: "TagResourceFailed",
        reason: "TagSpaceExhausted",
        accountId: lease.awsAccountId,
      }),
    );
    // Lifecycle continues — LeaseApproved is still emitted even when tagging fails.
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({ DetailType: "LeaseApproved" }),
    );
  });

  test("classifies a generic SDK error as ApiError and still emits LeaseApprovedEvent", async () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
    });
    mockContext.organizationsTaggingService.applyLeaseTags.mockRejectedValue(
      new Error("network timeout"),
    );

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(mockContext.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("Failed to tag account"),
      expect.objectContaining({
        logDetailType: "TagResourceFailed",
        reason: "ApiError",
        accountId: lease.awsAccountId,
      }),
    );
    // Lifecycle continues — LeaseApproved is still emitted even when tagging fails.
    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({ DetailType: "LeaseApproved" }),
    );
  });
});

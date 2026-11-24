// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PersistedBlueprintWithStackSets } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  PersistedMonitoredLease,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PersistedPrincipalCacheItemSchema } from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  PersistedSandboxAccount,
  PersistedSandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  InnovationSandbox,
  M2mAssigneeNotAllowedError,
} from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IneligibleLeaseOwnerError } from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedBlueprintDeploymentService,
  mockedBlueprintStore,
  mockedIdcService,
  mockedLeaseStore,
  mockedLeaseTemplateStore,
  mockedOrganizationsTaggingService,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  IdcIdentitySchema,
  buildM2mSyntheticEmail,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    isbEventBridgeClient: createMockOf(IsbEventBridgeClient),
    orgsService: mockedOrgsService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
    idcService: mockedIdcService(),
    leaseStore: mockedLeaseStore(),
    principalStore: createMockOf(PrincipalStore),
    sandboxAccountStore: mockedAccountStore(),
    blueprintStore: mockedBlueprintStore(),
    blueprintDeploymentService: mockedBlueprintDeploymentService(),
    leaseTemplateStore: mockedLeaseTemplateStore(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

const mockUser = generateSchemaData(IdcIdentitySchema, {
  roles: ["User"],
});

describe("InnovationSandbox.approveLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;

  const mockAvailableAccount = generateSchemaData(
    PersistedSandboxAccountSchema,
    {
      status: "Available",
    },
  );

  beforeEach(() => {
    mockContext = createMockContext();

    mockContext.idcService.getIsbMemberFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        } else {
          throw new Error("Invalid ISB User.");
        }
      },
    );

    // Mock owner resolution used by triggerAssignmentProcessing
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

    // Default: return a matching cache entry for every requested principal so
    // publishLease's enrichment doesn't hard-fail on zocker-generated random
    // desiredAssignments. Tests that care about specific cache behavior override.
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

    mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
      result: [mockAvailableAccount],
    } as PaginatedQueryResult<PersistedSandboxAccount>);

    mockContext.blueprintDeploymentService.validateBlueprintForDeployment.mockResolvedValue(
      {
        blueprint: {
          PK: "bp#b1c2d3e4-5678-90ab-cdef-blueprintabc",
          SK: "blueprint",
          itemType: "BLUEPRINT",
          blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
          name: "TestBlueprint",
          regionConcurrencyType: "SEQUENTIAL",
          deploymentTimeoutMinutes: 60,
          tags: {},
          createdBy: "test@example.com",
          totalHealthMetrics: {
            totalDeploymentCount: 0,
            totalSuccessfulCount: 0,
          },
          meta: {
            schemaVersion: 1,
            createdTime: currentDateTime.toISO(),
            lastEditTime: currentDateTime.toISO(),
          },
        },
        stackSets: [
          {
            PK: "bp#b1c2d3e4-5678-90ab-cdef-blueprintabc",
            SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
            itemType: "STACKSET",
            blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
            stackSetId: "a1b2c3d4-5678-90ab-cdef-123456789abc",
            administrationRoleArn: "arn:aws:iam::123456789012:role/admin",
            executionRoleName: "execution-role",
            regions: ["us-east-1"],
            deploymentOrder: 1,
            healthMetrics: {
              deploymentCount: 0,
              successfulDeploymentCount: 0,
              consecutiveFailures: 0,
            },
            meta: {
              schemaVersion: 1,
              createdTime: currentDateTime.toISO(),
              lastEditTime: currentDateTime.toISO(),
            },
          },
        ],
      } as PersistedBlueprintWithStackSets,
    );

    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("Writes approved lease to DB", async () => {
    const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
      status: "PendingApproval",
      leaseDurationInHours: 100,
      userEmail: mockUser.email,
      blueprintId: null,
      blueprintName: null,
    });
    const approver = "HappyManager@managers.com";

    await InnovationSandbox.approveLease(
      {
        lease: leaseToApprove,
        approver: approver,
      },
      mockContext,
    );

    const expectedSavedLease: PersistedMonitoredLease = {
      ...leaseToApprove,
      status: "Active",
      approvedBy: approver,
      awsAccountId: mockAvailableAccount.awsAccountId,
      startDate: currentDateTime.toISO(),
      lastCheckedDate: currentDateTime.toISO(),
      totalCostAccrued: 0,
    };

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      {
        ...mockAvailableAccount,
        currentLease: {
          leaseId: leaseToApprove.uuid,
          ownerEmail: leaseToApprove.userEmail,
        },
      },
      "Available",
      "Active",
    );
    expect(mockContext.leaseStore.update).toHaveBeenNthCalledWith(
      1,
      expectedSavedLease,
    );
  });

  test("rejects when the lease owner is not an ISB member", async () => {
    const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
      status: "PendingApproval",
      userEmail: mockUser.email,
      blueprintId: null,
      blueprintName: null,
    });
    mockContext.idcService.getIsbMemberFromEmail.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.approveLease(
        {
          lease: leaseToApprove,
          approver: "HappyManager@managers.com",
        },
        mockContext,
      ),
    ).rejects.toThrow(new IneligibleLeaseOwnerError(leaseToApprove.userEmail));
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
      const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
        status: "PendingApproval",
        leaseDurationInHours: 100,
        blueprintId: null,
        blueprintName: null,
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

      // After refactoring, publishLease() is called which logs the detailed approval
      expect(mockContext.logger.info).toHaveBeenCalledWith(
        expect.stringContaining("Published lease"),
        expect.objectContaining({
          logDetailType: "LeasePublished",
          autoApproved: false,
          creationMethod: expectedCreationMethod,
          hasBlueprint: false,
        }),
      );
    },
  );

  test("Rejects an M2M-assignee lease with a logged error (defense-in-depth)", async () => {
    const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
      status: "PendingApproval",
      userEmail: buildM2mSyntheticEmail("some-client", "Admin"),
      blueprintId: null,
      blueprintName: null,
    });

    await expect(
      InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      ),
    ).rejects.toThrow(M2mAssigneeNotAllowedError);

    expect(mockContext.idcService.getIsbMemberFromEmail).not.toHaveBeenCalled();
    expect(mockContext.leaseStore.update).not.toHaveBeenCalled();
    expect(mockContext.logger.error).toHaveBeenCalledWith(
      expect.stringContaining("IDC-grant code path"),
      expect.objectContaining({ leaseId: leaseToApprove.uuid }),
    );
  });

  describe("Acquire available account", () => {
    const accountWithoutTimestamp = generateSchemaData(
      PersistedSandboxAccountSchema,
      {
        status: "Available",
        lastCleanupCompletedAt: undefined,
      },
    );

    const accountWithOldTimestamp = generateSchemaData(
      PersistedSandboxAccountSchema,
      {
        status: "Available",
        lastCleanupCompletedAt: currentDateTime.minus({ hours: 48 }).toISO(),
      },
    );

    const accountWithRecentTimestamp = generateSchemaData(
      PersistedSandboxAccountSchema,
      {
        status: "Available",
        lastCleanupCompletedAt: currentDateTime.minus({ hours: 2 }).toISO(),
      },
    );

    test("Selects account with no cleanup timestamp (never used)", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithoutTimestamp, accountWithRecentTimestamp],
      } as PaginatedQueryResult<PersistedSandboxAccount>);

      const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
        blueprintId: null,
        blueprintName: null,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: PersistedMonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithoutTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).not.toHaveBeenCalled();
    });

    test("Selects account with timestamp > 24 hours old", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithOldTimestamp, accountWithRecentTimestamp],
      } as PaginatedQueryResult<PersistedSandboxAccount>);

      const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
        blueprintId: null,
        blueprintName: null,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: PersistedMonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithOldTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).not.toHaveBeenCalled();
    });

    test("Falls back to recent account when no preferred accounts available", async () => {
      mockContext.sandboxAccountStore.findByStatus.mockResolvedValue({
        result: [accountWithRecentTimestamp],
      } as PaginatedQueryResult<PersistedSandboxAccount>);

      const leaseToApprove = generateSchemaData(PersistedPendingLeaseSchema, {
        status: "PendingApproval",
        userEmail: mockUser.email,
        blueprintId: null,
        blueprintName: null,
      });

      const { newItem: approvedLease } = (await InnovationSandbox.approveLease(
        { lease: leaseToApprove, approver: "test@example.com" },
        mockContext,
      )) as { newItem: PersistedMonitoredLease };

      expect(approvedLease.awsAccountId).toBe(
        accountWithRecentTimestamp.awsAccountId,
      );
      expect(mockContext.logger.warn).toHaveBeenCalled();
    });
  });
});

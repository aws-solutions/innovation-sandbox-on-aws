// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  MonitoredLease,
  MonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedBlueprintDeploymentService,
  mockedBlueprintStore,
  mockedIsbEventBridge,
  mockedLeaseStore,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    sandboxAccountStore: mockedAccountStore(),
    orgsService: mockedOrgsService(),
    isbEventBridgeClient: mockedIsbEventBridge(),
    blueprintStore: mockedBlueprintStore(),
    blueprintDeploymentService: mockedBlueprintDeploymentService(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

describe("InnovationSandbox.resetLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockAccount: SandboxAccount;

  beforeEach(() => {
    mockContext = createMockContext();
    mockAccount = generateSchemaData(SandboxAccountSchema, {
      awsAccountId: "123456789012",
      status: "Active",
    });

    mockContext.sandboxAccountStore.get.mockImplementation(
      async (accountId) => {
        return {
          result:
            accountId === mockAccount.awsAccountId ? mockAccount : undefined,
        };
      },
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("should move account to CleanUp OU", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
      blueprintId: "650e8400-e29b-41d4-a716-446655440001",
      blueprintName: "TestBlueprint",
    });

    await InnovationSandbox.resetLease(
      { lease, blueprintName: "TestBlueprint" },
      mockContext,
    );

    expect(
      mockContext.orgsService.transactionalMoveAccount,
    ).toHaveBeenCalledWith(mockAccount, mockAccount.status, "CleanUp");
  });

  test("should update lease status to PendingApproval", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
    });

    await InnovationSandbox.resetLease(
      { lease, blueprintName: "TestBlueprint" },
      mockContext,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        uuid: lease.uuid,
        status: "PendingApproval",
      }),
    );
  });

  test("should send LeaseProvisioningFailedEvent and CleanAccountRequest", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
    });
    const blueprintName = "TestBlueprint";

    await InnovationSandbox.resetLease({ lease, blueprintName }, mockContext);

    expect(mockContext.isbEventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: mockAccount.awsAccountId,
        reason: "LEASE_RESET",
      }),
      expect.objectContaining({
        DetailType: "LeaseProvisioningFailed",
        Detail: {
          leaseId: {
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          },
          accountId: mockAccount.awsAccountId,
          blueprintName,
        },
      }),
    );
  });

  test("should log reset with searchable properties", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
    });

    await InnovationSandbox.resetLease(
      { lease, blueprintName: "TestBlueprint" },
      mockContext,
    );

    expect(mockContext.logger.info).toHaveBeenCalledWith(
      expect.stringContaining("Reset lease"),
      expect.objectContaining({
        blueprintName: "TestBlueprint",
        logDetailType: "LeaseReset",
        accountId: mockAccount.awsAccountId,
        reasonForReset: "ProvisioningFailed",
      }),
    );
  });

  test("should delete stack instance metadata when lease has blueprintId", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
      blueprintId: "650e8400-e29b-41d4-a716-446655440001",
      blueprintName: "TestBlueprint",
    });

    await InnovationSandbox.resetLease(
      { lease, blueprintName: "TestBlueprint" },
      mockContext,
    );

    expect(
      mockContext.blueprintDeploymentService.deleteStackInstancesMetadata,
    ).toHaveBeenCalledWith(
      "650e8400-e29b-41d4-a716-446655440001",
      mockAccount.awsAccountId,
      mockContext.blueprintStore,
    );
  });

  test("should throw error if account not found", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      awsAccountId: "nonexistent",
    });

    await expect(
      InnovationSandbox.resetLease(
        { lease, blueprintName: "TestBlueprint" },
        mockContext,
      ),
    ).rejects.toThrow("Unable to retrieve SandboxAccount information");
  });

  test("should convert MonitoredLease to PendingLease correctly", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Provisioning",
      awsAccountId: mockAccount.awsAccountId,
      approvedBy: "manager@example.com",
      startDate: "2024-01-01T00:00:00.000Z",
      totalCostAccrued: 100,
    });

    await InnovationSandbox.resetLease(
      { lease, blueprintName: "TestBlueprint" },
      mockContext,
    );

    const updateCall = mockContext.leaseStore.update.mock
      .calls[0]?.[0] as MonitoredLease;

    // Verify updateCall exists
    expect(updateCall).toBeDefined();

    // Should have MonitoredLease-specific fields cleared (null/undefined)
    expect(updateCall.approvedBy).toBeNull();
    expect(updateCall.startDate).toBeUndefined();
    expect(updateCall.awsAccountId).toBeNull();

    // Should have PendingLease fields
    expect(updateCall).toHaveProperty("status", "PendingApproval");
    expect(updateCall).toHaveProperty("uuid", lease.uuid);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { searchableLeaseProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedIdcService,
  mockedIsbEventBridge,
  mockedLeaseStore,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import {
  IsbUser,
  IsbUserSchema,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    idcService: mockedIdcService(),
    isbEventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

describe("InnovationSandbox.publishLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IsbUser;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IsbUserSchema);

    mockContext.idcService.getUserFromEmail.mockImplementation(
      async (email) => {
        if (email === mockUser.email) {
          return mockUser;
        }
        throw new Error("Invalid ISB User.");
      },
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  test("should grant user access and send LeaseApprovedEvent for Active lease", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Active",
      userEmail: mockUser.email,
      approvedBy: "manager@example.com",
    });

    await InnovationSandbox.publishLease({ lease }, mockContext);

    expect(
      mockContext.idcService.transactionalGrantUserAccess,
    ).toHaveBeenCalledWith(lease.awsAccountId, mockUser);

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

  test("should update lease status from Provisioning to Active and set startDate/expirationDate", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
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
    );
  });

  test("should update lease to set startDate and expirationDate even if already Active", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
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
    );
  });

  test("should log lease publication with searchable properties", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
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

  test("should throw error if user not found", async () => {
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      userEmail: "nonexistent@example.com",
    });

    mockContext.idcService.getUserFromEmail.mockResolvedValue(undefined);

    await expect(
      InnovationSandbox.publishLease({ lease }, mockContext),
    ).rejects.toThrow("Unable to retrieve user information");
  });
});

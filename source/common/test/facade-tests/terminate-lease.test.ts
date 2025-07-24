// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfigSchema } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
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
import { datetimeAsString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
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
    globalConfig: generateSchemaData(GlobalConfigSchema, {
      leases: generateSchemaData(GlobalConfigSchema.shape.leases, {
        ttl: 30,
      }),
    }),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.terminateLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IsbUser;
  let mockLeaseAccount: SandboxAccount;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IsbUserSchema);
    mockLeaseAccount = generateSchemaData(SandboxAccountSchema, {
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

  test("HappyPath - terminate active lease", async () => {
    console.log(mockContext);
    const lease = generateSchemaData(MonitoredLeaseSchema, {
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
    });

    expect(mockContext.idcService.revokeAllUserAccess).toHaveBeenCalledWith(
      lease.awsAccountId,
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: `Lease ${lease.uuid} ManuallyTerminated`,
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
    const lease = generateSchemaData(MonitoredLeaseSchema, {
      status: "Frozen",
      awsAccountId: mockLeaseAccount.awsAccountId,
      userEmail: mockUser.email,
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
    });

    expect(mockContext.idcService.revokeAllUserAccess).toHaveBeenCalledWith(
      lease.awsAccountId,
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: lease.awsAccountId,
        reason: `Lease ${lease.uuid} Expired`,
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
    const lease = generateSchemaData(MonitoredLeaseSchema, {
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
      `Lease of type (${lease.originalLeaseTemplateName}) for (${mockUser.email}) terminated. Reason: ManuallyTerminated. SandboxAccount (${mockLeaseAccount.awsAccountId}) sent for cleanup.`,
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
      },
    );
  });
});

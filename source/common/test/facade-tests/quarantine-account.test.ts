// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  PersistedLease,
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { AccountQuarantinedEvent } from "@amzn/innovation-sandbox-commons/events/account-quarantined-event.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseTerminatedEvent } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
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

describe("InnovationSandbox.quarantineAccount()", () => {
  let mockContext: ReturnType<typeof createMockContext>;
  let mockUser: IdcIdentity;

  beforeEach(() => {
    mockContext = createMockContext();
    mockUser = generateSchemaData(IdcIdentitySchema);

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

  test("quarantine an account without an attached lease", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Frozen", //expected to be frozen, but was found in available OU
    });

    mockContext.sandboxAccountStore.get.mockImplementation(
      async (_accountId) => {
        return {
          result: mockAccount,
        };
      },
    );
    await InnovationSandbox.quarantineAccount(
      {
        accountId: mockAccount.awsAccountId,
        currentOu: "Available",
        reason: "Test Quarantine",
        reasonForQuarantine: "DRIFT",
      },
      mockContext,
    );

    //moved to quarantine
    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockAccount,
      "Available",
      "Quarantine",
    );

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: EventDetailTypes.AccountQuarantined,
        Detail: {
          awsAccountId: mockAccount.awsAccountId,
          reason: "Test Quarantine",
        },
      } satisfies Partial<AccountQuarantinedEvent>),
    );

    //structured log emitted for log subscriber with reasonForQuarantine enum
    expect(mockContext.logger.warn).toHaveBeenCalledWith(
      expect.stringContaining("quarantined"),
      expect.objectContaining({
        logDetailType: "AccountQuarantined",
        accountId: mockAccount.awsAccountId,
        reasonForQuarantine: "DRIFT",
      }),
    );
  });

  test("quarantine an account with an attached active lease", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Active",
    });
    const activeLease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      awsAccountId: mockAccount.awsAccountId,
      status: "Active",
      userEmail: mockUser.email,
    });

    mockContext.sandboxAccountStore.get.mockImplementation(
      async (accountId) => {
        return {
          result:
            accountId === mockAccount.awsAccountId ? mockAccount : undefined,
        };
      },
    );

    mockContext.leaseStore.findByStatusAndAccountID.mockResolvedValue({
      nextPageIdentifier: null,
      result: [activeLease],
    } as PaginatedQueryResult<PersistedMonitoredLease>);

    await InnovationSandbox.quarantineAccount(
      {
        accountId: mockAccount.awsAccountId,
        currentOu: "Active",
        reason: "Test Quarantine",
        reasonForQuarantine: "MANUAL",
      },
      mockContext,
    );

    //moved to quarantine
    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      mockAccount,
      "Active",
      "Quarantine",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...activeLease,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "AccountQuarantined",
      endDate: currentDateTime.toISO(),
      lifecycleDispatch: null,
    } satisfies Partial<PersistedLease>);

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: EventDetailTypes.AccountQuarantined,
        Detail: {
          awsAccountId: mockAccount.awsAccountId,
          reason: "Test Quarantine",
        },
      } satisfies Partial<AccountQuarantinedEvent>),
    );

    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      mockContext.tracer,
      expect.objectContaining({
        DetailType: EventDetailTypes.LeaseTerminated,
        Detail: expect.objectContaining({
          accountId: mockAccount.awsAccountId,
        }),
      } satisfies Partial<LeaseTerminatedEvent>),
    );

    //no cleanup action issued
    expect(mockContext.eventBridgeClient.sendIsbEvent).not.toHaveBeenCalledWith(
      mockContext.tracer,
      expect.any(CleanAccountRequest),
    );
  });

  test("writes the Status tag as Quarantine after the OU move", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Frozen",
    });
    mockContext.sandboxAccountStore.get.mockResolvedValue({
      result: mockAccount,
    });

    await InnovationSandbox.quarantineAccount(
      {
        accountId: mockAccount.awsAccountId,
        currentOu: "Available",
        reason: "Test Quarantine",
        reasonForQuarantine: "DRIFT",
      },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.updateStatusTag,
    ).toHaveBeenCalledWith(mockAccount.awsAccountId, "Quarantine");
  });

  test("status-tag failure does not block the lifecycle", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Frozen",
    });
    mockContext.sandboxAccountStore.get.mockResolvedValue({
      result: mockAccount,
    });
    mockContext.organizationsTaggingService.updateStatusTag.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.quarantineAccount(
      {
        accountId: mockAccount.awsAccountId,
        currentOu: "Available",
        reason: "Test Quarantine",
        reasonForQuarantine: "DRIFT",
      },
      mockContext,
    );

    // Lifecycle continues — quarantine event still emitted.
    expect(mockContext.eventBridgeClient.sendIsbEvent).toHaveBeenCalled();
  });
});

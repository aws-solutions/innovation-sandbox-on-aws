// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PersistedSandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
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
import { ISB_ACCOUNT_TAG_SUFFIXES } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
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
    eventBridgeClient: mockedIsbEventBridge(),
    idcService: mockedIdcService(),
    orgsService: mockedOrgsService(),
    organizationsTaggingService: mockedOrganizationsTaggingService(),
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

describe("InnovationSandbox.ejectAccount()", () => {
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

  test("ejecting account from available", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Available",
    });

    await InnovationSandbox.ejectAccount(
      {
        sandboxAccount: mockAccount,
      },
      mockContext,
    );

    expect(
      mockContext.orgsService.performAccountMoveAction,
    ).toHaveBeenCalledWith(
      mockAccount.awsAccountId,
      mockAccount.status,
      "Exit",
    );
  });

  test("ejecting account that is part of an active lease", async () => {
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
      result: [activeLease],
      nextPageIdentifier: null,
    } as PaginatedQueryResult<PersistedMonitoredLease>);

    await InnovationSandbox.ejectAccount(
      {
        sandboxAccount: mockAccount,
      },
      mockContext,
    );

    expect(mockContext.idcService.revokeGroupAccess).toHaveBeenCalledWith(
      mockAccount.awsAccountId,
      "Manager",
    );

    expect(mockContext.idcService.revokeGroupAccess).toHaveBeenCalledWith(
      mockAccount.awsAccountId,
      "Admin",
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith(
      expect.objectContaining({
        ...activeLease,
        status: "Ejected",
        lifecycleDispatch: null,
      }),
    );

    expect(
      mockContext.orgsService.performAccountMoveAction,
    ).toHaveBeenCalledWith(
      mockAccount.awsAccountId,
      mockAccount.status,
      "Exit",
    );
  });

  test("untags all 5 ISB keys before moving the account to Exit", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Available",
    });

    await InnovationSandbox.ejectAccount(
      { sandboxAccount: mockAccount },
      mockContext,
    );

    expect(
      mockContext.organizationsTaggingService.untagAccount,
    ).toHaveBeenCalledWith(mockAccount.awsAccountId, [
      ...ISB_ACCOUNT_TAG_SUFFIXES,
    ]);

    const untagOrder =
      mockContext.organizationsTaggingService.untagAccount.mock
        .invocationCallOrder[0]!;
    const moveOrder =
      mockContext.orgsService.performAccountMoveAction.mock
        .invocationCallOrder[0]!;
    expect(untagOrder).toBeLessThan(moveOrder);
  });

  test("untag failure does not block the ejection", async () => {
    const mockAccount = generateSchemaData(PersistedSandboxAccountSchema, {
      status: "Available",
    });
    mockContext.organizationsTaggingService.untagAccount.mockRejectedValue(
      new Error("AccessDenied"),
    );

    await InnovationSandbox.ejectAccount(
      { sandboxAccount: mockAccount },
      mockContext,
    );

    expect(
      mockContext.orgsService.performAccountMoveAction,
    ).toHaveBeenCalledWith(
      mockAccount.awsAccountId,
      mockAccount.status,
      "Exit",
    );
  });
});

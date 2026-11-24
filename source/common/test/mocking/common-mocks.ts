// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import {
  PaginatedQueryResult,
  PutResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { PersistedSandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { SandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { BlueprintDeploymentService } from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { mock, MockProxy } from "vitest-mock-extended";

export function mockedLeaseStore() {
  const mockLeaseStore: MockProxy<LeaseStore> = createMockOf(LeaseStore, {
    usingRealFunctions: ["transactionalUpdate"],
  });

  mockLeaseStore.create.mockImplementation(async (lease: PersistedLease) => {
    return lease;
  });

  mockLeaseStore.update.mockImplementation(async (lease: PersistedLease) => {
    return {
      newItem: lease,
    } as PutResult<PersistedLease>;
  });

  mockLeaseStore.findByUserEmail.mockImplementation(
    async () =>
      ({
        result: [] as PersistedLease[],
        nextPageIdentifier: null,
      }) as PaginatedQueryResult<PersistedLease>,
  );

  mockLeaseStore.findByStatusAndAccountID.mockImplementation(
    async () =>
      ({
        result: [] as PersistedLease[],
        nextPageIdentifier: null,
      }) as PaginatedQueryResult<PersistedLease>,
  );

  return mockLeaseStore;
}

export function mockedAccountStore() {
  const mockAccountStore = createMockOf(SandboxAccountStore, {
    usingRealFunctions: ["transactionalPut"],
  });

  mockAccountStore.put.mockImplementation(
    async (account: PersistedSandboxAccount) => {
      return {
        newItem: account,
      } as PutResult<PersistedSandboxAccount>;
    },
  );

  return mockAccountStore;
}

export function mockedLeaseTemplateStore() {
  return createMockOf(LeaseTemplateStore, {
    usingRealFunctions: ["transactionalUpdate"],
  });
}

export function mockedOrgsService() {
  const mockOrgService = createMockOf(SandboxOuService, {
    usingRealFunctions: ["transactionalMoveAccount", "moveAccount"],
    withObjects: {
      sandboxAccountStore: mockedAccountStore(),
    },
  });

  return mockOrgService;
}

export function mockedIdcService() {
  return createMockOf(IdcService, {
    usingRealFunctions: [
      "transactionalAssignGroupAccess",
      "transactionalRevokeGroupAccess",
      "transactionalGrantUserAccess",
    ],
  });
}

export function mockedIsbEventBridge() {
  return createMockOf(IsbEventBridgeClient, {
    usingRealFunctions: ["sendIsbEvents"],
  });
}

export function mockedBlueprintStore() {
  return createMockOf(BlueprintStore);
}

export function mockedBlueprintDeploymentService() {
  return createMockOf(BlueprintDeploymentService);
}

export function mockTransaction<T>(returnValue: T): Transaction<T> {
  return new Transaction<T>({
    beginTransaction: async () => returnValue,
    rollbackTransaction: async () => {},
  });
}

export function mockedOrganizationsTaggingService() {
  return createMockOf(OrganizationsTaggingService);
}
export function mockedSandboxSpacesUsageStore(): MockProxy<SandboxSpacesUsageStore> {
  // SandboxSpacesUsageStore is a plain interface (not an abstract class), so
  // mock<T>() from vitest-mock-extended is used instead of createMockOf.
  const store = mock<SandboxSpacesUsageStore>();
  store.stampLeaseTtl.mockResolvedValue(undefined);
  store.listLeaseUserUsage.mockResolvedValue({ usage: [] });
  return store;
}

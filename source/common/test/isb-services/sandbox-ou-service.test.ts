// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Account,
  ConcurrentModificationException,
  DescribeAccountCommand,
  ListAccountsForParentCommand,
  MoveAccountCommand,
  OrganizationsClient,
  TooManyRequestsException,
} from "@aws-sdk/client-organizations";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { AccountPoolStackConfigStore } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/ssm-account-pool-stack-config-store.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  IsbOu,
  SandboxAccount,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";

// Mock AWS SDK clients
const mockOrganizationsClient = mockClient(OrganizationsClient);

// Mock SandboxAccountStore
const mockSandboxAccountStore = {
  put: vi.fn(),
} as unknown as SandboxAccountStore;

// Mock AccountPoolStackConfigStore
const mockAccountPoolStackConfigStore = {
  get: vi.fn(),
} as unknown as AccountPoolStackConfigStore;

describe("SandboxOuService", () => {
  let service: SandboxOuService;

  const mockAccountPoolConfig = {
    sandboxOuId: "ou-sandbox-12345678",
    availableOuId: "ou-available-12345678",
    activeOuId: "ou-active-12345678",
    frozenOuId: "ou-frozen-12345678",
    cleanupOuId: "ou-cleanup-12345678",
    quarantineOuId: "ou-quarantine-12345678",
    entryOuId: "ou-entry-12345678",
    exitOuId: "ou-exit-12345678",
    solutionVersion: "v1.0.0",
    supportedSchemas: '["1"]',
    isbManagedRegions: ["us-east-1", "us-west-2"],
  };

  beforeEach(() => {
    mockOrganizationsClient.reset();
    vi.clearAllMocks();

    // Mock AccountPoolStackConfigStore
    vi.mocked(mockAccountPoolStackConfigStore.get).mockResolvedValue(
      mockAccountPoolConfig as any,
    );

    service = new SandboxOuService({
      sandboxAccountStore: mockSandboxAccountStore,
      orgsClient: mockOrganizationsClient as any,
      accountPoolStackConfigStore: mockAccountPoolStackConfigStore,
    });
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("getIsbOuId()", () => {
    it.each<[IsbOu, keyof typeof mockAccountPoolConfig]>([
      ["Available", "availableOuId"],
      ["Active", "activeOuId"],
      ["Frozen", "frozenOuId"],
      ["CleanUp", "cleanupOuId"],
      ["Quarantine", "quarantineOuId"],
      ["Entry", "entryOuId"],
      ["Exit", "exitOuId"],
    ])("should return correct OU ID for %s", async (ouName, configKey) => {
      // Act
      const result = await (service as any).getIsbOuId(ouName);

      // Assert
      expect(result).toBe(mockAccountPoolConfig[configKey]);
    });

    it("should call config store for each OU lookup", async () => {
      // Act
      await (service as any).getIsbOuId("Available");
      await (service as any).getIsbOuId("Active");
      await (service as any).getIsbOuId("Frozen");

      // Assert - Config store should be called for each lookup (caching happens in the store)
      expect(mockAccountPoolStackConfigStore.get).toHaveBeenCalledTimes(3);
    });

    it("should throw error for invalid OU name", async () => {
      // Act & Assert
      await expect(
        (service as any).getIsbOuId("InvalidOU" as IsbOu),
      ).rejects.toThrow("Requested OU not found in Innovation Sandbox");
    });
  });

  describe("performAccountMoveAction()", () => {
    const accountId = "123456789012";
    const sourceOu: IsbOu = "Available";
    const destinationOu: IsbOu = "Active";

    it("should successfully move account between OUs", async () => {
      // Arrange
      mockOrganizationsClient.on(MoveAccountCommand).resolves({});

      // Act
      await service.performAccountMoveAction(
        accountId,
        sourceOu,
        destinationOu,
      );

      // Assert
      const moveCalls =
        mockOrganizationsClient.commandCalls(MoveAccountCommand);
      expect(moveCalls).toHaveLength(1);
      expect(moveCalls[0]!.args[0].input).toEqual({
        AccountId: accountId,
        SourceParentId: mockAccountPoolConfig.availableOuId,
        DestinationParentId: mockAccountPoolConfig.activeOuId,
      });
    });

    it("should retry on ConcurrentModificationException", async () => {
      // Arrange
      let callCount = 0;
      mockOrganizationsClient.on(MoveAccountCommand).callsFake(async () => {
        callCount++;
        if (callCount < 3) {
          throw new ConcurrentModificationException({
            $metadata: {},
            message: "ConcurrentModificationException",
          });
        }
        return {};
      });

      // Act
      await service.performAccountMoveAction(
        accountId,
        sourceOu,
        destinationOu,
      );

      // Assert
      expect(callCount).toBe(3);
    });

    it("should retry on TooManyRequestsException", async () => {
      // Arrange
      let callCount = 0;
      mockOrganizationsClient.on(MoveAccountCommand).callsFake(async () => {
        callCount++;
        if (callCount < 2) {
          throw new TooManyRequestsException({
            $metadata: {},
            message: "TooManyRequestsException",
          });
        }
        return {};
      });

      // Act
      await service.performAccountMoveAction(
        accountId,
        sourceOu,
        destinationOu,
      );

      // Assert
      expect(callCount).toBe(2);
    });

    it("should not retry on other errors", async () => {
      // Arrange
      mockOrganizationsClient
        .on(MoveAccountCommand)
        .rejects(new Error("AccessDeniedException"));

      // Act & Assert
      await expect(
        service.performAccountMoveAction(accountId, sourceOu, destinationOu),
      ).rejects.toThrow("AccessDeniedException");
      expect(
        mockOrganizationsClient.commandCalls(MoveAccountCommand),
      ).toHaveLength(1);
    });
  });

  describe("moveAccount()", () => {
    const mockAccount: SandboxAccount = {
      awsAccountId: "123456789012",
      email: "test@example.com",
      name: "Test Account",
      status: "Available",
      meta: {
        schemaVersion: 1,
        createdTime: "2024-01-01T00:00:00Z",
        lastEditTime: "2024-01-01T00:00:00Z",
      },
    };

    it("should move account and update store", async () => {
      // Arrange
      mockOrganizationsClient.on(MoveAccountCommand).resolves({});
      (mockSandboxAccountStore.put as any).mockResolvedValue({
        newItem: {
          ...mockAccount,
          status: "Active",
        },
      });

      // Act
      const result = await service.moveAccount(
        mockAccount,
        "Available",
        "Active",
      );

      // Assert
      expect(
        mockOrganizationsClient.commandCalls(MoveAccountCommand),
      ).toHaveLength(1);
      expect(mockSandboxAccountStore.put).toHaveBeenCalledWith({
        ...mockAccount,
        status: "Active",
      });
      expect(result.newItem.status).toBe("Active");
    });

    it("should propagate move errors", async () => {
      // Arrange
      mockOrganizationsClient
        .on(MoveAccountCommand)
        .rejects(new Error("Move failed"));

      // Act & Assert
      await expect(
        service.moveAccount(mockAccount, "Available", "Active"),
      ).rejects.toThrow("Move failed");
      expect(mockSandboxAccountStore.put).not.toHaveBeenCalled();
    });
  });

  describe("listAccountsInOU()", () => {
    const ouName: IsbOu = "Available";

    it("should list accounts in OU", async () => {
      // Arrange
      const mockAccounts: Account[] = [
        {
          Id: "111111111111",
          Name: "Account 1",
          Email: "account1@example.com",
        },
        {
          Id: "222222222222",
          Name: "Account 2",
          Email: "account2@example.com",
        },
      ];

      mockOrganizationsClient.on(ListAccountsForParentCommand).resolves({
        Accounts: mockAccounts,
        NextToken: undefined,
      });

      // Act
      const result = await service.listAccountsInOU({ ouName });

      // Assert
      expect(result.accounts).toEqual(mockAccounts);
      expect(result.nextPageIdentifier).toBeUndefined();
      const listCalls = mockOrganizationsClient.commandCalls(
        ListAccountsForParentCommand,
      );
      expect(listCalls).toHaveLength(1);
      expect(listCalls[0]!.args[0].input.ParentId).toBe(
        mockAccountPoolConfig.availableOuId,
      );
    });

    it("should support pagination", async () => {
      // Arrange
      const mockAccounts: Account[] = [
        {
          Id: "111111111111",
          Name: "Account 1",
          Email: "account1@example.com",
        },
      ];

      mockOrganizationsClient.on(ListAccountsForParentCommand).resolves({
        Accounts: mockAccounts,
        NextToken: "next-page-token",
      });

      // Act
      const result = await service.listAccountsInOU({
        ouName,
        pageSize: 10,
        pageIdentifier: "previous-token",
      });

      // Assert
      expect(result.accounts).toEqual(mockAccounts);
      expect(result.nextPageIdentifier).toBe("next-page-token");
      const listCalls = mockOrganizationsClient.commandCalls(
        ListAccountsForParentCommand,
      );
      expect(listCalls[0]!.args[0].input).toMatchObject({
        ParentId: mockAccountPoolConfig.availableOuId,
        MaxResults: 10,
        NextToken: "previous-token",
      });
    });
  });

  describe("describeAccount()", () => {
    it("should describe account successfully", async () => {
      // Arrange
      const accountId = "123456789012";
      const mockAccount = {
        Id: accountId,
        Name: "Test Account",
        Email: "test@example.com",
        Status: "ACTIVE" as const,
      };

      mockOrganizationsClient.on(DescribeAccountCommand).resolves({
        Account: mockAccount,
      });

      // Act
      const result = await service.describeAccount({ accountId });

      // Assert
      expect(result).toEqual({
        accountId: mockAccount.Id,
        name: mockAccount.Name,
        email: mockAccount.Email,
      });
      const describeCalls = mockOrganizationsClient.commandCalls(
        DescribeAccountCommand,
      );
      expect(describeCalls).toHaveLength(1);
      expect(describeCalls[0]!.args[0].input.AccountId).toBe(accountId);
    });

    it("should return undefined when account not found", async () => {
      // Arrange
      mockOrganizationsClient.on(DescribeAccountCommand).resolves({
        Account: undefined,
      });

      // Act
      const result = await service.describeAccount({
        accountId: "999999999999",
      });

      // Assert
      expect(result).toBeUndefined();
    });
  });

  describe("transactionalMoveAccount()", () => {
    const mockAccount: SandboxAccount = {
      awsAccountId: "123456789012",
      email: "test@example.com",
      name: "Test Account",
      status: "Available",
      meta: {
        schemaVersion: 1,
        createdTime: "2024-01-01T00:00:00Z",
        lastEditTime: "2024-01-01T00:00:00Z",
      },
    };

    it("should execute transaction successfully", async () => {
      // Arrange
      mockOrganizationsClient.on(MoveAccountCommand).resolves({});
      (mockSandboxAccountStore.put as any).mockResolvedValue({
        newItem: {
          ...mockAccount,
          status: "Active",
        },
      });

      const transaction = service.transactionalMoveAccount(
        mockAccount,
        "Available",
        "Active",
      );

      // Act
      await transaction.beginTransaction();

      // Assert
      expect(
        mockOrganizationsClient.commandCalls(MoveAccountCommand),
      ).toHaveLength(1);
      expect(mockSandboxAccountStore.put).toHaveBeenCalledWith({
        ...mockAccount,
        status: "Active",
      });
    });

    it("should rollback transaction on failure", async () => {
      // Arrange
      mockOrganizationsClient.on(MoveAccountCommand).resolves({});
      (mockSandboxAccountStore.put as any).mockResolvedValue({
        newItem: {
          ...mockAccount,
          status: "Active",
        },
      });

      const transaction = service.transactionalMoveAccount(
        mockAccount,
        "Available",
        "Active",
      );

      // Act - First execute the transaction, then rollback
      await transaction.beginTransaction();

      // Clear the call history to isolate rollback calls
      const callsBeforeRollback =
        mockOrganizationsClient.commandCalls(MoveAccountCommand).length;

      await transaction.rollbackTransaction();

      // Assert - rollback moves from destination back to source
      const allCalls = mockOrganizationsClient.commandCalls(MoveAccountCommand);
      expect(allCalls.length).toBe(callsBeforeRollback + 1);

      const rollbackCall = allCalls[allCalls.length - 1];
      expect(rollbackCall!.args[0].input).toMatchObject({
        AccountId: mockAccount.awsAccountId,
        SourceParentId: mockAccountPoolConfig.activeOuId, // Swapped (from Active back to Available)
        DestinationParentId: mockAccountPoolConfig.availableOuId, // Swapped
      });
    });
  });
});

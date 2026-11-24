// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { beforeEach, describe, expect, it, vi } from "vitest";

import { cleanupAccountAccess } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/cleanup-account-access.js";
import type { CleanupContext } from "@amzn/innovation-sandbox-durable-cleanup-orchestration/steps/types.js";

// Mock external dependencies
const mockSsoAdminSend = vi.fn();
const mockGetIdcConfig = vi.fn();
const mockListPermissionSetsProvisionedToAccount = vi.fn();
const mockGetAssignmentsForLease = vi.fn();
const mockDeleteAssignment = vi.fn().mockResolvedValue(true);

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    idcStackConfigStore: () => ({ get: mockGetIdcConfig }),
    idcService: () => ({
      listPermissionSetsProvisionedToAccount:
        mockListPermissionSetsProvisionedToAccount,
    }),
    principalStore: () => ({
      getAssignmentsForLease: mockGetAssignmentsForLease,
      deleteAssignment: mockDeleteAssignment,
    }),
  },
}));

vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: {
    ssoAdmin: () => ({ send: mockSsoAdminSend }),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  () => ({
    fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
  }),
);

// Mock the paginator
vi.mock("@aws-sdk/client-sso-admin", async (importOriginal) => {
  const original = (await importOriginal()) as Record<string, unknown>;
  return {
    ...original,
    paginateListAccountAssignments: vi.fn(),
  };
});

// Mock p-throttle to pass through without delay (module-scoped throttle would
// otherwise serialize calls across tests and add real 1s delays)
vi.mock("p-throttle", () => ({
  default: () => (fn: any) => fn,
}));

// Mock exponential-backoff to execute immediately without delays
vi.mock("exponential-backoff", () => ({
  backOff: async (fn: () => Promise<any>, options?: any) => {
    const maxAttempts = options?.numOfAttempts ?? 5;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await fn();
      } catch (error: any) {
        const shouldRetry = options?.retry?.(error) ?? true;
        if (!shouldRetry || attempt === maxAttempts) throw error;
      }
    }
  },
}));

import {
  DeleteAccountAssignmentCommand,
  DescribeAccountAssignmentDeletionStatusCommand,
  ListAccountAssignmentsCommandInput,
  paginateListAccountAssignments,
  SSOAdminPaginationConfiguration,
} from "@aws-sdk/client-sso-admin";

const TEST_ACCOUNT_ID = "123456789012";
const TEST_INSTANCE_ARN = "arn:aws:sso:::instance/ssoins-1234567890abcdef0";
const TEST_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-0123456789abcdef0";
const TEST_CUSTOM_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-1123456789abcdef0";
const TEST_SECOND_CUSTOM_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-2123456789abcdef0";
const TEST_ADMIN_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-a123456789abcdef0";
const TEST_MANAGER_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef0/ps-b123456789abcdef0";
const TEST_ADMIN_GROUP_ID = "admin-group-id";
const TEST_MANAGER_GROUP_ID = "manager-group-id";
const TEST_LEASE_ID = "a1b2c3d4-e5f6-7890-abcd-ef1234567890";

function createMockContext(
  overrides?: Partial<CleanupContext>,
): CleanupContext {
  const logger = {
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  };
  return {
    durableContext: { logger } as unknown as CleanupContext["durableContext"],
    env: {
      PRINCIPAL_TABLE_NAME: "test-principal-table",
      IDC_CONFIG_PARAM_ARN:
        "arn:aws:ssm:us-east-1:111111111111:parameter/isb_test_idc_config",
      IDC_ROLE_ARN: "arn:aws:iam::222222222222:role/ISB-IdcRole",
      INTERMEDIATE_ROLE_ARN:
        "arn:aws:iam::111111111111:role/ISB-IntermediateRole",
      USER_AGENT_EXTRA: "ISB-Test/1.0",
    } as unknown as CleanupContext["env"],
    accountId: TEST_ACCOUNT_ID,
    executionArn:
      "arn:aws:states:us-east-1:111111111111:execution:DurableCleanup:exec-abc",
    cleanupReason: "LEASE_TERMINATION",
    executionStartTime: "2024-06-01T12:00:00.000Z",
    accountStore: {
      get: vi
        .fn()
        .mockResolvedValue({ result: { awsAccountId: TEST_ACCOUNT_ID } }),
    } as unknown as CleanupContext["accountStore"],
    eventBridge: {} as CleanupContext["eventBridge"],
    organizationsTaggingService:
      {} as CleanupContext["organizationsTaggingService"],
    reportWriter: {
      updateReport: vi.fn().mockResolvedValue(undefined),
    } as unknown as CleanupContext["reportWriter"],
    reportKey: {} as CleanupContext["reportKey"],
    ...overrides,
  };
}

function setupPaginator(pages: { AccountAssignments: any[] }[]) {
  setupPaginators({ [TEST_PERMISSION_SET_ARN]: pages });
}

function setupPaginators(
  pagesByPermissionSet: Record<string, { AccountAssignments?: any[] }[]>,
) {
  vi.mocked(paginateListAccountAssignments).mockImplementation(async function* (
    _config: SSOAdminPaginationConfiguration,
    input: ListAccountAssignmentsCommandInput,
  ) {
    for (const page of pagesByPermissionSet[input.PermissionSetArn!] ?? []) {
      yield page;
    }
  } as any);
}

function mockSuccessfulDeletionLifecycle() {
  mockSsoAdminSend.mockResolvedValue({
    AccountAssignmentDeletionStatus: {
      RequestId: "request-id",
      Status: "SUCCEEDED",
    },
  });
}

describe("cleanupAccountAccess()", () => {
  beforeEach(() => {
    vi.clearAllMocks();

    mockGetIdcConfig.mockResolvedValue({
      ssoInstanceArn: TEST_INSTANCE_ARN,
      userPermissionSetArn: TEST_PERMISSION_SET_ARN,
      adminPermissionSetArn: TEST_ADMIN_PERMISSION_SET_ARN,
      adminGroupId: TEST_ADMIN_GROUP_ID,
      managerPermissionSetArn: TEST_MANAGER_PERMISSION_SET_ARN,
      managerGroupId: TEST_MANAGER_GROUP_ID,
      identityStoreId: "d-1234567890",
    });
    mockListPermissionSetsProvisionedToAccount.mockResolvedValue([
      TEST_PERMISSION_SET_ARN,
    ]);

    mockGetAssignmentsForLease.mockResolvedValue({
      result: [],
      nextPageIdentifier: null,
    });
  });

  it("returns zero counts when no IDC assignments exist and no leaseId on account", async () => {
    const ctx = createMockContext();
    setupPaginator([{ AccountAssignments: [] }]);

    const result = await cleanupAccountAccess(ctx);

    expect(result).toEqual({
      assignmentsFound: 0,
      assignmentsDeleted: 0,
      principalRecordsFound: 0,
      principalRecordsDeleted: 0,
      failed: false,
    });
    expect(mockListPermissionSetsProvisionedToAccount).toHaveBeenCalledWith(
      TEST_ACCOUNT_ID,
    );
  });

  it("deletes assignments across every permission set provisioned to the account", async () => {
    const ctx = createMockContext();
    mockListPermissionSetsProvisionedToAccount.mockResolvedValue([
      TEST_PERMISSION_SET_ARN,
      TEST_CUSTOM_PERMISSION_SET_ARN,
      TEST_SECOND_CUSTOM_PERMISSION_SET_ARN,
    ]);
    setupPaginators({
      [TEST_PERMISSION_SET_ARN]: [
        {
          AccountAssignments: [
            { PrincipalId: "user-id-1", PrincipalType: "USER" },
          ],
        },
      ],
      [TEST_CUSTOM_PERMISSION_SET_ARN]: [
        {
          AccountAssignments: [
            { PrincipalId: "group-id-1", PrincipalType: "GROUP" },
          ],
        },
      ],
      [TEST_SECOND_CUSTOM_PERMISSION_SET_ARN]: [
        {
          AccountAssignments: [
            { PrincipalId: "user-id-2", PrincipalType: "USER" },
          ],
        },
      ],
    });
    mockSuccessfulDeletionLifecycle();

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(3);
    expect(result.assignmentsDeleted).toBe(3);
    expect(
      mockSsoAdminSend.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof DeleteAccountAssignmentCommand)
        .map((command) => command.input.PermissionSetArn),
    ).toEqual([
      TEST_PERMISSION_SET_ARN,
      TEST_CUSTOM_PERMISSION_SET_ARN,
      TEST_SECOND_CUSTOM_PERMISSION_SET_ARN,
    ]);
  });

  it("preserves only the configured admin and manager group tuples", async () => {
    const ctx = createMockContext();
    mockListPermissionSetsProvisionedToAccount.mockResolvedValue([
      TEST_ADMIN_PERMISSION_SET_ARN,
      TEST_MANAGER_PERMISSION_SET_ARN,
    ]);
    setupPaginators({
      [TEST_ADMIN_PERMISSION_SET_ARN]: [
        {
          AccountAssignments: [
            {
              PrincipalId: TEST_ADMIN_GROUP_ID,
              PrincipalType: "GROUP",
            },
            { PrincipalId: "unexpected-admin-user", PrincipalType: "USER" },
          ],
        },
      ],
      [TEST_MANAGER_PERMISSION_SET_ARN]: [
        {
          AccountAssignments: [
            {
              PrincipalId: TEST_MANAGER_GROUP_ID,
              PrincipalType: "GROUP",
            },
            { PrincipalId: "unexpected-manager-group", PrincipalType: "GROUP" },
          ],
        },
      ],
    });
    mockSuccessfulDeletionLifecycle();

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(2);
    expect(result.assignmentsDeleted).toBe(2);
    expect(
      mockSsoAdminSend.mock.calls
        .map(([command]) => command)
        .filter((command) => command instanceof DeleteAccountAssignmentCommand)
        .map((command) => ({
          permissionSetArn: command.input.PermissionSetArn,
          principalId: command.input.PrincipalId,
          principalType: command.input.PrincipalType,
        })),
    ).toEqual([
      {
        permissionSetArn: TEST_ADMIN_PERMISSION_SET_ARN,
        principalId: "unexpected-admin-user",
        principalType: "USER",
      },
      {
        permissionSetArn: TEST_MANAGER_PERMISSION_SET_ARN,
        principalId: "unexpected-manager-group",
        principalType: "GROUP",
      },
    ]);
  });

  it("propagates permission set enumeration failure for quarantine handling", async () => {
    const ctx = createMockContext();
    mockListPermissionSetsProvisionedToAccount.mockRejectedValue(
      new Error("AccessDenied"),
    );
    setupPaginator([]);

    await expect(cleanupAccountAccess(ctx)).rejects.toThrow("AccessDenied");
    expect(paginateListAccountAssignments).not.toHaveBeenCalled();
    expect(mockSsoAdminSend).not.toHaveBeenCalled();
    expect(mockGetAssignmentsForLease).not.toHaveBeenCalled();
  });

  it("deletes lingering IDC assignments and polls for completion", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    let nextRequestId = 1;
    mockSsoAdminSend.mockImplementation((command) => {
      if (command instanceof DeleteAccountAssignmentCommand) {
        return Promise.resolve({
          AccountAssignmentDeletionStatus: {
            RequestId: `req-${nextRequestId++}`,
          },
        });
      }
      if (command instanceof DescribeAccountAssignmentDeletionStatusCommand) {
        return Promise.resolve({
          AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
        });
      }
      return Promise.reject(new Error("Unexpected SSO Admin command"));
    });

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(2);
    // 2 deletes + 2 describe polls
    expect(mockSsoAdminSend).toHaveBeenCalledTimes(4);
    expect(
      mockSsoAdminSend.mock.calls.filter(
        ([command]) => command instanceof DeleteAccountAssignmentCommand,
      ),
    ).toHaveLength(2);
    expect(
      mockSsoAdminSend.mock.calls.filter(
        ([command]) =>
          command instanceof DescribeAccountAssignmentDeletionStatusCommand,
      ),
    ).toHaveLength(2);
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          InstanceArn: TEST_INSTANCE_ARN,
          PermissionSetArn: TEST_PERMISSION_SET_ARN,
          PrincipalId: "user-id-1",
          PrincipalType: "USER",
          TargetId: TEST_ACCOUNT_ID,
          TargetType: "AWS_ACCOUNT",
        }),
      }),
    );
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          PrincipalId: "user-id-2",
          PrincipalType: "USER",
        }),
      }),
    );
  });

  it("throws after attempting all deletions when some fail", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    mockSsoAdminSend
      .mockRejectedValueOnce(new Error("ConflictException"))
      // Second assignment: delete succeeds + poll succeeds
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-2" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      });

    await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
      "1/2 IDC assignment deletions failed",
    );
    // First delete (fail) + second delete + second poll = 3 calls
    expect(mockSsoAdminSend).toHaveBeenCalledTimes(3);
  });

  it("handles multiple pages of assignments", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-1",
            PrincipalType: "USER",
          },
        ],
      },
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "user-id-2",
            PrincipalType: "USER",
          },
        ],
      },
    ]);

    mockSuccessfulDeletionLifecycle();

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(2);
  });

  it("handles zero pages from paginator gracefully", async () => {
    const ctx = createMockContext();
    setupPaginator([]);

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(0);
    expect(mockSsoAdminSend).not.toHaveBeenCalled();
  });

  it("handles pages with undefined AccountAssignments", async () => {
    const ctx = createMockContext();
    setupPaginator([{ AccountAssignments: undefined as any }]);

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(0);
    expect(mockSsoAdminSend).not.toHaveBeenCalled();
  });

  it("deletes GROUP type assignments from IDC", async () => {
    const ctx = createMockContext();
    setupPaginator([
      {
        AccountAssignments: [
          {
            AccountId: TEST_ACCOUNT_ID,
            PermissionSetArn: TEST_PERMISSION_SET_ARN,
            PrincipalId: "group-id-1",
            PrincipalType: "GROUP",
          },
        ],
      },
    ]);

    mockSsoAdminSend
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { RequestId: "req-group" },
      })
      .mockResolvedValueOnce({
        AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
      });

    const result = await cleanupAccountAccess(ctx);

    expect(result.assignmentsFound).toBe(1);
    expect(mockSsoAdminSend).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          PrincipalId: "group-id-1",
          PrincipalType: "GROUP",
        }),
      }),
    );
  });

  describe("deletion status polling", () => {
    it("polls until SUCCEEDED after IN_PROGRESS", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      mockSsoAdminSend
        // Delete call
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { RequestId: "req-1" },
        })
        // First poll: IN_PROGRESS
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { Status: "IN_PROGRESS" },
        })
        // Second poll: SUCCEEDED
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { Status: "SUCCEEDED" },
        });

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(1);
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(3);
    });

    it("throws when polling returns FAILED status", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      mockSsoAdminSend
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { RequestId: "req-fail" },
        })
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: {
            Status: "FAILED",
            FailureReason: "Permission denied",
          },
        });

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "1/1 IDC assignment deletions failed",
      );
    });

    it("counts deletion as failed when no RequestId is returned", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);

      mockSsoAdminSend.mockResolvedValueOnce({});

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "1/1 IDC assignment deletions failed",
      );
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(1);
      expect(ctx.reportWriter.updateReport).toHaveBeenCalledWith(
        ctx.reportKey,
        expect.objectContaining({
          accessCleanupSummary: expect.objectContaining({
            assignmentsFound: 1,
            assignmentsDeleted: 0,
            failed: true,
          }),
        }),
      );
    });

    it("treats ResourceNotFoundException as idempotent success", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "already-deleted-user",
              PrincipalType: "USER",
            },
          ],
        },
      ]);
      const notFoundError = Object.assign(new Error("Assignment not found"), {
        name: "ResourceNotFoundException",
        $metadata: {},
      });
      Object.setPrototypeOf(
        notFoundError,
        (await import("@aws-sdk/client-sso-admin")).ResourceNotFoundException
          .prototype,
      );
      mockSsoAdminSend.mockRejectedValueOnce(notFoundError);

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(1);
      expect(result.assignmentsDeleted).toBe(1);
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(1);
    });

    it("does not treat ResourceNotFoundException from status polling as success", async () => {
      const ctx = createMockContext();
      setupPaginator([
        {
          AccountAssignments: [
            {
              AccountId: TEST_ACCOUNT_ID,
              PermissionSetArn: TEST_PERMISSION_SET_ARN,
              PrincipalId: "user-id-1",
              PrincipalType: "USER",
            },
          ],
        },
      ]);
      const notFoundError = Object.assign(
        new Error("Deletion request not found"),
        {
          name: "ResourceNotFoundException",
          $metadata: {},
        },
      );
      Object.setPrototypeOf(
        notFoundError,
        (await import("@aws-sdk/client-sso-admin")).ResourceNotFoundException
          .prototype,
      );
      mockSsoAdminSend
        .mockResolvedValueOnce({
          AccountAssignmentDeletionStatus: { RequestId: "req-not-found" },
        })
        .mockRejectedValueOnce(notFoundError);

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "1/1 IDC assignment deletions failed",
      );
      expect(mockSsoAdminSend).toHaveBeenCalledTimes(2);
    });
  });

  describe("Principal Table cleanup", () => {
    it("deletes user assignment records when leaseId is on account record", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
            sk: `lease#${TEST_LEASE_ID}`,
          },
        ],
        nextPageIdentifier: null,
      });

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(1);
      expect(mockDeleteAssignment).toHaveBeenCalledWith({
        principalId: "user-id-1",
        principalType: "USER",
        sk: `lease#${TEST_LEASE_ID}`,
        expectedLastEditTime: undefined,
      });
    });

    it("deletes group assignment records when leaseId is on account record", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            groupId: "group-id-1",
            principalType: "GROUP",
            leaseId: TEST_LEASE_ID,
            sk: `lease#${TEST_LEASE_ID}`,
          },
        ],
        nextPageIdentifier: null,
      });

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(1);
      expect(mockDeleteAssignment).toHaveBeenCalledWith({
        principalId: "group-id-1",
        principalType: "GROUP",
        sk: `lease#${TEST_LEASE_ID}`,
        expectedLastEditTime: undefined,
      });
    });

    it("deletes legacy and tuple-keyed records by their exact keys", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
            sk: `lease#${TEST_LEASE_ID}`,
          },
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
            permissionSetArn: TEST_CUSTOM_PERMISSION_SET_ARN,
            permissionSetId: "ps-1123456789abcdef0",
            sk: `lease#${TEST_LEASE_ID}#ps#ps-1123456789abcdef0`,
          },
        ],
        nextPageIdentifier: null,
      });
      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsFound).toBe(2);
      expect(result.principalRecordsDeleted).toBe(2);
      expect(mockDeleteAssignment).toHaveBeenCalledTimes(2);
      expect(mockDeleteAssignment).toHaveBeenNthCalledWith(1, {
        principalId: "user-id-1",
        principalType: "USER",
        sk: `lease#${TEST_LEASE_ID}`,
        expectedLastEditTime: undefined,
      });
      expect(mockDeleteAssignment).toHaveBeenNthCalledWith(2, {
        principalId: "user-id-1",
        principalType: "USER",
        sk: `lease#${TEST_LEASE_ID}#ps#ps-1123456789abcdef0`,
        expectedLastEditTime: undefined,
      });
    });

    it("skips Principal Table cleanup when no leaseId on account", async () => {
      const ctx = createMockContext();
      setupPaginator([{ AccountAssignments: [] }]);

      const result = await cleanupAccountAccess(ctx);

      expect(result.principalRecordsDeleted).toBe(0);
      expect(mockGetAssignmentsForLease).not.toHaveBeenCalled();
    });

    it("throws when individual record deletion fails", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockResolvedValue({
            result: {
              awsAccountId: TEST_ACCOUNT_ID,
              currentLease: {
                leaseId: TEST_LEASE_ID,
                ownerEmail: "owner@example.com",
              },
            },
          }),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      mockGetAssignmentsForLease.mockResolvedValue({
        result: [
          {
            userId: "user-id-1",
            principalType: "USER",
            leaseId: TEST_LEASE_ID,
            sk: `lease#${TEST_LEASE_ID}`,
          },
        ],
        nextPageIdentifier: null,
      });

      mockDeleteAssignment.mockRejectedValueOnce(
        new Error("ConditionalCheckFailed"),
      );

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow(
        "Principal Table record deletions failed",
      );
    });

    it("throws when accountStore.get fails", async () => {
      const ctx = createMockContext({
        accountStore: {
          get: vi.fn().mockRejectedValue(new Error("DynamoDB error")),
        } as unknown as CleanupContext["accountStore"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      await expect(cleanupAccountAccess(ctx)).rejects.toThrow("DynamoDB error");
    });
  });

  describe("report writing", () => {
    it("does not throw when reportWriter.updateReport fails", async () => {
      const ctx = createMockContext({
        reportWriter: {
          updateReport: vi
            .fn()
            .mockRejectedValue(new Error("Report write failed")),
        } as unknown as CleanupContext["reportWriter"],
      });
      setupPaginator([{ AccountAssignments: [] }]);

      const result = await cleanupAccountAccess(ctx);

      expect(result.assignmentsFound).toBe(0);
      expect(result.assignmentsDeleted).toBe(0);
    });
  });
});

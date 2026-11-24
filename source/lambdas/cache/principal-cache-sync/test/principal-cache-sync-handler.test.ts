// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { PrincipalCacheSyncEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const INSTANCE_ID = "ins-0123456789abcdef";
const IDC_ACCOUNT_ID = "123456789012";
const permissionSetArn = (id: string) =>
  `arn:aws:sso:::permissionSet/${INSTANCE_ID}/${id}`;
const BUILT_IN_PERMISSION_SET_ID = "ps-0000000000000000";
const BUILT_IN_PERMISSION_SET_DESCRIPTION =
  "User PermissionSet for the Innovation Sandbox on AWS solution";
const BUILT_IN_PERMISSION_SET_SESSION_DURATION = "PT1H";
const ADMIN_PERMISSION_SET_ID = "ps-1111111111111111";
const MANAGER_PERMISSION_SET_ID = "ps-2222222222222222";
const CUSTOM_PERMISSION_SET_ID = "ps-3333333333333333";
const STALE_PERMISSION_SET_ID = "ps-4444444444444444";

const idcConfig = {
  identityStoreId: "d-0123456789",
  ssoInstanceArn: `arn:aws:sso:::instance/${INSTANCE_ID}`,
  adminGroupId: "admin-group",
  managerGroupId: "manager-group",
  userGroupId: "user-group",
  adminPermissionSetArn: permissionSetArn(ADMIN_PERMISSION_SET_ID),
  managerPermissionSetArn: permissionSetArn(MANAGER_PERMISSION_SET_ID),
  userPermissionSetArn: permissionSetArn(BUILT_IN_PERMISSION_SET_ID),
  solutionVersion: "1.4.0",
  supportedSchemas: '["1"]',
};

const testEnv = generateSchemaData(PrincipalCacheSyncEnvironmentSchema, {
  IDC_ACCOUNT_ID,
  ISB_NAMESPACE: "test",
});
const testContext = mockContext(testEnv);

let handler: typeof import("@amzn/innovation-sandbox-principal-cache-sync/principal-cache-sync-handler.js").handler;

const mockIdcService = {
  listAllIsbMemberIds: vi.fn(),
  listAllUsers: vi.fn(),
  listAllGroups: vi.fn(),
  listRegisteredPermissionSets: vi.fn(),
  getPermissionSet: vi.fn(),
  isPermissionSetRegistered: vi.fn(),
};

const mockPrincipalStore = {
  getCacheItems: vi.fn(),
  batchPutCacheItems: vi.fn(),
  batchDeleteCacheItemsBySk: vi.fn(),
  getPermissionSetCacheItems: vi.fn(),
  batchPutPermissionSetCacheItems: vi.fn(),
  batchDeletePermissionSetCacheItemsBySk: vi.fn(),
};

const mockIdcStackConfigStore = {
  get: vi.fn(),
};

function permissionSetCacheItem(props: {
  permissionSetId: string;
  name: string;
  description?: string;
  sessionDuration?: string;
}) {
  return {
    pk: "permissionSetCache" as const,
    sk: `ps#${props.permissionSetId}`,
    permissionSetArn: permissionSetArn(props.permissionSetId),
    permissionSetId: props.permissionSetId,
    name: props.name,
    ...(props.description !== undefined && {
      description: props.description,
    }),
    ...(props.sessionDuration !== undefined && {
      sessionDuration: props.sessionDuration,
    }),
    syncedAt: "2026-09-16T12:00:00.000Z",
    meta: {
      schemaVersion: 1,
      createdTime: "2026-09-16T12:00:00.000Z",
      lastEditTime: "2026-09-16T12:00:00.000Z",
    },
  };
}

function permissionSetEvent(
  eventName:
    | "CreatePermissionSet"
    | "TagResource"
    | "UntagResource"
    | "DeletePermissionSet"
    | "UpdatePermissionSet",
  requestParameters: Record<string, unknown>,
  overrides: {
    account?: string;
    actorAccount?: string;
    actorArn?: string;
    responseElements?: Record<string, unknown>;
  } = {},
) {
  return {
    version: "0",
    id: "event-id",
    "detail-type": "AWS API Call via CloudTrail",
    source: "aws.sso",
    account: overrides.account ?? IDC_ACCOUNT_ID,
    time: "2026-09-18T12:00:00Z",
    region: "us-east-1",
    resources: [],
    detail: {
      eventSource: "sso.amazonaws.com",
      eventName,
      userIdentity: {
        accountId: overrides.actorAccount ?? IDC_ACCOUNT_ID,
        arn:
          overrides.actorArn ??
          `arn:aws:sts::${IDC_ACCOUNT_ID}:assumed-role/Admin/test-user`,
      },
      requestParameters,
      ...(overrides.responseElements !== undefined && {
        responseElements: overrides.responseElements,
      }),
    },
  };
}

beforeAll(async () => {
  bulkStubEnv(testEnv);

  // Mock IsbServices before importing handler
  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      idcService: vi.fn().mockReturnValue(mockIdcService),
      principalStore: vi.fn().mockReturnValue(mockPrincipalStore),
      idcStackConfigStore: vi.fn().mockReturnValue(mockIdcStackConfigStore),
    },
  }));

  // Mock cross-account credentials
  vi.doMock(
    "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
    () => ({
      fromTemporaryIsbIdcCredentials: vi.fn().mockReturnValue({}),
    }),
  );

  // Import handler after mocking dependencies
  const module =
    await import("@amzn/innovation-sandbox-principal-cache-sync/principal-cache-sync-handler.js");
  handler = module.handler;
});

beforeEach(() => {
  bulkStubEnv(testEnv);
  vi.clearAllMocks();

  // Default mock responses
  mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set());
  mockIdcService.listAllUsers.mockResolvedValue([]);
  mockIdcService.listAllGroups.mockResolvedValue([]);
  mockIdcService.listRegisteredPermissionSets.mockResolvedValue([]);
  mockIdcService.isPermissionSetRegistered.mockResolvedValue(true);
  mockIdcService.getPermissionSet.mockResolvedValue({
    permissionSetArn: idcConfig.userPermissionSetArn,
    permissionSetId: BUILT_IN_PERMISSION_SET_ID,
    name: "test_IsbUsersPS",
    description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
    sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
  });
  mockPrincipalStore.getCacheItems.mockResolvedValue([]);
  mockPrincipalStore.batchPutCacheItems.mockResolvedValue(undefined);
  mockPrincipalStore.batchDeleteCacheItemsBySk.mockResolvedValue(undefined);
  mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
    permissionSetCacheItem({
      permissionSetId: BUILT_IN_PERMISSION_SET_ID,
      name: "test_IsbUsersPS",
      description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
      sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
    }),
  ]);
  mockPrincipalStore.batchPutPermissionSetCacheItems.mockResolvedValue(
    undefined,
  );
  mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk.mockResolvedValue(
    undefined,
  );
  mockIdcStackConfigStore.get.mockResolvedValue(idcConfig);
});

afterAll(() => {
  vi.restoreAllMocks();
});

describe("PrincipalCacheSyncHandler", () => {
  describe("permission set events", () => {
    it("writes a permission set tagged during creation without running the hourly sync", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue({
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "DeveloperAccess",
        description: "Developer permissions",
        sessionDuration: "PT4H",
      });

      await handler(
        permissionSetEvent(
          "CreatePermissionSet",
          {
            instanceArn: idcConfig.ssoInstanceArn,
            name: "DeveloperAccess",
            tags: [
              {
                key: "ISB:test:ManagedPermissionSet",
                value: "true",
              },
            ],
          },
          {
            responseElements: {
              permissionSet: {
                permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
              },
            },
          },
        ),
        testContext,
      );

      expect(mockIdcService.getPermissionSet).toHaveBeenCalledWith(
        permissionSetArn(CUSTOM_PERMISSION_SET_ID),
      );
      expect(mockIdcService.isPermissionSetRegistered).toHaveBeenCalledWith(
        permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        "test",
      );
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).toHaveBeenCalledWith([
        expect.objectContaining({
          sk: `ps#${CUSTOM_PERMISSION_SET_ID}`,
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          name: "DeveloperAccess",
        }),
      ]);
      expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
    });

    it("ignores a permission set created without the registration tag", async () => {
      await handler(
        permissionSetEvent(
          "CreatePermissionSet",
          {
            instanceArn: idcConfig.ssoInstanceArn,
            name: "DeveloperAccess",
          },
          {
            responseElements: {
              permissionSet: {
                permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
              },
            },
          },
        ),
        testContext,
      );

      expect(mockIdcService.getPermissionSet).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
      expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
    });

    it("writes a newly registered permission set without running the hourly sync", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue({
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "DeveloperAccess",
        description: "Developer permissions",
        sessionDuration: "PT4H",
      });

      await handler(
        permissionSetEvent("TagResource", {
          resourceArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          tags: [
            {
              key: "ISB:test:ManagedPermissionSet",
              value: "true",
            },
          ],
        }),
        testContext,
      );

      expect(mockIdcService.getPermissionSet).toHaveBeenCalledWith(
        permissionSetArn(CUSTOM_PERMISSION_SET_ID),
      );
      expect(mockIdcService.isPermissionSetRegistered).toHaveBeenCalledWith(
        permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        "test",
      );
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).toHaveBeenCalledWith([
        expect.objectContaining({
          sk: `ps#${CUSTOM_PERMISSION_SET_ID}`,
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          name: "DeveloperAccess",
        }),
      ]);
      expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
    });

    it("ignores tag events for another namespace", async () => {
      await handler(
        permissionSetEvent("TagResource", {
          instanceArn: idcConfig.ssoInstanceArn,
          resourceArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          tags: [
            {
              key: "ISB:other:ManagedPermissionSet",
              value: "true",
            },
          ],
        }),
        testContext,
      );

      expect(mockIdcService.getPermissionSet).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("deletes an untagged permission set", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue({
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "DeveloperAccess",
      });
      mockIdcService.isPermissionSetRegistered.mockResolvedValue(false);

      await handler(
        permissionSetEvent("UntagResource", {
          instanceArn: idcConfig.ssoInstanceArn,
          resourceArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          tagKeys: ["ISB:test:ManagedPermissionSet"],
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).toHaveBeenCalledWith([`ps#${CUSTOM_PERMISSION_SET_ID}`]);
    });

    it("keeps the built-in default when its registration tag is removed", async () => {
      mockIdcService.isPermissionSetRegistered.mockResolvedValue(false);

      await handler(
        permissionSetEvent("UntagResource", {
          instanceArn: idcConfig.ssoInstanceArn,
          resourceArn: idcConfig.userPermissionSetArn,
          tagKeys: ["ISB:test:ManagedPermissionSet"],
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("deletes a permission set after IDC deletion", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue(undefined);

      await handler(
        permissionSetEvent("DeletePermissionSet", {
          instanceArn: idcConfig.ssoInstanceArn,
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).toHaveBeenCalledWith([`ps#${CUSTOM_PERMISSION_SET_ID}`]);
    });

    it("uses current IDC tags instead of trusting a stale tag event", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue({
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "DeveloperAccess",
      });
      mockIdcService.isPermissionSetRegistered.mockResolvedValue(false);

      await handler(
        permissionSetEvent("TagResource", {
          instanceArn: idcConfig.ssoInstanceArn,
          resourceArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          tags: [
            {
              key: "ISB:test:ManagedPermissionSet",
              value: "true",
            },
          ],
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).toHaveBeenCalledWith([`ps#${CUSTOM_PERMISSION_SET_ID}`]);
    });

    it("refreshes metadata on UpdatePermissionSet and preserves createdTime", async () => {
      const existingItem = permissionSetCacheItem({
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "OldName",
      });
      mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
        existingItem,
      ]);
      mockIdcService.getPermissionSet.mockResolvedValue({
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "RenamedDeveloperAccess",
        description: "Updated description",
        sessionDuration: "PT8H",
      });

      await handler(
        permissionSetEvent("UpdatePermissionSet", {
          instanceArn: idcConfig.ssoInstanceArn,
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          description: "Updated description",
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).toHaveBeenCalledWith([
        expect.objectContaining({
          name: "RenamedDeveloperAccess",
          description: "Updated description",
          sessionDuration: "PT8H",
          meta: existingItem.meta,
        }),
      ]);
    });

    it("rejects events whose envelope or actor account is not the IDC account", async () => {
      await handler(
        permissionSetEvent(
          "DeletePermissionSet",
          {
            instanceArn: idcConfig.ssoInstanceArn,
            permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          },
          { actorAccount: "999999999999" },
        ),
        testContext,
      );

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("rejects permission sets from another IDC instance", async () => {
      await handler(
        permissionSetEvent("DeletePermissionSet", {
          instanceArn: idcConfig.ssoInstanceArn,
          permissionSetArn:
            "arn:aws:sso:::permissionSet/ins-9999999999999999/ps-3333333333333333",
        }),
        testContext,
      );

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("ignores unsupported EventBridge envelopes instead of running reconciliation", async () => {
      const event = permissionSetEvent("DeletePermissionSet", {
        instanceArn: idcConfig.ssoInstanceArn,
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
      });
      event.source = "untrusted.source";

      await handler(event, testContext);

      expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("ignores malformed permission set events instead of running reconciliation", async () => {
      const event = permissionSetEvent("TagResource", {
        instanceArn: idcConfig.ssoInstanceArn,
        resourceArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
      });

      await handler(event, testContext);

      expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
      expect(mockIdcStackConfigStore.get).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });

    it("ignores failed CloudTrail API calls", async () => {
      const event = permissionSetEvent("DeletePermissionSet", {
        instanceArn: idcConfig.ssoInstanceArn,
        permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
      }) as ReturnType<typeof permissionSetEvent> & {
        detail: { errorCode?: string; errorMessage?: string };
      };
      event.detail.errorCode = "AccessDeniedException";
      event.detail.errorMessage = "Not authorized";

      await handler(event, testContext);

      expect(mockIdcStackConfigStore.get).not.toHaveBeenCalled();
      expect(mockIdcService.getPermissionSet).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });
  });

  it("ignores unknown invocations instead of running reconciliation", async () => {
    await handler({}, testContext);

    expect(mockIdcService.listAllUsers).not.toHaveBeenCalled();
    expect(mockIdcStackConfigStore.get).not.toHaveBeenCalled();
  });

  it("should sync ISB users and groups to cache", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(
      new Set(["user-1", "user-2"]),
    );
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
      {
        principalId: "user-2",
        principalType: "USER",
        displayName: "User Two",
        email: "user2@example.com",
      },
      {
        principalId: "user-3",
        principalType: "USER",
        displayName: "Non-ISB User",
        email: "user3@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([
      {
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    // Should write only ISB members (user-1, user-2) + all groups (group-1)
    expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({
          pk: "principalCache",
          sk: "user#user-1",
          principalId: "user-1",
          displayName: "User One",
        }),
        expect.objectContaining({
          pk: "principalCache",
          sk: "user#user-2",
          principalId: "user-2",
          displayName: "User Two",
        }),
        expect.objectContaining({
          pk: "principalCache",
          sk: "group#group-1",
          principalId: "group-1",
          displayName: "Engineering",
        }),
      ]),
    );

    // Should NOT include non-ISB user (user-3)
    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    expect(writtenItems).toHaveLength(3);
    expect(
      writtenItems.find((i: any) => i.principalId === "user-3"),
    ).toBeUndefined();
  });

  it("should filter out non-ISB users", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["isb-user"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "isb-user",
        principalType: "USER",
        displayName: "ISB User",
        email: "isb@example.com",
      },
      {
        principalId: "external-user",
        principalType: "USER",
        displayName: "External",
        email: "ext@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    expect(writtenItems).toHaveLength(1);
    expect(writtenItems[0].principalId).toBe("isb-user");
  });

  it("should delete stale cache records", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["user-1"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    // Existing cache has user-1 and user-removed (stale)
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      {
        pk: "principalCache",
        sk: "user#user-1",
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
      {
        pk: "principalCache",
        sk: "user#user-removed",
        principalId: "user-removed",
        principalType: "USER",
        displayName: "Removed User",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    // Should delete the stale record
    expect(mockPrincipalStore.batchDeleteCacheItemsBySk).toHaveBeenCalledWith([
      "user#user-removed",
    ]);
  });

  it("should not call batchDeleteCacheItemsBySk when no stale records", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set(["user-1"]));
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        email: "user1@example.com",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);
    mockPrincipalStore.getCacheItems.mockResolvedValue([
      {
        pk: "principalCache",
        sk: "user#user-1",
        principalId: "user-1",
        principalType: "USER",
        displayName: "User One",
        syncedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    await handler({ source: "scheduled" }, testContext);

    expect(mockPrincipalStore.batchDeleteCacheItemsBySk).not.toHaveBeenCalled();
  });

  it("should handle empty identity store gracefully", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(new Set());
    mockIdcService.listAllUsers.mockResolvedValue([]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledWith([]);
  });

  it("should include email for users that have it", async () => {
    mockIdcService.listAllIsbMemberIds.mockResolvedValue(
      new Set(["user-with-email", "user-without-email"]),
    );
    mockIdcService.listAllUsers.mockResolvedValue([
      {
        principalId: "user-with-email",
        principalType: "USER",
        displayName: "Has Email",
        email: "has@example.com",
      },
      {
        principalId: "user-without-email",
        principalType: "USER",
        displayName: "No Email",
      },
    ]);
    mockIdcService.listAllGroups.mockResolvedValue([]);

    await handler({ source: "scheduled" }, testContext);

    const writtenItems =
      mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
    const withEmail = writtenItems.find(
      (i: any) => i.principalId === "user-with-email",
    );
    const withoutEmail = writtenItems.find(
      (i: any) => i.principalId === "user-without-email",
    );

    expect(withEmail.email).toBe("has@example.com");
    expect(withoutEmail.email).toBeUndefined();
  });

  describe("permission set reconciliation", () => {
    it("writes new assignable permission sets and excludes system roles", async () => {
      mockIdcService.listRegisteredPermissionSets.mockResolvedValue([
        {
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          permissionSetId: CUSTOM_PERMISSION_SET_ID,
          name: "DeveloperAccess",
          description: "Developer permissions",
          sessionDuration: "PT4H",
        },
        {
          permissionSetArn: idcConfig.adminPermissionSetArn,
          permissionSetId: ADMIN_PERMISSION_SET_ID,
          name: "AdminAccess",
        },
        {
          permissionSetArn: idcConfig.managerPermissionSetArn,
          permissionSetId: MANAGER_PERMISSION_SET_ID,
          name: "ManagerAccess",
        },
      ]);

      await handler({ source: "scheduled" }, testContext);

      const writtenItems =
        mockPrincipalStore.batchPutPermissionSetCacheItems.mock.calls[0]![0];
      expect(writtenItems).toHaveLength(1);
      expect(writtenItems[0]).toEqual(
        expect.objectContaining({
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          permissionSetId: CUSTOM_PERMISSION_SET_ID,
          name: "DeveloperAccess",
          description: "Developer permissions",
          sessionDuration: "PT4H",
        }),
      );
      expect(
        writtenItems.some(
          (item: any) =>
            item.permissionSetArn === idcConfig.adminPermissionSetArn ||
            item.permissionSetArn === idcConfig.managerPermissionSetArn,
        ),
      ).toBe(false);
    });

    it("always caches the built-in default even when it is untagged", async () => {
      mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([]);

      await handler({ source: "scheduled" }, testContext);

      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).toHaveBeenCalledWith([
        expect.objectContaining({
          permissionSetArn: idcConfig.userPermissionSetArn,
          permissionSetId: BUILT_IN_PERMISSION_SET_ID,
          name: "test_IsbUsersPS",
          description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
          sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
        }),
      ]);
      expect(mockIdcService.getPermissionSet).toHaveBeenCalledWith(
        idcConfig.userPermissionSetArn,
      );
    });

    it("fails before mutating the cache when the built-in default no longer exists", async () => {
      mockIdcService.getPermissionSet.mockResolvedValue(undefined);

      await expect(
        handler({ source: "scheduled" }, testContext),
      ).rejects.toThrow(
        `Built-in user permission set is unavailable: ${idcConfig.userPermissionSetArn}`,
      );

      expect(
        mockPrincipalStore.getPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("removes entries that are no longer registered", async () => {
      mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
        permissionSetCacheItem({
          permissionSetId: BUILT_IN_PERMISSION_SET_ID,
          name: "test_IsbUsersPS",
          description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
          sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
        }),
        permissionSetCacheItem({
          permissionSetId: STALE_PERMISSION_SET_ID,
          name: "StaleAccess",
        }),
      ]);

      await handler({ source: "scheduled" }, testContext);

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).toHaveBeenCalledWith([`ps#${STALE_PERMISSION_SET_ID}`]);
    });

    it("does not rewrite unchanged permission set entries", async () => {
      const customItem = permissionSetCacheItem({
        permissionSetId: CUSTOM_PERMISSION_SET_ID,
        name: "DeveloperAccess",
        description: "Developer permissions",
      });
      mockIdcService.listRegisteredPermissionSets.mockResolvedValue([
        {
          permissionSetArn: customItem.permissionSetArn,
          permissionSetId: customItem.permissionSetId,
          name: customItem.name,
          description: customItem.description,
        },
      ]);
      mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
        permissionSetCacheItem({
          permissionSetId: BUILT_IN_PERMISSION_SET_ID,
          name: "test_IsbUsersPS",
          description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
          sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
        }),
        customItem,
      ]);

      await handler({ source: "scheduled" }, testContext);

      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
    });

    it("keeps principal writes when permission set discovery fails", async () => {
      mockIdcService.listRegisteredPermissionSets.mockRejectedValue(
        new Error("IDC throttled"),
      );

      await expect(
        handler({ source: "scheduled" }, testContext),
      ).rejects.toThrow("IDC throttled");

      expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchPutPermissionSetCacheItems,
      ).not.toHaveBeenCalled();
      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });

    it("does not start permission set reconciliation when principal sync fails", async () => {
      mockIdcService.listAllIsbMemberIds.mockRejectedValue(
        new Error("Identity Store unavailable"),
      );

      await expect(
        handler({ source: "scheduled" }, testContext),
      ).rejects.toThrow("Identity Store unavailable");

      expect(
        mockIdcService.listRegisteredPermissionSets,
      ).not.toHaveBeenCalled();
    });

    it("does not delete stale entries when an upsert fails", async () => {
      mockIdcService.listRegisteredPermissionSets.mockResolvedValue([
        {
          permissionSetArn: permissionSetArn(CUSTOM_PERMISSION_SET_ID),
          permissionSetId: CUSTOM_PERMISSION_SET_ID,
          name: "DeveloperAccess",
        },
      ]);
      mockPrincipalStore.getPermissionSetCacheItems.mockResolvedValue([
        permissionSetCacheItem({
          permissionSetId: BUILT_IN_PERMISSION_SET_ID,
          name: "test_IsbUsersPS",
          description: BUILT_IN_PERMISSION_SET_DESCRIPTION,
          sessionDuration: BUILT_IN_PERMISSION_SET_SESSION_DURATION,
        }),
        permissionSetCacheItem({
          permissionSetId: STALE_PERMISSION_SET_ID,
          name: "StaleAccess",
        }),
      ]);
      mockPrincipalStore.batchPutPermissionSetCacheItems.mockRejectedValue(
        new Error("DynamoDB write failed"),
      );

      await expect(
        handler({ source: "scheduled" }, testContext),
      ).rejects.toThrow("DynamoDB write failed");

      expect(
        mockPrincipalStore.batchDeletePermissionSetCacheItemsBySk,
      ).not.toHaveBeenCalled();
    });
  });
});

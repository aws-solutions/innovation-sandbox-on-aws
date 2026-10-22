// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DescribeGroupCommand,
  DescribeUserCommand,
  GetGroupIdCommand,
  GetUserIdCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommand,
  ListGroupsCommand,
  ListUsersCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-identitystore";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  ListAccountAssignmentsCommand,
  PrincipalType,
  SSOAdminClient,
  TargetType,
} from "@aws-sdk/client-sso-admin";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { clearCache } from "@amzn/innovation-sandbox-commons/isb-services/idc-cache.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import type {
  IdcIdentity,
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const test_env = {
  IDC_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/isb_abc_idc_configuration",
  IDENTITY_STORE_ID: "d-111111111111",
  SSO_INSTANCE_ARN: "arn:aws:sso:::instance/ssoins-111111",
  USER_AGENT_EXTRA: "test-user-agent",
};

vi.mock("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js", () => {
  return {
    withTemporaryCredentials: vi.fn(
      () => (originalMethod: any) => originalMethod,
    ),
  };
});

describe("Idc service api", () => {
  const identityStoreMock = mockClient(IdentitystoreClient);
  const ssoAdminMock = mockClient(SSOAdminClient);
  const ssmClientMock = mockClient(SSMClient);
  const testPermissionSetArn =
    "arn:aws:sso:::permissionSet/ssoins-11111111/ps-11111111";
  const testGroupMembershipMetadata = {
    MembershipId: "test-membership-id",
    MembershipArn: "arn:aws:identitystore:::membership/test-membership-id",
  };
  const testUserMetadata = {
    UserArn: "arn:aws:identitystore:::user/test-user-id",
    Revision: "1",
  };
  const testGroupMetadata = {
    GroupArn: "arn:aws:identitystore:::group/test-group-id",
    Revision: "1",
  };

  const idcConfig = {
    identityStoreId: test_env.IDENTITY_STORE_ID,
    ssoInstanceArn: test_env.SSO_INSTANCE_ARN,
    userGroupId: "user-group-id",
    managerGroupId: "manager-group-id",
    adminGroupId: "admin-group-id",
    userPermissionSetArn: testPermissionSetArn,
    managerPermissionSetArn: testPermissionSetArn,
    adminPermissionSetArn: testPermissionSetArn,
    solutionVersion: "1.0.0",
    supportedSchemas: "1",
  };

  beforeEach(() => {
    identityStoreMock.reset();
    ssoAdminMock.reset();
    ssmClientMock.reset();
    clearCache();

    ssmClientMock.on(GetParameterCommand).resolves({
      Parameter: {
        Name: test_env.IDC_CONFIG_PARAM_ARN,
        Type: "String",
        Value: JSON.stringify(idcConfig),
      },
    });
  });

  const idcService = IsbServices.idcService(test_env);

  describe("users and assignment", async () => {
    const testIdcUser = {
      UserId: "TestUser",
      DisplayName: "Test User",
      UserName: "testuser",
      Emails: [
        {
          Value: "testuser@example.com",
          Primary: true,
        },
        {
          Value: "testuser1@example.com",
          Primary: false,
        },
      ],
    };

    it.each<[role: IsbRole, noUserInGroup: boolean]>([
      ["User", false],
      ["Manager", false],
      ["Admin", false],
      ["User", true],
    ])("should list users for role", async (role, noUserInGroup) => {
      if (noUserInGroup) {
        identityStoreMock.on(ListGroupMembershipsCommand).resolves({
          GroupMemberships: [],
        });
      } else {
        identityStoreMock.on(ListGroupMembershipsCommand).resolves({
          GroupMemberships: [
            {
              ...testGroupMembershipMetadata,
              IdentityStoreId: test_env.IDENTITY_STORE_ID,
              MemberId: {
                UserId: testIdcUser.UserId,
              },
            },
          ],
        });
      }

      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);

      const users: IsbUser[] = [];
      switch (role) {
        case "Admin":
          users.push(...(await idcService.listIsbAdmins()).result);
          break;
        case "Manager":
          users.push(...(await idcService.listIsbManagers()).result);
          break;
        case "User":
          users.push(...(await idcService.listIsbUsers()).result);
          break;
      }
      if (noUserInGroup) {
        expect(users.length).toBe(0);
      } else {
        expect(users.length).toBe(1);
        expect(users[0]).toMatchObject({
          userId: testIdcUser.UserId,
          displayName: testIdcUser.DisplayName,
          userName: testIdcUser.UserName,
          email: testIdcUser.Emails[0]!.Value,
        });
      }
    });

    it("should get list of users with pagination", async () => {
      const nextTextToken = "TestToken";

      identityStoreMock.on(ListGroupMembershipsCommand).resolves({
        GroupMemberships: [
          {
            ...testGroupMembershipMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            MemberId: {
              UserId: testIdcUser.UserId,
            },
          },
        ],
        NextToken: nextTextToken,
      });

      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);

      const response = await idcService.listIsbUsers({ pageSize: 2 });
      const users = response.result;
      expect(users.length).toBe(1);
      expect(users[0]).toMatchObject({
        userId: testIdcUser.UserId,
        displayName: testIdcUser.DisplayName,
        userName: testIdcUser.UserName,
        email: testIdcUser.Emails[0]!.Value,
      });
      expect(response.nextPageIdentifier).toEqual(nextTextToken);
    });

    it("should get user from email when all roles are assigned", async () => {
      const testEmail = "user@example.com";

      identityStoreMock.on(GetUserIdCommand).resolves({
        UserId: testIdcUser.UserId,
      });
      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          {
            ...testGroupMembershipMetadata,
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            ...testGroupMembershipMetadata,
            GroupId: idcConfig.managerGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            ...testGroupMembershipMetadata,
            GroupId: idcConfig.adminGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromEmail(testEmail);
      expect(user).toEqual({
        type: "user",
        userId: testIdcUser.UserId,
        displayName: testIdcUser.DisplayName,
        userName: testIdcUser.UserName,
        email: testIdcUser.Emails[0]!.Value,
        roles: ["User", "Manager", "Admin"],
      });
    });

    it("should get user from email with some roles assigned", async () => {
      const testEmail = "user@example.com";

      identityStoreMock.on(GetUserIdCommand).resolves({
        UserId: testIdcUser.UserId,
      });
      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          {
            ...testGroupMembershipMetadata,
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromEmail(testEmail);
      expect(user).toEqual({
        type: "user",
        userId: testIdcUser.UserId,
        displayName: testIdcUser.DisplayName,
        userName: testIdcUser.UserName,
        email: testIdcUser.Emails[0]!.Value,
        roles: ["User"],
      });
    });

    it("should return an undefined when the user isn't in any of the ISB groups", async () => {
      const testEmail = "user@example.com";

      identityStoreMock.on(GetUserIdCommand).resolves({
        UserId: testIdcUser.UserId,
      });
      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          {
            ...testGroupMembershipMetadata,
            GroupId: "not-isb-group",
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      expect(await idcService.getUserFromEmail(testEmail)).toEqual(undefined);
    });

    it("should get user from user name", async () => {
      const userName = "userName1";

      identityStoreMock.on(GetUserIdCommand).resolves({
        UserId: testIdcUser.UserId,
      });
      identityStoreMock.on(DescribeUserCommand).resolves(testIdcUser);
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          {
            ...testGroupMembershipMetadata,
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromUsername(userName);
      expect(user).toEqual({
        type: "user",
        userId: testIdcUser.UserId,
        displayName: testIdcUser.DisplayName,
        userName: testIdcUser.UserName,
        email: testIdcUser.Emails[0]!.Value,
        roles: ["User"],
      });
    });
  });

  describe("Account assignment and removal", async () => {
    const testUser: IdcIdentity = {
      type: "user",
      userId: "User1",
      email: "testuser@example.com",
      roles: ["User", "Manager"],
    };
    const testAccountId = "111111111111";
    const testPermissionSetArn =
      "arn:aws:sso:::permissionSet/ssoins-11111111/ps-11111111";

    it("should assign an account to a user", async () => {
      ssoAdminMock.on(CreateAccountAssignmentCommand).resolves({});

      await idcService
        .transactionalGrantUserAccess(testAccountId, testUser)
        .complete();

      const commandCalls = ssoAdminMock.commandCalls(
        CreateAccountAssignmentCommand,
      );
      expect(commandCalls.length).toBe(1);
      const hasMatchingCall = commandCalls.every((call) =>
        expect(call.args[0].input).toEqual({
          InstanceArn: test_env.SSO_INSTANCE_ARN,
          PermissionSetArn: testPermissionSetArn,
          PrincipalId: testUser.userId,
          PrincipalType: "USER",
          TargetId: testAccountId,
          TargetType: TargetType.AWS_ACCOUNT,
        }),
      );
      expect(hasMatchingCall).toBeTruthy();
    });

    it("should throw an error if the api fails", async () => {
      ssoAdminMock
        .on(CreateAccountAssignmentCommand)
        .rejects(new Error("Unexpected Error"));
      await expect(
        idcService
          .transactionalGrantUserAccess(testAccountId, testUser)
          .complete(),
      ).rejects.toThrow("Transaction Failed: Error: Unexpected Error");
    });

    it("should delete account assignment for a user", async () => {
      ssoAdminMock.on(DeleteAccountAssignmentCommand).resolves({});

      ssoAdminMock.on(ListAccountAssignmentsCommand).resolves({
        AccountAssignments: [
          {
            AccountId: testAccountId,
            PermissionSetArn: testPermissionSetArn,
            PrincipalId: testUser.userId,
            PrincipalType: PrincipalType.USER,
          },
        ],
      });

      await idcService.revokeAllUserAccess(testAccountId);

      const commandCalls = ssoAdminMock.commandCalls(
        DeleteAccountAssignmentCommand,
      );
      expect(commandCalls.length).toBe(1);
      const hasMatchingCall = commandCalls.every((call) =>
        expect(call.args[0].input).toEqual({
          InstanceArn: test_env.SSO_INSTANCE_ARN,
          PermissionSetArn: testPermissionSetArn,
          PrincipalId: testUser.userId,
          PrincipalType: "USER",
          TargetId: testAccountId,
          TargetType: TargetType.AWS_ACCOUNT,
        }),
      );
      expect(hasMatchingCall).toBeTruthy();
    });

    it("should revoke access to all users with ISB User PS", async () => {
      ssoAdminMock.on(DeleteAccountAssignmentCommand).resolves({});
      ssoAdminMock.on(ListAccountAssignmentsCommand).resolves({
        AccountAssignments: [
          {
            AccountId: testAccountId,
            PermissionSetArn: testPermissionSetArn,
            PrincipalId: testUser.userId,
            PrincipalType: PrincipalType.USER,
          },
          {
            AccountId: testAccountId,
            PermissionSetArn: testPermissionSetArn,
            PrincipalId: testUser.userId,
            PrincipalType: PrincipalType.USER,
          },
          {
            AccountId: testAccountId,
            PermissionSetArn: testPermissionSetArn,
            PrincipalId: testUser.userId,
            PrincipalType: PrincipalType.GROUP, //won't be removed because a group, not a user
          },
          {
            AccountId: testAccountId,
            PermissionSetArn: testPermissionSetArn + "SomethingElse", //won't be removed as it is another PS
            PrincipalId: testUser.userId,
            PrincipalType: PrincipalType.GROUP,
          },
        ],
      });

      await idcService.revokeAllUserAccess(testAccountId);

      const commandCalls = ssoAdminMock.commandCalls(
        DeleteAccountAssignmentCommand,
      );
      expect(commandCalls.length).toBe(2);
      const hasMatchingCall = commandCalls.every((call) =>
        expect(call.args[0].input).toEqual({
          InstanceArn: test_env.SSO_INSTANCE_ARN,
          PermissionSetArn: testPermissionSetArn,
          PrincipalId: testUser.userId,
          PrincipalType: "USER",
          TargetId: testAccountId,
          TargetType: TargetType.AWS_ACCOUNT,
        }),
      );
      expect(hasMatchingCall).toBeTruthy();
    });
  });

  describe("listAllUsers", () => {
    it("should return users with displayName and email", async () => {
      identityStoreMock.on(ListUsersCommand).resolves({
        Users: [
          {
            ...testUserMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            UserId: "user-1",
            UserName: "alice",
            DisplayName: "Alice Smith",
            Emails: [{ Value: "alice@example.com", Primary: true }],
          },
        ],
      });

      const result = await idcService.listAllUsers();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        principalId: "user-1",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
    });

    it("should exhaust pagination", async () => {
      identityStoreMock
        .on(ListUsersCommand)
        .resolvesOnce({
          Users: [
            {
              ...testUserMetadata,
              IdentityStoreId: test_env.IDENTITY_STORE_ID,
              UserId: "user-1",
              DisplayName: "User One",
              Emails: [{ Value: "one@example.com", Primary: true }],
            },
          ],
          NextToken: "page-2",
        })
        .resolvesOnce({
          Users: [
            {
              ...testUserMetadata,
              IdentityStoreId: test_env.IDENTITY_STORE_ID,
              UserId: "user-2",
              DisplayName: "User Two",
              Emails: [{ Value: "two@example.com", Primary: true }],
            },
          ],
        });

      const result = await idcService.listAllUsers();

      expect(result).toHaveLength(2);
      expect(result[0]!.displayName).toBe("User One");
      expect(result[1]!.displayName).toBe("User Two");
    });

    it("should omit email when user has no primary email", async () => {
      identityStoreMock.on(ListUsersCommand).resolves({
        Users: [
          {
            ...testUserMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            UserId: "user-1",
            DisplayName: "No Email",
            Emails: [],
          },
        ],
      });

      const result = await idcService.listAllUsers();

      expect(result[0]!.email).toBeUndefined();
    });

    it("should fall back to UserName when DisplayName is missing", async () => {
      identityStoreMock.on(ListUsersCommand).resolves({
        Users: [
          {
            ...testUserMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            UserId: "user-1",
            UserName: "jdoe",
            DisplayName: undefined,
            Emails: [],
          },
        ],
      });

      const result = await idcService.listAllUsers();

      expect(result[0]!.displayName).toBe("jdoe");
    });

    it("should skip users without UserId", async () => {
      identityStoreMock.on(ListUsersCommand).resolves({
        Users: [
          {
            ...testUserMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            UserId: "valid",
            DisplayName: "Valid",
            Emails: [],
          },
          {
            ...testUserMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            UserId: undefined,
            DisplayName: "Ghost",
            Emails: [],
          },
        ],
      });

      const result = await idcService.listAllUsers();

      expect(result).toHaveLength(1);
      expect(result[0]!.principalId).toBe("valid");
    });

    it("should return empty array when no users exist", async () => {
      identityStoreMock.on(ListUsersCommand).resolves({ Users: [] });

      const result = await idcService.listAllUsers();

      expect(result).toHaveLength(0);
    });

    it("should propagate errors", async () => {
      identityStoreMock
        .on(ListUsersCommand)
        .rejects(new Error("ThrottlingException: Rate exceeded"));

      await expect(idcService.listAllUsers()).rejects.toThrow(
        "ThrottlingException: Rate exceeded",
      );
    });
  });

  describe("listAllGroups", () => {
    it("should return groups with displayName", async () => {
      identityStoreMock.on(ListGroupsCommand).resolves({
        Groups: [
          {
            ...testGroupMetadata,
            GroupId: "group-1",
            DisplayName: "Engineering",
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });

      const result = await idcService.listAllGroups();

      expect(result).toHaveLength(1);
      expect(result[0]).toEqual({
        principalId: "group-1",
        principalType: "GROUP",
        displayName: "Engineering",
      });
    });

    it("should exhaust pagination", async () => {
      identityStoreMock
        .on(ListGroupsCommand)
        .resolvesOnce({
          Groups: [
            {
              ...testGroupMetadata,
              GroupId: "group-1",
              DisplayName: "Group One",
              IdentityStoreId: test_env.IDENTITY_STORE_ID,
            },
          ],
          NextToken: "page-2",
        })
        .resolvesOnce({
          Groups: [
            {
              ...testGroupMetadata,
              GroupId: "group-2",
              DisplayName: "Group Two",
              IdentityStoreId: test_env.IDENTITY_STORE_ID,
            },
          ],
        });

      const result = await idcService.listAllGroups();

      expect(result).toHaveLength(2);
      expect(result[0]!.displayName).toBe("Group One");
      expect(result[1]!.displayName).toBe("Group Two");
    });

    it("should skip groups without GroupId or DisplayName", async () => {
      identityStoreMock.on(ListGroupsCommand).resolves({
        Groups: [
          {
            ...testGroupMetadata,
            GroupId: "valid",
            DisplayName: "Valid",
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            ...testGroupMetadata,
            GroupId: undefined,
            DisplayName: "No ID",
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            ...testGroupMetadata,
            GroupId: "no-name",
            DisplayName: undefined,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });

      const result = await idcService.listAllGroups();

      expect(result).toHaveLength(1);
      expect(result[0]!.principalId).toBe("valid");
    });

    it("should return empty array when no groups exist", async () => {
      identityStoreMock.on(ListGroupsCommand).resolves({ Groups: [] });

      const result = await idcService.listAllGroups();

      expect(result).toHaveLength(0);
    });

    it("should propagate errors", async () => {
      identityStoreMock
        .on(ListGroupsCommand)
        .rejects(new Error("ServiceException: Internal error"));

      await expect(idcService.listAllGroups()).rejects.toThrow(
        "ServiceException: Internal error",
      );
    });
  });

  function createGroupMembership(userId?: string) {
    return {
      ...testGroupMembershipMetadata,
      IdentityStoreId: test_env.IDENTITY_STORE_ID,
      MemberId: userId ? { UserId: userId } : undefined,
    };
  }

  describe("listGroupMemberIds", () => {
    it("should return member user IDs from a single page", async () => {
      identityStoreMock.on(ListGroupMembershipsCommand).resolves({
        GroupMemberships: [
          createGroupMembership("user-1"),
          createGroupMembership("user-2"),
        ],
        NextToken: undefined,
      });

      const result = await idcService.listGroupMemberIds("test-group-id");
      expect(result).toEqual(new Set(["user-1", "user-2"]));
    });

    it("should exhaust pagination across multiple pages", async () => {
      identityStoreMock
        .on(ListGroupMembershipsCommand)
        .resolvesOnce({
          GroupMemberships: [createGroupMembership("user-1")],
          NextToken: "page2",
        })
        .resolvesOnce({
          GroupMemberships: [createGroupMembership("user-2")],
          NextToken: undefined,
        });

      const result = await idcService.listGroupMemberIds("test-group-id");
      expect(result).toEqual(new Set(["user-1", "user-2"]));
    });

    it("should handle empty group (no memberships)", async () => {
      identityStoreMock.on(ListGroupMembershipsCommand).resolves({
        GroupMemberships: [],
        NextToken: undefined,
      });

      const result = await idcService.listGroupMemberIds("empty-group");
      expect(result).toEqual(new Set());
    });

    it("should skip memberships without UserId", async () => {
      identityStoreMock.on(ListGroupMembershipsCommand).resolves({
        GroupMemberships: [
          createGroupMembership("user-1"),
          createGroupMembership(undefined),
          createGroupMembership("user-3"),
        ],
        NextToken: undefined,
      });

      const result = await idcService.listGroupMemberIds("test-group-id");
      expect(result).toEqual(new Set(["user-1", "user-3"]));
    });
  });

  describe("listAllIsbMemberIds", () => {
    it("should return union of all ISB group member IDs", async () => {
      identityStoreMock
        .on(ListGroupMembershipsCommand, { GroupId: "user-group-id" })
        .resolves({
          GroupMemberships: [
            createGroupMembership("user-1"),
            createGroupMembership("user-2"),
          ],
        })
        .on(ListGroupMembershipsCommand, { GroupId: "manager-group-id" })
        .resolves({
          GroupMemberships: [
            createGroupMembership("user-2"),
            createGroupMembership("user-3"),
          ],
        })
        .on(ListGroupMembershipsCommand, { GroupId: "admin-group-id" })
        .resolves({
          GroupMemberships: [createGroupMembership("user-4")],
        });

      const result = await idcService.listAllIsbMemberIds();
      expect(result).toEqual(new Set(["user-1", "user-2", "user-3", "user-4"]));
    });

    it("should deduplicate users across groups", async () => {
      identityStoreMock.on(ListGroupMembershipsCommand).resolves({
        GroupMemberships: [createGroupMembership("same-user")],
      });

      const result = await idcService.listAllIsbMemberIds();
      expect(result.size).toBe(1);
      expect(result.has("same-user")).toBe(true);
    });
  });

  describe("listGroupsForUser", () => {
    function createMockGroupMembership(groupId: string, userId: string) {
      return {
        ...testGroupMembershipMetadata,
        IdentityStoreId: test_env.IDENTITY_STORE_ID,
        GroupId: groupId,
        MemberId: { UserId: userId },
        MembershipId: `${groupId}-${userId}`,
      };
    }

    it("returns all group memberships for a user from a single page", async () => {
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          createMockGroupMembership("group-1", "user-x"),
          createMockGroupMembership("group-2", "user-x"),
        ],
        NextToken: undefined,
      });

      const result = await idcService.listGroupsForUser("user-x");
      expect(result.map((m) => m.GroupId)).toEqual(["group-1", "group-2"]);
    });

    it("exhausts pagination across multiple pages", async () => {
      identityStoreMock
        .on(ListGroupMembershipsForMemberCommand)
        .resolvesOnce({
          GroupMemberships: [createMockGroupMembership("group-1", "user-x")],
          NextToken: "page2",
        })
        .resolvesOnce({
          GroupMemberships: [createMockGroupMembership("group-2", "user-x")],
          NextToken: undefined,
        });

      const result = await idcService.listGroupsForUser("user-x");
      expect(result.map((m) => m.GroupId)).toEqual(["group-1", "group-2"]);
    });

    it("returns empty array when user belongs to no groups", async () => {
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [],
        NextToken: undefined,
      });

      const result = await idcService.listGroupsForUser("user-x");
      expect(result).toEqual([]);
    });

    it("skips memberships without GroupId", async () => {
      identityStoreMock.on(ListGroupMembershipsForMemberCommand).resolves({
        GroupMemberships: [
          createMockGroupMembership("group-1", "user-x"),
          {
            ...testGroupMembershipMetadata,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
            MemberId: { UserId: "user-x" },
            MembershipId: "no-group-id",
          },
          createMockGroupMembership("group-3", "user-x"),
        ],
        NextToken: undefined,
      });

      const result = await idcService.listGroupsForUser("user-x");
      expect(result.map((m) => m.GroupId)).toEqual(["group-1", "group-3"]);
    });
  });

  describe("getCachedPrincipalByAttr", () => {
    const mockPrincipalStore = {
      getCacheItems: vi.fn(),
      batchPutCacheItems: vi.fn(),
      batchGetCacheItems: vi.fn(),
    } as any;

    const mockLogger = { warn: vi.fn(), debug: vi.fn() } as any;

    beforeEach(() => {
      mockPrincipalStore.getCacheItems.mockReset();
      mockPrincipalStore.batchPutCacheItems.mockReset();
      mockPrincipalStore.batchGetCacheItems.mockReset();
      mockPrincipalStore.getCacheItems.mockResolvedValue([]);
      mockPrincipalStore.batchPutCacheItems.mockResolvedValue(undefined);
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([]);
      mockLogger.warn.mockReset();
    });

    it("returns cache hit when user email matches", async () => {
      const cachedItem = {
        pk: "principalCache",
        sk: "user#user-123",
        principalId: "user-123",
        principalType: "USER" as const,
        displayName: "Alice Smith",
        email: "alice@example.com",
        syncedAt: "2024-01-01T00:00:00.000Z",
        ttl: 9999999999,
      };
      mockPrincipalStore.getCacheItems.mockResolvedValue([cachedItem]);

      const result = await idcService.getCachedPrincipalByAttr(
        "USER",
        "alice@example.com",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
      // Should not call IDC on cache hit
      expect(identityStoreMock.commandCalls(GetUserIdCommand)).toHaveLength(0);
    });

    it("resolves a user by email via GetUserId + DescribeUser on cache miss", async () => {
      identityStoreMock.on(GetUserIdCommand).resolves({ UserId: "user-123" });
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-123",
        DisplayName: "Alice Smith",
        UserName: "alice",
        Emails: [{ Value: "alice@example.com", Primary: true }],
      });

      const result = await idcService.getCachedPrincipalByAttr(
        "USER",
        "alice@example.com",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
    });

    it("performs write-through on IDC resolution success", async () => {
      identityStoreMock.on(GetUserIdCommand).resolves({ UserId: "user-123" });
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-123",
        DisplayName: "Alice Smith",
        UserName: "alice",
        Emails: [{ Value: "alice@example.com", Primary: true }],
      });

      await idcService.getCachedPrincipalByAttr(
        "USER",
        "alice@example.com",
        mockPrincipalStore,
        mockLogger,
      );

      expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledTimes(1);
      const writtenItems =
        mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
      expect(writtenItems[0]).toMatchObject({
        pk: "principalCache",
        sk: "user#user-123",
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
      expect(writtenItems[0].syncedAt).toBeDefined();
      expect(writtenItems[0].ttl).toBeGreaterThan(0);
    });

    it("returns undefined when user is not found in IDC", async () => {
      identityStoreMock.on(GetUserIdCommand).rejects(
        new ResourceNotFoundException({
          message: "User not found",
          $metadata: {},
          ResourceType: "USER",
          RequestId: "req-1",
        }),
      );

      const result = await idcService.getCachedPrincipalByAttr(
        "USER",
        "nobody@example.com",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it("resolves a group by displayName via GetGroupId on cache miss", async () => {
      identityStoreMock
        .on(GetGroupIdCommand)
        .resolves({ GroupId: "group-456" });

      const result = await idcService.getCachedPrincipalByAttr(
        "GROUP",
        "Engineering",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "group-456",
        principalType: "GROUP",
        displayName: "Engineering",
      });
    });

    it("returns undefined when group is not found in IDC", async () => {
      identityStoreMock.on(GetGroupIdCommand).rejects(
        new ResourceNotFoundException({
          message: "Group not found",
          $metadata: {},
          ResourceType: "GROUP",
          RequestId: "req-2",
        }),
      );

      const result = await idcService.getCachedPrincipalByAttr(
        "GROUP",
        "NonexistentGroup",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it("propagates non-ResourceNotFoundException errors", async () => {
      identityStoreMock.on(GetUserIdCommand).rejects(new Error("Throttling"));

      await expect(
        idcService.getCachedPrincipalByAttr(
          "USER",
          "alice@example.com",
          mockPrincipalStore,
          mockLogger,
        ),
      ).rejects.toThrow("Throttling");
    });

    it("swallows cache write failures (best-effort)", async () => {
      identityStoreMock.on(GetUserIdCommand).resolves({ UserId: "user-999" });
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-999",
        DisplayName: "Fail Write User",
        Emails: [{ Value: "fail@example.com", Primary: true }],
      });
      mockPrincipalStore.batchPutCacheItems.mockRejectedValue(
        new Error("DynamoDB throttling"),
      );

      const result = await idcService.getCachedPrincipalByAttr(
        "USER",
        "fail@example.com",
        mockPrincipalStore,
        mockLogger,
      );

      // Should still return the resolved principal
      expect(result).toEqual({
        principalId: "user-999",
        principalType: "USER",
        displayName: "Fail Write User",
        email: "fail@example.com",
      });
    });
  });

  describe("getCachedPrincipalById", () => {
    const mockPrincipalStore = {
      getCacheItems: vi.fn(),
      batchPutCacheItems: vi.fn(),
      batchGetCacheItems: vi.fn(),
    } as any;

    const mockLogger = { warn: vi.fn(), debug: vi.fn() } as any;

    beforeEach(() => {
      mockPrincipalStore.getCacheItems.mockReset();
      mockPrincipalStore.batchPutCacheItems.mockReset();
      mockPrincipalStore.batchGetCacheItems.mockReset();
      mockPrincipalStore.batchPutCacheItems.mockResolvedValue(undefined);
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([]);
      mockLogger.warn.mockReset();
    });

    it("returns cache hit for USER when batchGetCacheItems finds the principal", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        {
          pk: "principalCache",
          sk: "user#user-123",
          principalId: "user-123",
          principalType: "USER" as const,
          displayName: "Alice Smith",
          email: "alice@example.com",
          syncedAt: "2024-01-01T00:00:00.000Z",
          ttl: 9999999999,
        },
      ]);

      const result = await idcService.getCachedPrincipalById(
        "USER",
        "user-123",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
      // Should not call IDC on cache hit
      expect(identityStoreMock.commandCalls(DescribeUserCommand)).toHaveLength(
        0,
      );
    });

    it("returns cache hit for GROUP when batchGetCacheItems finds the principal", async () => {
      mockPrincipalStore.batchGetCacheItems.mockResolvedValue([
        {
          pk: "principalCache",
          sk: "group#group-456",
          principalId: "group-456",
          principalType: "GROUP" as const,
          displayName: "Engineering",
          syncedAt: "2024-01-01T00:00:00.000Z",
          ttl: 9999999999,
        },
      ]);

      const result = await idcService.getCachedPrincipalById(
        "GROUP",
        "group-456",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "group-456",
        principalType: "GROUP",
        displayName: "Engineering",
      });
      expect(identityStoreMock.commandCalls(DescribeGroupCommand)).toHaveLength(
        0,
      );
    });

    it("resolves USER via DescribeUser on cache miss", async () => {
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-123",
        DisplayName: "Alice Smith",
        UserName: "alice",
        Emails: [{ Value: "alice@example.com", Primary: true }],
      });

      const result = await idcService.getCachedPrincipalById(
        "USER",
        "user-123",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
    });

    it("resolves GROUP via DescribeGroup on cache miss", async () => {
      identityStoreMock.on(DescribeGroupCommand).resolves({
        GroupId: "group-456",
        DisplayName: "Engineering",
      });

      const result = await idcService.getCachedPrincipalById(
        "GROUP",
        "group-456",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "group-456",
        principalType: "GROUP",
        displayName: "Engineering",
      });
    });

    it("returns undefined when USER is not found (ResourceNotFoundException)", async () => {
      identityStoreMock.on(DescribeUserCommand).rejects(
        new ResourceNotFoundException({
          message: "User not found",
          $metadata: {},
          ResourceType: "USER",
          RequestId: "req-1",
        }),
      );

      const result = await idcService.getCachedPrincipalById(
        "USER",
        "nonexistent-user",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it("returns undefined when GROUP is not found (ResourceNotFoundException)", async () => {
      identityStoreMock.on(DescribeGroupCommand).rejects(
        new ResourceNotFoundException({
          message: "Group not found",
          $metadata: {},
          ResourceType: "GROUP",
          RequestId: "req-2",
        }),
      );

      const result = await idcService.getCachedPrincipalById(
        "GROUP",
        "nonexistent-group",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toBeUndefined();
    });

    it("propagates non-ResourceNotFoundException errors for USER", async () => {
      identityStoreMock
        .on(DescribeUserCommand)
        .rejects(new Error("Throttling"));

      await expect(
        idcService.getCachedPrincipalById(
          "USER",
          "user-123",
          mockPrincipalStore,
          mockLogger,
        ),
      ).rejects.toThrow("Throttling");
    });

    it("propagates non-ResourceNotFoundException errors for GROUP", async () => {
      identityStoreMock
        .on(DescribeGroupCommand)
        .rejects(new Error("Service unavailable"));

      await expect(
        idcService.getCachedPrincipalById(
          "GROUP",
          "group-456",
          mockPrincipalStore,
          mockLogger,
        ),
      ).rejects.toThrow("Service unavailable");
    });

    it("performs write-through with correct SK prefix for USER", async () => {
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-123",
        DisplayName: "Alice Smith",
        Emails: [{ Value: "alice@example.com", Primary: true }],
      });

      await idcService.getCachedPrincipalById(
        "USER",
        "user-123",
        mockPrincipalStore,
        mockLogger,
      );

      expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledTimes(1);
      const writtenItems =
        mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
      expect(writtenItems[0]).toMatchObject({
        pk: "principalCache",
        sk: "user#user-123",
        principalId: "user-123",
        principalType: "USER",
        displayName: "Alice Smith",
        email: "alice@example.com",
      });
      expect(writtenItems[0].syncedAt).toBeDefined();
      expect(writtenItems[0].ttl).toBeGreaterThan(0);
    });

    it("performs write-through with correct SK prefix for GROUP", async () => {
      identityStoreMock.on(DescribeGroupCommand).resolves({
        GroupId: "group-456",
        DisplayName: "Engineering",
      });

      await idcService.getCachedPrincipalById(
        "GROUP",
        "group-456",
        mockPrincipalStore,
        mockLogger,
      );

      expect(mockPrincipalStore.batchPutCacheItems).toHaveBeenCalledTimes(1);
      const writtenItems =
        mockPrincipalStore.batchPutCacheItems.mock.calls[0]![0];
      expect(writtenItems[0]).toMatchObject({
        pk: "principalCache",
        sk: "group#group-456",
        principalId: "group-456",
        principalType: "GROUP",
        displayName: "Engineering",
      });
      expect(writtenItems[0]).not.toHaveProperty("email");
      expect(writtenItems[0].syncedAt).toBeDefined();
      expect(writtenItems[0].ttl).toBeGreaterThan(0);
    });

    it("swallows cache write failures (best-effort)", async () => {
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-999",
        DisplayName: "Fail Write User",
        Emails: [{ Value: "fail@example.com", Primary: true }],
      });
      mockPrincipalStore.batchPutCacheItems.mockRejectedValue(
        new Error("DynamoDB throttling"),
      );

      const result = await idcService.getCachedPrincipalById(
        "USER",
        "user-999",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result).toEqual({
        principalId: "user-999",
        principalType: "USER",
        displayName: "Fail Write User",
        email: "fail@example.com",
      });
    });

    it("falls back to principalId when DisplayName and UserName are undefined", async () => {
      identityStoreMock.on(DescribeUserCommand).resolves({
        UserId: "user-123",
        DisplayName: undefined,
        UserName: undefined,
        Emails: [{ Value: "a@example.com", Primary: true }],
      });

      const result = await idcService.getCachedPrincipalById(
        "USER",
        "user-123",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result?.displayName).toBe("user-123");
    });

    it("falls back to principalId when GROUP DisplayName is undefined", async () => {
      identityStoreMock.on(DescribeGroupCommand).resolves({
        GroupId: "group-456",
        DisplayName: undefined,
      });

      const result = await idcService.getCachedPrincipalById(
        "GROUP",
        "group-456",
        mockPrincipalStore,
        mockLogger,
      );

      expect(result?.displayName).toBe("group-456");
    });
  });
});

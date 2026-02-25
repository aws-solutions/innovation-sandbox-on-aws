// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DescribeUserCommand,
  GetUserIdCommand,
  IdentitystoreClient,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommand,
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
import {
  IsbRole,
  IsbUser,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";

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
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            GroupId: idcConfig.managerGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
          {
            GroupId: idcConfig.adminGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromEmail(testEmail);
      expect(user).toEqual({
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
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromEmail(testEmail);
      expect(user).toEqual({
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
            GroupId: idcConfig.userGroupId,
            IdentityStoreId: test_env.IDENTITY_STORE_ID,
          },
        ],
      });
      const user = await idcService.getUserFromUsername(userName);
      expect(user).toEqual({
        userId: testIdcUser.UserId,
        displayName: testIdcUser.DisplayName,
        userName: testIdcUser.UserName,
        email: testIdcUser.Emails[0]!.Value,
        roles: ["User"],
      });
    });
  });

  describe("Account assignment and removal", async () => {
    const testUser: IsbUser = {
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
});

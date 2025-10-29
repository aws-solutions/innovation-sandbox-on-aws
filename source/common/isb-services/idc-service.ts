// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DescribeUserCommand,
  GetUserIdCommand,
  IdentitystoreClient,
  IdentitystorePaginationConfiguration,
  ListGroupMembershipsCommand,
  ListGroupMembershipsForMemberCommandInput,
  ResourceNotFoundException,
  User,
  paginateListGroupMembershipsForMember,
} from "@aws-sdk/client-identitystore";
import { GetParameterCommand, SSMClient } from "@aws-sdk/client-ssm";
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  ListAccountAssignmentsCommandInput,
  PrincipalType,
  SSOAdminClient,
  SSOAdminPaginationConfiguration,
  TargetType,
  paginateListAccountAssignments,
} from "@aws-sdk/client-sso-admin";

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  cacheAdmins,
  cacheManagers,
  cacheUsers,
  getCachedAdmins,
  getCachedManagers,
  getCachedUsers,
} from "@amzn/innovation-sandbox-commons/isb-services/idc-cache.js";
import {
  IsbRole,
  IsbUser,
  sharedIdcSsmParamName,
} from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { IdcConfig } from "@amzn/innovation-sandbox-shared-json-param-parser/src/shared-json-param-parser-handler.js";
import pThrottle from "p-throttle";

// IDC supports 20 TPS for all requests
// (https://docs.aws.amazon.com/singlesignon/latest/userguide/limits.html)
const throttle1PerSec = pThrottle({
  limit: 1,
  interval: 1000,
});

export class IdcService {
  readonly namespace;
  readonly identityStoreClient;
  readonly ssoAdminClient;
  readonly ssmClient;
  private idcConfig?: IdcConfig;
  public static defaultPageSize = 50;

  constructor(props: {
    namespace: string;
    identityStoreClient: IdentitystoreClient;
    ssoAdminClient: SSOAdminClient;
    ssmClient: SSMClient;
  }) {
    this.namespace = props.namespace;
    this.identityStoreClient = props.identityStoreClient;
    this.ssoAdminClient = props.ssoAdminClient;
    this.ssmClient = props.ssmClient;
  }

  private async getIdcConfig(): Promise<IdcConfig> {
    if (!this.idcConfig) {
      const command = new GetParameterCommand({
        Name: sharedIdcSsmParamName(this.namespace),
      });
      const response = await this.ssmClient.send(command);
      if (!response.Parameter?.Value) {
        throw new Error("IDC configuration not found in SSM parameter store");
      }
      this.idcConfig = JSON.parse(response.Parameter.Value) as IdcConfig;
    }
    return this.idcConfig;
  }

  private isbUserFromIdcUser(user: User, roles?: IsbRole[]): IsbUser {
    return {
      displayName: user.DisplayName,
      userName: user.UserName,
      userId: user.UserId,
      email: user.Emails?.filter((emailTuple) => emailTuple.Primary).map(
        (emailTuple) => emailTuple.Value,
      )[0]!,
      roles: roles,
    };
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbUsers(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = { pageSize: IdcService.defaultPageSize },
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedUsers = getCachedUsers(props.pageIdentifier ?? "FIRST_PAGE");
    if (cachedUsers) {
      return cachedUsers;
    }
    const config = await this.getIdcConfig();
    const users = await this.listGroupMembers({
      ...props,
      groupId: config.userGroupId,
    });
    cacheUsers(props.pageIdentifier ?? "FIRST_PAGE", users);
    return users;
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbManagers(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = { pageSize: IdcService.defaultPageSize },
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedManagers = getCachedManagers(
      props.pageIdentifier ?? "FIRST_PAGE",
    );
    if (cachedManagers) {
      return cachedManagers;
    }
    const config = await this.getIdcConfig();
    const managers = await this.listGroupMembers({
      ...props,
      groupId: config.managerGroupId,
    });
    cacheManagers(props.pageIdentifier ?? "FIRST_PAGE", managers);
    return managers;
  }

  /**
   * requires actions
   *  "identitystore:ListGroupMemberships",
   *  "identitystore:DescribeUser",
   */
  public async listIsbAdmins(
    props: {
      pageSize?: number;
      pageIdentifier?: string;
    } = { pageSize: IdcService.defaultPageSize },
  ): Promise<PaginatedQueryResult<IsbUser>> {
    const cachedAdmins = getCachedAdmins(props.pageIdentifier ?? "FIRST_PAGE");
    if (cachedAdmins) {
      return cachedAdmins;
    }
    const config = await this.getIdcConfig();
    const admins = await this.listGroupMembers({
      ...props,
      groupId: config.adminGroupId,
    });
    cacheAdmins(props.pageIdentifier ?? "FIRST_PAGE", admins);
    return admins;
  }

  private async listGroupMembers(props: {
    groupId: string;
    pageSize?: number;
    pageIdentifier?: string;
  }): Promise<PaginatedQueryResult<IsbUser>> {
    const config = await this.getIdcConfig();
    const command = new ListGroupMembershipsCommand({
      GroupId: props.groupId,
      IdentityStoreId: config.identityStoreId,
      MaxResults: props.pageSize,
      NextToken: props.pageIdentifier,
    });
    const response = await this.identityStoreClient.send(command);
    const users: IsbUser[] = [];
    const throttledDescribeUser = throttle1PerSec(
      async (descUserCommand: DescribeUserCommand) => {
        const user = await this.identityStoreClient.send(descUserCommand);
        return this.isbUserFromIdcUser(user);
      },
    );
    if (response.GroupMemberships) {
      for (const membership of response.GroupMemberships) {
        const descUserCommand = new DescribeUserCommand({
          IdentityStoreId: config.identityStoreId,
          UserId: membership.MemberId?.UserId,
        });
        const user = await throttledDescribeUser(descUserCommand);
        users.push(user);
      }
    }
    return {
      result: users,
      nextPageIdentifier: response.NextToken ?? null,
    };
  }

  /**
   * requires actions
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:ListGroupMembershipsForMember"
   */
  public async getUserFromEmail(email: string): Promise<IsbUser | undefined> {
    return this.getUserFromUniqueAttr("emails.value", email);
  }

  /**
   * requires actions
   *  "identitystore:GetUserId",
   *  "identitystore:DescribeUser",
   *  "identitystore:ListGroupMembershipsForMember"
   */
  public async getUserFromUsername(
    userName: string,
  ): Promise<IsbUser | undefined> {
    return this.getUserFromUniqueAttr("userName", userName);
  }

  private async getUserFromUniqueAttr(
    attr: "emails.value" | "userName",
    value: string,
  ): Promise<IsbUser | undefined> {
    const config = await this.getIdcConfig();
    const command = new GetUserIdCommand({
      IdentityStoreId: config.identityStoreId,
      AlternateIdentifier: {
        UniqueAttribute: {
          AttributePath: attr,
          AttributeValue: value,
        },
      },
    });

    try {
      const { UserId: userId } = await this.identityStoreClient.send(command);

      if (!userId) {
        return undefined;
      }

      const descUserCommand = new DescribeUserCommand({
        IdentityStoreId: config.identityStoreId,
        UserId: userId,
      });
      const user = await this.identityStoreClient.send(descUserCommand);
      const input: ListGroupMembershipsForMemberCommandInput = {
        IdentityStoreId: config.identityStoreId,
        MemberId: {
          UserId: userId,
        },
      };
      const paginatorConfig: IdentitystorePaginationConfiguration = {
        client: this.identityStoreClient,
      };
      const paginator = paginateListGroupMembershipsForMember(
        paginatorConfig,
        input,
      );
      const groupIdToRole: Record<string, IsbRole> = {
        [config.userGroupId]: "User",
        [config.managerGroupId]: "Manager",
        [config.adminGroupId]: "Admin",
      };
      const roles: IsbRole[] = [];
      for await (const { GroupMemberships } of paginator) {
        if (GroupMemberships) {
          for (const groupMembership of GroupMemberships) {
            const role = groupIdToRole[groupMembership.GroupId!];
            if (role) {
              roles.push(role);
            }
          }
        }
      }
      if (roles.length === 0) {
        // the user isn't an ISB user
        return undefined;
      }
      return this.isbUserFromIdcUser(user, roles);
    } catch (error) {
      if (error instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw error;
    }
  }

  private async grantUserAccess(accountId: string, isbUser: IsbUser) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const command = new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: userPS.PermissionSetArn,
      PrincipalId: isbUser.userId,
      PrincipalType: "USER",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:DeleteAccountAssignment",
   */
  private async revokeUserAccess(accountId: string, isbUser: IsbUser) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const command = new DeleteAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: userPS.PermissionSetArn,
      PrincipalId: isbUser.userId,
      PrincipalType: "USER",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment",
   */
  public transactionalGrantUserAccess(accountId: string, isbUser: IsbUser) {
    return new Transaction({
      beginTransaction: () => this.grantUserAccess(accountId, isbUser),
      rollbackTransaction: () => this.revokeUserAccess(accountId, isbUser),
    });
  }

  /**
   * removes access to all users which have the user Permission Set
   * requires actions
   *  sso:ListAccountAssignments,
   *  sso:DeleteAccountAssignment,
   */
  public async revokeAllUserAccess(accountId: string) {
    const config = await this.getIdcConfig();
    const userPS = { PermissionSetArn: config.userPermissionSetArn };
    const input: ListAccountAssignmentsCommandInput = {
      InstanceArn: config.ssoInstanceArn,
      AccountId: accountId,
      PermissionSetArn: userPS.PermissionSetArn,
    };
    const paginatorConfig: SSOAdminPaginationConfiguration = {
      client: this.ssoAdminClient,
    };
    const paginator = paginateListAccountAssignments(paginatorConfig, input);
    const throttledDeleteAccountAssignment = throttle1PerSec(
      async (command: DeleteAccountAssignmentCommand) => {
        await this.ssoAdminClient.send(command);
      },
    );
    for await (const page of paginator) {
      if (page.AccountAssignments) {
        for (const accountAssignment of page.AccountAssignments) {
          if (accountAssignment.PrincipalType !== PrincipalType.USER) {
            continue;
          }
          const command = new DeleteAccountAssignmentCommand({
            InstanceArn: config.ssoInstanceArn,
            PermissionSetArn: userPS.PermissionSetArn,
            PrincipalId: accountAssignment.PrincipalId,
            PrincipalType: accountAssignment.PrincipalType,
            TargetId: accountId,
            TargetType: TargetType.AWS_ACCOUNT,
          });
          await throttledDeleteAccountAssignment(command);
        }
      }
    }
  }

  private async getCorrespondingPSAndGroup(
    role: Exclude<IsbRole, "User">,
  ): Promise<{
    permissionSetArn: string;
    groupId: string;
  }> {
    const config = await this.getIdcConfig();
    return {
      permissionSetArn:
        role === "Admin"
          ? config.adminPermissionSetArn
          : config.managerPermissionSetArn,
      groupId: role === "Admin" ? config.adminGroupId : config.managerGroupId,
    };
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   */
  public async assignGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    const config = await this.getIdcConfig();
    const { groupId, permissionSetArn } =
      await this.getCorrespondingPSAndGroup(role);
    const command = new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: permissionSetArn,
      PrincipalId: groupId,
      PrincipalType: "GROUP",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:DeleteAccountAssignment",
   */
  public async revokeGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    const config = await this.getIdcConfig();
    const { groupId, permissionSetArn } =
      await this.getCorrespondingPSAndGroup(role);
    const command = new DeleteAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: permissionSetArn,
      PrincipalId: groupId,
      PrincipalType: "GROUP",
      TargetId: accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    });
    await this.ssoAdminClient.send(command);
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment"
   */
  public transactionalAssignGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    return new Transaction({
      beginTransaction: () => this.assignGroupAccess(accountId, role),
      rollbackTransaction: () => this.revokeGroupAccess(accountId, role),
    });
  }

  /**
   * requires actions
   *  "sso:CreateAccountAssignment",
   *  "sso:DeleteAccountAssignment"
   */
  public transactionalRevokeGroupAccess(
    accountId: string,
    role: Exclude<IsbRole, "User">,
  ) {
    return new Transaction({
      beginTransaction: () => this.revokeGroupAccess(accountId, role),
      rollbackTransaction: () => this.assignGroupAccess(accountId, role),
    });
  }
}

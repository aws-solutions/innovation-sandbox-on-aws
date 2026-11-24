// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  OptionalItem,
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import type { PersistedPermissionSetCacheItem } from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import type {
  PersistedAssignment,
  PersistedGroupAssignment,
  PersistedGroupMembershipCache,
  PersistedPrincipalCacheItem,
  PersistedUserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

export interface DeleteAssignmentProps {
  principalId: string;
  principalType: PrincipalType;
  sk: string;
  expectedLastEditTime?: string;
}

export interface DeleteAssignmentsByLeasePrincipalProps {
  principalId: string;
  principalType: PrincipalType;
  leaseId: string;
  permissionSetArn?: string;
  builtInPermissionSetArn?: string;
}

export abstract class PrincipalStore {
  abstract createUserAssignment(
    assignment: PersistedUserAssignment,
  ): Promise<PersistedUserAssignment>;

  abstract createGroupAssignment(
    assignment: PersistedGroupAssignment,
  ): Promise<PersistedGroupAssignment>;

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link findAssignment} or {@link getAssignmentsForPrincipalAndLease}.
   */
  abstract getUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedUserAssignment>>;

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link findAssignment} or {@link getAssignmentsForPrincipalAndLease}.
   */
  abstract getGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedGroupAssignment>>;

  abstract getAssignmentsForPrincipalAndLease(props: {
    principalId: string;
    principalType: PrincipalType;
    leaseId: string;
  }): Promise<PersistedAssignment[]>;

  abstract findAssignment(props: {
    principalId: string;
    principalType: PrincipalType;
    leaseId: string;
    permissionSetArn?: string;
    builtInPermissionSetArn?: string;
  }): Promise<PersistedAssignment | undefined>;

  abstract deleteAssignment(props: DeleteAssignmentProps): Promise<boolean>;

  abstract deleteAssignmentsByLeasePrincipal(
    props: DeleteAssignmentsByLeasePrincipalProps,
  ): Promise<number>;

  abstract getAssignmentsForLease(props: {
    leaseId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>>;

  abstract getDirectAssignmentsForUser(props: {
    userId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedUserAssignment>>;

  abstract getGroupMembershipCache(
    userId: string,
  ): Promise<SingleItemResult<PersistedGroupMembershipCache>>;

  abstract putGroupMembershipCache(
    cache: PersistedGroupMembershipCache,
  ): Promise<void>;

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link deleteAssignmentsByLeasePrincipal}; omit `permissionSetArn` to delete every
   * assignment for the principal and lease.
   */
  abstract deleteUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link deleteAssignmentsByLeasePrincipal}; omit `permissionSetArn` to delete every
   * assignment for the principal and lease.
   */
  abstract deleteGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<OptionalItem>;

  abstract batchPutAssignments(
    assignments: PersistedAssignment[],
  ): Promise<void>;

  abstract getAllGroupAssignmentKeys(): Promise<
    { groupId: string; leaseId: string; sk: string }[]
  >;

  abstract batchGetGroupAssignments(
    keys: { groupId: string; sk: string }[],
  ): Promise<PersistedGroupAssignment[]>;

  abstract batchPutCacheItems(
    items: PersistedPrincipalCacheItem[],
  ): Promise<void>;

  abstract getCacheItems(props: {
    type?: PrincipalType;
  }): Promise<PersistedPrincipalCacheItem[]>;

  abstract batchGetCacheItems(
    keys: { principalId: string; principalType: PrincipalType }[],
  ): Promise<PersistedPrincipalCacheItem[]>;

  abstract batchDeleteCacheItemsBySk(sks: string[]): Promise<void>;

  abstract batchPutPermissionSetCacheItems(
    items: PersistedPermissionSetCacheItem[],
  ): Promise<void>;

  abstract getPermissionSetCacheItem(
    permissionSetId: string,
  ): Promise<PersistedPermissionSetCacheItem | undefined>;

  abstract getPermissionSetCacheItems(props?: {
    consistentRead?: boolean;
  }): Promise<PersistedPermissionSetCacheItem[]>;

  abstract batchDeletePermissionSetCacheItemsBySk(sks: string[]): Promise<void>;

  abstract listAllAssignments(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>>;
}

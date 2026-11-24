// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UUID_PATTERN } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { PERMISSION_SET_ID_PATTERN } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

/**
 * DynamoDB Key Constants and Helper Functions for Principal Table
 *
 * The Principal table uses a 3-item-type single-table design:
 *
 * Item Type 1: User Assignment
 *   - PK: "user#{userId}"
 *   - SK: "lease#{leaseId}" (legacy) or
 *         "lease#{leaseId}#ps#{permissionSetId}"
 *
 * Item Type 2: Group Assignment
 *   - PK: "group#{groupId}"
 *   - SK: "lease#{leaseId}" (legacy) or
 *         "lease#{leaseId}#ps#{permissionSetId}"
 *
 * Item Type 3: Group Membership Cache
 *   - PK: "user#{userId}"
 *   - SK: "groupMembership"
 */

export const USER_PK_PREFIX = "user#";
export const GROUP_PK_PREFIX = "group#";
export const LEASE_SK_PREFIX = "lease#";
export const PERMISSION_SET_SK_INFIX = "#ps#";
export const GROUP_MEMBERSHIP_SK = "groupMembership" as const;

export const ASSIGNMENT_SK_PATTERN = new RegExp(
  `^${LEASE_SK_PREFIX}(${UUID_PATTERN})(?:${PERMISSION_SET_SK_INFIX}(${PERMISSION_SET_ID_PATTERN}))?$`,
);

export function userPk(userId: string): string {
  return `${USER_PK_PREFIX}${userId}`;
}

export function groupPk(groupId: string): string {
  return `${GROUP_PK_PREFIX}${groupId}`;
}

export function principalPk(props: {
  principalId: string;
  principalType: "USER" | "GROUP";
}): string {
  return props.principalType === "USER"
    ? userPk(props.principalId)
    : groupPk(props.principalId);
}

/**
 * Returns the legacy assignment sort key and the prefix shared by all
 * permission-set-specific assignment records for the lease.
 */
export function leaseSk(leaseId: string): string {
  return `${LEASE_SK_PREFIX}${leaseId}`;
}

export function assignmentSk(
  leaseId: string,
  permissionSetId?: string,
): string {
  return permissionSetId === undefined || permissionSetId === ""
    ? leaseSk(leaseId)
    : `${leaseSk(leaseId)}${PERMISSION_SET_SK_INFIX}${permissionSetId}`;
}

export function parseAssignmentSk(
  sk: string,
): { leaseId: string; permissionSetId?: string } | undefined {
  const match = ASSIGNMENT_SK_PATTERN.exec(sk);
  if (!match) {
    return undefined;
  }

  const leaseId = match[1];
  if (leaseId === undefined) {
    return undefined;
  }

  const permissionSetId = match[2];
  return permissionSetId === undefined
    ? { leaseId }
    : { leaseId, permissionSetId };
}

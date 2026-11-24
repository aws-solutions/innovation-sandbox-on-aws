// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { DesiredAssignment } from "../types/lease.js";
import { getUserEmail, isIdcUser, type IsbUser } from "./auth-utils.js";

/**
 * True if the user owns the lease or is a direct `USER` assignee. Group
 * assignees and Admin/Manager access are the caller's to decide.
 */
export function isLeaseOwnerOrDirectAssignee(
  user: IsbUser,
  lease: {
    userEmail: string;
    desiredAssignments?: readonly DesiredAssignment[];
  },
): boolean {
  if (getUserEmail(user) === lease.userEmail) {
    return true;
  }

  return (
    isIdcUser(user) &&
    !!lease.desiredAssignments?.some(
      (a) => a.principalType === "USER" && a.principalId === user.userId,
    )
  );
}

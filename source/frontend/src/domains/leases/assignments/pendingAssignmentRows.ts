// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { assignmentPrincipalKey } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type { AssignmentTablePrincipal } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";
import type { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-shared/types/lease.js";

export type PendingAssignmentTableAssignment = {
  rowId: string;
  row: DesiredAssignmentWithDisplay;
};

export type PendingAssignmentTablePrincipal =
  AssignmentTablePrincipal<PendingAssignmentTableAssignment>;

export const createPendingAssignmentRows = (
  assignments: readonly DesiredAssignmentWithDisplay[],
  ownerEmail: string | undefined,
): PendingAssignmentTablePrincipal[] => {
  const assignmentsByPrincipal = new Map<
    string,
    DesiredAssignmentWithDisplay
  >();
  for (const assignment of assignments) {
    const key = assignmentPrincipalKey(assignment);
    if (!assignmentsByPrincipal.has(key)) {
      assignmentsByPrincipal.set(key, assignment);
    }
  }

  return [...assignmentsByPrincipal.entries()].map(([key, assignment]) => {
    return {
      kind: "principal",
      rowId: `principal:${key}`,
      principalId: assignment.principalId,
      principalType: assignment.principalType,
      displayName:
        assignment.displayName ?? assignment.email ?? assignment.principalId,
      subtitle: assignment.email,
      isOwner:
        assignment.principalType === "USER" &&
        !!ownerEmail &&
        assignment.email?.toLowerCase() === ownerEmail.toLowerCase(),
      assignment: {
        rowId: `assignment:${key}`,
        row: assignment,
      },
      operations: [],
    };
  });
};

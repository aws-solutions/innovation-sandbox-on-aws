// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  assignmentPrincipalKey,
  assignmentTupleKey,
  permissionSetLabel,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type {
  AssignmentTableItem as SharedAssignmentTableItem,
  AssignmentTablePrincipal as SharedAssignmentTablePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";
import type {
  AssignmentSyncStatus,
  GetLeaseAssignmentsResponse,
  LeaseAssignmentView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import type { AssignmentPrincipalRef } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

export type AssignmentRowState = "current" | "added" | "removed" | "restored";

export type AssignmentRow = {
  rowId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  subtitle?: string;
  addedBy?: string;
  addedDate?: string;
  state: AssignmentRowState;
  isOwner: boolean;
  isDesired: boolean;
  syncStatus: AssignmentSyncStatus;
  permissionSet: PermissionSetReference;
  replacesRowId?: string;
  replacementRowId?: string;
};

export type AssignmentTableAssignment = {
  kind: "assignment";
  rowId: string;
  row: AssignmentRow;
  transitionFrom?: AssignmentRow;
};

export type AssignmentTableOperation = {
  kind: "operation";
  rowId: string;
  action: "grant" | "revoke";
  permissionSet: PermissionSetReference;
  syncStatus: AssignmentSyncStatus | "pending";
};

export type AssignmentTablePrincipal = SharedAssignmentTablePrincipal<
  AssignmentTableAssignment,
  AssignmentTableOperation
>;

export type AssignmentTableItem = SharedAssignmentTableItem<
  AssignmentTableAssignment,
  AssignmentTableOperation
>;

export type AssignmentRowsById = Record<string, AssignmentRow>;

export const assignmentRowId = (
  principalType: PrincipalType,
  principalId: string,
  permissionSetArn: string,
) => assignmentTupleKey({ principalType, principalId, permissionSetArn });

export const isDesiredAssignmentRow = (row: AssignmentRow): boolean => {
  if (row.state === "added" || row.state === "restored") return true;
  if (row.state === "removed") return false;
  return row.isDesired;
};

export const hasStagedAssignmentChanges = (
  rowsById: Readonly<AssignmentRowsById>,
): boolean => Object.values(rowsById).some(({ state }) => state !== "current");

export const hasAssignmentSyncFailures = (
  rows: readonly AssignmentRow[],
): boolean =>
  rows.some(
    ({ syncStatus }) =>
      syncStatus === "grantFailed" || syncStatus === "revokeFailed",
  );

export const assignmentRefsFingerprint = (
  assignments: readonly AssignmentPrincipalRef[],
): string =>
  assignments
    .map(({ permissionSetArn, principalId, principalType }) =>
      assignmentTupleKey({
        principalId,
        principalType,
        permissionSetArn,
      }),
    )
    .sort((left, right) => left.localeCompare(right))
    .join("\n");

export const desiredAssignmentsFingerprint = (
  response: GetLeaseAssignmentsResponse,
): string =>
  assignmentRefsFingerprint(
    response.assignments
      .filter(({ isDesired }) => isDesired)
      .map(({ permissionSet, principalId, principalType }) => ({
        principalId,
        principalType,
        permissionSetArn: permissionSet.permissionSetArn,
      })),
  );

const assignmentRowFromApi = (
  assignment: LeaseAssignmentView,
): AssignmentRow => ({
  rowId: assignmentRowId(
    assignment.principalType,
    assignment.principalId,
    assignment.permissionSet.permissionSetArn,
  ),
  principalId: assignment.principalId,
  principalType: assignment.principalType,
  displayName: assignment.displayName,
  subtitle:
    assignment.principalType === "USER" ? assignment.assigneeEmail : "Group",
  addedBy: assignment.addedBy,
  addedDate: assignment.addedDate,
  state: "current",
  isOwner: assignment.isOwner,
  isDesired: assignment.isDesired,
  syncStatus: assignment.syncStatus,
  permissionSet: assignment.permissionSet,
});

export const assignmentRowsFromResponse = (
  response: GetLeaseAssignmentsResponse | undefined,
): AssignmentRowsById =>
  Object.fromEntries(
    (response?.assignments ?? []).map((assignment) => {
      const row = assignmentRowFromApi(assignment);
      return [row.rowId, row];
    }),
  );

export const toDesiredAssignmentRefs = (
  rows: readonly AssignmentRow[],
): AssignmentPrincipalRef[] =>
  rows.filter(isDesiredAssignmentRow).map((row) => ({
    principalId: row.principalId,
    principalType: row.principalType,
    permissionSetArn: row.permissionSet.permissionSetArn,
  }));

export const sortAssignmentRows = (
  rows: readonly AssignmentRow[],
): AssignmentRow[] => {
  const stateRank: Record<AssignmentRowState, number> = {
    current: 0,
    added: 1,
    removed: 0,
    restored: 0,
  };
  return [...rows].sort((left, right) => {
    if (left.isOwner !== right.isOwner) return left.isOwner ? -1 : 1;
    if (stateRank[left.state] !== stateRank[right.state]) {
      return stateRank[left.state] - stateRank[right.state];
    }
    const displayNameComparison = left.displayName.localeCompare(
      right.displayName,
    );
    if (displayNameComparison !== 0) return displayNameComparison;
    return permissionSetLabel(left.permissionSet).localeCompare(
      permissionSetLabel(right.permissionSet),
    );
  });
};

const aggregateSyncStatus = (
  rows: readonly AssignmentRow[],
  fallback: AssignmentSyncStatus,
): AssignmentSyncStatus => {
  const priority: readonly AssignmentSyncStatus[] = [
    "grantFailed",
    "revokeFailed",
    "granting",
    "revoking",
  ];
  return (
    priority.find((status) =>
      rows.some(({ syncStatus }) => syncStatus === status),
    ) ?? fallback
  );
};

const toTableAssignment = (
  principalRows: readonly AssignmentRow[],
): AssignmentTableAssignment => {
  const rowsById = new Map(principalRows.map((row) => [row.rowId, row]));
  for (const row of principalRows) {
    const replacement = row.replacementRowId
      ? rowsById.get(row.replacementRowId)
      : undefined;
    if (row.state === "removed" && replacement?.replacesRowId === row.rowId) {
      return {
        kind: "assignment",
        rowId: `transition:${row.rowId}:${replacement.rowId}`,
        row: replacement,
        transitionFrom: row,
      };
    }
  }

  const row =
    principalRows.find(isDesiredAssignmentRow) ??
    principalRows.find(
      (candidate) => candidate.state === "removed" && candidate.isDesired,
    ) ??
    principalRows.find(({ isOwner }) => isOwner) ??
    principalRows[0];
  return {
    kind: "assignment",
    rowId: `assignment:${row.rowId}`,
    row: {
      ...row,
      syncStatus: aggregateSyncStatus(principalRows, row.syncStatus),
    },
  };
};

const operationRow = (
  assignmentRowId: string,
  index: number,
  action: "grant" | "revoke",
  permissionSet: PermissionSetReference,
  syncStatus: AssignmentSyncStatus | "pending",
): AssignmentTableOperation => ({
  kind: "operation",
  rowId: `operation:${assignmentRowId}:${index}:${action}:${permissionSet.permissionSetArn}`,
  action,
  permissionSet,
  syncStatus,
});

const operationActionForStatus = (
  syncStatus: AssignmentSyncStatus,
): "grant" | "revoke" =>
  syncStatus === "revoking" ||
  syncStatus === "revokeFailed" ||
  syncStatus === "suspended"
    ? "revoke"
    : "grant";

const toTableOperations = (
  assignment: AssignmentTableAssignment,
  principalRows: readonly AssignmentRow[],
): AssignmentTableOperation[] => {
  const currentOperations = (
    excludedRowIds: ReadonlySet<string>,
    offset: number,
  ) =>
    principalRows
      .filter(
        (operation) =>
          operation.state === "current" && !excludedRowIds.has(operation.rowId),
      )
      .map((operation, index) =>
        operationRow(
          operation.rowId,
          index + offset,
          operationActionForStatus(operation.syncStatus),
          operation.permissionSet,
          operation.syncStatus,
        ),
      );

  if (assignment.transitionFrom) {
    const stagedOperations = [
      operationRow(
        assignment.rowId,
        0,
        "grant",
        assignment.row.permissionSet,
        "pending",
      ),
      operationRow(
        assignment.rowId,
        1,
        "revoke",
        assignment.transitionFrom.permissionSet,
        "pending",
      ),
    ];
    return [
      ...stagedOperations,
      ...currentOperations(
        new Set([assignment.row.rowId, assignment.transitionFrom.rowId]),
        stagedOperations.length,
      ),
    ];
  }

  const { row } = assignment;
  if (row.state === "added" || row.state === "restored") {
    const stagedOperations = [
      operationRow(row.rowId, 0, "grant", row.permissionSet, "pending"),
    ];
    return [
      ...stagedOperations,
      ...currentOperations(new Set([row.rowId]), stagedOperations.length),
    ];
  }
  if (row.state === "removed") {
    const stagedOperations = [
      operationRow(row.rowId, 0, "revoke", row.permissionSet, "pending"),
    ];
    return [
      ...stagedOperations,
      ...currentOperations(new Set([row.rowId]), stagedOperations.length),
    ];
  }
  return currentOperations(new Set(), 0);
};

export const groupAssignmentRows = (
  rows: readonly AssignmentRow[],
): AssignmentTablePrincipal[] => {
  const rowsByPrincipal = new Map<string, AssignmentRow[]>();
  for (const row of rows) {
    const key = assignmentPrincipalKey(row);
    const principalRows = rowsByPrincipal.get(key) ?? [];
    principalRows.push(row);
    rowsByPrincipal.set(key, principalRows);
  }

  return [...rowsByPrincipal.entries()].map(([key, principalRows]) => {
    const representative =
      principalRows.find(({ isOwner }) => isOwner) ?? principalRows[0];
    const assignment = toTableAssignment(principalRows);
    return {
      kind: "principal",
      rowId: `principal:${key}`,
      principalId: representative.principalId,
      principalType: representative.principalType,
      displayName: representative.displayName,
      subtitle: representative.subtitle,
      isOwner: representative.isOwner,
      assignment,
      operations: toTableOperations(assignment, principalRows),
    };
  });
};

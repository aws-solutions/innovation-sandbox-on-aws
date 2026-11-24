// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  type AssignmentRow,
  assignmentRowId,
  type AssignmentRowsById,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorModel";
import {
  defaultAssignablePermissionSet,
  isSameAssignmentPrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

export type AssignmentPermissionSetConfig = {
  defaultPermissionSetArn: string;
  assignablePermissionSets: readonly PermissionSetReference[];
};

const rowFromPrincipal = (
  principal: IdcPrincipalView,
  permissionSet: PermissionSetReference,
): AssignmentRow => ({
  rowId: assignmentRowId(
    principal.principalType,
    principal.principalId,
    permissionSet.permissionSetArn,
  ),
  principalId: principal.principalId,
  principalType: principal.principalType,
  displayName: principal.displayName,
  subtitle: principal.principalType === "USER" ? principal.email : "Group",
  state: "added",
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
  permissionSet,
});

const unlinkReplacement = (
  rowsById: AssignmentRowsById,
  rowId: string,
): AssignmentRowsById => {
  const row = rowsById[rowId];
  if (!row) return rowsById;

  const next = {
    ...rowsById,
    [rowId]: {
      ...row,
      replacesRowId: undefined,
      replacementRowId: undefined,
    },
  };

  if (
    row.replacesRowId &&
    next[row.replacesRowId]?.replacementRowId === rowId
  ) {
    next[row.replacesRowId] = {
      ...next[row.replacesRowId],
      replacementRowId: undefined,
    };
  }
  if (
    row.replacementRowId &&
    next[row.replacementRowId]?.replacesRowId === rowId
  ) {
    next[row.replacementRowId] = {
      ...next[row.replacementRowId],
      replacesRowId: undefined,
    };
  }

  return next;
};

export const addAssignment = (
  rowsById: AssignmentRowsById,
  principal: IdcPrincipalView,
  config: AssignmentPermissionSetConfig,
): AssignmentRowsById => {
  if (
    Object.values(rowsById).some((row) =>
      isSameAssignmentPrincipal(row, principal),
    )
  ) {
    return rowsById;
  }

  const nextPermissionSet = defaultAssignablePermissionSet(
    config.assignablePermissionSets,
    config.defaultPermissionSetArn,
  );
  if (!nextPermissionSet) return rowsById;

  const row = rowFromPrincipal(principal, nextPermissionSet);
  return { ...rowsById, [row.rowId]: row };
};

export const removeAssignment = (
  rowsById: AssignmentRowsById,
  rowId: string,
): AssignmentRowsById => {
  const row = rowsById[rowId];
  if (!row) return rowsById;

  if (row.state === "restored") {
    const unlinkedRows = unlinkReplacement(rowsById, rowId);
    return {
      ...unlinkedRows,
      [rowId]: {
        ...unlinkedRows[rowId],
        state: "current",
      },
    };
  }

  if (row.state !== "added") {
    return {
      ...rowsById,
      [rowId]: {
        ...row,
        state: "removed",
      },
    };
  }

  const { [rowId]: _removed, ...remainingRows } = rowsById;
  if (!row.replacesRowId || !remainingRows[row.replacesRowId]) {
    return remainingRows;
  }
  return {
    ...remainingRows,
    [row.replacesRowId]: {
      ...remainingRows[row.replacesRowId],
      state: "removed",
      replacementRowId: undefined,
    },
  };
};

export const restoreAssignment = (
  rowsById: AssignmentRowsById,
  rowId: string,
): AssignmentRowsById => {
  const row = rowsById[rowId];
  if (row?.state !== "current") return rowsById;
  return {
    ...rowsById,
    [rowId]: { ...row, state: "restored" },
  };
};

export const undoAssignmentChange = (
  rowsById: AssignmentRowsById,
  rowId: string,
): AssignmentRowsById => {
  const row = rowsById[rowId];
  if (row?.state !== "removed" && row?.state !== "restored") {
    return rowsById;
  }

  if (!row.replacementRowId) {
    return {
      ...rowsById,
      [rowId]: { ...row, state: "current" },
    };
  }

  const replacement = rowsById[row.replacementRowId];
  if (replacement?.state === "restored") {
    return {
      ...rowsById,
      [rowId]: {
        ...row,
        state: row.isDesired ? "current" : "restored",
        replacementRowId: undefined,
      },
      [replacement.rowId]: {
        ...replacement,
        state: "current",
        replacesRowId: undefined,
      },
    };
  }

  const { [row.replacementRowId]: _replacement, ...remainingRows } = rowsById;
  return {
    ...remainingRows,
    [rowId]: {
      ...row,
      state: row.isDesired ? "current" : "restored",
      replacementRowId: undefined,
    },
  };
};

const stageExistingTarget = (
  rowsById: AssignmentRowsById,
  sourceRowId: string,
  targetRowId: string,
): AssignmentRowsById => {
  const originalSource = rowsById[sourceRowId];
  const transitionSourceId =
    originalSource.state === "added"
      ? originalSource.replacesRowId
      : sourceRowId;
  let next = unlinkReplacement(rowsById, sourceRowId);
  next = unlinkReplacement(next, targetRowId);
  const source = next[sourceRowId];
  const target = next[targetRowId];

  if (source.state === "added") {
    const { [sourceRowId]: _source, ...remainingRows } = next;
    next = remainingRows;
  } else if (source.state === "restored") {
    next[sourceRowId] = { ...source, state: "current" };
  } else {
    next[sourceRowId] = { ...source, state: "removed" };
  }

  if (transitionSourceId && next[transitionSourceId]) {
    next[transitionSourceId] = {
      ...next[transitionSourceId],
      state: "removed",
      replacementRowId: targetRowId,
    };
  }
  next[targetRowId] = {
    ...target,
    state: "restored",
    replacesRowId: transitionSourceId,
  };
  return next;
};

const switchToRemovedTarget = (
  rowsById: AssignmentRowsById,
  sourceRowId: string,
  targetRowId: string,
): AssignmentRowsById => {
  let next = unlinkReplacement(rowsById, sourceRowId);
  next = unlinkReplacement(next, targetRowId);
  const source = next[sourceRowId];
  const target = next[targetRowId];

  if (source.state === "added") {
    const { [sourceRowId]: _source, ...remainingRows } = next;
    next = remainingRows;
  } else if (source.state === "restored") {
    next[sourceRowId] = { ...source, state: "current" };
  } else {
    next[sourceRowId] = { ...source, state: "removed" };
  }
  next[targetRowId] = {
    ...target,
    state: target.isDesired ? "current" : "restored",
  };
  return next;
};

const stageNewPermissionSet = (
  rowsById: AssignmentRowsById,
  row: AssignmentRow,
  nextRowId: string,
  permissionSet: PermissionSetReference,
): AssignmentRowsById => {
  const replacement: AssignmentRow = {
    ...row,
    rowId: nextRowId,
    permissionSet,
    state: "added",
    addedBy: undefined,
    addedDate: undefined,
    syncStatus: "active",
  };
  if (row.state !== "added") {
    return {
      ...rowsById,
      [row.rowId]: {
        ...row,
        state: "removed",
        replacementRowId: nextRowId,
      },
      [nextRowId]: { ...replacement, replacesRowId: row.rowId },
    };
  }

  const { [row.rowId]: _row, ...remainingRows } = rowsById;
  if (row.replacesRowId && remainingRows[row.replacesRowId]) {
    remainingRows[row.replacesRowId] = {
      ...remainingRows[row.replacesRowId],
      replacementRowId: nextRowId,
    };
  }
  return {
    ...remainingRows,
    [nextRowId]: {
      ...replacement,
      replacesRowId: row.replacesRowId,
    },
  };
};

export function changeAssignmentPermissionSet(
  rowsById: AssignmentRowsById,
  rowId: string,
  permissionSetArn: string,
  config: AssignmentPermissionSetConfig,
): AssignmentRowsById {
  const row = rowsById[rowId];
  const permissionSet = config.assignablePermissionSets.find(
    ({ permissionSetArn: assignableArn }) => assignableArn === permissionSetArn,
  );
  if (
    !row ||
    !permissionSet ||
    row.permissionSet.permissionSetArn === permissionSetArn
  ) {
    return rowsById;
  }

  const replacementSource =
    row.state === "restored" && row.replacesRowId
      ? rowsById[row.replacesRowId]
      : undefined;
  if (replacementSource?.replacementRowId === row.rowId) {
    const baselineRows = undoAssignmentChange(
      rowsById,
      replacementSource.rowId,
    );
    return changeAssignmentPermissionSet(
      baselineRows,
      replacementSource.rowId,
      permissionSetArn,
      config,
    );
  }

  const nextRowId = assignmentRowId(
    row.principalType,
    row.principalId,
    permissionSetArn,
  );
  const existingTarget = rowsById[nextRowId];
  if (existingTarget?.state === "current" && !existingTarget.isDesired) {
    return stageExistingTarget(rowsById, rowId, nextRowId);
  }
  if (existingTarget && existingTarget.state !== "removed") {
    if (
      existingTarget.state !== "added" ||
      row.state === "added" ||
      existingTarget.replacesRowId
    ) {
      return rowsById;
    }
    return {
      ...rowsById,
      [rowId]: {
        ...row,
        state: "removed",
        replacementRowId: nextRowId,
      },
      [nextRowId]: {
        ...existingTarget,
        replacesRowId: rowId,
      },
    };
  }
  if (existingTarget?.state === "removed") {
    return switchToRemovedTarget(rowsById, rowId, nextRowId);
  }
  return stageNewPermissionSet(rowsById, row, nextRowId, permissionSet);
}

export const shouldExcludePrincipal = (
  rows: readonly AssignmentRow[],
  principal: IdcPrincipalView,
  leaseOwnerEmail: string,
): boolean => {
  if (rows.some((row) => isSameAssignmentPrincipal(row, principal))) {
    return true;
  }
  if (
    principal.principalType === "USER" &&
    principal.email?.toLowerCase() === leaseOwnerEmail.toLowerCase()
  ) {
    return true;
  }
  return false;
};

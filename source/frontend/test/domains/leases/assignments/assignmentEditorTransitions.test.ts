// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type AssignmentRow,
  assignmentRowId,
  type AssignmentRowsById,
  groupAssignmentRows,
  hasStagedAssignmentChanges,
  isDesiredAssignmentRow,
  sortAssignmentRows,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorModel";
import {
  addAssignment,
  type AssignmentPermissionSetConfig,
  changeAssignmentPermissionSet,
  removeAssignment,
  restoreAssignment,
  shouldExcludePrincipal,
  undoAssignmentChange,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorTransitions";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const permissionSet = (suffix: string): PermissionSetReference => ({
  permissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-${suffix.padEnd(16, "0")}`,
  permissionSetId: `ps-${suffix.padEnd(16, "0")}`,
  name: suffix,
  availability: "AVAILABLE",
});

const permissionSetA = permissionSet("a");
const permissionSetB = permissionSet("b");
const permissionSetC = permissionSet("c");
const permissionSets = [permissionSetA, permissionSetB, permissionSetC];
const principal = {
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "USER" as const,
  displayName: "Alice",
  email: "alice@example.com",
};
const config: AssignmentPermissionSetConfig = {
  defaultPermissionSetArn: permissionSetA.permissionSetArn,
  assignablePermissionSets: permissionSets,
};

const currentRow = (
  selectedPermissionSet: PermissionSetReference,
  isDesired = true,
): AssignmentRow => ({
  rowId: assignmentRowId(
    principal.principalType,
    principal.principalId,
    selectedPermissionSet.permissionSetArn,
  ),
  principalId: principal.principalId,
  principalType: principal.principalType,
  displayName: principal.displayName,
  subtitle: principal.email,
  state: "current",
  isOwner: false,
  isDesired,
  syncStatus: isDesired ? "active" : "revokeFailed",
  permissionSet: selectedPermissionSet,
});

const currentRows = (
  selectedPermissionSets: readonly PermissionSetReference[],
): AssignmentRowsById =>
  Object.fromEntries(
    selectedPermissionSets.map((item) => {
      const row = currentRow(item);
      return [row.rowId, row];
    }),
  );

const desiredArns = (rowsById: AssignmentRowsById) =>
  Object.values(rowsById)
    .filter(isDesiredAssignmentRow)
    .map(({ permissionSet }) => permissionSet.permissionSetArn)
    .sort();

const select = (
  rowsById: AssignmentRowsById,
  selectedPermissionSet: PermissionSetReference,
) => {
  const row =
    Object.values(rowsById).find(isDesiredAssignmentRow) ??
    Object.values(rowsById)[0]!;
  return changeAssignmentPermissionSet(
    rowsById,
    row.rowId,
    selectedPermissionSet.permissionSetArn,
    config,
  );
};

describe("assignment editor transitions", () => {
  it("preserves only the final permission-set selection", () => {
    const replaced = select(currentRows([permissionSetA]), permissionSetB);
    const result = select(replaced, permissionSetC);
    const permissionSetARowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetA.permissionSetArn,
    );
    const permissionSetBRowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetB.permissionSetArn,
    );
    const permissionSetCRowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetC.permissionSetArn,
    );

    expect(desiredArns(result)).toEqual([permissionSetC.permissionSetArn]);
    expect(result[permissionSetBRowId]).toBeUndefined();
    expect(result[permissionSetARowId]).toMatchObject({
      state: "removed",
      replacementRowId: permissionSetCRowId,
    });
    expect(result[permissionSetCRowId]).toMatchObject({
      state: "added",
      replacesRowId: permissionSetARowId,
    });
    expect(Object.values(result)).toHaveLength(2);
  });

  it("changes the permission set for a newly staged principal", () => {
    const added = addAssignment({}, principal, config);
    const result = select(added, permissionSetB);

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
  });

  it("adds a group with the default permission set", () => {
    const result = addAssignment(
      {},
      {
        principalId: "22222222-2222-4222-8222-222222222222",
        principalType: "GROUP",
        displayName: "Engineering",
      },
      config,
    );

    expect(Object.values(result)).toEqual([
      expect.objectContaining({
        principalType: "GROUP",
        displayName: "Engineering",
        subtitle: "Group",
        state: "added",
        permissionSet: permissionSetA,
      }),
    ]);
  });

  it("does not add a principal when all configured permission sets are unavailable", () => {
    const rows = {};

    expect(
      addAssignment(rows, principal, {
        ...config,
        assignablePermissionSets: [],
      }),
    ).toBe(rows);
  });

  it("does not restore a removed principal through the add flow", () => {
    const rows = currentRows([permissionSetA]);
    const removed = removeAssignment(
      rows,
      assignmentRowId(
        principal.principalType,
        principal.principalId,
        permissionSetA.permissionSetArn,
      ),
    );

    expect(addAssignment(removed, principal, config)).toBe(removed);
  });

  it("models a saved permission-set change as one replacement", () => {
    const result = select(currentRows([permissionSetA]), permissionSetB);

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
    expect(Object.values(result)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          permissionSet: permissionSetA,
          state: "removed",
        }),
        expect.objectContaining({
          permissionSet: permissionSetB,
          state: "added",
        }),
      ]),
    );
  });

  it("removes all access after a staged permission-set change", () => {
    const changed = select(currentRows([permissionSetA]), permissionSetB);
    const originalRowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetA.permissionSetArn,
    );
    const replacementRowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetB.permissionSetArn,
    );

    const result = removeAssignment(changed, replacementRowId);

    expect(desiredArns(result)).toEqual([]);
    expect(result[replacementRowId]).toBeUndefined();
    expect(result[originalRowId]).toMatchObject({
      state: "removed",
      replacementRowId: undefined,
    });
  });

  it("can restore a still-live previous permission set after a partial replacement", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [previous.rowId]: previous,
      [desired.rowId]: desired,
    };

    const result = select(rows, permissionSetA);

    expect(desiredArns(result)).toEqual([permissionSetA.permissionSetArn]);
    expect(result[previous.rowId]).toMatchObject({
      state: "restored",
      replacesRowId: desired.rowId,
    });
    expect(result[desired.rowId]).toMatchObject({
      state: "removed",
      replacementRowId: previous.rowId,
    });

    const undone = undoAssignmentChange(result, desired.rowId);
    expect(desiredArns(undone)).toEqual([permissionSetB.permissionSetArn]);
    expect(undone[previous.rowId]).toMatchObject({
      state: "current",
      isDesired: false,
    });
  });

  it("unlinks a restored replacement when removing it", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const restored = select(
      {
        [previous.rowId]: previous,
        [desired.rowId]: desired,
      },
      permissionSetA,
    );

    const result = removeAssignment(restored, previous.rowId);
    const [principalRow] = groupAssignmentRows(
      sortAssignmentRows(Object.values(result)),
    );

    expect(desiredArns(result)).toEqual([]);
    expect(result[previous.rowId]).toMatchObject({
      state: "current",
      isDesired: false,
    });
    expect(result[previous.rowId].replacesRowId).toBeUndefined();
    expect(result[desired.rowId]).toMatchObject({
      state: "removed",
      isDesired: true,
    });
    expect(result[desired.rowId].replacementRowId).toBeUndefined();
    expect(principalRow.assignment.transitionFrom).toBeUndefined();
  });

  it("returns to the server state when a restored permission set is changed back", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [previous.rowId]: previous,
      [desired.rowId]: desired,
    };

    const restored = select(rows, permissionSetA);
    const result = select(restored, permissionSetB);

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
    expect(result[previous.rowId]).toMatchObject({
      state: "current",
      isDesired: false,
    });
    expect(result[desired.rowId]).toMatchObject({
      state: "current",
      isDesired: true,
    });
    expect(hasStagedAssignmentChanges(result)).toBe(false);
  });

  it("returns to the server state after replacing an independently restored tuple", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [previous.rowId]: previous,
      [desired.rowId]: desired,
    };
    const removed = removeAssignment(rows, desired.rowId);
    const restored = restoreAssignment(removed, previous.rowId);

    const result = select(restored, permissionSetB);

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
    expect(result[previous.rowId]).toMatchObject({
      state: "current",
      isDesired: false,
    });
    expect(result[desired.rowId]).toMatchObject({
      state: "current",
      isDesired: true,
    });
    expect(hasStagedAssignmentChanges(result)).toBe(false);
  });

  it("ignores stale or no-op transition requests", () => {
    const rows = currentRows([permissionSetA]);
    const rowId = Object.keys(rows)[0]!;

    expect(removeAssignment(rows, "missing-row")).toBe(rows);
    expect(restoreAssignment(rows, "missing-row")).toBe(rows);
    expect(undoAssignmentChange(rows, rowId)).toBe(rows);
    expect(
      changeAssignmentPermissionSet(
        rows,
        "missing-row",
        permissionSetB.permissionSetArn,
        config,
      ),
    ).toBe(rows);
    expect(
      changeAssignmentPermissionSet(rows, rowId, "unknown-arn", config),
    ).toBe(rows);
    expect(
      changeAssignmentPermissionSet(
        rows,
        rowId,
        permissionSetA.permissionSetArn,
        config,
      ),
    ).toBe(rows);
  });

  it("switches back to a permission set with a pending revoke", () => {
    const selected = currentRow(permissionSetA);
    const pendingRevoke = currentRow(permissionSetB, false);
    const rows = {
      [selected.rowId]: selected,
      [pendingRevoke.rowId]: pendingRevoke,
    };
    const removed = removeAssignment(rows, pendingRevoke.rowId);

    const result = changeAssignmentPermissionSet(
      removed,
      selected.rowId,
      permissionSetB.permissionSetArn,
      config,
    );

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
    expect(result[selected.rowId]).toMatchObject({
      state: "removed",
      isDesired: true,
    });
    expect(result[pendingRevoke.rowId]).toMatchObject({
      state: "restored",
      isDesired: false,
    });
  });

  it("switches between permission sets with failed revokes", () => {
    const firstPendingRevoke = currentRow(permissionSetA, false);
    const secondPendingRevoke = currentRow(permissionSetB, false);
    const rows = {
      [firstPendingRevoke.rowId]: firstPendingRevoke,
      [secondPendingRevoke.rowId]: secondPendingRevoke,
    };
    const restored = restoreAssignment(rows, firstPendingRevoke.rowId);

    const result = changeAssignmentPermissionSet(
      restored,
      firstPendingRevoke.rowId,
      permissionSetB.permissionSetArn,
      config,
    );

    expect(desiredArns(result)).toEqual([permissionSetB.permissionSetArn]);
    expect(result[firstPendingRevoke.rowId]).toMatchObject({
      state: "removed",
      replacementRowId: secondPendingRevoke.rowId,
    });
    expect(result[secondPendingRevoke.rowId]).toMatchObject({
      state: "restored",
      replacesRowId: firstPendingRevoke.rowId,
    });

    const undone = undoAssignmentChange(result, firstPendingRevoke.rowId);
    expect(desiredArns(undone)).toEqual([permissionSetA.permissionSetArn]);
    expect(undone[firstPendingRevoke.rowId]).toMatchObject({
      state: "restored",
      replacementRowId: undefined,
    });
    expect(undone[secondPendingRevoke.rowId]).toMatchObject({
      state: "current",
      replacesRowId: undefined,
    });
  });

  it("undoes a replacement back to the server state", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [previous.rowId]: previous,
      [desired.rowId]: desired,
    };

    const restored = select(rows, permissionSetA);
    const replaced = select(restored, permissionSetC);
    const [replacementPrincipal] = groupAssignmentRows(
      sortAssignmentRows(Object.values(replaced)),
    );
    const baseline = undoAssignmentChange(
      replaced,
      replacementPrincipal.assignment.transitionFrom!.rowId,
    );

    expect(desiredArns(baseline)).toEqual([permissionSetB.permissionSetArn]);
    expect(baseline[previous.rowId]).toMatchObject({
      state: "current",
      isDesired: false,
    });
    expect(baseline[desired.rowId]).toMatchObject({
      state: "current",
      isDesired: true,
    });
    expect(hasStagedAssignmentChanges(baseline)).toBe(false);
  });

  it("returns to the server state after revisiting a staged permission set", () => {
    const selectedB = select(currentRows([permissionSetA]), permissionSetB);
    const selectedC = select(selectedB, permissionSetC);
    const revisitedB = select(selectedC, permissionSetB);
    const [principalRow] = groupAssignmentRows(
      sortAssignmentRows(Object.values(revisitedB)),
    );

    const result = undoAssignmentChange(
      revisitedB,
      principalRow.assignment.transitionFrom!.rowId,
    );

    expect(desiredArns(result)).toEqual([permissionSetA.permissionSetArn]);
    expect(Object.values(result)).toEqual([
      expect.objectContaining({
        permissionSet: permissionSetA,
        state: "current",
      }),
    ]);
    expect(hasStagedAssignmentChanges(result)).toBe(false);
  });

  it("restores a failed revoke after undoing a replacement", () => {
    const previous = currentRow(permissionSetA, false);
    const restored = restoreAssignment(
      { [previous.rowId]: previous },
      previous.rowId,
    );
    const replaced = select(restored, permissionSetC);
    const [replacementPrincipal] = groupAssignmentRows(
      sortAssignmentRows(Object.values(replaced)),
    );

    const result = undoAssignmentChange(
      replaced,
      replacementPrincipal.assignment.transitionFrom!.rowId,
    );

    expect(desiredArns(result)).toEqual([permissionSetA.permissionSetArn]);
    expect(result[previous.rowId]).toMatchObject({
      state: "restored",
      isDesired: false,
      syncStatus: "revokeFailed",
    });
  });

  it("can replace a staged permission set with a still-live previous permission set", () => {
    const previous = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const staged = select(
      {
        [previous.rowId]: previous,
        [desired.rowId]: desired,
      },
      permissionSetC,
    );

    const result = select(staged, permissionSetA);
    const stagedRowId = assignmentRowId(
      principal.principalType,
      principal.principalId,
      permissionSetC.permissionSetArn,
    );

    expect(desiredArns(result)).toEqual([permissionSetA.permissionSetArn]);
    expect(result[stagedRowId]).toBeUndefined();
    expect(result[previous.rowId]).toMatchObject({
      state: "restored",
      replacesRowId: desired.rowId,
    });
    expect(result[desired.rowId]).toMatchObject({
      state: "removed",
      replacementRowId: previous.rowId,
    });
  });

  it("undoes removal of the desired permission set when an obsolete tuple remains", () => {
    const obsolete = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [obsolete.rowId]: obsolete,
      [desired.rowId]: desired,
    };
    const removed = removeAssignment(rows, desired.rowId);
    const [principalRow] = groupAssignmentRows(
      sortAssignmentRows(Object.values(removed)),
    );

    expect(principalRow.assignment.row.rowId).toBe(desired.rowId);

    const undone = undoAssignmentChange(
      removed,
      principalRow.assignment.row.rowId,
    );
    expect(desiredArns(undone)).toEqual([permissionSetB.permissionSetArn]);
  });

  it("preserves existing failed operations while staging another replacement", () => {
    const obsolete = currentRow(permissionSetA, false);
    const desired = currentRow(permissionSetB);
    const rows = {
      [obsolete.rowId]: obsolete,
      [desired.rowId]: desired,
    };
    const result = select(rows, permissionSetC);
    const [principalRow] = groupAssignmentRows(
      sortAssignmentRows(Object.values(result)),
    );

    expect(principalRow.operations).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          action: "grant",
          permissionSet: permissionSetC,
          syncStatus: "pending",
        }),
        expect.objectContaining({
          action: "revoke",
          permissionSet: permissionSetB,
          syncStatus: "pending",
        }),
        expect.objectContaining({
          action: "revoke",
          permissionSet: permissionSetA,
          syncStatus: "revokeFailed",
        }),
      ]),
    );
    expect(principalRow.operations).toHaveLength(3);
  });

  it("excludes existing principals and the lease owner from search", () => {
    expect(
      shouldExcludePrincipal(
        Object.values(currentRows([permissionSetA])),
        principal,
        "owner@example.com",
      ),
    ).toBe(true);
    expect(
      shouldExcludePrincipal(
        [],
        {
          ...principal,
          principalId: "22222222-2222-4222-8222-222222222222",
          email: "OWNER@example.com",
        },
        "owner@example.com",
      ),
    ).toBe(true);
    expect(
      shouldExcludePrincipal(
        [],
        {
          ...principal,
          principalId: "33333333-3333-4333-8333-333333333333",
        },
        "owner@example.com",
      ),
    ).toBe(false);
  });
});

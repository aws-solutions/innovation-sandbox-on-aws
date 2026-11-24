// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  type SelectProps,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import {
  type AssignmentTableAssignment,
  type AssignmentTableItem,
  type AssignmentTableOperation,
  isDesiredAssignmentRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorModel";
import { permissionSetLabel } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import { AssignmentPermissionSetSelector } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentPermissionSetSelector";
import type { AssignmentsEditor } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsEditor";

export const visibleAssignment = (
  item: AssignmentTableItem,
): AssignmentTableAssignment | undefined =>
  item.kind === "principal" ? item.assignment : undefined;

const SyncStatus = ({
  syncStatus,
  isTerminal,
}: {
  syncStatus: AssignmentTableOperation["syncStatus"];
  isTerminal: boolean;
}) => {
  switch (syncStatus) {
    case "pending":
      return <StatusIndicator type="pending">Pending save</StatusIndicator>;
    case "granting":
      return <StatusIndicator type="loading">Granting</StatusIndicator>;
    case "revoking":
      return <StatusIndicator type="loading">Revoking</StatusIndicator>;
    case "suspended":
      return (
        <StatusIndicator type="stopped">
          {isTerminal ? "Access ended" : "Access suspended"}
        </StatusIndicator>
      );
    case "grantFailed":
      return <StatusIndicator type="error">Grant failed</StatusIndicator>;
    case "revokeFailed":
      return <StatusIndicator type="error">Revoke failed</StatusIndicator>;
    default:
      return <StatusIndicator type="success">Active</StatusIndicator>;
  }
};

const AssignmentStatus = ({
  assignment,
  isTerminal,
}: {
  assignment: AssignmentTableAssignment;
  isTerminal: boolean;
}) => {
  const { row, transitionFrom } = assignment;
  if (transitionFrom) {
    return <StatusIndicator type="pending">Pending change</StatusIndicator>;
  }
  if (row.state === "added" || row.state === "restored") {
    return <StatusIndicator type="pending">Pending add</StatusIndicator>;
  }
  if (row.state === "removed") {
    return <StatusIndicator type="pending">Pending remove</StatusIndicator>;
  }
  return <SyncStatus syncStatus={row.syncStatus} isTerminal={isTerminal} />;
};

export const AssignmentStatusCell = ({
  item,
  isTerminal,
}: {
  item: AssignmentTableItem;
  isTerminal: boolean;
}) =>
  item.kind === "operation" ? (
    <SyncStatus syncStatus={item.syncStatus} isTerminal={isTerminal} />
  ) : (
    <AssignmentStatus assignment={item.assignment} isTerminal={isTerminal} />
  );

const PermissionSetDetails = ({
  assignment,
}: {
  assignment: AssignmentTableAssignment;
}) => (
  <SpaceBetween size="xxs">
    {assignment.transitionFrom && (
      <Box variant="small" color="text-status-inactive">
        Changing from{" "}
        {permissionSetLabel(assignment.transitionFrom.permissionSet)}
      </Box>
    )}
    <Box>{permissionSetLabel(assignment.row.permissionSet)}</Box>
  </SpaceBetween>
);

type PrincipalPermissionSetsProps = {
  principal: AssignmentTableItem;
  editor: AssignmentsEditor;
  canManage: boolean;
  isBusy: boolean;
  permissionSetOptions: SelectProps.Option[];
};

const PrincipalPermissionSets = ({
  principal,
  editor,
  canManage,
  isBusy,
  permissionSetOptions,
}: PrincipalPermissionSetsProps) => {
  if (principal.kind === "operation") {
    return permissionSetLabel(principal.permissionSet);
  }
  const assignment = visibleAssignment(principal);
  if (!assignment) return null;
  const { row } = assignment;

  if (!canManage || !isDesiredAssignmentRow(row)) {
    return <PermissionSetDetails assignment={assignment} />;
  }

  const permissionSetArn = row.permissionSet.permissionSetArn;
  const selectedOption = permissionSetOptions.find(
    ({ value }) => value === permissionSetArn,
  ) ?? {
    value: permissionSetArn,
    label: permissionSetLabel(row.permissionSet),
  };

  return (
    <AssignmentPermissionSetSelector
      principalDisplayName={principal.displayName}
      selectedOption={selectedOption}
      options={permissionSetOptions}
      disabled={isBusy}
      onChange={(selectedPermissionSetArn) =>
        editor.setPermissionSet(principal, selectedPermissionSetArn)
      }
    />
  );
};

type AssignmentPermissionSetCellProps = Omit<
  PrincipalPermissionSetsProps,
  "principal"
> & {
  item: AssignmentTableItem;
};

export const AssignmentPermissionSetCell = ({
  item,
  ...principalProps
}: AssignmentPermissionSetCellProps) => (
  <PrincipalPermissionSets principal={item} {...principalProps} />
);

const AssignmentAction = ({
  assignment,
  editor,
  isBusy,
}: {
  assignment: AssignmentTableAssignment;
  editor: AssignmentsEditor;
  isBusy: boolean;
}) => {
  const { row, transitionFrom } = assignment;
  if (transitionFrom) {
    return (
      <Button
        variant="inline-link"
        wrapText={false}
        ariaLabel={`Undo permission set change for ${row.displayName}`}
        onClick={() => editor.undo(transitionFrom)}
        disabled={isBusy}
      >
        Undo
      </Button>
    );
  }
  if (row.isOwner) return null;
  if (row.state === "restored") {
    return (
      <Button
        variant="inline-link"
        wrapText={false}
        ariaLabel={`Remove access for ${row.displayName}`}
        onClick={() => editor.undo(row)}
        disabled={isBusy}
      >
        Remove
      </Button>
    );
  }
  if (row.state === "current" && !row.isDesired) {
    return (
      <Button
        variant="inline-link"
        wrapText={false}
        ariaLabel={`Undo access removal for ${row.displayName}`}
        onClick={() => editor.restore(row)}
        disabled={isBusy || editor.isAtCapacity}
      >
        Undo
      </Button>
    );
  }
  if (row.state === "removed") {
    return (
      <Button
        variant="inline-link"
        wrapText={false}
        ariaLabel={`Undo access removal for ${row.displayName}`}
        onClick={() => editor.undo(row)}
        disabled={isBusy || (editor.isAtCapacity && !row.replacementRowId)}
      >
        Undo
      </Button>
    );
  }
  return (
    <Button
      variant="inline-link"
      wrapText={false}
      ariaLabel={`Remove access for ${row.displayName}`}
      onClick={() => editor.remove(row)}
      disabled={isBusy}
    >
      Remove
    </Button>
  );
};

export const AssignmentActionCell = ({
  item,
  editor,
  canManage,
  isBusy,
}: {
  item: AssignmentTableItem;
  editor: AssignmentsEditor;
  canManage: boolean;
  isBusy: boolean;
}) => {
  if (!canManage || item.kind === "operation") return null;

  const assignment = visibleAssignment(item);
  return assignment ? (
    <AssignmentAction assignment={assignment} editor={editor} isBusy={isBusy} />
  ) : null;
};

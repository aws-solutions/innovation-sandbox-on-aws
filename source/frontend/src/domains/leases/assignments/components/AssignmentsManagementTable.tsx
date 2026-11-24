// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, type SelectProps } from "@cloudscape-design/components";
import { DateTime } from "luxon";

import type { AssignmentPermissionSetConfig } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorTransitions";
import {
  AssignmentActionCell,
  AssignmentPermissionSetCell,
  AssignmentStatusCell,
  visibleAssignment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentManagementCells";
import { AssignmentsTable } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTable";
import type { AssignmentsEditor } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsEditor";
import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import type { GroupAssignmentMode } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { groupAssignmentsEnabled } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

type AssignmentsManagementTableProps = {
  editor: AssignmentsEditor;
  canManage: boolean;
  isTerminal: boolean;
  isBusy: boolean;
  enablePrincipalSearch: boolean;
  groupAssignmentMode: GroupAssignmentMode;
  permissionSetConfig: AssignmentPermissionSetConfig;
  permissionSetOptions: SelectProps.Option[];
};

export const AssignmentsManagementTable = ({
  editor,
  canManage,
  isTerminal,
  isBusy,
  enablePrincipalSearch,
  groupAssignmentMode,
  permissionSetConfig,
  permissionSetOptions,
}: AssignmentsManagementTableProps) => (
  <AssignmentsTable
    principals={editor.principalRows}
    mode="management"
    toolbarStart={
      canManage ? (
        <PrincipalTypeahead
          onSelect={editor.addPrincipal}
          shouldExclude={editor.shouldExclude}
          enablePrincipalSearch={enablePrincipalSearch}
          type={groupAssignmentsEnabled(groupAssignmentMode) ? "all" : "users"}
          disabled={
            isBusy ||
            editor.isAtCapacity ||
            permissionSetConfig.assignablePermissionSets.length === 0
          }
        />
      ) : undefined
    }
    empty={
      <Box textAlign="center" color="text-status-inactive">
        <b>No assignments</b>
        <Box variant="p" color="inherit">
          {canManage
            ? "Use the search box above to configure access."
            : "This lease has not been shared with anyone yet."}
        </Box>
      </Box>
    }
    renderStatus={(item) => (
      <AssignmentStatusCell item={item} isTerminal={isTerminal} />
    )}
    renderPermissionSet={(item) => (
      <AssignmentPermissionSetCell
        item={item}
        editor={editor}
        canManage={canManage}
        isBusy={isBusy}
        permissionSetOptions={permissionSetOptions}
      />
    )}
    renderAddedBy={(item) => {
      const assignment = visibleAssignment(item);
      if (!assignment) return undefined;
      return (assignment.transitionFrom ?? assignment.row).addedBy;
    }}
    renderAddedDate={(item) => {
      const assignment = visibleAssignment(item);
      if (!assignment) return undefined;
      const addedDate = (assignment.transitionFrom ?? assignment.row).addedDate;
      return addedDate ? DateTime.fromISO(addedDate).toRelative() : undefined;
    }}
    renderActions={(item) => (
      <AssignmentActionCell
        item={item}
        editor={editor}
        canManage={canManage}
        isBusy={isBusy}
      />
    )}
  />
);

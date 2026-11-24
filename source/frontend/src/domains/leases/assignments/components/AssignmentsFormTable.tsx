// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Button } from "@cloudscape-design/components";

import {
  permissionSetLabel,
  resolvePermissionSetReference,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import { AssignmentPermissionSetSelector } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentPermissionSetSelector";
import { AssignmentsTable } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTable";
import type {
  AssignmentsFormController,
  StagedAssignmentTablePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsForm";
import { PrincipalTypeahead } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PrincipalTypeahead";
import type { GroupAssignmentMode } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { groupAssignmentsEnabled } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

type AssignmentsFormTableProps = {
  form: AssignmentsFormController;
  enablePrincipalSearch: boolean;
  groupAssignmentMode: GroupAssignmentMode;
};

const PrincipalPermissionSets = ({
  principal,
  form,
}: {
  principal: StagedAssignmentTablePrincipal;
  form: AssignmentsFormController;
}) => {
  if (!form.permissionSetsConfigured) {
    return permissionSetLabel(form.defaultPermissionSet);
  }

  const permissionSetArn =
    principal.assignment.row.permissionSetArn ?? form.defaultPermissionSetArn;
  const permissionSet = resolvePermissionSetReference(
    permissionSetArn,
    form.defaultPermissionSet,
    form.permissionSetsByArn,
  );
  const selectedOption =
    form.permissionSetOptions.find(({ value }) => value === permissionSetArn) ??
    (permissionSetArn
      ? {
          value: permissionSetArn,
          label: permissionSet?.name ?? permissionSetArn,
        }
      : null);

  return (
    <AssignmentPermissionSetSelector
      principalDisplayName={principal.displayName}
      selectedOption={selectedOption}
      options={form.permissionSetOptions}
      onChange={(selectedArn) => form.setPermissionSet(principal, selectedArn)}
    />
  );
};

export const AssignmentsFormTable = ({
  form,
  enablePrincipalSearch,
  groupAssignmentMode,
}: AssignmentsFormTableProps) => (
  <AssignmentsTable
    principals={form.principalRows}
    mode="edit"
    toolbarStart={
      <PrincipalTypeahead
        onSelect={form.addPrincipal}
        shouldExclude={form.shouldExclude}
        enablePrincipalSearch={enablePrincipalSearch}
        type={groupAssignmentsEnabled(groupAssignmentMode) ? "all" : "users"}
        disabled={
          form.isAtCapacity ||
          (form.permissionSetsConfigured &&
            form.assignablePermissionSets.length === 0)
        }
      />
    }
    empty={
      <Box textAlign="center" color="text-status-inactive">
        <b>No one added yet</b>
        <Box variant="p" color="inherit">
          Use the search box above to configure access at approval.
        </Box>
      </Box>
    }
    renderPermissionSet={(item) => (
      <PrincipalPermissionSets principal={item} form={form} />
    )}
    renderActions={(item) => {
      if (item.isOwner) return null;
      return (
        <Button
          variant="inline-link"
          wrapText={false}
          onClick={() => form.removePrincipal(item)}
        >
          Remove
        </Button>
      );
    }}
  />
);

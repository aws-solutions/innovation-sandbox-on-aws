// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Container,
  Header,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { resolvePermissionSetReference } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type { AssignmentTableItem } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";
import { AssignmentsTable } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTable";
import {
  createPendingAssignmentRows,
  type PendingAssignmentTableAssignment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/pendingAssignmentRows";
import { DesiredAssignmentWithDisplay } from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

type PendingAssignmentsListProps = {
  desiredAssignments?: DesiredAssignmentWithDisplay[];
  defaultPermissionSet?: PermissionSetReference;
  allowedPermissionSets?: PermissionSetReference[];
  ownerEmail?: string;
};

const PendingPermissionSet = ({
  item,
  defaultPermissionSet,
  permissionSetsByArn,
}: {
  item: AssignmentTableItem<PendingAssignmentTableAssignment>;
  defaultPermissionSet?: PermissionSetReference;
  permissionSetsByArn: ReadonlyMap<string, PermissionSetReference>;
}) => {
  const { row } = item.assignment;
  const permissionSet = resolvePermissionSetReference(
    row.permissionSetArn,
    defaultPermissionSet,
    permissionSetsByArn,
  );
  if (!permissionSet) {
    return row.permissionSetArn ?? "Default";
  }
  return (
    <SpaceBetween direction="horizontal" size="xs">
      <span>{permissionSet.name ?? permissionSet.permissionSetArn}</span>
      {permissionSet.availability === "UNAVAILABLE" && (
        <StatusIndicator type="warning">Unavailable</StatusIndicator>
      )}
    </SpaceBetween>
  );
};

export const PendingAssignmentsList = ({
  desiredAssignments,
  defaultPermissionSet,
  allowedPermissionSets = [],
  ownerEmail,
}: PendingAssignmentsListProps) => {
  if (!desiredAssignments || desiredAssignments.length === 0) {
    return null;
  }
  const permissionSetsByArn = new Map(
    allowedPermissionSets.map((permissionSet) => [
      permissionSet.permissionSetArn,
      permissionSet,
    ]),
  );
  const principalRows = createPendingAssignmentRows(
    desiredAssignments,
    ownerEmail,
  );

  return (
    <Container
      header={
        <Header
          variant="h3"
          description="The following users and groups will receive access to this lease"
        >
          Planned access
        </Header>
      }
    >
      <AssignmentsTable
        principals={principalRows}
        mode="readonly"
        empty={<Box color="text-status-inactive">No additional principals</Box>}
        renderPermissionSet={(item) => (
          <PendingPermissionSet
            item={item}
            defaultPermissionSet={defaultPermissionSet}
            permissionSetsByArn={permissionSetsByArn}
          />
        )}
      />
    </Container>
  );
};

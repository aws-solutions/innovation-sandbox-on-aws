// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";

import type { AssignmentOwner } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import { AssignmentsFormTable } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsFormTable";
import { useAssignmentsForm } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsForm";
import {
  DEFAULT_GROUP_ASSIGNMENT_MODE,
  type GroupAssignmentMode,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import { groupAssignmentsEnabled } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

type AssignmentsFormProps = {
  enablePrincipalSearch?: boolean;
  groupAssignmentMode?: GroupAssignmentMode;
  owner?: AssignmentOwner;
  defaultPermissionSet?: PermissionSetReference;
  allowedPermissionSets?: readonly PermissionSetReference[];
};

const EMPTY_PERMISSION_SETS: readonly PermissionSetReference[] = [];

export const AssignmentsForm = ({
  enablePrincipalSearch = true,
  groupAssignmentMode = DEFAULT_GROUP_ASSIGNMENT_MODE,
  owner,
  defaultPermissionSet,
  allowedPermissionSets,
}: AssignmentsFormProps = {}) => {
  const form = useAssignmentsForm({
    owner,
    defaultPermissionSet,
    allowedPermissionSets: allowedPermissionSets ?? EMPTY_PERMISSION_SETS,
  });
  const description = groupAssignmentsEnabled(groupAssignmentMode)
    ? "Optional. Pick users and groups that should access this lease as soon as it is approved."
    : "Optional. Pick users that should access this lease as soon as it is approved.";

  return (
    <Container
      header={
        <Header
          variant="h3"
          description={description}
          counter={`(${form.assignments.length}/${MAX_ASSIGNMENTS})`}
        >
          Configure access
        </Header>
      }
    >
      <SpaceBetween size="m">
        {form.isAtCapacity && (
          <Alert type="warning">
            {form.isOverCapacity
              ? `Configure access for no more than ${MAX_ASSIGNMENTS} principals before continuing.`
              : `This lease has reached the maximum of ${MAX_ASSIGNMENTS} principals.`}
          </Alert>
        )}
        <AssignmentsFormTable
          form={form}
          enablePrincipalSearch={enablePrincipalSearch}
          groupAssignmentMode={groupAssignmentMode}
        />
      </SpaceBetween>
    </Container>
  );
};

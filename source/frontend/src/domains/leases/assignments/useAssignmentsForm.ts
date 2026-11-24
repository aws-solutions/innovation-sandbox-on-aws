// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo } from "react";
import { useFormContext, useWatch } from "react-hook-form";

import {
  type AssignmentOwner,
  assignmentPrincipalKey,
  defaultAssignablePermissionSet,
  isSameAssignmentPrincipal,
  type StagedAssignment,
  upsertOwnerAssignment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type { AssignmentTablePrincipal } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";
import { useAssignmentPermissionSets } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentPermissionSets";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

type AssignmentsFormShape = {
  assignments?: StagedAssignment[];
};

export type StagedAssignmentTableAssignment = {
  rowId: string;
  row: StagedAssignment;
};

export type StagedAssignmentTablePrincipal =
  AssignmentTablePrincipal<StagedAssignmentTableAssignment>;

type UseAssignmentsFormProps = {
  owner?: AssignmentOwner;
  defaultPermissionSet?: PermissionSetReference;
  allowedPermissionSets: readonly PermissionSetReference[];
};

const groupStagedAssignments = (
  assignments: readonly StagedAssignment[],
  ownerPrincipalId: string | undefined,
): StagedAssignmentTablePrincipal[] => {
  const assignmentsByPrincipal = new Map<string, StagedAssignment>();
  for (const assignment of assignments) {
    const key = assignmentPrincipalKey(assignment);
    if (!assignmentsByPrincipal.has(key)) {
      assignmentsByPrincipal.set(key, assignment);
    }
  }

  return [...assignmentsByPrincipal.entries()].map(
    ([principalKey, assignment]) => {
      return {
        kind: "principal",
        rowId: `principal:${principalKey}`,
        principalId: assignment.principalId,
        principalType: assignment.principalType,
        displayName:
          assignment.displayName ?? assignment.email ?? assignment.principalId,
        subtitle: assignment.email,
        isOwner:
          assignment.principalType === "USER" &&
          assignment.principalId === ownerPrincipalId,
        assignment: {
          rowId: `assignment:${principalKey}`,
          row: assignment,
        },
        operations: [],
      };
    },
  );
};

const replacePrincipalPermissionSet = (
  assignments: readonly StagedAssignment[],
  principal: StagedAssignmentTablePrincipal,
  permissionSetArn: string,
): StagedAssignment[] => {
  return assignments.map((assignment) =>
    isSameAssignmentPrincipal(assignment, principal)
      ? { ...assignment, permissionSetArn }
      : assignment,
  );
};

export const useAssignmentsForm = ({
  owner,
  defaultPermissionSet,
  allowedPermissionSets,
}: UseAssignmentsFormProps) => {
  const { control, getValues, setValue } =
    useFormContext<AssignmentsFormShape>();
  const assignments = useWatch({ control, name: "assignments" }) ?? [];
  const permissionSets = useAssignmentPermissionSets(
    defaultPermissionSet,
    allowedPermissionSets,
  );
  const { defaultPermissionSetArn } = permissionSets;
  const ownerPrincipalId = owner?.principalId;
  const ownerEmail = owner?.email;
  const normalizedOwner = useMemo<AssignmentOwner | undefined>(
    () =>
      ownerPrincipalId
        ? {
            principalId: ownerPrincipalId,
            displayName: owner?.displayName,
            email: ownerEmail,
          }
        : undefined,
    [owner?.displayName, ownerEmail, ownerPrincipalId],
  );

  useEffect(() => {
    if (!defaultPermissionSetArn) return;

    const currentAssignments = getValues("assignments") ?? [];
    const updatedAssignments = upsertOwnerAssignment(
      currentAssignments,
      normalizedOwner,
      defaultPermissionSetArn,
    );
    if (updatedAssignments === currentAssignments) return;
    setValue("assignments", updatedAssignments, { shouldValidate: true });
  }, [defaultPermissionSetArn, getValues, normalizedOwner, setValue]);

  const principalRows = useMemo(
    () => groupStagedAssignments(assignments, ownerPrincipalId),
    [assignments, ownerPrincipalId],
  );
  const isAtCapacity = assignments.length >= MAX_ASSIGNMENTS;
  const isOverCapacity = assignments.length > MAX_ASSIGNMENTS;

  const addPrincipal = useCallback(
    (principal: IdcPrincipalView) => {
      const currentAssignments = getValues("assignments") ?? [];
      if (currentAssignments.length >= MAX_ASSIGNMENTS) return;

      const nextPermissionSet = defaultAssignablePermissionSet(
        permissionSets.assignablePermissionSets,
        defaultPermissionSetArn,
      );
      if (!nextPermissionSet) return;

      setValue(
        "assignments",
        [
          ...currentAssignments,
          {
            principalId: principal.principalId,
            principalType: principal.principalType,
            displayName: principal.displayName,
            email: principal.email,
            permissionSetArn: nextPermissionSet.permissionSetArn,
          },
        ],
        { shouldValidate: true, shouldDirty: true },
      );
    },
    [
      defaultPermissionSetArn,
      getValues,
      permissionSets.assignablePermissionSets,
      setValue,
    ],
  );

  const removePrincipal = useCallback(
    (principal: StagedAssignmentTablePrincipal) => {
      const currentAssignments = getValues("assignments") ?? [];
      setValue(
        "assignments",
        currentAssignments.filter(
          (assignment) => !isSameAssignmentPrincipal(assignment, principal),
        ),
        { shouldValidate: true, shouldDirty: true },
      );
    },
    [getValues, setValue],
  );

  const setPermissionSet = useCallback(
    (principal: StagedAssignmentTablePrincipal, permissionSetArn: string) => {
      const currentAssignments = getValues("assignments") ?? [];
      setValue(
        "assignments",
        replacePrincipalPermissionSet(
          currentAssignments,
          principal,
          permissionSetArn,
        ),
        { shouldValidate: true, shouldDirty: true },
      );
    },
    [getValues, setValue],
  );

  const shouldExclude = useCallback(
    (principal: IdcPrincipalView) => {
      const isOwner =
        principal.principalType === "USER" &&
        (principal.principalId === ownerPrincipalId ||
          (!!ownerEmail && principal.email === ownerEmail));
      return (
        isOwner ||
        assignments.some((assignment) =>
          isSameAssignmentPrincipal(assignment, principal),
        )
      );
    },
    [assignments, ownerEmail, ownerPrincipalId],
  );

  return {
    assignments,
    principalRows,
    isAtCapacity,
    isOverCapacity,
    addPrincipal,
    removePrincipal,
    setPermissionSet,
    shouldExclude,
    defaultPermissionSet,
    ...permissionSets,
  };
};

export type AssignmentsFormController = ReturnType<typeof useAssignmentsForm>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

export type AssignmentPrincipal = {
  principalId: string;
  principalType: PrincipalType;
  displayName?: string;
};

export type AssignmentPrincipalIdentity = Pick<
  AssignmentPrincipal,
  "principalId" | "principalType"
>;

export type StagedAssignment = AssignmentPrincipal & {
  email?: string;
  permissionSetArn: string;
};

export type AssignmentOwner = {
  principalId: string;
  displayName?: string;
  email?: string;
};

export const assignmentPrincipalKey = ({
  principalId,
  principalType,
}: AssignmentPrincipalIdentity): string => `${principalType}|${principalId}`;

export const isSameAssignmentPrincipal = (
  left: AssignmentPrincipalIdentity,
  right: AssignmentPrincipalIdentity,
): boolean => assignmentPrincipalKey(left) === assignmentPrincipalKey(right);

export const permissionSetLabel = (
  permissionSet?: PermissionSetReference,
): string =>
  permissionSet?.name ?? permissionSet?.permissionSetArn ?? "Default";

export const resolvePermissionSetReference = (
  permissionSetArn: string | undefined,
  defaultPermissionSet: PermissionSetReference | undefined,
  permissionSetsByArn: ReadonlyMap<string, PermissionSetReference>,
): PermissionSetReference | undefined => {
  if (!permissionSetArn) return defaultPermissionSet;

  return (
    permissionSetsByArn.get(permissionSetArn) ??
    (defaultPermissionSet?.permissionSetArn === permissionSetArn
      ? defaultPermissionSet
      : undefined)
  );
};

export const assignmentTupleKey = (
  assignment: AssignmentPrincipal & { permissionSetArn?: string },
  defaultPermissionSetArn?: string,
): string =>
  `${assignment.principalType}|${assignment.principalId}|${
    assignment.permissionSetArn ?? defaultPermissionSetArn ?? "default"
  }`;

export const assignmentsFingerprint = (
  assignments: readonly (AssignmentPrincipal & {
    permissionSetArn?: string;
  })[],
): string =>
  assignments
    .map((assignment) => assignmentTupleKey(assignment))
    .sort() // NOSONAR typescript:S2871: Use locale-independent UTF-16 ordering for canonical assignment keys.
    .join("\n");

export const defaultAssignablePermissionSet = (
  assignablePermissionSets: readonly PermissionSetReference[],
  defaultPermissionSetArn: string | undefined,
): PermissionSetReference | undefined =>
  assignablePermissionSets.find(
    ({ permissionSetArn }) => permissionSetArn === defaultPermissionSetArn,
  ) ?? assignablePermissionSets[0];

export const upsertOwnerAssignment = (
  assignments: StagedAssignment[],
  owner: AssignmentOwner | undefined,
  defaultPermissionSetArn: string,
): StagedAssignment[] => {
  if (!owner?.principalId) return assignments;

  const ownerIndex = assignments.findIndex(
    (assignment) =>
      assignment.principalType === "USER" &&
      assignment.principalId === owner.principalId,
  );
  const ownerAssignment: StagedAssignment = {
    principalId: owner.principalId,
    principalType: "USER",
    displayName: owner.displayName ?? owner.email,
    email: owner.email,
    permissionSetArn: defaultPermissionSetArn,
  };

  if (ownerIndex === -1) {
    return [ownerAssignment, ...assignments];
  }

  return assignments;
};

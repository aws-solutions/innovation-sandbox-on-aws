// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

export type AssignmentTableAssignmentBase = {
  rowId: string;
};

export type AssignmentTableOperationBase = {
  kind: "operation";
  rowId: string;
  action: "grant" | "revoke";
};

export type AssignmentTablePrincipal<
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase = never,
> = {
  kind: "principal";
  rowId: string;
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  subtitle?: string;
  isOwner: boolean;
  assignment: TAssignment;
  operations: TOperation[];
};

export type AssignmentTableItem<
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase = never,
> = AssignmentTablePrincipal<TAssignment, TOperation> | TOperation;

export type AssignmentsTableMode = "edit" | "management" | "readonly";

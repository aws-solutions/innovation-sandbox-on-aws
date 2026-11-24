// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
export {
  assertPermissionSetGrantAllowed,
  assignmentTupleKey,
  getAssignablePermissionSets,
  hydratePermissionSetReference,
  hydratePermissionSets,
  isSystemPermissionSetArn,
  loadPermissionSetContext,
  resolvePermissionSetConfig,
  validateNewAssignmentGrants,
} from "./permission-set.service.js";
export type {
  AssignmentTupleKey,
  HydratedPermissionSets,
  PermissionSetConfig,
  PermissionSetContext,
  ResolvedPermissionSetConfig,
} from "./permission-set.types.js";

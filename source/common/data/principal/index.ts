// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PersistedAssignmentSchema,
  PersistedGroupAssignmentSchema,
  PersistedGroupMembershipCacheSchema,
  PersistedPrincipalCacheItemSchema,
  PersistedUserAssignmentSchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

export type {
  PersistedAssignment,
  PersistedGroupAssignment,
  PersistedGroupMembershipCache,
  PersistedPrincipalCacheItem,
  PersistedPrincipalTableItem,
  PersistedUserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

export { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";

export { DynamoPrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/dynamo-principal-store.js";

export {
  GROUP_MEMBERSHIP_SK,
  GROUP_PK_PREFIX,
  LEASE_SK_PREFIX,
  PERMISSION_SET_SK_INFIX,
  USER_PK_PREFIX,
  assignmentSk,
  groupPk,
  leaseSk,
  parseAssignmentSk,
  principalPk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";

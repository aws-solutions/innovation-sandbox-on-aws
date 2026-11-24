// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  InvalidPermissionSetPolicyError,
  PermissionSetPolicyTooLargeError,
  PolicyDocumentSchema,
  PolicyStatementSchema,
  UnsupportedPermissionSetBoundaryError,
  type PolicyDocument,
  type PolicyStatement,
  type ResolvePermissionSetPolicyServices,
  type ResolvedPermissionSetPolicy,
} from "./permission-policy.types.js";

export { resolvePermissionSetPolicy } from "./permission-policy.service.js";

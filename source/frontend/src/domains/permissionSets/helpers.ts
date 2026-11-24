// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// The IDC configurer creates the built-in set with this immutable suffix; the
// public catalog intentionally does not expose deployment configuration ARNs.
export const BUILT_IN_PERMISSION_SET_NAME_SUFFIX = "_IsbUsersPS";

export const isBuiltInPermissionSet = (permissionSet: { name?: string }) =>
  permissionSet.name?.endsWith(BUILT_IN_PERMISSION_SET_NAME_SUFFIX) ?? false;

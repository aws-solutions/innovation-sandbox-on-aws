// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { SelectProps } from "@cloudscape-design/components";
import { useMemo } from "react";

import { permissionSetLabel } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

export const useAssignmentPermissionSets = (
  defaultPermissionSet: PermissionSetReference | undefined,
  allowedPermissionSets: readonly PermissionSetReference[],
) => {
  const defaultPermissionSetArn = defaultPermissionSet?.permissionSetArn;
  const permissionSetsConfigured = allowedPermissionSets.length > 0;
  const permissionSetsByArn = useMemo(
    () =>
      new Map(
        allowedPermissionSets.map((permissionSet) => [
          permissionSet.permissionSetArn,
          permissionSet,
        ]),
      ),
    [allowedPermissionSets],
  );
  const orderedPermissionSets = useMemo(
    () =>
      [...allowedPermissionSets].sort((left, right) => {
        if (left.permissionSetArn === defaultPermissionSetArn) return -1;
        if (right.permissionSetArn === defaultPermissionSetArn) return 1;
        return permissionSetLabel(left).localeCompare(
          permissionSetLabel(right),
        );
      }),
    [allowedPermissionSets, defaultPermissionSetArn],
  );
  const assignablePermissionSets = useMemo(
    () =>
      orderedPermissionSets.filter(
        ({ availability }) => availability === "AVAILABLE",
      ),
    [orderedPermissionSets],
  );
  const permissionSetOptions = useMemo<SelectProps.Option[]>(
    () =>
      orderedPermissionSets.map((permissionSet) => ({
        value: permissionSet.permissionSetArn,
        label: permissionSetLabel(permissionSet),
        description:
          permissionSet.availability === "UNAVAILABLE"
            ? "Unavailable in the registered catalog"
            : permissionSet.description,
        disabled: permissionSet.availability === "UNAVAILABLE",
      })),
    [orderedPermissionSets],
  );

  return {
    defaultPermissionSetArn,
    permissionSetsConfigured,
    permissionSetsByArn,
    assignablePermissionSets,
    permissionSetOptions,
  };
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { GroupAssignmentMode } from "../types/configuration.js";
import type { DesiredAssignment } from "../types/lease.js";

export function groupAssignmentsEnabled(mode: GroupAssignmentMode): boolean {
  return mode === GroupAssignmentMode.ALL;
}

/**
 * Returns group-to-lease associations that the configured mode rejects.
 * `NONE` means no new group-to-lease associations: users remain allowed, while a
 * group is allowed only when that same group ID is already associated with this
 * lease. The policy deliberately ignores permission-set tuples, so an existing
 * group can remain, be removed, or have its permission sets changed without
 * temporarily enabling new group assignments. Existing groups also continue
 * through lifecycle operations such as approval. Principal search is gated
 * separately so `NONE` does not expose group discovery.
 *
 * This check intentionally relies on the supplied principal type. Before access is
 * granted, assignment processing resolves the principal ID in IDC as that type; a
 * group submitted as a user therefore fails user resolution instead of bypassing
 * this policy.
 */
export function findDisallowedGroupAssignments(
  mode: GroupAssignmentMode,
  desiredAssignments: readonly DesiredAssignment[],
  existingAssignments: readonly DesiredAssignment[] = [],
): DesiredAssignment[] {
  if (groupAssignmentsEnabled(mode)) return [];

  const existingGroupIds = new Set(
    existingAssignments
      .filter((assignment) => assignment.principalType === "GROUP")
      .map((assignment) => assignment.principalId),
  );

  return desiredAssignments.filter(
    (assignment) =>
      assignment.principalType === "GROUP" &&
      !existingGroupIds.has(assignment.principalId),
  );
}

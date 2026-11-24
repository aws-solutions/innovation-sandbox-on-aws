// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  type StagedAssignment,
  upsertOwnerAssignment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";

const ownerAssignment: StagedAssignment = {
  principalId: "11111111-1111-4111-8111-111111111111",
  principalType: "USER",
  displayName: "Existing owner",
  email: "existing-owner@example.com",
  permissionSetArn: "selected-permission-set-arn",
};

describe("upsertOwnerAssignment", () => {
  it("adds the owner with the default permission set", () => {
    const updatedAssignments = upsertOwnerAssignment(
      [],
      {
        principalId: ownerAssignment.principalId,
        displayName: "Current user name",
        email: "current-user@example.com",
      },
      "default-permission-set-arn",
    );

    expect(updatedAssignments).toEqual([
      {
        principalId: ownerAssignment.principalId,
        principalType: "USER",
        displayName: "Current user name",
        email: "current-user@example.com",
        permissionSetArn: "default-permission-set-arn",
      },
    ]);
  });

  it("leaves an existing owner assignment unchanged", () => {
    const assignments = [ownerAssignment];

    expect(
      upsertOwnerAssignment(
        assignments,
        {
          principalId: ownerAssignment.principalId,
          displayName: "Current user name",
          email: "current-user@example.com",
        },
        "default-permission-set-arn",
      ),
    ).toBe(assignments);
  });
});

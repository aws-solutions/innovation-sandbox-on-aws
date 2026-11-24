// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  findDisallowedGroupAssignments,
  groupAssignmentsEnabled,
} from "../utils/group-assignment-policy.js";

const user = {
  principalId: "00000000-0000-0000-0000-000000000001",
  principalType: "USER",
} as const;
const existingGroup = {
  principalId: "00000000-0000-0000-0000-000000000002",
  principalType: "GROUP",
} as const;
const newGroup = {
  principalId: "00000000-0000-0000-0000-000000000003",
  principalType: "GROUP",
} as const;

describe("group assignment policy", () => {
  it("allows every assignment in ALL mode", () => {
    expect(groupAssignmentsEnabled("ALL")).toBe(true);
    expect(
      findDisallowedGroupAssignments("ALL", [user, existingGroup, newGroup]),
    ).toEqual([]);
  });

  it("rejects new groups but permits users in NONE mode", () => {
    expect(groupAssignmentsEnabled("NONE")).toBe(false);
    expect(findDisallowedGroupAssignments("NONE", [user, newGroup])).toEqual([
      newGroup,
    ]);
  });

  it("allows an existing group to remain while rejecting a new group", () => {
    expect(
      findDisallowedGroupAssignments(
        "NONE",
        [user, existingGroup, newGroup],
        [existingGroup],
      ),
    ).toEqual([newGroup]);
  });

  it("allows permission-set changes for an existing group in NONE mode", () => {
    const existingGroupWithDefault = {
      ...existingGroup,
      permissionSetArn: "arn:aws:sso:::permissionSet/instance/default",
    };
    const existingGroupWithCustom = {
      ...existingGroup,
      permissionSetArn: "arn:aws:sso:::permissionSet/instance/custom",
    };

    expect(
      findDisallowedGroupAssignments(
        "NONE",
        [existingGroupWithDefault, existingGroupWithCustom],
        [existingGroupWithDefault],
      ),
    ).toEqual([]);
  });
});

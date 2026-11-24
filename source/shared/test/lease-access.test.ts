// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import type { DesiredAssignment } from "../types/lease.js";
import type { IsbUser } from "../utils/auth-utils.js";
import { isLeaseOwnerOrDirectAssignee } from "../utils/lease-access.js";

const OWNER_EMAIL = "owner@example.com";
const USER_ID = "11111111-1111-4111-8111-111111111111";
const OTHER_ID = "22222222-2222-4222-8222-222222222222";

const userWith = (email: string, userId = USER_ID): IsbUser => ({
  type: "user",
  email,
  userId,
  roles: ["User"],
});

const assignment = (
  principalType: DesiredAssignment["principalType"],
  principalId: string,
): DesiredAssignment => ({ principalType, principalId });

describe("isLeaseOwnerOrDirectAssignee", () => {
  it("is true for the owner, with or without assignments", () => {
    const lease = { userEmail: OWNER_EMAIL };

    expect(isLeaseOwnerOrDirectAssignee(userWith(OWNER_EMAIL), lease)).toBe(
      true,
    );
  });

  it("is true for a direct USER assignee", () => {
    const lease = {
      userEmail: OWNER_EMAIL,
      desiredAssignments: [assignment("USER", USER_ID)],
    };

    expect(
      isLeaseOwnerOrDirectAssignee(userWith("bob@example.com"), lease),
    ).toBe(true);
  });

  it("is false for another user's assignment", () => {
    const lease = {
      userEmail: OWNER_EMAIL,
      desiredAssignments: [assignment("USER", OTHER_ID)],
    };

    expect(
      isLeaseOwnerOrDirectAssignee(userWith("bob@example.com"), lease),
    ).toBe(false);
  });

  it("does not treat a GROUP assignment as direct access", () => {
    const lease = {
      userEmail: OWNER_EMAIL,
      desiredAssignments: [assignment("GROUP", USER_ID)],
    };

    expect(
      isLeaseOwnerOrDirectAssignee(userWith("bob@example.com"), lease),
    ).toBe(false);
  });

  it("is false for a machine identity that is not the owner", () => {
    const lease = {
      userEmail: OWNER_EMAIL,
      desiredAssignments: [assignment("USER", USER_ID)],
    };
    const m2m: IsbUser = {
      type: "m2m",
      clientId: "client-1",
      roles: ["User"],
    };

    expect(isLeaseOwnerOrDirectAssignee(m2m, lease)).toBe(false);
  });
});

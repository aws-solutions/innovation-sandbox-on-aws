// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  assignmentSk,
  parseAssignmentSk,
  principalPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";

const LEASE_ID = "00000000-0000-4000-8000-000000000001";
const PERMISSION_SET_ID = "ps-a1b2c3d4e5f60001";

describe("principal DynamoDB keys", () => {
  describe("principalPk", () => {
    it.each([
      ["USER", "user#principal-id"],
      ["GROUP", "group#principal-id"],
    ] as const)("builds a %s principal key", (principalType, expected) => {
      expect(principalPk({ principalId: "principal-id", principalType })).toBe(
        expected,
      );
    });
  });

  describe("assignmentSk", () => {
    it("builds a legacy assignment key when permissionSetId is absent", () => {
      expect(assignmentSk(LEASE_ID)).toBe(`lease#${LEASE_ID}`);
    });

    it("builds a tuple-keyed assignment key", () => {
      expect(assignmentSk(LEASE_ID, PERMISSION_SET_ID)).toBe(
        `lease#${LEASE_ID}#ps#${PERMISSION_SET_ID}`,
      );
    });

    it("treats an empty permissionSetId as absent", () => {
      expect(assignmentSk(LEASE_ID, "")).toBe(`lease#${LEASE_ID}`);
    });
  });

  describe("parseAssignmentSk", () => {
    it("parses a legacy assignment key", () => {
      expect(parseAssignmentSk(assignmentSk(LEASE_ID))).toEqual({
        leaseId: LEASE_ID,
      });
    });

    it("parses a tuple-keyed assignment key", () => {
      expect(
        parseAssignmentSk(assignmentSk(LEASE_ID, PERMISSION_SET_ID)),
      ).toEqual({
        leaseId: LEASE_ID,
        permissionSetId: PERMISSION_SET_ID,
      });
    });

    it.each([
      "groupMembership",
      "lease#",
      "lease#not-a-uuid",
      `lease#${LEASE_ID}#ps#`,
      `lease#${LEASE_ID}#ps#not-a-permission-set-id`,
      `lease#${LEASE_ID}#ps#${PERMISSION_SET_ID}#extra`,
    ])("returns undefined for invalid key %s", (sk) => {
      expect(parseAssignmentSk(sk)).toBeUndefined();
    });
  });
});

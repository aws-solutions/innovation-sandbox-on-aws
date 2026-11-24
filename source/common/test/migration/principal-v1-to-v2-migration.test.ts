// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { expect, test } from "vitest";

import {
  PersistedGroupAssignmentSchema,
  PersistedUserAssignmentSchema,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";

const LEASE_ID = "00000000-0000-4000-8000-000000000001";
const PRINCIPAL_ID = "00000000-0000-4000-8000-000000000002";
const TIMESTAMP = "2026-01-01T00:00:00.000Z";
const meta = {
  schemaVersion: 1,
  createdTime: TIMESTAMP,
  lastEditTime: TIMESTAMP,
};

const storedV1UserAssignment = {
  pk: `user#${PRINCIPAL_ID}`,
  sk: `lease#${LEASE_ID}`,
  userId: PRINCIPAL_ID,
  principalType: "USER",
  leaseId: LEASE_ID,
  assigneeEmail: "assignee@example.com",
  leaseOwnerEmail: "owner@example.com",
  addedBy: "admin@example.com",
  addedDate: TIMESTAMP,
  meta,
};

const storedV1GroupAssignment = {
  pk: `group#${PRINCIPAL_ID}`,
  sk: `lease#${LEASE_ID}`,
  leaseId: LEASE_ID,
  groupId: PRINCIPAL_ID,
  principalType: "GROUP",
  displayName: "Example group",
  leaseOwnerEmail: "owner@example.com",
  addedBy: "admin@example.com",
  addedDate: TIMESTAMP,
  meta,
};

test("stored v1 principal assignments parse unchanged under v2 schemas", () => {
  expect(PersistedUserAssignmentSchema.parse(storedV1UserAssignment)).toEqual(
    storedV1UserAssignment,
  );
  expect(PersistedGroupAssignmentSchema.parse(storedV1GroupAssignment)).toEqual(
    storedV1GroupAssignment,
  );
});

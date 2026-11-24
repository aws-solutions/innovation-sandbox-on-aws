// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * maintaining accurate and consistent schema versions for all tables is critical to the update methodology
 * of the solution (described in ADR-0002)
 *
 * this file tests that all schemas match their specified schema version. if a test fails, the test should be
 * updated to pass ONLY after verifying that schema versions have been correctly maintained.
 *
 * rules for updating schema version:
 *   - if any fields have been added or changed since the last public release of the solution, the schema version
 *   must be incremented exactly once for the next release of the solution.
 *   - changes to any schema must also include a migration script and related migration test (under test/migration)
 *   that ensures data can be safely migrated.
 */
import objectHash from "object-hash";
import { expect, test } from "vitest";

import {
  BlueprintSchemaVersion,
  PersistedBlueprintItemSchema,
  PersistedDeploymentHistoryItemSchema,
  PersistedStackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { LeaseCostHistorySchemaVersion } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import {
  LeaseTemplateSchemaVersion,
  PersistedLeaseTemplateSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  LeaseSchemaVersion,
  PersistedApprovalDeniedLeaseSchema,
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  PersistedGroupAssignmentSchema,
  PersistedGroupMembershipCacheSchema,
  PersistedUserAssignmentSchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  PersistedSandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

test("LeaseTemplate Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedLeaseTemplateSchema.shape),
  ).toMatchInlineSnapshot(`"c32a751bddd5b0a46fc55c48001d8a05fe7d39a8"`);
  expect(LeaseTemplateSchemaVersion).toEqual(5);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedPendingLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"88d3ea0904303ca4d725c0f361faf6ac7498d71e"`);
  expect(
    objectHash.sha1(PersistedApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"3fb6adbc590c12ca2b54e5760dede1da05fa2809"`);
  expect(
    objectHash.sha1(PersistedMonitoredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"b95062e00fab18bce50341d8935daabf65f7dafb"`);
  expect(
    objectHash.sha1(PersistedExpiredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"229ccd97c573895eab8f652e6bfed0c4d18006d8"`);
  expect(LeaseSchemaVersion).toEqual(5);
});

test("LeaseCostHistory Schema Version", () => {
  // The table is new in v1.4.0, so its first release ships version 1 whatever
  // its pre-release iterations changed.
  expect(LeaseCostHistorySchemaVersion).toEqual(1);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedSandboxAccountSchema.shape),
  ).toMatchInlineSnapshot(`"319848456a9a5d6f40a0ac9c64c8b0901da6b72b"`);
  expect(SandboxAccountSchemaVersion).toEqual(2);
});

test("Blueprint Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedBlueprintItemSchema.shape),
  ).toMatchInlineSnapshot(`"b2bf3101f9348f9088c3478c99a4fbb9c6ff4481"`);
  expect(
    objectHash.sha1(PersistedStackSetItemSchema.shape),
  ).toMatchInlineSnapshot(`"460d8c1516b98a06f25f60e45a076bb97352b53c"`);
  expect(
    objectHash.sha1(PersistedDeploymentHistoryItemSchema.shape),
  ).toMatchInlineSnapshot(`"06b57221051e914458db376647250d1f7bb991d1"`);
  expect(BlueprintSchemaVersion).toEqual(1);
});

test("Principal Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedUserAssignmentSchema.shape),
  ).toMatchInlineSnapshot(`"30fc54dd316113af955517b769e6d8aba860307e"`);
  expect(
    objectHash.sha1(PersistedGroupAssignmentSchema.shape),
  ).toMatchInlineSnapshot(`"fbb2c7679eb72740134d68b29c5a12b187b780d8"`);
  expect(
    objectHash.sha1(PersistedGroupMembershipCacheSchema.shape),
  ).toMatchInlineSnapshot(`"1374b4465840b33e96a8595ac78e8681f867de45"`);
  expect(PrincipalSchemaVersion).toEqual(2);
});

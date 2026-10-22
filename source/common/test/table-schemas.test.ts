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
  ).toMatchInlineSnapshot(`"80a138fb47d57bf982d41f65f383e1ee995ba5b3"`);
  expect(LeaseTemplateSchemaVersion).toEqual(4);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedPendingLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"b92958290b79eaf13a19c5d84d99f6f86e1a0bd2"`);
  expect(
    objectHash.sha1(PersistedApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"52ac06eec4ba8ec7c1dc70883e55e47d3cc58b62"`);
  expect(
    objectHash.sha1(PersistedMonitoredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"4ff31d1a0beab2d7f6ab5f3361610b792fbb31fc"`);
  expect(
    objectHash.sha1(PersistedExpiredLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"e98562864256968bbb2adcdbfeadd22de1c45d75"`);
  expect(LeaseSchemaVersion).toEqual(4);
});

test("PersistedSandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(
    objectHash.sha1(PersistedSandboxAccountSchema.shape),
  ).toMatchInlineSnapshot(`"bfe522aad6a5a225a05e11ebcf685e0220f7ead7"`);
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
  ).toMatchInlineSnapshot(`"7b6ddc9fedabd00aee402a330acfe440a8b78211"`);
  expect(
    objectHash.sha1(PersistedGroupAssignmentSchema.shape),
  ).toMatchInlineSnapshot(`"861abd7b39897a116419c11717f981405b3e7dcb"`);
  expect(
    objectHash.sha1(PersistedGroupMembershipCacheSchema.shape),
  ).toMatchInlineSnapshot(`"1374b4465840b33e96a8595ac78e8681f867de45"`);
  expect(PrincipalSchemaVersion).toEqual(1);
});

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
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  ApprovalDeniedLeaseSchema,
  ExpiredLeaseSchema,
  LeaseSchemaVersion,
  MonitoredLeaseSchema,
  PendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  SandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

test("LeaseTemplate Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(LeaseTemplateSchema.shape)).toMatchInlineSnapshot(
    `"6ab4d06254f2d6d16686616a8219a77ebe6818b9"`,
  );
  expect(LeaseTemplateSchemaVersion).toEqual(2);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(PendingLeaseSchema.shape)).toMatchInlineSnapshot(
    `"4096a07dbe58dfb3e4d4e284a3d91c60cefce423"`,
  );
  expect(
    objectHash.sha1(ApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"c4f9ac4d3adcc7c9a38e3380372b2f1dc0829dd3"`);
  expect(objectHash.sha1(MonitoredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"b90d5cc121d6ba30fab53ae3909fe54d95b0ea5e"`,
  );
  expect(objectHash.sha1(ExpiredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"200c5da2c425fc1afaf9c7367abf36b7eb5c1ebc"`,
  );
  expect(LeaseSchemaVersion).toEqual(2);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(SandboxAccountSchema.shape)).toMatchInlineSnapshot(
    `"7c239f345d00a68829596c72731d34db84081497"`,
  );
  expect(SandboxAccountSchemaVersion).toEqual(1);
});

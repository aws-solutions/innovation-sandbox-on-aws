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
  BlueprintItemSchema,
  BlueprintSchemaVersion,
  DeploymentHistoryItemSchema,
  StackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
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
    `"3d46ee015190c3e6b35cad8a244c756a13a57ae9"`,
  );
  expect(LeaseTemplateSchemaVersion).toEqual(3);
});

test("Lease Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(PendingLeaseSchema.shape)).toMatchInlineSnapshot(
    `"c4a59a3fe622dd7584cf5dfcb314f5b519a95b1c"`,
  );
  expect(
    objectHash.sha1(ApprovalDeniedLeaseSchema.shape),
  ).toMatchInlineSnapshot(`"4771510cfadbbc8d2b2be4e58edba02a7d8091cf"`);
  expect(objectHash.sha1(MonitoredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"15c4120d6254a56ebba1cf8c2d49200911ce61ed"`,
  );
  expect(objectHash.sha1(ExpiredLeaseSchema.shape)).toMatchInlineSnapshot(
    `"d6c97629462bb477448d644f94e6cac7eceb6778"`,
  );
  expect(LeaseSchemaVersion).toEqual(3);
});

test("SandboxAccount Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(SandboxAccountSchema.shape)).toMatchInlineSnapshot(
    `"48aa14f06a1a3c0c3722917f076486bd2325db9d"`,
  );
  expect(SandboxAccountSchemaVersion).toEqual(1);
});

test("Blueprint Schema Version", () => {
  //Changes to this test have critical upgrade path implications as detailed at the top of this file
  expect(objectHash.sha1(BlueprintItemSchema.shape)).toMatchInlineSnapshot(
    `"3fda6ff7037b064e2844090050a8775dc457d5d6"`,
  );
  expect(objectHash.sha1(StackSetItemSchema.shape)).toMatchInlineSnapshot(
    `"4cffc26d63954218083438cdbba4557a578c2946"`,
  );
  expect(
    objectHash.sha1(DeploymentHistoryItemSchema.shape),
  ).toMatchInlineSnapshot(`"360fa8296a0eb1ea9b83af76731b0cbe1b627d0c"`);
  expect(BlueprintSchemaVersion).toEqual(1);
});

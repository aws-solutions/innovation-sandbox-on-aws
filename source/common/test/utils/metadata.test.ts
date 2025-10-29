// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Lease,
  LeaseSchema,
  LeaseSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { describe, expect, test } from "vitest";

class TestClass {
  @validateItem(LeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public static metaEnhancedFunction(lease: Lease): Lease {
    return lease;
  }
}

describe("meta decorators", () => {
  test("applies meta to lease", () => {
    const lease = generateSchemaData(LeaseSchema, {
      status: "PendingApproval",
      meta: undefined,
    });

    const updatedLease = TestClass.metaEnhancedFunction(lease);

    expect(lease.meta).toBeUndefined;
    expect(updatedLease.meta).not.toBeUndefined;
  });
});

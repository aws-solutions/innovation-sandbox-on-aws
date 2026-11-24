// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import * as leaseCostHistoryBarrel from "@amzn/innovation-sandbox-commons/data/lease-cost-history/index.js";

describe("the lease-cost-history barrel", () => {
  test("does not re-export the Dynamo implementation", () => {
    // The frontend consumes the API types from this directory. Re-exporting the
    // implementation here puts the AWS SDK and the powertools logger one
    // accidental barrel import away from the browser bundle.
    expect(Object.keys(leaseCostHistoryBarrel)).not.toContain(
      "DynamoLeaseCostHistoryStore",
    );
  });

  test("still exports the API types, the keys, the store contract and the schemas", () => {
    const exported = Object.keys(leaseCostHistoryBarrel);
    expect(exported).toContain("LeaseCostHistoryKey");
    expect(exported).toContain("LeaseCostHistoryStore");
    expect(exported).toContain("CostObservationSchema");
    expect(exported).toContain("BreachRecordSchema");
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import { PersistedMonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { getLeaseTerminatedReason } from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

describe("getLeaseTerminatedReason", () => {
  test("returns UserTerminated reason payload for UserTerminated status", () => {
    const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
      status: "Active",
    });

    expect(getLeaseTerminatedReason("UserTerminated", lease)).toEqual({
      type: "UserTerminated",
      comment: "Terminated by user",
    });
  });

  test.each([
    ["the bill when no budget check total is given", undefined, 30],
    ["the budget check total when it is above the bill", 120, 120],
    ["the bill when it is above the budget check total", 10, 30],
  ])(
    "reports totalSpend as %s for BudgetExceeded status",
    (_case, budgetTotalSpend, expectedTotalSpend) => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        status: "Active",
        maxSpend: 100,
        totalCostAccrued: 30,
      });

      expect(
        getLeaseTerminatedReason("BudgetExceeded", lease, budgetTotalSpend),
      ).toEqual({
        type: "BudgetExceeded",
        budget: 100,
        totalSpend: expectedTotalSpend,
      });
    },
  );
});

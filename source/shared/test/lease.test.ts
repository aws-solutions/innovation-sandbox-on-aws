// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";
import { getCurrentLeaseSpend } from "../types/lease.js";

describe("getCurrentLeaseSpend", () => {
  it.each([
    ["the evaluated spend when it is higher", 12, 15, 15],
    ["the billed total when it is higher", 12, 9, 12],
    ["the billed total when the evaluated spend is null", 12, null, 12],
    ["the billed total when there is no evaluated spend", 12, undefined, 12],
  ])("returns %s", (_, totalCostAccrued, lastEvaluatedSpend, expected) => {
    expect(
      getCurrentLeaseSpend({
        totalCostAccrued,
        lastEvaluatedSpend,
        bedrockTokenMonitoringEnabled: true,
      }),
    ).toBe(expected);
  });

  it("returns the billed total when Bedrock token monitoring is off", () => {
    expect(
      getCurrentLeaseSpend({
        totalCostAccrued: 90,
        lastEvaluatedSpend: 100,
        bedrockTokenMonitoringEnabled: false,
      }),
    ).toBe(90);
  });
});

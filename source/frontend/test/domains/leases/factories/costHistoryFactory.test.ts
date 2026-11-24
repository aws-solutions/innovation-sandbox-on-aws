// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  createMockBedrockTokenCostHistory,
  createMockCostHistory,
  createMockFirstIntervalCostHistory,
  createMockNeverOptedInCostHistory,
  createMockNoBreakdownCostHistory,
  createMockNoCurrentCostHistory,
  createMockRateBreachCostHistory,
  LeaseHistoryFixture,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

const fixtures: [string, LeaseHistoryFixture][] = [
  ["rate and prediction", createMockCostHistory()],
  ["first interval", createMockFirstIntervalCostHistory()],
  ["never opted in", createMockNeverOptedInCostHistory()],
  ["no service breakdown", createMockNoBreakdownCostHistory()],
  ["rate breach", createMockRateBreachCostHistory()],
  ["no current", createMockNoCurrentCostHistory()],
  ["Bedrock token monitoring", createMockBedrockTokenCostHistory()],
];

function nullPaths(value: unknown, path = "data"): string[] {
  if (value === null) return [path];
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => nullPaths(item, `${path}[${i}]`));
  }
  if (typeof value === "object") {
    return Object.entries(value as object).flatMap(([key, member]) =>
      nullPaths(member, `${path}.${key}`),
    );
  }
  return [];
}

describe("costHistoryFactory", () => {
  describe.each(fixtures)("%s", (_name, fixture) => {
    it("should omit optional members rather than nulling them", () => {
      expect(nullPaths(fixture.data)).toEqual([]);
    });

    it("should carry the members the contract requires", () => {
      expect(fixture.status).toBe("success");
      expect(fixture.data.result).toBeInstanceOf(Array);
      expect(fixture.data.tokens).toBeInstanceOf(Array);
      expect(fixture.data.breaches).toBeInstanceOf(Array);
      expect(fixture.data.budget.thresholds).toBeInstanceOf(Array);
    });

    it("should order every series newest first", () => {
      const timestamps = fixture.data.result.map((row) => row.timestamp);
      expect(timestamps).toEqual([...timestamps].sort().reverse());
    });
  });

  it("should leave every rate-derived field absent on a first-interval lease", () => {
    const current = createMockFirstIntervalCostHistory().data.current!;

    expect(current.hourlyRate).toBeUndefined();
    expect(current.dailyRate).toBeUndefined();
    expect(current.hourlyRateWindowHours).toBeUndefined();
    expect(current.dailyRateWindowHours).toBeUndefined();
    expect(current.rateSource).toBeUndefined();
    expect(current.hoursToBudgetExhaustion).toBeUndefined();
    expect(current.services.every((s) => s.changePercent === undefined)).toBe(
      true,
    );
    expect(current.predictedCost).toBe(current.billedCostAccrued);
  });

  it("should carry a rate threshold rather than a dollar one on a RATE breach", () => {
    const breach = createMockRateBreachCostHistory().data.breaches.find(
      (entry) => entry.triggeredBy === "RATE",
    )!;

    expect(breach.thresholdDollars).toBeUndefined();
    expect(breach.thresholdRate).toBe(12);
    expect(breach.thresholdRateBasis).toBe("HOURLY");
    expect(breach.rateAtFire!).toBeGreaterThan(breach.thresholdRate!);
  });

  it("should leave current out while keeping the readings, as an unreadable newest reading does", () => {
    const data = createMockNoCurrentCostHistory().data;

    expect(data.current).toBeUndefined();
    expect(data.result).not.toHaveLength(0);
  });
});

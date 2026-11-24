// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  toBreachEntry,
  toCostHistoryResultRow,
  toTokenSeriesRows,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/cost-history-api.types.js";
import {
  BedrockTokenRowSchema,
  BreachRecordSchema,
  CostObservation,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";

// The store's disclosure test only exercises the DROP path, where `result` is
// empty, so it passes while a page of VALID rows would serialize `sk`, `ttl` and
// `meta` straight into the response body.
describe("a valid page projects to the contract row, not the stored row", () => {
  const storedRow: CostObservation = {
    leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
    sk: "COST#2026-08-11T08:00:00.000Z",
    billedCostAccrued: 60.0,
    billedCostDelta: 28.0,
    predictedCostAtRefresh: 46.0,
    latestPeriodStart: "2026-08-11",
    latestPeriodAmount: 12.0,
    serviceBreakdown: { "Amazon Bedrock": 52.1 },
    latestPeriodServiceAmounts: { "Amazon Bedrock": 10.5 },
    billedBedrockTokenCost: null,
    ttl: futureTtl(),
    meta: { schemaVersion: LeaseCostHistorySchemaVersion },
  };

  test("the projection carries the four contract fields and nothing else", () => {
    const row = toCostHistoryResultRow(storedRow);

    expect(row).toEqual({
      timestamp: "2026-08-11T08:00:00.000Z",
      billedCostAccrued: 60.0,
      predictedCostAtRefresh: 46.0,
      serviceBreakdown: { "Amazon Bedrock": 52.1 },
    });
  });

  test("an absent breakdown stays absent, not null", () => {
    const {
      serviceBreakdown,
      latestPeriodServiceAmounts,
      ...withoutBreakdown
    } = storedRow;
    void serviceBreakdown;
    void latestPeriodServiceAmounts;

    expect(toCostHistoryResultRow(withoutBreakdown)).not.toHaveProperty(
      "serviceBreakdown",
    );
  });
});

describe("the breach and token windows are projected, not spread", () => {
  const meta = { schemaVersion: LeaseCostHistorySchemaVersion };
  const leaseUuid = "750e8400-e29b-41d4-a716-446655440002";

  const storedBreach = BreachRecordSchema.parse({
    leaseUuid,
    sk: "BREACH#2026-08-11T11:00:00.000Z",
    triggeredBy: "REPORTED",
    action: "ALERT",
    thresholdDollars: 70.0,
    thresholdRate: null,
    thresholdRateBasis: null,
    billedCostAtFire: 72.0,
    predictedCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    evaluatedBy: "LEASE_MONITORING",
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    insight: null,
    ttl: futureTtl(),
    meta,
  });

  const storedToken = BedrockTokenRowSchema.parse({
    leaseUuid,
    sk: "BEDROCK_TOKEN#2026-08-11T11:00:00.000Z",
    tokens: {
      "us-east-1": {
        "anthropic.claude-3-sonnet-20240229-v1:0": {
          input: 1000,
          output: 500,
          cacheRead: 10,
          cacheWrite: 5,
        },
        "amazon.titan-text-v1": {
          input: 20,
          output: 10,
          cacheRead: 0,
          cacheWrite: 0,
        },
      },
    },
    monitoredBedrockTokenCostDelta: 1.25,
    monitoredBedrockTokenCost: 12.5,
    coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000Z" },
    ttl: futureTtl(),
    meta,
  });

  test("toBreachEntry drops the storage attributes and derives the timestamp", () => {
    const entry = toBreachEntry(storedBreach);
    const serialized = JSON.stringify(entry);

    expect(entry.timestamp).toBe("2026-08-11T11:00:00.000Z");
    for (const stored of ["leaseUuid", "sk", "ttl", "meta"]) {
      expect(entry).not.toHaveProperty(stored);
    }
    expect(serialized).not.toContain("BREACH#");
    // The response shows these, so the projection keeps them deliberately.
    expect(entry.evaluatedBy).toBe("LEASE_MONITORING");
    expect(entry.billedCostAtFire).toBe(72.0);
  });

  test("toBreachEntry carries the token poll's compared figure and its monitored Bedrock term", () => {
    const pollEntry = toBreachEntry(
      BreachRecordSchema.parse({
        ...storedBreach,
        evaluatedBy: "TOKEN_POLL",
        evaluatedSpendAtFire: 76.0,
        monitoredBedrockTokenCostAtFire: 4.0,
      }),
    );

    expect(pollEntry).toMatchObject({
      evaluatedBy: "TOKEN_POLL",
      billedCostAtFire: 72.0,
      evaluatedSpendAtFire: 76.0,
      monitoredBedrockTokenCostAtFire: 4.0,
    });
  });

  test("toBreachEntry carries a DURATION breach's hours remaining", () => {
    const duration = toBreachEntry(
      BreachRecordSchema.parse({
        ...storedBreach,
        triggeredBy: "DURATION",
        thresholdDollars: null,
        thresholdHoursRemaining: 24,
      }),
    );

    expect(duration).toMatchObject({
      triggeredBy: "DURATION",
      action: "ALERT",
      thresholdDollars: null,
      thresholdHoursRemaining: 24,
    });
  });

  test("toTokenSeriesRows flattens region then model and drops the poll anchor", () => {
    const rows = toTokenSeriesRows(storedToken);
    const serialized = JSON.stringify(rows);

    expect(rows).toHaveLength(2);
    expect(rows[0]!.region).toBe("us-east-1");
    expect(rows.map((row) => row.modelId).sort()).toEqual([
      "amazon.titan-text-v1",
      "anthropic.claude-3-sonnet-20240229-v1:0",
    ]);
    // coveredThrough and the token-cost delta are internal resume fields.
    expect(serialized).not.toContain("coveredThrough");
    expect(serialized).not.toContain("monitoredBedrockTokenCostDelta");
    expect(serialized).not.toContain("leaseUuid");
    expect(serialized).not.toContain("BEDROCK_TOKEN#");
    expect(serialized).not.toContain("schemaVersion");
    // Lease-wide as of the timestamp, so it repeats rather than being divided.
    expect(rows.every((row) => row.monitoredBedrockTokenCost === 12.5)).toBe(
      true,
    );
    expect(rows[0]!.timestamp).toBe("2026-08-11T11:00:00.000Z");
  });

  test("toTokenSeriesRows leaves monitoredBedrockTokenCost absent on an unpriced row rather than reporting 0", () => {
    const unpriced = BedrockTokenRowSchema.parse({
      ...storedToken,
      monitoredBedrockTokenCost: null,
      monitoredBedrockTokenCostDelta: null,
    });

    const rows = toTokenSeriesRows(unpriced);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => !("monitoredBedrockTokenCost" in row))).toBe(
      true,
    );
  });

  test("toTokenSeriesRows keeps a monitoredBedrockTokenCost of 0 on a row whose counts were all free", () => {
    const free = BedrockTokenRowSchema.parse({
      ...storedToken,
      monitoredBedrockTokenCost: 0,
      monitoredBedrockTokenCostDelta: 0,
    });

    const rows = toTokenSeriesRows(free);

    expect(rows).toHaveLength(2);
    expect(rows.every((row) => row.monitoredBedrockTokenCost === 0)).toBe(true);
  });

  test("a row with no token counts yields no series rows", () => {
    const empty = BedrockTokenRowSchema.parse({
      ...storedToken,
      tokens: {},
      coveredThrough: {},
      monitoredBedrockTokenCost: 0,
      monitoredBedrockTokenCostDelta: 0,
    });

    expect(toTokenSeriesRows(empty)).toEqual([]);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { afterEach, describe, expect, test, vi } from "vitest";

import {
  BEDROCK_TOKEN_SK_PREFIX,
  BREACH_SK_PREFIX,
  COST_SK_PREFIX,
  LeaseCostHistoryKey,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import {
  BedrockTokenRowSchema,
  BreachRecordSchema,
  calculateCostHistoryTtl,
  CostObservationSchema,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  now,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

const LEASE_UUID = "750e8400-e29b-41d4-a716-446655440002";
const meta = { schemaVersion: LeaseCostHistorySchemaVersion };

describe("CostObservationSchema", () => {
  // The documented cost observation row, extended with the two anchor-day fields
  // this schema adds: `latestPeriodAmount` and `latestPeriodServiceAmounts`. NOT
  // verbatim -- the doc carries neither, and this schema requires the first and
  // pairs the second with `serviceBreakdown`, so a verbatim doc row does not parse.
  const validRow = {
    leaseUuid: LEASE_UUID,
    sk: "COST#2026-08-11T08:00:00.000Z",
    billedCostAccrued: 60.0,
    billedCostDelta: 28.0,
    predictedCostAtRefresh: 46.0,
    latestPeriodStart: "2026-08-11",
    latestPeriodAmount: 12.0,
    serviceBreakdown: {
      "Amazon Bedrock": 52.1,
      "Amazon Elastic Compute Cloud - Compute": 6.4,
      "Amazon Simple Storage Service": 1.5,
    },
    latestPeriodServiceAmounts: {
      "Amazon Bedrock": 10.5,
      "Amazon Elastic Compute Cloud - Compute": 1.2,
      "Amazon Simple Storage Service": 0.3,
    },
    billedBedrockTokenCost: 44.1,
    ttl: futureTtl(),
    meta,
  };

  test("accepts breakdownCoversFrom alongside a serviceBreakdown", () => {
    expect(
      CostObservationSchema.parse({
        ...validRow,
        breakdownCoversFrom: "2026-08-10",
      }).breakdownCoversFrom,
    ).toBe("2026-08-10");
  });

  test("rejects breakdownCoversFrom when there is no serviceBreakdown to cover", () => {
    const {
      serviceBreakdown: _breakdown,
      latestPeriodServiceAmounts: _dayAmounts,
      ...noBreakdown
    } = validRow;
    const result = CostObservationSchema.safeParse({
      ...noBreakdown,
      breakdownCoversFrom: "2026-08-10",
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues.map((issue) => issue.path)).toEqual([
      ["breakdownCoversFrom"],
    ]);
  });

  test("distinguishes billedBedrockTokenCost 0.00 (no spend) from null (monitoring off)", () => {
    expect(
      CostObservationSchema.parse({ ...validRow, billedBedrockTokenCost: 0.0 })
        .billedBedrockTokenCost,
    ).toBe(0.0);
    expect(
      CostObservationSchema.parse({ ...validRow, billedBedrockTokenCost: null })
        .billedBedrockTokenCost,
    ).toBeNull();
  });

  test("accepts the anchor-day token amount, signed like its sibling, and rejects a non-number", () => {
    const parse = (latestPeriodBedrockTokenAmount: unknown) =>
      CostObservationSchema.parse({
        ...validRow,
        billedBedrockTokenCost: 44.1,
        latestPeriodBedrockTokenAmount,
      });

    expect(parse(4.1).latestPeriodBedrockTokenAmount).toBe(4.1);
    // A discount restatement can net a day negative, as it can for latestPeriodAmount.
    expect(parse(-0.5).latestPeriodBedrockTokenAmount).toBe(-0.5);
    expect(
      CostObservationSchema.parse({
        ...validRow,
        billedBedrockTokenCost: 44.1,
      }),
    ).not.toHaveProperty("latestPeriodBedrockTokenAmount");
    expect(() => parse("4.1")).toThrow();
  });

  test("rejects a sort key without milliseconds", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        sk: "COST#2026-08-11T08:00:00Z",
      }),
    ).toThrow();
  });

  test("rejects a sort key carrying a timezone offset", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        sk: "COST#2026-08-11T08:00:00.000+02:00",
      }),
    ).toThrow();
  });

  test("rejects the wrong prefix", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        sk: "BREACH#2026-08-11T08:00:00.000Z",
      }),
    ).toThrow();
  });

  test("rejects an unpadded latestPeriodStart", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        latestPeriodStart: "2026-8-1",
      }),
    ).toThrow();
  });

  test("rejects a latestPeriodStart carrying a time component", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        latestPeriodStart: "2026-08-11T00:00:00.000Z",
      }),
    ).toThrow();
  });

  test("rejects a well-shaped latestPeriodStart that is not a calendar date", () => {
    // This is differenced to size the resume window, so a value the pattern
    // admits but the calendar does not would mis-count silently.
    for (const notADate of ["9999-99-99", "2026-13-01", "2026-02-30"]) {
      expect(() =>
        CostObservationSchema.parse({
          ...validRow,
          latestPeriodStart: notADate,
        }),
      ).toThrow();
    }
  });

  test("rejects a row missing latestPeriodAmount", () => {
    const { latestPeriodAmount: _dropped, ...withoutAnchor } = validRow;
    expect(() => CostObservationSchema.parse(withoutAnchor)).toThrow();
  });

  test("rejects a breakdown without its anchor-day companion, and the reverse", () => {
    const { latestPeriodServiceAmounts: _a, ...noAnchorAmounts } = validRow;
    expect(() => CostObservationSchema.parse(noAnchorAmounts)).toThrow();
    const { serviceBreakdown: _b, ...noBreakdown } = validRow;
    expect(() =>
      CostObservationSchema.parse({
        ...noBreakdown,
        latestPeriodServiceAmounts: { "Amazon Bedrock": 10.5 },
      }),
    ).toThrow();
  });

  test("rejects an unmodelled extra attribute", () => {
    expect(() =>
      CostObservationSchema.parse({ ...validRow, somethingElse: 1 }),
    ).toThrow();
  });

  test("rejects a ttl further ahead than any retention window, relative to now", () => {
    // A fixed far-future ceiling admits the failure the bound exists to catch:
    // a row stamped decades out is one DynamoDB never acts on, so the history
    // outlives its lease. The ceiling is the longest lease the config permits plus
    // the longest retention window it permits, so it accepts a row stamped at that
    // maximum and rejects anything past it.
    const maxDaysAhead =
      CONFIG_BOUNDS.MAX_DURATION_HOURS / 24 + CONFIG_BOUNDS.MAX_TTL_DAYS;
    const pastCeiling = Math.floor(
      DateTime.now()
        .plus({ days: maxDaysAhead + 1 })
        .valueOf() / 1000,
    );
    const atCeiling = Math.floor(
      DateTime.now()
        .plus({ days: maxDaysAhead - 1 })
        .valueOf() / 1000,
    );
    const thirtyDaysAhead = Math.floor(
      DateTime.now().plus({ days: 30 }).valueOf() / 1000,
    );

    expect(() =>
      CostObservationSchema.parse({ ...validRow, ttl: pastCeiling }),
    ).toThrow();
    expect(
      CostObservationSchema.parse({ ...validRow, ttl: atCeiling }).ttl,
    ).toBe(atCeiling);
    expect(
      CostObservationSchema.parse({ ...validRow, ttl: thirtyDaysAhead }).ttl,
    ).toBe(thirtyDaysAhead);
  });

  test("rejects a serviceBreakdown with more keys than the bound", () => {
    const oversized = Object.fromEntries(
      Array.from({ length: 201 }, (_, i) => [`service-${i}`, 1]),
    );
    expect(() =>
      CostObservationSchema.parse({
        ...validRow,
        serviceBreakdown: oversized,
        latestPeriodServiceAmounts: oversized,
      }),
    ).toThrow();
  });
});

describe("BedrockTokenRowSchema", () => {
  // The documented Bedrock token row, verbatim.
  const validRow = {
    leaseUuid: LEASE_UUID,
    sk: "BEDROCK_TOKEN#2026-08-11T10:55:00.000Z",
    tokens: {
      "us-east-1": {
        "amazon.nova-pro-v1:0": {
          input: 184320,
          output: 41200,
          cacheRead: 1104000,
          cacheWrite: 92400,
        },
      },
    },
    monitoredBedrockTokenCostDelta: 1.87,
    monitoredBedrockTokenCost: 12.44,
    coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000Z" },
    ttl: futureTtl(),
    meta,
  };

  test("parses a valid documented row", () => {
    expect(BedrockTokenRowSchema.parse(validRow)).toMatchObject({
      monitoredBedrockTokenCost: 12.44,
    });
  });

  test("rejects a sort key without milliseconds", () => {
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        sk: "BEDROCK_TOKEN#2026-08-11T10:55:00Z",
      }),
    ).toThrow();
  });

  test("rejects a coveredThrough value carrying a timezone offset", () => {
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000+02:00" },
      }),
    ).toThrow();
  });

  test("rejects a seconds-only or microsecond coveredThrough", () => {
    // The resume anchor is compared across regions, so it is pinned to the same
    // fixed width as the sort keys rather than left to z.iso.datetime().
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        coveredThrough: { "us-east-1": "2026-08-11T10:54:00Z" },
      }),
    ).toThrow();
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000123Z" },
      }),
    ).toThrow();
  });

  test("rejects an unmodelled extra attribute and a negative monitoredBedrockTokenCost", () => {
    expect(() =>
      BedrockTokenRowSchema.parse({ ...validRow, somethingElse: 1 }),
    ).toThrow();
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        monitoredBedrockTokenCost: -1,
      }),
    ).toThrow();
  });

  test("rejects a cost with no token counts to attribute it to", () => {
    // The shape a batched-read zip defect produces: a cost figure belonging to
    // no region, model or measured window.
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        tokens: {},
        coveredThrough: {},
      }),
    ).toThrow();
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        tokens: {},
        coveredThrough: {},
        monitoredBedrockTokenCost: 0,
      }),
    ).toThrow();
  });

  test("accepts an unpriced row, whose costs are null rather than 0", () => {
    expect(
      BedrockTokenRowSchema.parse({
        ...validRow,
        monitoredBedrockTokenCost: null,
        monitoredBedrockTokenCostDelta: null,
      }),
    ).toMatchObject({
      monitoredBedrockTokenCost: null,
      monitoredBedrockTokenCostDelta: null,
    });
  });

  test("accepts an empty row where both costs are zero", () => {
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        tokens: {},
        coveredThrough: {},
        monitoredBedrockTokenCost: 0,
        monitoredBedrockTokenCostDelta: 0,
      }),
    ).not.toThrow();
  });

  test("rejects counts for a region with no resume anchor", () => {
    // Nothing is written for a region whose read failed, so counts without an
    // anchor mean a truncated identifier, and the next poll's window would be
    // computed from lease start.
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        coveredThrough: { "us-west-2": "2026-08-11T10:54:00.000Z" },
      }),
    ).toThrow();
  });

  test.each(["constructor", "toString", "valueOf", "hasOwnProperty"])(
    "rejects counts under the inherited key %s with no resume anchor",
    (inheritedKey) => {
      // The anchor check used to read `coveredThrough[region] === undefined`, so
      // any region name that resolves through Object.prototype satisfied it with
      // no anchor present -- the completeness rule above, bypassed. Region codes
      // come from an AWS response, and the row would then be written with a
      // resume anchor the next poll cannot find.
      expect(
        BedrockTokenRowSchema.safeParse({
          ...validRow,
          tokens: { [inheritedKey]: validRow.tokens["us-east-1"] },
          coveredThrough: {},
        }).success,
      ).toBe(false);
    },
  );

  test("accepts an inherited-looking region key when its anchor is present", () => {
    // So the fix is a prototype guard and not a blanket rejection of the name.
    expect(
      BedrockTokenRowSchema.safeParse({
        ...validRow,
        tokens: { constructor: validRow.tokens["us-east-1"] },
        coveredThrough: { constructor: "2026-08-11T10:54:00.000Z" },
      }).success,
    ).toBe(true);
  });

  test("accepts an anchor for a region whose counts are not in this row", () => {
    expect(() =>
      BedrockTokenRowSchema.parse({
        ...validRow,
        coveredThrough: {
          ...validRow.coveredThrough,
          "us-west-2": "2026-08-11T10:54:00.000Z",
        },
      }),
    ).not.toThrow();
  });

  test("rejects an unknown token type rather than stripping it", () => {
    // CloudWatch adds token metrics over time. Stripped instead of rejected, the
    // row's `tokens` would disagree with the `monitoredBedrockTokenCost` computed from the full
    // set at write time, with nothing to signal it -- no drop, no count, no warning.
    const withUnknownType = {
      ...validRow,
      tokens: {
        "us-east-1": {
          "amazon.nova-pro-v1:0": {
            ...validRow.tokens["us-east-1"]["amazon.nova-pro-v1:0"],
            reasoning: 100,
          },
        },
      },
    };

    expect(BedrockTokenRowSchema.safeParse(withUnknownType).success).toBe(
      false,
    );
  });

  test("rejects a row that passes both key caps but exceeds DynamoDB's item limit", () => {
    // 40 regions x 200 models is inside MAX_MAP_KEYS at both levels, because
    // that cap bounds each level independently and never their product. Written,
    // this throws uncaught out of appendBedrockTokenRow, the region's
    // coveredThrough never advances, and the re-read window ages out of
    // CloudWatch at 15 days -- a permanent Bedrock understatement.
    const models = Object.fromEntries(
      Array.from({ length: 200 }, (_, m) => [
        `anthropic.claude-3-5-sonnet-20241022-v2:0-variant-${String(m).padStart(3, "0")}`,
        { input: 1, output: 1, cacheRead: 1, cacheWrite: 1 },
      ]),
    );
    const regions = Array.from({ length: 40 }, (_, r) => `us-region-${r}`);
    const oversized = {
      ...validRow,
      tokens: Object.fromEntries(regions.map((region) => [region, models])),
      coveredThrough: Object.fromEntries(
        regions.map((region) => [region, "2026-08-11T10:54:00.000Z"]),
      ),
    };

    // Every per-level key cap is satisfied.
    expect(Object.keys(oversized.tokens)).toHaveLength(40);
    expect(Object.keys(oversized.tokens["us-region-0"]!)).toHaveLength(200);
    expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(
      300_000,
    );

    expect(() => BedrockTokenRowSchema.parse(oversized)).toThrow(
      /must serialize to under/,
    );
  });
});

describe("BreachRecordSchema", () => {
  // The documented breach record row, verbatim (a PREDICTED breach).
  const validRow = {
    leaseUuid: LEASE_UUID,
    sk: "BREACH#2026-08-11T11:00:00.000Z",
    triggeredBy: "PREDICTED",
    action: "ALERT",
    thresholdDollars: 70.0,
    thresholdRate: null,
    thresholdRateBasis: null,
    billedCostAtFire: 60.0,
    predictedCostAtFire: 72.0,
    evaluatedBy: "TOKEN_POLL",
    evaluatedSpendAtFire: 66.0,
    monitoredBedrockTokenCostAtFire: 26.0,
    rateAtFire: 2.0,
    rateSourceAtFire: "HOURLY",
    insight: {
      kind: "CHANGE",
      service: "Amazon Bedrock",
      amount: 52.1,
      shareOfComparedSpend: 0.87,
      changePercent: 112,
    },
    ttl: futureTtl(),
    meta,
  };

  test("rejects a negative cap, rate or cost at fire", () => {
    // Unlike CostObservationSchema.billedCostDelta, none of these can be restated
    // negative: a negative one is a corrupt audit row, and the freeze path reads
    // them back.
    const nonnegativeFields = [
      "thresholdDollars",
      "thresholdRate",
      "billedCostAtFire",
      "predictedCostAtFire",
      "evaluatedSpendAtFire",
      "monitoredBedrockTokenCostAtFire",
      "rateAtFire",
    ] as const;
    for (const field of nonnegativeFields) {
      // A RATE row is the only shape carrying thresholdRate; PREDICTED carries
      // the rest, and the pairing rules forbid mixing them.
      const base =
        field === "thresholdRate"
          ? {
              ...validRow,
              triggeredBy: "RATE",
              thresholdDollars: null,
              thresholdRate: 12.0,
              thresholdRateBasis: "HOURLY",
              predictedCostAtFire: null,
            }
          : validRow;
      expect(() =>
        BreachRecordSchema.parse({ ...base, [field]: -1e9 }),
      ).toThrow();
    }
  });

  test("parses a RATE breach with null thresholdDollars", () => {
    expect(
      BreachRecordSchema.parse({
        ...validRow,
        triggeredBy: "RATE",
        action: "ALERT",
        thresholdDollars: null,
        thresholdRate: 12.0,
        thresholdRateBasis: "HOURLY",
        predictedCostAtFire: null,
      }),
    ).toMatchObject({ triggeredBy: "RATE", action: "ALERT" });
  });

  test("rejects a RATE breach whose persisted cap is zero", () => {
    // A configured limit is strictly positive, so a zero cap on a stored RATE
    // row is corruption, not a limit that fired at any spend.
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        triggeredBy: "RATE",
        thresholdDollars: null,
        thresholdRate: 0,
        thresholdRateBasis: "HOURLY",
        predictedCostAtFire: null,
      }),
    ).toThrow();
  });

  test("accepts a fixed-width millisecond breach key", () => {
    expect(() => BreachRecordSchema.parse(validRow)).not.toThrow();
  });

  test("rejects breach keys without milliseconds or with sub-millisecond precision", () => {
    for (const sk of [
      "BREACH#2026-08-11T11:00:00Z",
      "BREACH#2026-08-11T11:00:00.000123Z",
      "BREACH#2026-08-11T11:00:00.000123456789Z",
    ]) {
      expect(() => BreachRecordSchema.parse({ ...validRow, sk })).toThrow();
    }
  });

  test("rejects an unknown triggeredBy value", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, triggeredBy: "GUESS" }),
    ).toThrow();
  });

  test("accepts a RATE breach with either action, and rejects one citing a dollar threshold", () => {
    const rateRow = {
      ...validRow,
      triggeredBy: "RATE",
      thresholdDollars: null,
      thresholdRate: 12.0,
      thresholdRateBasis: "HOURLY",
    };
    // A spend-rate limit carries its own configured action.
    expect(() =>
      BreachRecordSchema.parse({ ...rateRow, action: "FREEZE_ACCOUNT" }),
    ).not.toThrow();
    expect(() =>
      BreachRecordSchema.parse({ ...rateRow, action: "ALERT" }),
    ).not.toThrow();
    // ...and names a rate cap, never a dollar threshold.
    expect(() =>
      BreachRecordSchema.parse({ ...rateRow, thresholdDollars: 70.0 }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({ ...rateRow, thresholdRate: null }),
    ).toThrow();
    // A null basis leaves $12/hour and $12/day indistinguishable in the audit
    // trail, and the email template falls back to "hour".
    expect(() =>
      BreachRecordSchema.parse({ ...rateRow, thresholdRateBasis: null }),
    ).toThrow();
  });

  test("requires evaluated spend on a TOKEN_POLL breach and lets its monitored term be null", () => {
    // The poll owns evaluation and always calculates evaluated spend. The
    // monitored term is null where none was substituted.
    const pollRow = {
      ...validRow,
      evaluatedBy: "TOKEN_POLL",
      evaluatedSpendAtFire: 66.0,
      monitoredBedrockTokenCostAtFire: 26.0,
    };
    expect(() => BreachRecordSchema.parse(pollRow)).not.toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...pollRow,
        monitoredBedrockTokenCostAtFire: null,
      }),
    ).not.toThrow();
    expect(() =>
      BreachRecordSchema.parse({ ...pollRow, evaluatedSpendAtFire: null }),
    ).toThrow(/required on a TOKEN_POLL breach/);
  });

  test("rejects a REPORTED breach with no dollar threshold or a stray rate cap", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        triggeredBy: "REPORTED",
        thresholdDollars: null,
      }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, thresholdRate: 12.0 }),
    ).toThrow();
  });

  // The remaining pairing rules, each verified rejected rather than
  // merely documented.
  test("rejects a non-RATE breach carrying a stray thresholdRateBasis", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, thresholdRateBasis: "HOURLY" }),
    ).toThrow();
  });

  test("rejects a PREDICTED breach with no projection or no rate at fire", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, predictedCostAtFire: null }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        rateAtFire: null,
        rateSourceAtFire: null,
      }),
    ).toThrow();
  });

  test("rejects a RATE breach with no measured rate at fire", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        triggeredBy: "RATE",
        thresholdDollars: null,
        thresholdRate: 12.0,
        thresholdRateBasis: "HOURLY",
        predictedCostAtFire: null,
        rateAtFire: null,
        rateSourceAtFire: null,
      }),
    ).toThrow();
  });

  test("rejects a half-populated rate-at-fire pair", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, rateSourceAtFire: null }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        triggeredBy: "REPORTED",
        rateAtFire: null,
      }),
    ).toThrow();
  });

  test("never lets a LEASE_MONITORING breach carry an evaluated spend figure or a monitored Bedrock term", () => {
    // It compares the bill as is.
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
      }),
    ).not.toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        evaluatedBy: "LEASE_MONITORING",
        monitoredBedrockTokenCostAtFire: null,
      }),
    ).toThrow(/must be null on a LEASE_MONITORING breach/);
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: 26.0,
      }),
    ).toThrow(/must be null on a LEASE_MONITORING breach/);
  });

  // The lease's maxSpend reached: it terminates the lease, and names no
  // projection or rate.
  const maxSpendRow = {
    ...validRow,
    triggeredBy: "MAX_SPEND",
    action: "TERMINATE",
    thresholdDollars: 100.0,
    predictedCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    insight: null,
  };

  test("parses a MAX_SPEND breach from either evaluator", () => {
    expect(BreachRecordSchema.parse(maxSpendRow)).toMatchObject({
      triggeredBy: "MAX_SPEND",
      action: "TERMINATE",
      thresholdDollars: 100.0,
    });
    expect(() =>
      BreachRecordSchema.parse({
        ...maxSpendRow,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
      }),
    ).not.toThrow();
  });

  test("rejects TERMINATE on any breach but MAX_SPEND and EXPIRY", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...maxSpendRow,
        triggeredBy: "REPORTED",
      }),
    ).toThrow(/a REPORTED breach never terminates/);
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, action: "TERMINATE" }),
    ).toThrow(/a PREDICTED breach never terminates/);
  });

  test("rejects a MAX_SPEND breach that does not terminate", () => {
    for (const action of ["ALERT", "FREEZE_ACCOUNT"]) {
      expect(() =>
        BreachRecordSchema.parse({ ...maxSpendRow, action }),
      ).toThrow(/a MAX_SPEND breach always terminates/);
    }
  });

  test("rejects a MAX_SPEND breach with no cap, or with a rate or projection field", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...maxSpendRow, thresholdDollars: null }),
    ).toThrow(/required on a MAX_SPEND breach/);
    for (const stray of [
      { thresholdRate: 12.0 },
      { thresholdRateBasis: "HOURLY" },
      { predictedCostAtFire: 72.0 },
      { rateAtFire: 2.0, rateSourceAtFire: "HOURLY" },
    ]) {
      expect(() =>
        BreachRecordSchema.parse({ ...maxSpendRow, ...stray }),
      ).toThrow();
    }
  });

  // A duration threshold reached, and the lease's end: both measured in time,
  // and only by Lease Monitoring.
  const durationRow = {
    ...validRow,
    triggeredBy: "DURATION",
    action: "ALERT",
    thresholdDollars: null,
    thresholdHoursRemaining: 24,
    predictedCostAtFire: null,
    evaluatedBy: "LEASE_MONITORING",
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    insight: null,
  };
  const expiryRow = {
    ...durationRow,
    triggeredBy: "EXPIRY",
    action: "TERMINATE",
    thresholdHoursRemaining: null,
  };

  test("parses a DURATION breach that alerts or freezes, and an EXPIRY breach", () => {
    for (const action of ["ALERT", "FREEZE_ACCOUNT"]) {
      expect(
        BreachRecordSchema.parse({ ...durationRow, action }),
      ).toMatchObject({
        triggeredBy: "DURATION",
        action,
        thresholdHoursRemaining: 24,
      });
    }
    expect(BreachRecordSchema.parse(expiryRow)).toMatchObject({
      triggeredBy: "EXPIRY",
      action: "TERMINATE",
      thresholdHoursRemaining: null,
    });
  });

  test("rejects a DURATION breach with no hours remaining, and hours on any other breach", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...durationRow,
        thresholdHoursRemaining: null,
      }),
    ).toThrow(/required on a DURATION breach/);
    const { thresholdHoursRemaining: _, ...withoutHours } = durationRow;
    expect(() => BreachRecordSchema.parse(withoutHours)).toThrow(
      /required on a DURATION breach/,
    );
    expect(() =>
      BreachRecordSchema.parse({ ...durationRow, thresholdHoursRemaining: 0 }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({ ...expiryRow, thresholdHoursRemaining: 24 }),
    ).toThrow(/must be null on an EXPIRY breach/);
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, thresholdHoursRemaining: 24 }),
    ).toThrow(/must be null on a PREDICTED breach/);
  });

  test("rejects a DURATION breach that terminates, and an EXPIRY breach that does not", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...durationRow, action: "TERMINATE" }),
    ).toThrow(/a DURATION breach never terminates/);
    for (const action of ["ALERT", "FREEZE_ACCOUNT"]) {
      expect(() => BreachRecordSchema.parse({ ...expiryRow, action })).toThrow(
        /an EXPIRY breach always terminates/,
      );
    }
  });

  test("rejects a DURATION or EXPIRY breach from the token poll, or with a cost or rate figure", () => {
    for (const row of [durationRow, expiryRow]) {
      expect(() =>
        BreachRecordSchema.parse({
          ...row,
          evaluatedBy: "TOKEN_POLL",
          evaluatedSpendAtFire: 66.0,
        }),
      ).toThrow(/only checked by LEASE_MONITORING/);
      for (const stray of [
        { thresholdDollars: 100.0 },
        { thresholdRate: 12.0 },
        { thresholdRateBasis: "HOURLY" },
        { predictedCostAtFire: 72.0 },
        { rateAtFire: 2.0, rateSourceAtFire: "HOURLY" },
        { evaluatedSpendAtFire: 66.0 },
        {
          insight: {
            kind: "NEW_ENTRANT",
            service: "Amazon Bedrock",
            amount: 52.1,
          },
        },
      ]) {
        expect(() => BreachRecordSchema.parse({ ...row, ...stray })).toThrow(
          /must be null on an? (DURATION|EXPIRY) breach/,
        );
      }
    }
  });

  test("rejects an insight missing the figure its kind names", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: {
          kind: "COMPOSITION",
          service: "Amazon Bedrock",
          amount: 52.1,
        },
      }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: { kind: "CHANGE", service: "Amazon Bedrock", amount: 52.1 },
      }),
    ).toThrow();
    // NEW_ENTRANT names neither figure, so it needs neither.
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: {
          kind: "NEW_ENTRANT",
          service: "Amazon Bedrock",
          amount: 52.1,
        },
      }),
    ).not.toThrow();
  });

  test("rejects an unmodelled extra attribute, on the row and inside the insight", () => {
    expect(() =>
      BreachRecordSchema.parse({ ...validRow, somethingElse: 1 }),
    ).toThrow();
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: { ...validRow.insight, somethingElse: 1 },
      }),
    ).toThrow();
  });

  test("rejects an unbounded insight service name", () => {
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: { ...validRow.insight, service: "s".repeat(257) },
      }),
    ).toThrow();
  });

  test.each([
    ["a script tag", "<script>alert(1)</script>"],
    ["an attribute break", 'EC2" onmouseover="alert(1)'],
    ["an entity", "EC2 &amp; friends"],
    // The markup set does not cover these, and the textBody has no escaping to
    // apply: a newline renders as extra sentences in a signed ISB notification.
    [
      "a newline injection",
      "EC2\n\nYour lease is suspended. Confirm at http://x",
    ],
    ["a tab", "EC2\tInjected"],
    ["a NUL", "EC2\u0000"],
    ["a zero-width joiner", "EC2\u200dSpoof"],
  ])("rejects an insight service name carrying %s", (_label, service) => {
    // The notification copy interpolates this into htmlBody, which escapes
    // nothing, so template injection through this field is the risk.
    expect(() =>
      BreachRecordSchema.parse({
        ...validRow,
        insight: { ...validRow.insight, service },
      }),
    ).toThrow();
  });

  test.each([
    "AWS Lambda",
    "Amazon Elastic Compute Cloud - Compute",
    "AWS Cost Explorer (Bedrock)",
    "Amazon Bedrock/Claude",
    "AWS_Config",
    // A rejection here is not fail-safe: the whole detail fails to parse and the
    // notification is lost, so every legitimate charge name must be admitted.
    "anthropic.claude-3-sonnet-20240229-v1:0",
    "Acme Corp, Inc. Marketplace Subscription",
    "Amazon Q Developer + Pro",
    "Amazon Elastic Compute Cloud — Compute",
  ])("accepts the real AWS service name %s", (service) => {
    expect(
      BreachRecordSchema.parse({
        ...validRow,
        insight: { ...validRow.insight, service },
      }).insight?.service,
    ).toBe(service);
  });
});

describe("sort key ordering", () => {
  test("generated sort keys of different types sort by prefix regardless of timestamp", () => {
    const key = new LeaseCostHistoryKey(LEASE_UUID);
    // A later COST timestamp still sorts after an earlier BEDROCK_TOKEN one,
    // and a BREACH sits between them, purely on prefix.
    const bedrock = key.generateBedrockTokenSk("2026-08-11T23:59:59.999Z");
    const breach = key.generateBreachSk("2026-08-11T00:00:00.000Z");
    const cost = key.generateCostSk("2026-08-11T00:00:00.000Z");
    expect([cost, breach, bedrock].slice().sort()).toEqual([
      bedrock,
      breach,
      cost,
    ]);
  });
});

describe("LeaseCostHistoryKey", () => {
  test("generates regex-valid sort keys from a helper timestamp", () => {
    const key = new LeaseCostHistoryKey(LEASE_UUID);
    const ts = "2026-08-11T08:00:00.000Z";
    expect(key.generateCostSk(ts)).toBe(`${COST_SK_PREFIX}${ts}`);
    expect(key.generateBreachSk(ts)).toBe(`${BREACH_SK_PREFIX}${ts}`);
    expect(key.generateBedrockTokenSk(ts)).toBe(
      `${BEDROCK_TOKEN_SK_PREFIX}${ts}`,
    );
  });
});

describe("nowAsIsoDatetimeString fixed width", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  test("an exact second yields fixed-width .000Z, which passes the COST sort-key regex", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));

    const ts = nowAsIsoDatetimeString();
    expect(ts).toBe("2026-08-11T14:00:00.000Z");

    const key = new LeaseCostHistoryKey(LEASE_UUID);
    expect(() =>
      CostObservationSchema.parse({
        leaseUuid: LEASE_UUID,
        sk: key.generateCostSk(ts),
        billedCostAccrued: 0,
        billedCostDelta: 0,
        predictedCostAtRefresh: null,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 0,
        billedBedrockTokenCost: null,
        ttl: futureTtl(),
        meta,
      }),
    ).not.toThrow();
  });
});

// TtlSchema, LeaseUuidSchema and the record key bound are shared constants, so
// each was covered on one row only -- a per-field edit on either of the other
// two would have passed. These pin all three.
describe("shared field constraints hold on every row type", () => {
  const rows = {
    CostObservation: {
      schema: CostObservationSchema,
      row: {
        leaseUuid: LEASE_UUID,
        sk: "COST#2026-08-11T08:00:00.000Z",
        billedCostAccrued: 60.0,
        billedCostDelta: 28.0,
        predictedCostAtRefresh: null,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 12.0,
        billedBedrockTokenCost: null,
        ttl: futureTtl(),
        meta,
      },
    },
    BedrockTokenRow: {
      schema: BedrockTokenRowSchema,
      row: {
        leaseUuid: LEASE_UUID,
        sk: "BEDROCK_TOKEN#2026-08-11T10:55:00.000Z",
        // Zeroed rather than left with a cost: an empty-token row carrying one
        // is itself rejected, which would make these cases pass for the wrong
        // reason.
        tokens: {},
        monitoredBedrockTokenCostDelta: 0,
        monitoredBedrockTokenCost: 0,
        coveredThrough: {},
        ttl: futureTtl(),
        meta,
      },
    },
    BreachRecord: {
      schema: BreachRecordSchema,
      row: {
        leaseUuid: LEASE_UUID,
        sk: "BREACH#2026-08-11T11:00:00.000Z",
        triggeredBy: "REPORTED",
        action: "ALERT",
        thresholdDollars: 70.0,
        thresholdRate: null,
        thresholdRateBasis: null,
        billedCostAtFire: 60.0,
        predictedCostAtFire: null,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
        rateAtFire: null,
        rateSourceAtFire: null,
        insight: null,
        ttl: futureTtl(),
        meta,
      },
    },
  } as const;

  const cases = Object.entries(rows);

  test.each(cases)("%s rejects a ttl of 0", (_name, { schema, row }) => {
    expect(() => schema.parse({ ...row, ttl: 0 })).toThrow();
  });

  test.each(cases)(
    "%s rejects a millisecond-scale ttl",
    (_name, { schema, row }) => {
      expect(() => schema.parse({ ...row, ttl: 1789200000000 })).toThrow();
    },
  );

  test.each(cases)(
    "%s rejects a leaseUuid that is not a uuid",
    (_name, { schema, row }) => {
      expect(() => schema.parse({ ...row, leaseUuid: "x" })).toThrow();
    },
  );

  test("a record key longer than the bound is rejected", () => {
    expect(() =>
      CostObservationSchema.parse({
        ...rows.CostObservation.row,
        serviceBreakdown: { ["a".repeat(257)]: 1 },
        latestPeriodServiceAmounts: { ["a".repeat(257)]: 1 },
      }),
    ).toThrow();
  });
});

describe("calculateCostHistoryTtl", () => {
  const RETENTION_DAYS = 30;

  afterEach(() => {
    vi.useRealTimers();
  });

  test("a row written under that anchor parses, and its ttl is predicted", () => {
    // The bound and the anchor are separate concerns, so this pins that the anchor
    // produces a value the schema accepts rather than one it rejects.
    const expirationDate = now().plus({ days: 60 }).toISO();
    const ttl = calculateCostHistoryTtl({
      retentionDays: RETENTION_DAYS,
      expirationDate,
    });

    const row = CostObservationSchema.parse({
      leaseUuid: LEASE_UUID,
      sk: "COST#2026-08-11T08:00:00.000Z",
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      billedBedrockTokenCost: null,
      ttl,
      meta,
    });

    expect(row.ttl).toBe(
      Math.floor(
        DateTime.fromISO(expirationDate, { zone: "utc" })
          .plus({ days: RETENTION_DAYS })
          .valueOf() / 1000,
      ),
    );
  });

  test("falls back to startDate plus the lease duration when no expiry is set", () => {
    const startDate = "2026-07-12T00:00:00.000Z";

    const ttl = calculateCostHistoryTtl({
      retentionDays: RETENTION_DAYS,
      startDate,
      leaseDurationInHours: 48,
    });

    expect(ttl).toBe(
      Math.floor(
        DateTime.fromISO(startDate, { zone: "utc" })
          .plus({ hours: 48 })
          .plus({ days: RETENTION_DAYS })
          .valueOf() / 1000,
      ),
    );
  });

  test("throws on an unparseable expirationDate rather than shortening the ttl", () => {
    // Falling through to the insert anchor would stamp a shorter ttl than the
    // lease's own end, discarding history while the lease still runs.
    expect(() =>
      calculateCostHistoryTtl({
        retentionDays: RETENTION_DAYS,
        expirationDate: "not-a-datetime",
        startDate: "2026-07-12T00:00:00.000Z",
        leaseDurationInHours: 48,
      }),
    ).toThrow(/expirationDate is unusable/);
  });

  test("throws on an unparseable startDate when that branch is taken", () => {
    expect(() =>
      calculateCostHistoryTtl({
        retentionDays: RETENTION_DAYS,
        startDate: "not-a-datetime",
        leaseDurationInHours: 48,
      }),
    ).toThrow(/startDate is unusable/);
  });

  test("a stored retention window over the cap still writes on a maximum-length lease", () => {
    // The row has to remain writable, so this asserts through the schema rather
    // than against the arithmetic alone.
    vi.useFakeTimers();
    const startDate = "2026-08-11T08:00:00.000Z";
    vi.setSystemTime(new Date(startDate));

    const ttl = calculateCostHistoryTtl({
      retentionDays: CONFIG_BOUNDS.MAX_TTL_DAYS + 1,
      startDate,
      leaseDurationInHours: CONFIG_BOUNDS.MAX_DURATION_HOURS,
    });

    const row = CostObservationSchema.parse({
      leaseUuid: LEASE_UUID,
      sk: "COST#2026-08-11T08:00:00.000Z",
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      billedBedrockTokenCost: null,
      ttl,
      meta,
    });

    expect(row.ttl).toBe(
      Math.floor(
        DateTime.fromISO(startDate, { zone: "utc" })
          .plus({ hours: CONFIG_BOUNDS.MAX_DURATION_HOURS })
          .plus({ days: CONFIG_BOUNDS.MAX_TTL_DAYS })
          .valueOf() / 1000,
      ),
    );
  });

  test("anchors on the insert when the lease has no end at all", () => {
    // An indefinite lease has no expiry to anchor to, so retention runs from the
    // row rather than from a lease end that does not exist.
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T08:00:00.000Z"));

    expect(
      calculateCostHistoryTtl({
        retentionDays: RETENTION_DAYS,
        startDate: "2026-07-12T00:00:00.000Z",
      }),
    ).toBe(
      Math.floor(
        DateTime.fromISO("2026-08-11T08:00:00.000Z", { zone: "utc" })
          .plus({ days: RETENTION_DAYS })
          .valueOf() / 1000,
      ),
    );
  });
});

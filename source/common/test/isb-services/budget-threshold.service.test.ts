// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from "@aws-lambda-powertools/logger";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";
import z from "zod";

import type { AuditedWindowQueryResult } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BreachInsightSchema,
  BreachRecord,
  BreachRecordSchema,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  BreachEvaluator,
  BreachInsight,
  evaluatePredictedThresholds,
  evaluateRateCaps,
  evaluateReportedThresholds,
  evaluateSpendingControls,
  NewBreachRecord,
  persistBreachRecords,
  persistDurationBreaches,
  persistExpiryBreach,
  persistMaxSpendBreach,
  PredictedBreach,
  RateBreach,
  ReportedBreach,
  RunProjection,
  selectBreachInsight,
  selectComparedSpendInsight,
  selectSpendingControlEvents,
  SpendingControlEventContext,
  SpendingControlEventLease,
  ThresholdEvaluationLease,
  thresholdFiredLog,
  UNBILLED_BEDROCK_INSIGHT_SERVICE,
} from "@amzn/innovation-sandbox-commons/isb-services/budget-threshold/index.js";
import { isSubscribedEmailEvent } from "@amzn/innovation-sandbox-commons/isb-services/notification/email-events.js";
import { SpendRates } from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import {
  BudgetThresholdFiredLogSchema,
  SpendRateThresholdFiredLogSchema,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  BudgetThreshold,
  RateLimitEntry,
  ThresholdActionSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-shared/types/lease.js";

const noRates: SpendRates = {
  hourlyRate: null,
  dailyRate: null,
  hourlyRateWindowHours: null,
  dailyRateWindowHours: null,
};

function rates(
  hourlyRate: number | null,
  dailyRate: number | null,
): SpendRates {
  return {
    hourlyRate,
    dailyRate,
    hourlyRateWindowHours: hourlyRate === null ? null : 8,
    dailyRateWindowHours: dailyRate === null ? null : 24,
  };
}

const alertAt = (dollarsSpent: number): BudgetThreshold => ({
  dollarsSpent,
  action: "ALERT",
});
const predictedAlertAt = (dollarsSpent: number): BudgetThreshold => ({
  dollarsSpent,
  action: "ALERT",
  triggerOn: "PREDICTED",
});

const rateLimitAt =
  (basis: RateLimitEntry["basis"], action: RateLimitEntry["action"]) =>
  (rate: number): RateLimitEntry => ({ basis, rate, action });
const hourlyAlert = rateLimitAt("HOURLY", "ALERT");
const hourlyFreeze = rateLimitAt("HOURLY", "FREEZE_ACCOUNT");
const dailyAlert = rateLimitAt("DAILY", "ALERT");
const dailyFreeze = rateLimitAt("DAILY", "FREEZE_ACCOUNT");
const dollars = (breaches: { thresholdDollars: number | null }[]) =>
  breaches.map((breach) => breach.thresholdDollars);

/**
 * The handler's existing straddle, restated as an oracle: newly exceeded means
 * the stored total was below the threshold and the new total has reached it.
 */
function legacyNewlyBreached(
  thresholds: BudgetThreshold[],
  previous: number,
  current: number,
): number[] {
  return thresholds
    .filter((t) => previous < t.dollarsSpent && t.dollarsSpent <= current)
    .map((t) => t.dollarsSpent);
}

describe("evaluateReportedThresholds", () => {
  it("ignores PREDICTED thresholds and carries the threshold's own action", () => {
    const breaches = evaluateReportedThresholds({
      thresholds: [
        { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        predictedAlertAt(100),
      ],
      previousEvaluatedSpend: 80,
      evaluatedSpend: 120,
      predictedCost: null,
      rates: noRates,
      rateSource: null,
    });
    expect(breaches).toEqual([
      {
        triggeredBy: "REPORTED",
        action: "FREEZE_ACCOUNT",
        thresholdDollars: 100,
        thresholdRate: null,
        thresholdRateBasis: null,
        spendAtFire: 120,
        predictedCostAtFire: null,
        rateAtFire: null,
        rateSourceAtFire: null,
      },
    ]);
  });

  it("leaves the context empty rather than failing when the source names an unmeasured rate", () => {
    // On its own the billed evaluation does not depend on the projection, so a
    // spend-rate inconsistency does not cost a reported alert here. The
    // composite evaluation fails on the same input; see its own test.
    const inconsistent = {
      predictedCost: 131,
      rates: rates(3.5, null),
      rateSource: "DAILY" as const,
    };
    expect(
      evaluateReportedThresholds({
        thresholds: [alertAt(100)],
        previousEvaluatedSpend: 80,
        evaluatedSpend: 120,
        ...inconsistent,
      }),
    ).toMatchObject([
      {
        triggeredBy: "REPORTED",
        thresholdDollars: 100,
        predictedCostAtFire: null,
        rateAtFire: null,
        rateSourceAtFire: null,
      },
    ]);
    expect(
      evaluateReportedThresholds({
        thresholds: undefined,
        previousEvaluatedSpend: 80,
        evaluatedSpend: 120,
        ...inconsistent,
      }),
    ).toEqual([]);
  });
});

describe("evaluatePredictedThresholds", () => {
  const worked = {
    thresholds: [predictedAlertAt(70)],
    evaluatedSpend: 60,
    rates: rates(3.5, 52),
    rateSource: "HOURLY" as const,
  };

  it("fires once within an interval as the projection climbs through the line", () => {
    // 08:00 $60.00, 09:00 $63.50, 10:00 $67.00, 11:00 $70.50, 12:00 $74.00
    const runs: Array<[number | null, number]> = [
      [null, 60],
      [60, 63.5],
      [63.5, 67],
      [67, 70.5],
      [70.5, 74],
    ];
    const fired = runs.map(
      ([previousPredictedCost, predictedCost]) =>
        evaluatePredictedThresholds({
          ...worked,
          previousPredictedCost,
          predictedCost,
        }).length,
    );
    expect(fired).toEqual([0, 0, 0, 1, 0]);
  });

  it("fires again after the projection drops below the line and re-crosses it", () => {
    // Re-based down to $65 by a refresh after a teardown, then climbing again.
    expect(
      evaluatePredictedThresholds({
        ...worked,
        previousPredictedCost: 74,
        predictedCost: 65,
      }),
    ).toEqual([]);
    expect(
      evaluatePredictedThresholds({
        ...worked,
        previousPredictedCost: 65,
        predictedCost: 72,
      }),
    ).toHaveLength(1);
  });

  it("ignores REPORTED thresholds, including ones without triggerOn", () => {
    expect(
      evaluatePredictedThresholds({
        ...worked,
        thresholds: [
          alertAt(65),
          { dollarsSpent: 65, action: "ALERT", triggerOn: "REPORTED" },
        ],
        previousPredictedCost: 60,
        predictedCost: 70,
      }),
    ).toEqual([]);
  });

  it("populates the projected figure and the rate that carried it", () => {
    const [breach] = evaluatePredictedThresholds({
      ...worked,
      previousPredictedCost: 67,
      predictedCost: 70.5,
    });
    expect(breach).toEqual({
      triggeredBy: "PREDICTED",
      action: "ALERT",
      thresholdDollars: 70,
      thresholdRate: null,
      thresholdRateBasis: null,
      spendAtFire: 60,
      predictedCostAtFire: 70.5,
      rateAtFire: 3.5,
      rateSourceAtFire: "HOURLY",
    });
  });

  it("carries a freeze action through a predicted crossing", () => {
    const freezeAt70: BudgetThreshold = {
      dollarsSpent: 70,
      action: "FREEZE_ACCOUNT",
      triggerOn: "PREDICTED",
    };
    expect(
      evaluatePredictedThresholds({
        ...worked,
        thresholds: [freezeAt70],
        previousPredictedCost: 67,
        predictedCost: 70.5,
      }),
    ).toMatchObject([{ triggeredBy: "PREDICTED", action: "FREEZE_ACCOUNT" }]);
    // With no rate the same line is not evaluated: a predicted freeze cannot
    // be requested on a billed figure standing in for the projection.
    expect(
      evaluatePredictedThresholds({
        thresholds: [freezeAt70],
        previousPredictedCost: 67,
        predictedCost: 71,
        evaluatedSpend: 71,
        rates: noRates,
        rateSource: null,
      }),
    ).toEqual([]);
  });

  it("stores the daily rate in its own unit when the daily rate won", () => {
    const [breach] = evaluatePredictedThresholds({
      ...worked,
      rates: rates(1, 52),
      rateSource: "DAILY",
      previousPredictedCost: 67,
      predictedCost: 70.5,
    });
    expect(breach).toMatchObject({ rateAtFire: 52, rateSourceAtFire: "DAILY" });
  });

  it("rejects a source naming an unmeasured rate rather than recording a breach without it", () => {
    // The source and the rates come from one computation; disagreement is a
    // caller bug, and neither a projected nor a billed record would be truthful.
    expect(() =>
      evaluatePredictedThresholds({
        ...worked,
        rates: rates(null, 52),
        previousPredictedCost: 67,
        predictedCost: 70.5,
      }),
    ).toThrow("rateSource HOURLY names an unmeasured rate");
  });
});

describe("evaluateRateCaps", () => {
  const context = { evaluatedSpend: 60, predictedCost: 70.5 };

  it("produces one alert record per crossed limit, each naming its own basis", () => {
    const breaches = evaluateRateCaps({
      rateLimits: [hourlyAlert(3), dailyAlert(50)],
      rates: rates(3.5, 52),
      previousHourlyRate: 2,
      previousDailyRate: 40,
      ...context,
    });
    expect(breaches).toEqual([
      {
        triggeredBy: "RATE",
        action: "ALERT",
        thresholdDollars: null,
        thresholdRate: 3,
        thresholdRateBasis: "HOURLY",
        spendAtFire: 60,
        predictedCostAtFire: 70.5,
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      },
      {
        triggeredBy: "RATE",
        action: "ALERT",
        thresholdDollars: null,
        thresholdRate: 50,
        thresholdRateBasis: "DAILY",
        spendAtFire: 60,
        predictedCostAtFire: 70.5,
        rateAtFire: 52,
        rateSourceAtFire: "DAILY",
      },
    ]);
  });

  it("records every same-basis limit one jump crosses, each with its own action", () => {
    const breaches = evaluateRateCaps({
      rateLimits: [hourlyAlert(10), hourlyFreeze(15), hourlyAlert(20)],
      rates: rates(16, null),
      previousHourlyRate: 4,
      previousDailyRate: null,
      ...context,
    });
    expect(
      breaches.map(({ thresholdRate, action }) => ({ thresholdRate, action })),
    ).toEqual([
      { thresholdRate: 10, action: "ALERT" },
      { thresholdRate: 15, action: "FREEZE_ACCOUNT" },
    ]);
  });

  it("de-duplicates every same-basis limit against the one stored rate", () => {
    // Last run already stood above 10; only the 15 line is crossed now.
    const breaches = evaluateRateCaps({
      rateLimits: [hourlyAlert(10), hourlyAlert(15)],
      rates: rates(16, null),
      previousHourlyRate: 12,
      previousDailyRate: null,
      ...context,
    });
    expect(breaches.map((breach) => breach.thresholdRate)).toEqual([15]);
  });

  it("re-arms a rolling DAILY limit edge-triggered: 8 → 12 → 9 → 11 against 10 fires at 12 and at 11", () => {
    // Deliberate v1.4 behavior with no cooldown or hysteresis; see the
    // predictive-budget-controls design doc.
    const measured = [8, 12, 9, 11];
    let previousDailyRate: number | null = null;
    const runs = measured.map((dailyRate) => {
      const breaches = evaluateRateCaps({
        rateLimits: [dailyAlert(10)],
        rates: rates(null, dailyRate),
        previousHourlyRate: null,
        previousDailyRate,
        ...context,
      });
      previousDailyRate = dailyRate;
      return breaches;
    });
    expect(runs.map((breaches) => breaches.length)).toEqual([0, 1, 0, 1]);
    expect(
      runs.flat().map(({ rateAtFire, thresholdRateBasis }) => ({
        rateAtFire,
        thresholdRateBasis,
      })),
    ).toEqual([
      { rateAtFire: 12, thresholdRateBasis: "DAILY" },
      { rateAtFire: 11, thresholdRateBasis: "DAILY" },
    ]);
  });
});

describe("evaluateSpendingControls", () => {
  const lease: ThresholdEvaluationLease = {
    status: "Active",
    budgetThresholds: [alertAt(100), predictedAlertAt(70)],
    rateLimits: [hourlyAlert(3)],
    totalCostAccrued: 60,
    lastPredictedSpend: 67,
    lastEvaluatedHourlySpendRate: 2,
    lastEvaluatedDailySpendRate: 40,
  };
  const projection = {
    predictedCost: 70.5,
    rateSource: "HOURLY" as const,
    rates: rates(3.5, 52),
  };

  it("evaluates reported, predicted and rate thresholds together and advances the scalars", () => {
    const evaluation = evaluateSpendingControls({
      lease,
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "PREDICTED",
        thresholdDollars: 70,
        predictedCostAtFire: 70.5,
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      }),
      expect.objectContaining({
        triggeredBy: "RATE",
        thresholdRate: 3,
        predictedCostAtFire: 70.5,
        rateAtFire: 3.5,
      }),
    ]);
    expect(evaluation).toMatchObject({
      lastPredictedSpend: 70.5,
      lastEvaluatedHourlySpendRate: 3.5,
      lastEvaluatedDailySpendRate: 52,
    });
  });

  it.each([
    [80, 120],
    [0, 80],
    [100, 100],
    [105, 106],
    [130, 90],
  ])(
    "matches the existing straddle on the stored total for a lease with no triggerOn (previous %d, current %d)",
    (previous, current) => {
      const thresholds = [alertAt(80), alertAt(100), alertAt(120)];
      const evaluation = evaluateSpendingControls({
        lease: {
          ...lease,
          budgetThresholds: thresholds,
          totalCostAccrued: previous,
        },
        evaluatedSpend: current,
        projection: null,
      });
      expect(dollars(evaluation.breaches)).toEqual(
        legacyNewlyBreached(thresholds, previous, current),
      );
    },
  );

  it("compares a first projection against zero, not the billed total, so a predicted threshold below the bill fires", () => {
    const evaluation = evaluateSpendingControls({
      lease: {
        ...lease,
        budgetThresholds: [alertAt(100), predictedAlertAt(50)],
        lastPredictedSpend: undefined,
        rateLimits: undefined,
      },
      // Nothing was projected before, so the prediction goes from 0.00 to
      // 70.50 and crosses 50, which the billed 60.00 is already above.
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "PREDICTED",
        thresholdDollars: 50,
        predictedCostAtFire: 70.5,
      }),
    ]);
    expect(evaluation).toMatchObject({
      lastEvaluatedSpend: 60,
      lastPredictedSpend: 70.5,
    });
  });

  it("raises nothing again in a run where the compared figures did not move", () => {
    const evaluation = evaluateSpendingControls({
      lease: {
        ...lease,
        lastEvaluatedSpend: 105,
        lastPredictedSpend: 115.5,
        // The rates did not move either, so the hourly limit stays crossed
        // rather than being crossed again.
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 52,
      },
      // 105.00 and 115.50 were compared last run, and are again.
      evaluatedSpend: 105,
      projection: { ...projection, predictedCost: 115.5 },
    });
    expect(evaluation.breaches).toEqual([]);
    expect(evaluation).toMatchObject({
      lastEvaluatedSpend: 105,
      lastPredictedSpend: 115.5,
    });
  });

  it("stores the reported figure and keeps the stored projection where nothing was projected", () => {
    const evaluation = evaluateSpendingControls({
      lease: { ...lease, lastPredictedSpend: 92 },
      evaluatedSpend: 70,
      projection: null,
    });
    expect(evaluation).toMatchObject({
      lastEvaluatedSpend: 70,
      lastPredictedSpend: 92,
    });
  });

  it("suppresses predicted crossings and rate caps on a frozen lease but still fires reported ones", () => {
    const evaluation = evaluateSpendingControls({
      lease: { ...lease, status: "Frozen" },
      evaluatedSpend: 105,
      projection: { ...projection, predictedCost: 110 },
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "REPORTED",
        thresholdDollars: 100,
        predictedCostAtFire: 110,
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      }),
    ]);
  });

  it("keeps a reported threshold on the billed total while a predicted one at the same amount fires", () => {
    const evaluation = evaluateSpendingControls({
      lease: {
        ...lease,
        budgetThresholds: [
          { dollarsSpent: 65, action: "FREEZE_ACCOUNT" },
          predictedAlertAt(65),
        ],
        totalCostAccrued: 55,
        lastPredictedSpend: 60,
      },
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "PREDICTED",
        action: "ALERT",
        thresholdDollars: 65,
      }),
      expect.objectContaining({ triggeredBy: "RATE" }),
    ]);
  });

  it("evaluates predicted thresholds on a provisioning lease: only a freeze suppresses them", () => {
    const evaluation = evaluateSpendingControls({
      lease: { ...lease, status: "Provisioning" },
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches.map((b) => b.triggeredBy)).toEqual([
      "PREDICTED",
      "RATE",
    ]);
  });

  it("does not re-alert a daily cap the stored daily rate already exceeds", () => {
    // lastEvaluatedHourlySpendRate sits below any hourly cap, so a swapped scalar would fire.
    const evaluation = evaluateSpendingControls({
      lease: {
        ...lease,
        budgetThresholds: [],
        rateLimits: [dailyAlert(50)],
        lastEvaluatedDailySpendRate: 51,
      },
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([]);
  });

  it("holds the daily scalar through a run where only the daily window was missing", () => {
    const daily = {
      ...lease,
      budgetThresholds: [],
      rateLimits: [dailyAlert(50)],
      lastPredictedSpend: null,
      lastEvaluatedHourlySpendRate: null,
      lastEvaluatedDailySpendRate: null,
    };
    // Run A: first daily rate ($72/day, $3.00/hour, so it won), above the cap.
    const runA = evaluateSpendingControls({
      lease: daily,
      evaluatedSpend: 60,
      projection: {
        predictedCost: 66,
        rateSource: "DAILY",
        rates: rates(2.5, 72),
      },
    });
    expect(runA.breaches.map((b) => b.triggeredBy)).toEqual(["RATE"]);

    // Run B: the nearest-24h observation is the one the hourly rate used, so
    // the daily rate is null while spend is unchanged. The stored 72 holds.
    const runB = evaluateSpendingControls({
      lease: {
        ...daily,
        lastEvaluatedDailySpendRate: runA.lastEvaluatedDailySpendRate,
      },
      evaluatedSpend: 62,
      projection: {
        predictedCost: 67,
        rateSource: "HOURLY",
        rates: rates(2.5, null),
      },
    });
    expect(runB.breaches).toEqual([]);
    expect(runB.lastEvaluatedDailySpendRate).toBe(72);

    // Run C: the daily window is back and the rate never fell below the cap.
    const runC = evaluateSpendingControls({
      lease: {
        ...daily,
        lastEvaluatedDailySpendRate: runB.lastEvaluatedDailySpendRate,
      },
      evaluatedSpend: 64,
      projection: {
        predictedCost: 69,
        rateSource: "DAILY",
        rates: rates(2.5, 70),
      },
    });
    expect(runC.breaches).toEqual([]);
  });

  it("advances the scalars on a frozen lease so a suppressed crossing never fires later", () => {
    const frozen = evaluateSpendingControls({
      lease: { ...lease, status: "Frozen" },
      evaluatedSpend: 60,
      projection,
    });
    expect(frozen).toMatchObject({
      breaches: [],
      lastPredictedSpend: 70.5,
      lastEvaluatedHourlySpendRate: 3.5,
      lastEvaluatedDailySpendRate: 52,
    });

    // Unfrozen next run: the $70 line and the hourly cap are already behind
    // the stored scalars, so neither fires.
    const resumed = evaluateSpendingControls({
      lease: {
        ...lease,
        lastPredictedSpend: frozen.lastPredictedSpend,
        lastEvaluatedHourlySpendRate: frozen.lastEvaluatedHourlySpendRate,
        lastEvaluatedDailySpendRate: frozen.lastEvaluatedDailySpendRate,
      },
      evaluatedSpend: 60,
      projection: { ...projection, predictedCost: 74, rates: rates(3.6, 52) },
    });
    expect(resumed.breaches).toEqual([]);
  });

  it("fires on the first predictive evaluation when the projection is already past a line", () => {
    const evaluation = evaluateSpendingControls({
      lease: { ...lease, lastPredictedSpend: null, rateLimits: undefined },
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "PREDICTED",
        thresholdDollars: 70,
      }),
    ]);
    expect(evaluation.lastPredictedSpend).toBe(70.5);
  });

  it("fails the whole evaluation when the projection's source names an unmeasured rate", () => {
    // Nothing is recorded for the lease this run, so the reported crossing
    // below is re-evaluated next run rather than lost.
    expect(() =>
      evaluateSpendingControls({
        lease,
        evaluatedSpend: 105,
        projection: {
          ...projection,
          rateSource: "DAILY",
          rates: rates(3.5, null),
        },
      }),
    ).toThrow("rateSource DAILY names an unmeasured rate");
  });

  it("advances the scalars when nothing fired", () => {
    const evaluation = evaluateSpendingControls({
      lease: {
        ...lease,
        lastPredictedSpend: 71,
        lastEvaluatedHourlySpendRate: 3.5,
      },
      evaluatedSpend: 60,
      projection,
    });
    expect(evaluation.breaches).toEqual([]);
    expect(evaluation).toMatchObject({
      lastPredictedSpend: 70.5,
      lastEvaluatedHourlySpendRate: 3.5,
      lastEvaluatedDailySpendRate: 52,
    });
  });

  it("evaluates only reported thresholds and leaves the scalars alone without a projection", () => {
    const evaluation = evaluateSpendingControls({
      lease,
      evaluatedSpend: 105,
      projection: null,
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "REPORTED",
        thresholdDollars: 100,
        predictedCostAtFire: null,
        rateAtFire: null,
      }),
    ]);
    expect(evaluation).toMatchObject({
      lastPredictedSpend: 67,
      lastEvaluatedHourlySpendRate: 2,
      lastEvaluatedDailySpendRate: 40,
    });
  });

  it("evaluates no predicted threshold while no rate is in force, and moves the scalar past any line the billed total passed", () => {
    // The $70 PREDICTED threshold sits between lastPredictedSpend 67 and the
    // billed 105, but with no rate it is not evaluated. Only the $100 REPORTED
    // threshold fires, with no projection recorded as context.
    const evaluation = evaluateSpendingControls({
      lease,
      evaluatedSpend: 105,
      projection: { predictedCost: 105, rateSource: null, rates: noRates },
    });
    expect(evaluation.breaches).toEqual([
      expect.objectContaining({
        triggeredBy: "REPORTED",
        thresholdDollars: 100,
        predictedCostAtFire: null,
        rateAtFire: null,
      }),
    ]);
    expect(evaluation).toMatchObject({
      lastPredictedSpend: 105,
      lastEvaluatedHourlySpendRate: null,
      lastEvaluatedDailySpendRate: null,
    });

    // Once a rate exists the $70 line is already behind the stored figure, so
    // it never fires: a suppressed crossing is not fired retroactively.
    const nextRun = evaluateSpendingControls({
      lease: {
        ...lease,
        totalCostAccrued: 105,
        lastPredictedSpend: evaluation.lastPredictedSpend,
        // Dollar thresholds only: the first measured rate would cross a
        // spend-rate limit, which is a separate, legitimate crossing.
        rateLimits: [],
      },
      evaluatedSpend: 105,
      projection: {
        predictedCost: 110,
        rateSource: "HOURLY",
        rates: rates(3.5, 52),
      },
    });
    expect(nextRun.breaches).toEqual([]);
  });

  it("takes no maxSpend, so a projected figure can never be compared against it", () => {
    // Termination stays in the handlers, off the projection; the input type is the guard.
    expectTypeOf<ThresholdEvaluationLease>().not.toHaveProperty("maxSpend");
  });
});

describe("selectBreachInsight", () => {
  // The README's interval: Bedrock $52.10 of $60.00 (87%), up from $24.60.
  const previous = {
    "Amazon Bedrock": 24.6,
    "Amazon Elastic Compute Cloud - Compute": 6.2,
    "Amazon Simple Storage Service": 1.2,
  };
  const newest = {
    "Amazon Bedrock": 52.1,
    "Amazon Elastic Compute Cloud - Compute": 6.4,
    "Amazon Simple Storage Service": 1.5,
  };

  it("returns null where no breakdown is stored at all", () => {
    expect(
      selectBreachInsight({
        newestBreakdown: undefined,
        previousBreakdown: undefined,
        billedCostAccrued: 60,
      }),
    ).toBeNull();
  });

  it("returns null where the breakdown is empty or the total is zero", () => {
    expect(
      selectBreachInsight({
        newestBreakdown: {},
        previousBreakdown: undefined,
        billedCostAccrued: 60,
      }),
    ).toBeNull();
    expect(
      selectBreachInsight({
        newestBreakdown: newest,
        previousBreakdown: undefined,
        billedCostAccrued: 0,
      }),
    ).toBeNull();
  });

  it("falls back to composition when the previous breakdown is empty", () => {
    // An empty previous map is a stored observation without a breakdown, not
    // an interval in which nothing was spent; no service is new against it.
    expect(
      selectBreachInsight({
        newestBreakdown: { "Amazon EC2": 50, "Amazon Bedrock": 10 },
        previousBreakdown: {},
        billedCostAccrued: 60,
      }),
    ).toEqual({
      kind: "COMPOSITION",
      service: "Amazon EC2",
      amount: 50,
      shareOfComparedSpend: 50 / 60,
    });
  });

  it("names the largest dollar mover as a change, with its own signed percent", () => {
    const insight = selectBreachInsight({
      newestBreakdown: newest,
      previousBreakdown: previous,
      billedCostAccrued: 60,
    });
    expect(insight).toMatchObject({
      kind: "CHANGE",
      service: "Amazon Bedrock",
      amount: 52.1,
    });
    expect(insight?.changePercent).toBeCloseTo(111.8, 1);
  });

  it("names a large fall over a small rise", () => {
    // A Cost Explorer restatement took $60 off Bedrock while Lambda rose a cent.
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 40, "AWS Lambda": 10.01 },
      previousBreakdown: { "Amazon Bedrock": 100, "AWS Lambda": 10 },
      billedCostAccrued: 50.01,
    });
    expect(insight).toEqual({
      kind: "CHANGE",
      service: "Amazon Bedrock",
      amount: 40,
      changePercent: -60,
    });
  });

  it("names the largest of the new entrants that clear the floor", () => {
    // Kendra (12%) and SageMaker (19%) both qualify; Textract (4%) does not.
    const insight = selectBreachInsight({
      newestBreakdown: {
        ...newest,
        "Amazon Kendra": 10,
        "Amazon SageMaker": 16,
        "Amazon Textract": 3,
      },
      previousBreakdown: previous,
      billedCostAccrued: 85,
    });
    expect(insight).toMatchObject({
      kind: "NEW_ENTRANT",
      service: "Amazon SageMaker",
    });
  });

  it("takes shares of billedCostAccrued, not of the breakdown's own sum", () => {
    // The breakdown sums to $60 but the lease's total is $80: SageMaker is
    // 10% of the parts and only 7.5% of the whole, so it is not an entrant,
    // and the composition share is of the whole.
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 54, "Amazon SageMaker": 6 },
      previousBreakdown: { "Amazon Bedrock": 54 },
      billedCostAccrued: 80,
    });
    expect(insight).toEqual({
      kind: "COMPOSITION",
      service: "Amazon Bedrock",
      amount: 54,
      shareOfComparedSpend: 54 / 80,
    });
  });

  it("keeps the floors inclusive at sub-dollar magnitudes", () => {
    // 0.7 / 7 and (0.5 - 0.4) / 0.4 both land a rounding error short of the
    // exact ratio in binary.
    expect(
      selectBreachInsight({
        newestBreakdown: { "Amazon Bedrock": 6.3, "Amazon SageMaker": 0.7 },
        previousBreakdown: { "Amazon Bedrock": 6.3 },
        billedCostAccrued: 7,
      }),
    ).toMatchObject({ kind: "NEW_ENTRANT", service: "Amazon SageMaker" });
    expect(
      selectBreachInsight({
        newestBreakdown: { "AWS Lambda": 0.5 },
        previousBreakdown: { "AWS Lambda": 0.4 },
        billedCostAccrued: 0.5,
      }),
    ).toMatchObject({ kind: "CHANGE", service: "AWS Lambda" });
  });

  it("treats a service billed at zero last interval as a new entrant", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 20 },
      previousBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 0 },
      billedCostAccrued: 50,
    });
    expect(insight).toEqual({
      kind: "NEW_ENTRANT",
      service: "AWS Lambda",
      amount: 20,
    });
  });

  it("reports a service that vanished as a fall of 100%", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { A: 30 },
      previousBreakdown: { A: 30, B: 10 },
      billedCostAccrued: 30,
    });
    expect(insight).toEqual({
      kind: "CHANGE",
      service: "B",
      amount: 0,
      changePercent: -100,
    });
    expect(BreachInsightSchema.safeParse(insight).success).toBe(true);
  });

  it("names the earlier service when two moved the same dollars", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { A: 20, B: 110 },
      previousBreakdown: { A: 10, B: 100 },
      billedCostAccrued: 130,
    });
    expect(insight).toMatchObject({ kind: "CHANGE", service: "A" });
    expect(insight?.changePercent).toBe(100);
  });

  it("passes over an unnameable service on the previous side of a change", () => {
    // The ampersand title moved the most dollars; the next mover is named.
    const insight = selectBreachInsight({
      newestBreakdown: { "cPanel & WHM": 60, "Amazon Bedrock": 40 },
      previousBreakdown: { "cPanel & WHM": 10, "Amazon Bedrock": 30 },
      billedCostAccrued: 100,
    });
    expect(insight).toMatchObject({
      kind: "CHANGE",
      service: "Amazon Bedrock",
    });
    expect(insight?.changePercent).toBeCloseTo(33.33, 2);
    expect(BreachInsightSchema.safeParse(insight).success).toBe(true);
  });

  it("passes over a service whose name the breach record cannot carry", () => {
    // A seller-authored Marketplace title with an ampersand is skipped for the
    // next service rather than producing an insight the store would reject.
    const insight = selectBreachInsight({
      newestBreakdown: { "cPanel & WHM": 50, "Amazon Bedrock": 10 },
      previousBreakdown: undefined,
      billedCostAccrued: 60,
    });
    expect(insight).toMatchObject({
      kind: "COMPOSITION",
      service: "Amazon Bedrock",
    });
    expect(BreachInsightSchema.safeParse(insight).success).toBe(true);

    expect(
      selectBreachInsight({
        newestBreakdown: { ...newest, "Acme=Corp AMI": 20 },
        previousBreakdown: previous,
        billedCostAccrued: 80,
      }),
    ).toMatchObject({ kind: "CHANGE", service: "Amazon Bedrock" });
  });

  it("returns null when no service can be named", () => {
    expect(
      selectBreachInsight({
        newestBreakdown: { "Ben & Jerry's Data Feed": 30 },
        previousBreakdown: undefined,
        billedCostAccrued: 30,
      }),
    ).toBeNull();
  });

  it("lets a doubling service beat a two-cent new entrant", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 60, "AWS Lambda": 0.02 },
      previousBreakdown: { "Amazon Bedrock": 30 },
      billedCostAccrued: 60.02,
    });
    expect(insight).toMatchObject({
      kind: "CHANGE",
      service: "Amazon Bedrock",
      changePercent: 100,
    });
  });

  it("ranks changes by dollars, so one cent becoming five does not outrank Bedrock", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 52, "AWS Lambda": 0.05 },
      previousBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 0.01 },
      billedCostAccrued: 52.05,
    });
    expect(insight).toMatchObject({
      kind: "CHANGE",
      service: "Amazon Bedrock",
    });
    expect(insight?.changePercent).toBeCloseTo(73.33, 2);
  });

  it("falls back to composition when the largest mover moved less than a quarter", () => {
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 33, "AWS Lambda": 1 },
      previousBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 1 },
      billedCostAccrued: 34,
    });
    expect(insight).toEqual({
      kind: "COMPOSITION",
      service: "Amazon Bedrock",
      amount: 33,
      shareOfComparedSpend: 33 / 34,
    });
  });

  it("yields to composition when a small service was billed at zero last interval", () => {
    // At zero last interval Lambda has no percent to report, and at 3% of the
    // total it is under the new-entrant floor, so it is neither kind and the
    // unchanged Bedrock is named, with no division by zero on the way.
    const insight = selectBreachInsight({
      newestBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 1 },
      previousBreakdown: { "Amazon Bedrock": 30, "AWS Lambda": 0 },
      billedCostAccrued: 31,
    });
    expect(insight).toMatchObject({
      kind: "COMPOSITION",
      service: "Amazon Bedrock",
    });
    expect(BreachInsightSchema.safeParse(insight).success).toBe(true);
  });

  it("produces insights the breach record schema accepts, for every kind", () => {
    const insights = [
      selectBreachInsight({
        newestBreakdown: newest,
        previousBreakdown: undefined,
        billedCostAccrued: 60,
      }),
      selectBreachInsight({
        newestBreakdown: newest,
        previousBreakdown: previous,
        billedCostAccrued: 60,
      }),
      selectBreachInsight({
        newestBreakdown: { ...newest, "Amazon SageMaker": 7 },
        previousBreakdown: previous,
        billedCostAccrued: 67,
      }),
    ];
    expect(insights.map((insight) => insight?.kind)).toEqual([
      "COMPOSITION",
      "CHANGE",
      "NEW_ENTRANT",
    ]);
    for (const insight of insights) {
      expect(BreachInsightSchema.safeParse(insight).success).toBe(true);
    }
  });
});

describe("selectComparedSpendInsight", () => {
  // The 2026-10-14 lease: a bill that is all EC2, with far more unbilled
  // Nova Pro tokens beside it.
  const ec2 = "Amazon Elastic Compute Cloud - Compute";
  const bill = { [ec2]: 2.21, "Amazon Simple Storage Service": 0.01 };

  it("is selectBreachInsight where nothing is unbilled", () => {
    const inputs = [
      { newestBreakdown: undefined, previousBreakdown: undefined },
      { newestBreakdown: bill, previousBreakdown: undefined },
      { newestBreakdown: bill, previousBreakdown: { [ec2]: 1 } },
      {
        newestBreakdown: { ...bill, "AWS Lambda": 1 },
        previousBreakdown: bill,
      },
    ];
    for (const input of inputs) {
      for (const unbilledBedrockTokenCost of [null, 0]) {
        expect(
          selectComparedSpendInsight({
            ...input,
            billedCostAccrued: 2.22,
            unbilledBedrockTokenCost,
          }),
        ).toEqual(selectBreachInsight({ ...input, billedCostAccrued: 2.22 }));
      }
    }
  });

  it("names the unbilled Bedrock usage where it is larger than every billed service, its share taken of the bill plus it", () => {
    const insight = selectComparedSpendInsight({
      newestBreakdown: bill,
      // EC2 more than doubled, which would otherwise be the change named
      previousBreakdown: { [ec2]: 1, "Amazon Simple Storage Service": 0.01 },
      billedCostAccrued: 2.22,
      unbilledBedrockTokenCost: 5.45,
    });

    expect(insight).toEqual({
      kind: "COMPOSITION",
      service: UNBILLED_BEDROCK_INSIGHT_SERVICE,
      amount: 5.45,
      shareOfComparedSpend: 5.45 / (2.22 + 5.45),
    });
    expect(BreachInsightSchema.safeParse(insight).success).toBe(true);
  });

  it("names the largest billed service with its share of the bill plus the unbilled usage, so it never reads as all of the spend", () => {
    expect(
      selectComparedSpendInsight({
        newestBreakdown: { [ec2]: 10 },
        previousBreakdown: undefined,
        billedCostAccrued: 10,
        unbilledBedrockTokenCost: 4,
      }),
    ).toEqual({
      kind: "COMPOSITION",
      service: ec2,
      amount: 10,
      shareOfComparedSpend: 10 / 14,
    });
  });

  it("keeps a change or a new entrant on the billed breakdown while a billed service is the largest", () => {
    const previousBreakdown = { [ec2]: 4, "Amazon Simple Storage Service": 1 };
    expect(
      selectComparedSpendInsight({
        newestBreakdown: { [ec2]: 10, "Amazon Simple Storage Service": 1 },
        previousBreakdown,
        billedCostAccrued: 11,
        unbilledBedrockTokenCost: 4,
      }),
    ).toMatchObject({ kind: "CHANGE", service: ec2, amount: 10 });
    expect(
      selectComparedSpendInsight({
        newestBreakdown: {
          [ec2]: 4,
          "Amazon Simple Storage Service": 1,
          "AWS Lambda": 3,
        },
        previousBreakdown,
        billedCostAccrued: 8,
        unbilledBedrockTokenCost: 2,
      }),
    ).toEqual({ kind: "NEW_ENTRANT", service: "AWS Lambda", amount: 3 });
  });

  it("names a billed service that ties the unbilled usage", () => {
    expect(
      selectComparedSpendInsight({
        newestBreakdown: { [ec2]: 5 },
        previousBreakdown: undefined,
        billedCostAccrued: 5,
        unbilledBedrockTokenCost: 5,
      }),
    ).toMatchObject({
      kind: "COMPOSITION",
      service: ec2,
      shareOfComparedSpend: 0.5,
    });
  });

  it("names nothing where the breakdown names no service, however large the unbilled usage", () => {
    // The breakdown off, Cost Explorer not reported yet, an empty breakdown,
    // and one naming only services the record cannot carry.
    for (const [newestBreakdown, billedCostAccrued] of [
      [undefined, 0],
      [undefined, 4],
      [{}, 0],
      [{ "Seller <b>tool</b>": 4 }, 4],
    ] as const) {
      expect(
        selectComparedSpendInsight({
          newestBreakdown,
          previousBreakdown: undefined,
          billedCostAccrued,
          unbilledBedrockTokenCost: 5,
        }),
      ).toBeNull();
    }
  });

  it("returns null where the bill plus the unbilled usage is not positive", () => {
    expect(
      selectComparedSpendInsight({
        newestBreakdown: { [ec2]: 1 },
        previousBreakdown: undefined,
        billedCostAccrued: -5,
        unbilledBedrockTokenCost: 2,
      }),
    ).toBeNull();
  });
});

describe("persistBreachRecords", () => {
  const leaseUuid = "750e8400-e29b-41d4-a716-446655440002";
  const leaseMonitoring: BreachEvaluator = { evaluatedBy: "LEASE_MONITORING" };
  // Not the 30-day retention default: a ttl derived here from that default,
  // rather than taken from the caller, would not match.
  const ttl = Math.floor(now().plus({ days: 17 }).valueOf() / 1000);
  const insight: BreachInsight = {
    kind: "CHANGE",
    service: "Amazon Bedrock",
    amount: 52.1,
    changePercent: 111.8,
  };
  // One run crossing a REPORTED threshold, a PREDICTED one and the hourly cap.
  const lease: ThresholdEvaluationLease = {
    status: "Active",
    budgetThresholds: [alertAt(100), predictedAlertAt(105)],
    rateLimits: [hourlyAlert(3)],
    totalCostAccrued: 90,
    lastPredictedSpend: 95,
    lastEvaluatedHourlySpendRate: 2,
    lastEvaluatedDailySpendRate: null,
  };
  const threeBreaches = evaluateSpendingControls({
    lease,
    evaluatedSpend: 102,
    projection: {
      predictedCost: 110,
      rateSource: "HOURLY",
      rates: rates(3.5, 52),
    },
  }).breaches;

  /**
   * Validates each row the way the real store does and hands back the stored
   * item, so the pairing rules the schema enforces are exercised on the rows
   * built here from the evaluators' own breaches. Also notices an append that
   * starts while another is still pending.
   */
  function fakeStore(failOn?: number) {
    const rows: NewBreachRecord[] = [];
    let inFlight = 0;
    let overlapped = false;
    const appendBreachRecord = vi.fn(
      async (row: NewBreachRecord): Promise<BreachRecord> => {
        // Taken on entry, so the failure lands on the same append whether or
        // not the caller waited for the one before it.
        const ordinal = appendBreachRecord.mock.calls.length;
        inFlight++;
        if (inFlight > 1) {
          overlapped = true;
        }
        await Promise.resolve();
        inFlight--;
        if (ordinal === failOn) {
          throw new Error("write failed");
        }
        rows.push(row);
        return BreachRecordSchema.parse({
          ...row,
          sk: `BREACH#2026-08-11T09:00:00.00${rows.length}Z`,
          meta: { schemaVersion: LeaseCostHistorySchemaVersion },
        });
      },
    );
    return {
      services: { costHistoryStore: { appendBreachRecord } },
      appendBreachRecord,
      rows,
      overlapped: () => overlapped,
    };
  }

  it("writes one row per breach, awaiting each append before the next", async () => {
    const store = fakeStore();
    expect(threeBreaches.map((b) => b.triggeredBy)).toEqual([
      "REPORTED",
      "PREDICTED",
      "RATE",
    ]);

    const records = await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 102,
        evaluator: leaseMonitoring,
        breaches: threeBreaches,
        insight,
        ttl,
      },
      store.services,
    );

    expect(store.appendBreachRecord).toHaveBeenCalledTimes(3);
    expect(store.overlapped()).toBe(false);
    expect(store.rows).toMatchObject([
      {
        triggeredBy: "REPORTED",
        action: "ALERT",
        thresholdDollars: 100,
        billedCostAtFire: 102,
        predictedCostAtFire: 110,
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      },
      {
        triggeredBy: "PREDICTED",
        thresholdDollars: 105,
        billedCostAtFire: 102,
        predictedCostAtFire: 110,
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      },
      {
        triggeredBy: "RATE",
        thresholdRate: 3,
        thresholdRateBasis: "HOURLY",
        rateAtFire: 3.5,
        rateSourceAtFire: "HOURLY",
      },
    ]);
    // The stored items, as the store returned them.
    expect(records.map((record) => record.sk)).toEqual([
      "BREACH#2026-08-11T09:00:00.001Z",
      "BREACH#2026-08-11T09:00:00.002Z",
      "BREACH#2026-08-11T09:00:00.003Z",
    ]);
  });

  it("stamps every row as Lease Monitoring's, with the billed total it compared, the insight verbatim and the ttl given", async () => {
    const store = fakeStore();

    await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 102,
        evaluator: leaseMonitoring,
        breaches: threeBreaches,
        insight,
        ttl,
      },
      store.services,
    );

    expect(store.rows).toHaveLength(threeBreaches.length);
    for (const row of store.rows) {
      expect(row).toMatchObject({
        leaseUuid,
        billedCostAtFire: 102,
        evaluatedBy: "LEASE_MONITORING",
        // The bill as is was compared, so nothing was substituted.
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
        insight,
        ttl,
      });
    }
  });

  it("stamps the token poll's rows with the compared figure and its monitored term", async () => {
    const store = fakeStore();
    // The poll compared its thresholds against evaluated spend, so that
    // is what its breaches carry as spendAtFire.
    expect(threeBreaches.every((breach) => breach.spendAtFire === 102)).toBe(
      true,
    );

    await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 76,
        evaluator: {
          evaluatedBy: "TOKEN_POLL",
          monitoredBedrockTokenCostAtFire: 26,
        },
        breaches: threeBreaches,
        insight,
        ttl,
      },
      store.services,
    );

    expect(store.rows).toHaveLength(threeBreaches.length);
    for (const row of store.rows) {
      expect(row).toMatchObject({
        evaluatedBy: "TOKEN_POLL",
        // The billed total under the billed name; the compared figure beside it.
        billedCostAtFire: 76,
        evaluatedSpendAtFire: 102,
        monitoredBedrockTokenCostAtFire: 26,
      });
    }
  });

  it("a RATE breach names the cap and its basis and nulls the dollar threshold", async () => {
    const store = fakeStore();
    const breaches = evaluateRateCaps({
      rateLimits: [dailyAlert(50)],
      rates: rates(3.5, 52),
      previousHourlyRate: 2,
      previousDailyRate: 40,
      evaluatedSpend: 100,
      predictedCost: 110,
    });

    await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 100,
        evaluator: leaseMonitoring,
        breaches,
        insight: null,
        ttl,
      },
      store.services,
    );

    expect(store.rows).toEqual([
      {
        leaseUuid,
        triggeredBy: "RATE",
        action: "ALERT",
        thresholdDollars: null,
        thresholdRate: 50,
        thresholdRateBasis: "DAILY",
        thresholdHoursRemaining: null,
        billedCostAtFire: 100,
        predictedCostAtFire: 110,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
        rateAtFire: 52,
        rateSourceAtFire: "DAILY",
        insight: null,
        ttl,
      },
    ]);
  });

  it("a REPORTED breach with no rate in force nulls both rate-at-fire fields", async () => {
    const store = fakeStore();
    const breaches = evaluateReportedThresholds({
      thresholds: [{ dollarsSpent: 100, action: "FREEZE_ACCOUNT" }],
      previousEvaluatedSpend: 90,
      evaluatedSpend: 103,
      predictedCost: 103,
      rates: noRates,
      rateSource: null,
    });

    await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 103,
        evaluator: leaseMonitoring,
        breaches,
        insight: null,
        ttl,
      },
      store.services,
    );

    expect(store.rows).toEqual([
      {
        leaseUuid,
        triggeredBy: "REPORTED",
        action: "FREEZE_ACCOUNT",
        thresholdDollars: 100,
        thresholdRate: null,
        thresholdRateBasis: null,
        thresholdHoursRemaining: null,
        billedCostAtFire: 103,
        predictedCostAtFire: null,
        evaluatedBy: "LEASE_MONITORING",
        evaluatedSpendAtFire: null,
        monitoredBedrockTokenCostAtFire: null,
        rateAtFire: null,
        rateSourceAtFire: null,
        insight: null,
        ttl,
      },
    ]);
  });

  it("writes nothing when nothing was breached", async () => {
    const store = fakeStore();

    const records = await persistBreachRecords(
      {
        leaseUuid,
        billedCostAtFire: 102,
        evaluator: leaseMonitoring,
        breaches: [],
        insight,
        ttl,
      },
      store.services,
    );

    expect(records).toEqual([]);
    expect(store.appendBreachRecord).not.toHaveBeenCalled();
  });

  it("propagates a failed append and does not attempt the rows after it", async () => {
    const store = fakeStore(2);

    await expect(
      persistBreachRecords(
        {
          leaseUuid,
          billedCostAtFire: 102,
          evaluator: leaseMonitoring,
          breaches: threeBreaches,
          insight,
          ttl,
        },
        store.services,
      ),
    ).rejects.toThrow("write failed");

    expect(store.appendBreachRecord).toHaveBeenCalledTimes(2);
    expect(store.rows.map((row) => row.triggeredBy)).toEqual(["REPORTED"]);
  });
});

/**
 * A breach store whose read returns `history`, or throws it, and whose append
 * parses the row as the store would.
 */
function fakeServices(history: BreachRecord[] | Error) {
  const appendBreachRecord = vi.fn(
    async (row: NewBreachRecord): Promise<BreachRecord> =>
      BreachRecordSchema.parse({
        ...row,
        sk: "BREACH#2026-08-11T10:00:00.000Z",
        meta: { schemaVersion: LeaseCostHistorySchemaVersion },
      }),
  );
  const listBreachRecords = vi.fn(
    async (): Promise<AuditedWindowQueryResult<BreachRecord>> => {
      if (history instanceof Error) {
        throw history;
      }
      return {
        result: history,
        droppedRecordCount: 0,
        droppedRecordReason: null,
      };
    },
  );
  const warn = vi.fn();
  return {
    services: {
      costHistoryStore: { appendBreachRecord, listBreachRecords },
      logger: { warn } as unknown as Logger,
    },
    appendBreachRecord,
    listBreachRecords,
    warn,
  };
}

describe("persistMaxSpendBreach", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-08-11T10:00:00.000Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const leaseUuid = "750e8400-e29b-41d4-a716-446655440002";
  const ttl = Math.floor(now().plus({ days: 17 }).valueOf() / 1000);
  // The token poll's crossing: 118.00 billed plus 4.00 of monitored Bedrock cost.
  const input = {
    leaseUuid,
    billedCostAtFire: 118,
    evaluator: {
      evaluatedBy: "TOKEN_POLL",
      monitoredBedrockTokenCostAtFire: 4,
    } satisfies BreachEvaluator,
    maxSpend: 120,
    comparedCost: 122,
    leaseStartDate: "2026-08-01T00:00:00.000Z",
    ttl,
  };

  function storedMaxSpend(
    maxSpend: number,
    evaluatedBy: BreachEvaluator["evaluatedBy"] = "TOKEN_POLL",
  ): BreachRecord {
    return BreachRecordSchema.parse({
      leaseUuid,
      sk: "BREACH#2026-08-11T09:00:00.000Z",
      triggeredBy: "MAX_SPEND",
      action: "TERMINATE",
      thresholdDollars: maxSpend,
      thresholdRate: null,
      thresholdRateBasis: null,
      billedCostAtFire: 110,
      predictedCostAtFire: null,
      evaluatedBy,
      evaluatedSpendAtFire: evaluatedBy === "TOKEN_POLL" ? 121 : null,
      monitoredBedrockTokenCostAtFire: evaluatedBy === "TOKEN_POLL" ? 11 : null,
      rateAtFire: null,
      rateSourceAtFire: null,
      insight: null,
      ttl,
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    });
  }

  it("writes one MAX_SPEND row with the figures the run compared", async () => {
    const fake = fakeServices([]);

    const records = await persistMaxSpendBreach(input, fake.services);

    expect(fake.appendBreachRecord.mock.calls).toEqual([
      [
        {
          leaseUuid,
          triggeredBy: "MAX_SPEND",
          action: "TERMINATE",
          thresholdDollars: 120,
          thresholdRate: null,
          thresholdRateBasis: null,
          thresholdHoursRemaining: null,
          billedCostAtFire: 118,
          predictedCostAtFire: null,
          evaluatedBy: "TOKEN_POLL",
          evaluatedSpendAtFire: 122,
          monitoredBedrockTokenCostAtFire: 4,
          rateAtFire: null,
          rateSourceAtFire: null,
          insight: null,
          ttl,
        },
      ],
    ]);
    expect(records).toHaveLength(1);
    // The lease's breach history up to now.
    expect(fake.listBreachRecords).toHaveBeenCalledWith(leaseUuid, {
      from: "2026-08-01T00:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    });
  });

  it.each(["TOKEN_POLL", "LEASE_MONITORING"] as const)(
    "writes nothing where %s already recorded a MAX_SPEND row at this cap",
    async (evaluatedBy) => {
      const fake = fakeServices([storedMaxSpend(120, evaluatedBy)]);

      const records = await persistMaxSpendBreach(input, fake.services);

      expect(records).toEqual([]);
      expect(fake.appendBreachRecord).not.toHaveBeenCalled();
    },
  );

  it("ignores a threshold row at the same dollar figure", async () => {
    // A projected crossing of 120.00, the same figure as the cap.
    const predicted = BreachRecordSchema.parse({
      ...storedMaxSpend(120),
      triggeredBy: "PREDICTED",
      action: "ALERT",
      predictedCostAtFire: 121,
      rateAtFire: 1,
      rateSourceAtFire: "HOURLY",
    });
    const fake = fakeServices([predicted]);

    await persistMaxSpendBreach(input, fake.services);

    expect(fake.appendBreachRecord).toHaveBeenCalledWith(
      expect.objectContaining({ triggeredBy: "MAX_SPEND" }),
    );
  });

  it("writes a row where the earlier MAX_SPEND row was at another cap", async () => {
    // Reached at 100, then the cap was raised to 120 and reached again.
    const fake = fakeServices([storedMaxSpend(100)]);

    await persistMaxSpendBreach(input, fake.services);

    expect(fake.appendBreachRecord).toHaveBeenCalledTimes(1);
  });

  it("warns where the store drops breach rows it cannot read, and uses the rows it returned", async () => {
    const fake = fakeServices([]);
    fake.listBreachRecords.mockResolvedValueOnce({
      result: [storedMaxSpend(120)],
      droppedRecordCount: 1,
      droppedRecordReason: "SCHEMA_VALIDATION",
    });

    const records = await persistMaxSpendBreach(input, fake.services);

    expect(records).toEqual([]);
    expect(fake.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "dropped 1 unreadable rows; an earlier maxSpend breach may be missed",
      ),
      expect.objectContaining({ leaseId: leaseUuid, droppedRecordCount: 1 }),
    );
  });

  it("writes the row and warns where the history cannot be read", async () => {
    const fake = fakeServices(new Error("table unavailable"));

    await persistMaxSpendBreach(input, fake.services);

    expect(fake.appendBreachRecord).toHaveBeenCalledTimes(1);
    expect(fake.warn).toHaveBeenCalledWith(
      expect.stringContaining("assuming no earlier maxSpend breach"),
      expect.objectContaining({ leaseId: leaseUuid }),
    );
  });
});

describe("persistDurationBreaches and persistExpiryBreach", () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime("2026-08-11T10:00:00.000Z");
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const leaseUuid = "750e8400-e29b-41d4-a716-446655440002";
  const ttl = Math.floor(now().plus({ days: 17 }).valueOf() / 1000);
  // Measured in time, so every cost and rate field but the billed total is null.
  const timeRow = {
    leaseUuid,
    thresholdDollars: null,
    thresholdRate: null,
    thresholdRateBasis: null,
    billedCostAtFire: 64,
    predictedCostAtFire: null,
    evaluatedBy: "LEASE_MONITORING",
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    insight: null,
    ttl,
  };
  const expiryInput = {
    leaseUuid,
    expirationDate: "2026-08-11T09:00:00.000Z",
    billedCostAtFire: 64,
    ttl,
  };

  function storedExpiry(sk: string): BreachRecord {
    return BreachRecordSchema.parse({
      ...timeRow,
      sk,
      triggeredBy: "EXPIRY",
      action: "TERMINATE",
      thresholdHoursRemaining: null,
      meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    });
  }

  it("writes one DURATION row per threshold reached, naming its hours and its action", async () => {
    const fake = fakeServices([]);

    const records = await persistDurationBreaches(
      {
        leaseUuid,
        billedCostAtFire: 64,
        thresholds: [
          { hoursRemaining: 48, action: "ALERT" },
          { hoursRemaining: 24, action: "FREEZE_ACCOUNT" },
        ],
        ttl,
      },
      fake.services,
    );

    expect(fake.appendBreachRecord.mock.calls).toEqual([
      [
        {
          ...timeRow,
          triggeredBy: "DURATION",
          action: "ALERT",
          thresholdHoursRemaining: 48,
        },
      ],
      [
        {
          ...timeRow,
          triggeredBy: "DURATION",
          action: "FREEZE_ACCOUNT",
          thresholdHoursRemaining: 24,
        },
      ],
    ]);
    expect(records).toHaveLength(2);
    // A crossing is newly reached against the lease's last check, so there is
    // nothing to read back.
    expect(fake.listBreachRecords).not.toHaveBeenCalled();
  });

  it("writes one EXPIRY row that terminates, reading the history since the lease's end", async () => {
    const fake = fakeServices([]);

    const records = await persistExpiryBreach(expiryInput, fake.services);

    expect(fake.appendBreachRecord.mock.calls).toEqual([
      [
        {
          ...timeRow,
          triggeredBy: "EXPIRY",
          action: "TERMINATE",
          thresholdHoursRemaining: null,
        },
      ],
    ]);
    expect(records).toHaveLength(1);
    expect(fake.listBreachRecords).toHaveBeenCalledWith(leaseUuid, {
      from: "2026-08-11T09:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    });
  });

  it("writes nothing where an EXPIRY row has been recorded since the lease's end", async () => {
    const fake = fakeServices([
      storedExpiry("BREACH#2026-08-11T09:05:00.000Z"),
    ]);

    const records = await persistExpiryBreach(expiryInput, fake.services);

    expect(records).toEqual([]);
    expect(fake.appendBreachRecord).not.toHaveBeenCalled();
  });

  it("ignores a duration row recorded since the lease's end", async () => {
    const duration = BreachRecordSchema.parse({
      ...storedExpiry("BREACH#2026-08-11T09:05:00.000Z"),
      triggeredBy: "DURATION",
      action: "ALERT",
      thresholdHoursRemaining: 1,
    });
    const fake = fakeServices([duration]);

    await persistExpiryBreach(expiryInput, fake.services);

    expect(fake.appendBreachRecord).toHaveBeenCalledTimes(1);
  });

  it("reads from the end with the milliseconds the read's bounds need, where the API stored it without", async () => {
    const fake = fakeServices([]);

    await persistExpiryBreach(
      { ...expiryInput, expirationDate: "2026-08-11T09:00:00Z" },
      fake.services,
    );

    expect(fake.listBreachRecords).toHaveBeenCalledWith(leaseUuid, {
      from: "2026-08-11T09:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    });
  });

  it("writes the row and warns where the history cannot be read", async () => {
    const fake = fakeServices(new Error("table unavailable"));

    await persistExpiryBreach(expiryInput, fake.services);

    expect(fake.appendBreachRecord).toHaveBeenCalledTimes(1);
    expect(fake.warn).toHaveBeenCalledWith(
      expect.stringContaining("assuming no earlier expiry breach"),
      expect.objectContaining({ leaseId: leaseUuid }),
    );
  });
});

describe("selectSpendingControlEvents", () => {
  const lease: SpendingControlEventLease = {
    uuid: "750e8400-e29b-41d4-a716-446655440002",
    userEmail: "user@example.com",
    awsAccountId: "123456789012",
    maxSpend: 200,
    status: "Active",
  };
  const leaseId = { userEmail: lease.userEmail, uuid: lease.uuid };
  const context: SpendingControlEventContext = {
    hoursToBudgetExhaustion: 8.4,
    lastReportedAt: "2026-08-11T08:00:00.000Z",
  };
  const noContext: SpendingControlEventContext = {
    hoursToBudgetExhaustion: null,
    lastReportedAt: undefined,
  };
  const insight: BreachInsight = {
    kind: "COMPOSITION",
    service: "Amazon Bedrock",
    amount: 52.1,
    shareOfComparedSpend: 0.87,
  };
  const carried: RunProjection = {
    predictedCost: 110,
    rateSource: "HOURLY",
    rates: rates(3.5, 52),
  };

  /**
   * Breaches straight from the evaluators, so the events are built from what
   * a run produces rather than from hand-written breaches. The stored figures
   * sit below every line used here, and the run's are 102 billed and 110
   * projected unless a test says otherwise.
   */
  function breachesOf(
    budgetThresholds: BudgetThreshold[],
    options: {
      rateLimits?: RateLimitEntry[];
      totalCostAccrued?: number;
      evaluatedSpend?: number;
      projection?: RunProjection | null;
    } = {},
  ) {
    return evaluateSpendingControls({
      lease: {
        status: "Active",
        budgetThresholds,
        rateLimits: options.rateLimits,
        totalCostAccrued: options.totalCostAccrued ?? 90,
        lastPredictedSpend: 95,
        lastEvaluatedHourlySpendRate: 2,
        lastEvaluatedDailySpendRate: 40,
      },
      evaluatedSpend: options.evaluatedSpend ?? 102,
      projection:
        options.projection === undefined ? carried : options.projection,
    }).breaches;
  }

  const freezeAt = (dollarsSpent: number): BudgetThreshold => ({
    dollarsSpent,
    action: "FREEZE_ACCOUNT",
  });
  /** The dollar line alerted on; a spend-rate alert, which names none, fails the comparison. */
  const alertedDollars = (
    alert: ReturnType<typeof selectSpendingControlEvents>["alert"],
  ): number | "RATE" | null => {
    if (alert === null) {
      return null;
    }
    return "budgetThresholdTriggered" in alert.Detail
      ? alert.Detail.budgetThresholdTriggered
      : "RATE";
  };

  describe("on an Active lease", () => {
    const predictedFreezeAt98: BudgetThreshold = {
      dollarsSpent: 98,
      action: "FREEZE_ACCOUNT",
      triggerOn: "PREDICTED",
    };

    // The billed total went from 90 to 102 and the projection from 95 to 110.
    it.each([
      [
        "a freeze above an alert suppresses the alert",
        [alertAt(95), freezeAt(100)],
        {},
        100,
        null,
      ],
      [
        "a freeze below a higher alert yields both",
        [freezeAt(95), alertAt(100)],
        {},
        95,
        100,
      ],
      [
        "two freezes select the higher",
        [freezeAt(95), freezeAt(100)],
        {},
        100,
        null,
      ],
      [
        "a reported freeze outranks a lower projected freeze",
        [freezeAt(100), predictedFreezeAt98],
        {},
        100,
        null,
      ],
      [
        "a projected freeze crossed alone is selected",
        [freezeAt(100), predictedFreezeAt98],
        { totalCostAccrued: 101 },
        98,
        null,
      ],
      [
        "a dollar freeze holds the alert slot against a rate alert",
        [freezeAt(100)],
        { rateLimits: [hourlyAlert(3)] },
        100,
        null,
      ],
    ] as const)(
      "%s",
      (
        _name,
        thresholds,
        options,
        selectedFreezeThreshold,
        selectedAlertThreshold,
      ) => {
        const selection = selectSpendingControlEvents({
          lease,
          billedCostAccrued: 102,
          breaches: breachesOf(
            [...thresholds],
            options as Parameters<typeof breachesOf>[1],
          ),
          insight: null,
          context,
        });

        expect(
          selection.freeze?.Detail.reason.type === "BudgetExceeded"
            ? selection.freeze.Detail.reason.triggeredBudgetThreshold
            : null,
        ).toBe(selectedFreezeThreshold);
        expect(alertedDollars(selection.alert)).toBe(selectedAlertThreshold);
      },
    );
  });

  describe("on a lease that is not Active", () => {
    // The billed total went from 90 to 102.
    it.each([
      [
        "the freeze is not selected and does not suppress the alert below it",
        "Frozen",
        [alertAt(95), freezeAt(100)],
        null,
        95,
      ],
      [
        "the freeze does not suppress a higher alert",
        "Frozen",
        [freezeAt(95), alertAt(98), freezeAt(100)],
        null,
        98,
      ],
      ["a freeze alone selects nothing", "Frozen", [freezeAt(100)], null, null],
      [
        "an Active lease still selects the freeze",
        "Active",
        [alertAt(95), freezeAt(100)],
        100,
        null,
      ],
    ] as const)(
      "%s",
      (
        _name,
        status,
        thresholds,
        selectedFreezeThreshold,
        selectedAlertThreshold,
      ) => {
        const selection = selectSpendingControlEvents({
          lease: { ...lease, status },
          billedCostAccrued: 102,
          breaches: breachesOf([...thresholds], { projection: null }),
          insight: null,
          context,
        });

        expect(
          selection.freeze?.Detail.reason.type === "BudgetExceeded"
            ? selection.freeze.Detail.reason.triggeredBudgetThreshold
            : null,
        ).toBe(selectedFreezeThreshold);
        expect(alertedDollars(selection.alert)).toBe(selectedAlertThreshold);
      },
    );
  });

  it("emits the freeze and the alert the handler has always emitted for a lease with no triggerOn", () => {
    // The handler's own scenario: $40 to $120 in one scan past a $60 freeze
    // and a $100 alert, with no projection in play.
    const selection = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 120,
      breaches: breachesOf([freezeAt(60), alertAt(100)], {
        totalCostAccrued: 40,
        evaluatedSpend: 120,
        projection: null,
      }),
      insight: null,
      context: noContext,
    });

    expect(selection.freeze?.Detail).toEqual({
      leaseId,
      accountId: lease.awsAccountId,
      reason: {
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 60,
        budget: 200,
        totalSpend: 120,
        triggeredBy: "REPORTED",
      },
    });
    // Optional on the freeze schema, so the key is absent, not null or undefined.
    expect(selection.freeze?.Detail.reason).not.toHaveProperty("rateSource");
    expect(selection.alert?.Detail).toEqual({
      leaseId,
      accountId: lease.awsAccountId,
      budget: 200,
      budgetThresholdTriggered: 100,
      totalSpend: 120,
      actionRequested: "ALERT",
      triggeredBy: "REPORTED",
      predictedCost: null,
      rate: null,
      rateSource: null,
      hoursToBudgetExhaustion: null,
      insight: null,
    });
  });

  it("alerts on the highest crossed threshold whichever figure crossed it", () => {
    // $100 crossed by the billed total, $105 by the projection: $105 wins and
    // the alert reads as a projection.
    const predictedWins = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([alertAt(100), predictedAlertAt(105)]),
      insight,
      context,
    });
    expect(predictedWins.freeze).toBeNull();
    expect(predictedWins.alert?.Detail).toMatchObject({
      triggeredBy: "PREDICTED",
      budgetThresholdTriggered: 105,
      actionRequested: "ALERT",
      totalSpend: 102,
      predictedCost: 110,
      rate: 3.5,
      rateSource: "HOURLY",
      hoursToBudgetExhaustion: 8.4,
      lastReportedAt: "2026-08-11T08:00:00.000Z",
      insight,
    });

    // $96 crossed by the projection, $100 by the billed total: $100 wins, and
    // the projection rides along as context.
    const reportedWins = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([alertAt(100), predictedAlertAt(96)]),
      insight,
      context,
    });
    expect(reportedWins.alert?.Detail).toMatchObject({
      triggeredBy: "REPORTED",
      budgetThresholdTriggered: 100,
      predictedCost: 110,
      rate: 3.5,
      rateSource: "HOURLY",
    });
  });

  it("requests the freeze for a predicted freeze threshold and suppresses its paired alert", () => {
    const selection = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([
        { dollarsSpent: 105, action: "FREEZE_ACCOUNT", triggerOn: "PREDICTED" },
      ]),
      insight,
      context,
    });

    // The one threshold type the account lifecycle manager acts on.
    expect(selection.freeze?.DetailType).toBe(
      EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
    );
    expect(selection.freeze?.Detail.reason).toEqual({
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 105,
      budget: 200,
      totalSpend: 102,
      triggeredBy: "PREDICTED",
      rateSource: "HOURLY",
    });
    expect(selection.alert).toBeNull();
  });

  it("suppresses the paired alert only when the freeze threshold is itself the largest crossed", () => {
    // The breaches compared against 102; the caller states 98 as the billed
    // total, as when the token poll substituted a monitored Bedrock term into the
    // comparison. The events carry the caller's figure.
    const freezeLargest = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 98,
      breaches: breachesOf([alertAt(96), freezeAt(100)]),
      insight: null,
      context,
    });
    // A billed crossing names no rate source on the freeze, even with a rate
    // in force: this event has no rate figure for the source to qualify.
    expect(freezeLargest.freeze?.Detail.reason).toEqual({
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 100,
      budget: 200,
      totalSpend: 98,
      triggeredBy: "REPORTED",
    });
    expect(freezeLargest.alert).toBeNull();

    const alertLargest = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 98,
      breaches: breachesOf([freezeAt(96), alertAt(100)]),
      insight: null,
      context,
    });
    expect(alertLargest.freeze?.Detail.reason).toMatchObject({
      triggeredBudgetThreshold: 96,
      totalSpend: 98,
    });
    expect(alertLargest.alert?.Detail).toMatchObject({
      budgetThresholdTriggered: 100,
      totalSpend: 98,
    });
  });

  it.each([[[freezeAt(100), alertAt(100)]], [[alertAt(100), freezeAt(100)]]])(
    "lets a freeze at the same line as an alert suppress it whichever the template lists first (%j)",
    (thresholds) => {
      const selection = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: breachesOf(thresholds),
        insight: null,
        context,
      });
      expect(selection.freeze?.Detail.reason).toMatchObject({
        triggeredBudgetThreshold: 100,
      });
      expect(selection.alert).toBeNull();
    },
  );

  it("prefers the billed crossing when both figures crossed the same line, whichever breach comes first", () => {
    // The evaluators list billed crossings first, so the reversed list is the
    // order a caller assembling breaches from elsewhere could hand over.
    const sameLine = breachesOf([alertAt(100), predictedAlertAt(100)]);
    expect(sameLine.map((breach) => breach.triggeredBy)).toEqual([
      "REPORTED",
      "PREDICTED",
    ]);
    for (const breaches of [sameLine, [...sameLine].reverse()]) {
      const selection = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches,
        insight: null,
        context,
      });
      expect(selection.alert?.Detail).toMatchObject({
        triggeredBy: "REPORTED",
        budgetThresholdTriggered: 100,
      });
    }
  });

  it("carries each event's own trigger kind when a projected freeze sits below a billed alert", () => {
    const selection = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([
        { dollarsSpent: 96, action: "FREEZE_ACCOUNT", triggerOn: "PREDICTED" },
        alertAt(100),
      ]),
      insight,
      context,
    });

    expect(selection.freeze?.Detail.reason).toEqual({
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 96,
      budget: 200,
      totalSpend: 102,
      triggeredBy: "PREDICTED",
      rateSource: "HOURLY",
    });
    expect(selection.alert?.Detail).toMatchObject({
      triggeredBy: "REPORTED",
      budgetThresholdTriggered: 100,
      actionRequested: "ALERT",
      predictedCost: 110,
      rate: 3.5,
      rateSource: "HOURLY",
    });
  });

  it.each([[[80, 120]], [[120, 80]]])(
    "names the largest of two freeze thresholds crossed in one run, stored as %j",
    (order) => {
      const selection = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 130,
        breaches: breachesOf(order.map(freezeAt), {
          totalCostAccrued: 70,
          evaluatedSpend: 130,
          projection: null,
        }),
        insight: null,
        context: noContext,
      });
      expect(selection.freeze?.Detail.reason).toMatchObject({
        triggeredBudgetThreshold: 120,
      });
      expect(selection.alert).toBeNull();
    },
  );

  it("alerts on a spend-rate limit through its own alert type, which the email subscription carries, and never requests a freeze", () => {
    const selection = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], { rateLimits: [hourlyAlert(3)] }),
      insight,
      context,
    });

    // No freeze event: an ALERT limit asks the lifecycle manager for nothing.
    expect(selection.freeze).toBeNull();
    expect(selection.alert).toBeInstanceOf(
      LeaseSpendRateThresholdBreachedAlert,
    );
    expect(selection.alert?.DetailType).toBe(
      EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
    );
    expect(selection.alert?.DetailType).toBe("LeaseSpendRateThresholdAlert");
    expect(isSubscribedEmailEvent(selection.alert!.DetailType)).toBe(true);
    expect(selection.alert?.Detail).toEqual({
      leaseId,
      accountId: lease.awsAccountId,
      rateBasis: "HOURLY",
      thresholdRate: 3,
      measuredRate: 3.5,
      budget: 200,
      totalSpend: 102,
      predictedCost: 110,
      hoursToBudgetExhaustion: 8.4,
      lastReportedAt: "2026-08-11T08:00:00.000Z",
      insight,
    });
    // The dollar-alert fields have no place on the spend-rate contract.
    for (const key of ["triggeredBy", "actionRequested", "rateSource"]) {
      expect(selection.alert?.Detail).not.toHaveProperty(key);
    }
  });

  it("names the limit exceeded by the larger share of itself when both are crossed, the hourly one on a tie", () => {
    // 3.5 against 3 is 17% over; 70 against 50 is 40% over.
    const daily = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], {
        rateLimits: [hourlyAlert(3), dailyAlert(50)],
        projection: { ...carried, rates: rates(3.5, 70) },
      }),
      insight: null,
      context,
    });
    expect(daily.alert?.DetailType).toBe(
      EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
    );
    expect(daily.alert?.Detail).toMatchObject({
      rateBasis: "DAILY",
      thresholdRate: 50,
      measuredRate: 70,
    });

    // Share of the limit, not dollars over it: 6 against 3 is double for $3
    // over, 60 against 50 is a fifth over for $10 over.
    const hourly = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], {
        rateLimits: [hourlyAlert(3), dailyAlert(50)],
        projection: { ...carried, rates: rates(6, 60) },
      }),
      insight: null,
      context,
    });
    expect(hourly.alert?.Detail).toMatchObject({
      thresholdRate: 3,
      rateBasis: "HOURLY",
    });

    // 3.75 against 2.5 and 75 against 50 are both half again over. The
    // evaluators list the hourly limit first, so the reversed list is the order
    // a caller assembling breaches from elsewhere could hand over.
    const tied = breachesOf([], {
      rateLimits: [hourlyAlert(2.5), dailyAlert(50)],
      projection: { ...carried, rates: rates(3.75, 75) },
    });
    expect(tied.map((breach) => breach.thresholdRateBasis)).toEqual([
      "HOURLY",
      "DAILY",
    ]);
    for (const breaches of [tied, [...tied].reverse()]) {
      const tie = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches,
        insight: null,
        context,
      });
      expect(tie.alert?.Detail).toMatchObject({
        thresholdRate: 2.5,
        rateBasis: "HOURLY",
      });
    }
  });

  it("lets a crossed dollar threshold take the one alert over a spend-rate limit crossed the same run", () => {
    const withAlert = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([alertAt(100)], { rateLimits: [hourlyAlert(3)] }),
      insight: null,
      context,
    });
    expect(withAlert.alert?.DetailType).toBe(
      EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
    );
    expect(withAlert.alert?.Detail).toMatchObject({
      triggeredBy: "REPORTED",
      budgetThresholdTriggered: 100,
    });

    const withFreeze = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([freezeAt(100)], {
        rateLimits: [hourlyAlert(3)],
      }),
      insight: null,
      context,
    });
    expect(withFreeze.freeze).not.toBeNull();
    expect(withFreeze.alert).toBeNull();
  });

  it("carries the caller's countdown rate and unbilled Bedrock usage on a dollar alert, beside the rate that carried the projection", () => {
    const tokenPollContext: SpendingControlEventContext = {
      ...context,
      countdownRate: { rate: 133.2, rateSource: "DAILY" },
      unbilledBedrockTokenCost: 5.45,
    };
    const predictedWins = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([alertAt(100), predictedAlertAt(105)]),
      insight,
      context: tokenPollContext,
    });
    expect(predictedWins.alert?.Detail).toMatchObject({
      triggeredBy: "PREDICTED",
      predictedCost: 110,
      rate: 3.5,
      rateSource: "HOURLY",
      countdownRate: 133.2,
      countdownRateSource: "DAILY",
      unbilledBedrockTokenCost: 5.45,
    });

    const reportedWins = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([alertAt(100), predictedAlertAt(96)]),
      insight,
      context: tokenPollContext,
    });
    expect(reportedWins.alert?.Detail).toMatchObject({
      triggeredBy: "REPORTED",
      rate: 3.5,
      rateSource: "HOURLY",
      countdownRate: 133.2,
      countdownRateSource: "DAILY",
      unbilledBedrockTokenCost: 5.45,
    });
  });

  it("carries the countdown rate and unbilled Bedrock usage on a spend-rate alert too, beside the measured rate that crossed the limit", () => {
    const selection = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], { rateLimits: [hourlyAlert(3)] }),
      insight,
      context: {
        ...context,
        countdownRate: { rate: 133.2, rateSource: "DAILY" },
        unbilledBedrockTokenCost: 5.45,
      },
    });
    expect(selection.alert).toBeInstanceOf(
      LeaseSpendRateThresholdBreachedAlert,
    );
    expect(selection.alert?.Detail).toMatchObject({
      rateBasis: "HOURLY",
      thresholdRate: 3,
      measuredRate: 3.5,
      countdownRate: 133.2,
      countdownRateSource: "DAILY",
      unbilledBedrockTokenCost: 5.45,
      insight,
    });
    // Rate-native: none of the dollar alert's trigger or projection-rate fields.
    for (const key of [
      "triggeredBy",
      "actionRequested",
      "budgetThresholdTriggered",
      "rate",
      "rateSource",
    ]) {
      expect(selection.alert?.Detail).not.toHaveProperty(key);
    }
    expect(() =>
      LeaseSpendRateThresholdBreachedAlert.parse(selection.alert!.Detail),
    ).not.toThrow();
  });

  describe("spend-rate limits with actions", () => {
    // The stored hourly rate is 2 and the daily 40 (see breachesOf), so a
    // measured hourly 16 crosses every hourly line in (2, 16].
    const hourly16 = { ...carried, rates: rates(16, null) };
    const select = (
      rateLimits: RateLimitEntry[],
      options: {
        thresholds?: BudgetThreshold[];
        projection?: RunProjection;
      } = {},
    ) => {
      const breaches = breachesOf(options.thresholds ?? [], {
        rateLimits,
        projection: options.projection ?? hourly16,
      });
      return {
        breaches,
        selection: selectSpendingControlEvents({
          lease,
          billedCostAccrued: 102,
          breaches,
          insight: null,
          context,
        }),
      };
    };
    const rateLines = (breaches: { thresholdRate: number | null }[]) =>
      breaches.map((breach) => breach.thresholdRate);

    it("10 ALERT and 15 ALERT: records both and alerts on 15 alone", () => {
      const { breaches, selection } = select([
        hourlyAlert(10),
        hourlyAlert(15),
      ]);
      expect(rateLines(breaches)).toEqual([10, 15]);
      expect(selection.freeze).toBeNull();
      expect(selection.alert?.DetailType).toBe(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
      );
      expect(selection.alert?.Detail).toMatchObject({
        rateBasis: "HOURLY",
        thresholdRate: 15,
        measuredRate: 16,
      });
    });

    it("10 ALERT and 15 FREEZE: records both and freezes without an alert", () => {
      const { breaches, selection } = select([
        hourlyAlert(10),
        hourlyFreeze(15),
      ]);
      expect(rateLines(breaches)).toEqual([10, 15]);
      expect(selection.alert).toBeNull();
      expect(selection.freeze?.DetailType).toBe(
        EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
      );
      expect(selection.freeze?.Detail).toEqual({
        leaseId,
        accountId: lease.awsAccountId,
        reason: {
          type: "SpendRateExceeded",
          rateBasis: "HOURLY",
          thresholdRate: 15,
          measuredRate: 16,
          budget: 200,
          totalSpend: 102,
        },
      });
    });

    it("10 FREEZE and 15 ALERT: records both, freezes on 10 and alerts on 15", () => {
      const { breaches, selection } = select([
        hourlyFreeze(10),
        hourlyAlert(15),
      ]);
      expect(rateLines(breaches)).toEqual([10, 15]);
      expect(selection.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        thresholdRate: 10,
      });
      expect(selection.alert?.DetailType).toBe(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
      );
      expect(selection.alert?.Detail).toMatchObject({
        thresholdRate: 15,
        measuredRate: 16,
      });
    });

    it("lets the highest freeze suppress every lower alert on its basis", () => {
      const { selection } = select([
        hourlyAlert(8),
        hourlyAlert(12),
        hourlyFreeze(13),
      ]);
      expect(selection.alert).toBeNull();
      expect(selection.freeze?.Detail.reason).toMatchObject({
        thresholdRate: 13,
      });
    });

    it("raises one freeze, for the highest line, however many freeze rows crossed", () => {
      const { breaches, selection } = select([
        hourlyFreeze(5),
        hourlyFreeze(10),
        hourlyFreeze(14),
      ]);
      // Every row is recorded; only one lifecycle request is raised.
      expect(rateLines(breaches)).toEqual([5, 10, 14]);
      expect(selection.freeze?.Detail.reason).toMatchObject({
        thresholdRate: 14,
      });
      expect(selection.alert).toBeNull();
    });

    it("does not let a freeze in one basis suppress an alert in the other", () => {
      const { selection } = select([hourlyFreeze(10), dailyAlert(50)], {
        projection: { ...carried, rates: rates(16, 60) },
      });
      expect(selection.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        rateBasis: "HOURLY",
        thresholdRate: 10,
      });
      expect(selection.alert?.Detail).toMatchObject({
        rateBasis: "DAILY",
        thresholdRate: 50,
      });
    });

    it("picks one alert and one freeze across bases by the larger share of the limit, hourly on a tie", () => {
      // Measured: hourly 16, daily 100 (stored: 2 and 40).
      const both = { ...carried, rates: rates(16, 100) };
      // Hourly 16 against 10 is 60% over; daily 100 against 80 is 25% over.
      const byShare = select(
        [hourlyAlert(10), dailyAlert(80), hourlyFreeze(8), dailyFreeze(50)],
        { projection: both },
      );
      expect(rateLines(byShare.breaches)).toEqual([10, 80, 8, 50]);
      expect(byShare.selection.alert?.Detail).toMatchObject({
        rateBasis: "HOURLY",
        thresholdRate: 10,
      });
      // 16 against 8 and 100 against 50 are both double: hourly on the tie.
      expect(byShare.selection.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        rateBasis: "HOURLY",
        thresholdRate: 8,
      });

      // 16 against 15 is 7% over; 100 against 60 is 67% over.
      const dailyWins = select([hourlyFreeze(15), dailyFreeze(60)], {
        projection: both,
      }).selection;
      expect(dailyWins.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        rateBasis: "DAILY",
        thresholdRate: 60,
        measuredRate: 100,
      });
    });

    it("lets a dollar alert outrank a rate alert but coexist with a rate freeze", () => {
      const { selection } = select([hourlyFreeze(10), hourlyAlert(15)], {
        thresholds: [alertAt(100)],
      });
      expect(selection.alert?.DetailType).toBe(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
      );
      expect(selection.alert?.Detail).toMatchObject({
        triggeredBy: "REPORTED",
        budgetThresholdTriggered: 100,
      });
      expect(selection.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        thresholdRate: 10,
      });
    });

    it("lets a dollar freeze outrank a rate freeze, every row still recorded", () => {
      const { breaches, selection } = select([hourlyFreeze(10)], {
        thresholds: [freezeAt(100)],
      });
      expect(breaches.map((breach) => breach.triggeredBy)).toEqual([
        "REPORTED",
        "RATE",
      ]);
      expect(selection.freeze?.Detail.reason).toEqual({
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 100,
        budget: 200,
        totalSpend: 102,
        triggeredBy: "REPORTED",
      });
      expect(selection.alert).toBeNull();
    });

    it("drops a rate freeze on a lease that is not Active before it can suppress the same-basis alert", () => {
      const breaches = breachesOf([], {
        rateLimits: [hourlyAlert(10), hourlyFreeze(15)],
        projection: hourly16,
      });
      for (const status of ["Frozen", "Provisioning"] as const) {
        const selection = selectSpendingControlEvents({
          lease: { ...lease, status },
          billedCostAccrued: 102,
          breaches,
          insight: null,
          context,
        });
        expect(selection.freeze).toBeNull();
        expect(selection.alert?.DetailType).toBe(
          EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
        );
        expect(selection.alert?.Detail).toMatchObject({
          rateBasis: "HOURLY",
          thresholdRate: 10,
        });
      }
    });

    it("sends the dollar freeze in place of a rate freeze, and the dollar freeze suppresses the alert", () => {
      const { breaches } = select([hourlyFreeze(10), hourlyAlert(15)], {
        thresholds: [freezeAt(100)],
      });
      const selection = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches,
        insight: null,
        context,
      });
      // The RATE crossings are still there to persist and log.
      expect(breaches.map((breach) => breach.triggeredBy)).toEqual([
        "REPORTED",
        "RATE",
        "RATE",
      ]);
      expect(selection.freeze?.Detail.reason).toMatchObject({
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 100,
      });
      // The dollar crossing owns the alert slot, and its freeze suppresses it.
      expect(selection.alert).toBeNull();
    });

    it("sends the rate freeze beside a dollar alert when no dollar freeze was crossed", () => {
      const { breaches } = select([hourlyFreeze(10)], {
        thresholds: [alertAt(100)],
      });
      const selection = selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches,
        insight: null,
        context,
      });
      expect(selection.freeze?.Detail.reason).toMatchObject({
        type: "SpendRateExceeded",
        thresholdRate: 10,
      });
      expect(selection.alert?.Detail).toMatchObject({
        triggeredBy: "REPORTED",
        budgetThresholdTriggered: 100,
      });
    });

    it("builds a rate freeze the lifecycle manager's parser accepts", () => {
      const { selection } = select([hourlyFreeze(10)]);
      expect(() =>
        LeaseFreezingThresholdBreachedAlert.parse(selection.freeze!.Detail),
      ).not.toThrow();
    });

    it("evaluates nothing on a frozen lease", () => {
      const evaluation = evaluateSpendingControls({
        lease: {
          status: "Frozen",
          budgetThresholds: [],
          rateLimits: [hourlyFreeze(10)],
          totalCostAccrued: 90,
          lastPredictedSpend: 95,
          lastEvaluatedHourlySpendRate: 2,
          lastEvaluatedDailySpendRate: 40,
        },
        evaluatedSpend: 102,
        projection: hourly16,
      });
      expect(evaluation.breaches).toEqual([]);
      expect(evaluation.lastEvaluatedHourlySpendRate).toBe(16);
    });
  });

  it("publishes nothing when nothing crossed", () => {
    expect(
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: [],
        insight,
        context,
      }),
    ).toEqual({ freeze: null, alert: null });
  });

  it("builds details the consumers' own parsers accept, for every kind of event", () => {
    const selections = [
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 120,
        breaches: breachesOf([freezeAt(60), alertAt(100)], {
          totalCostAccrued: 40,
          evaluatedSpend: 120,
          projection: null,
        }),
        insight: null,
        context: noContext,
      }),
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: breachesOf([alertAt(100), predictedAlertAt(105)]),
        insight,
        context,
      }),
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: breachesOf([
          {
            dollarsSpent: 105,
            action: "FREEZE_ACCOUNT",
            triggerOn: "PREDICTED",
          },
        ]),
        insight,
        context,
      }),
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: breachesOf([], { rateLimits: [hourlyAlert(3)] }),
        insight,
        context,
      }),
      selectSpendingControlEvents({
        lease,
        billedCostAccrued: 102,
        breaches: breachesOf([], { rateLimits: [hourlyFreeze(3)] }),
        insight,
        context,
      }),
    ];
    const kinds = selections.map(({ freeze, alert }) => {
      const alertKind =
        alert === null
          ? "-"
          : alert instanceof LeaseSpendRateThresholdBreachedAlert
            ? "SpendRate"
            : alert.Detail.triggeredBy;
      return `${freeze?.Detail.reason.type ?? "-"}/${alertKind}`;
    });
    expect(kinds).toEqual([
      "BudgetExceeded/REPORTED",
      "-/PREDICTED",
      "BudgetExceeded/-",
      "-/SpendRate",
      "SpendRateExceeded/-",
    ]);
    for (const { freeze, alert } of selections) {
      if (freeze !== null) {
        expect(() =>
          LeaseFreezingThresholdBreachedAlert.parse(freeze.Detail),
        ).not.toThrow();
      }
      if (alert instanceof LeaseSpendRateThresholdBreachedAlert) {
        expect(() =>
          LeaseSpendRateThresholdBreachedAlert.parse(alert.Detail),
        ).not.toThrow();
      } else if (alert !== null) {
        expect(() =>
          LeaseBudgetThresholdBreachedAlert.parse(alert.Detail),
        ).not.toThrow();
      }
    }
  });

  it("still parses dollar events under the previous release's consumer schemas; spend-rate events are new contracts", () => {
    // During a deploy the previous release's email and lifecycle lambdas can
    // receive a detail built here, and each throws on a parse failure. These
    // are that release's two schemas, restated: non-strict objects that strip
    // the new fields and require the dollar threshold. A spend-rate alert
    // travels on a detail type that release never subscribed to, and a
    // SpendRateExceeded freeze reason is one it cannot parse; both are
    // acceptable only because a spend-rate limit can be configured through
    // this release's API alone.
    const previousBudgetAlert = z.object({
      leaseId: LeaseKeySchema,
      accountId: AwsAccountIdSchema,
      budget: z.number().optional(),
      totalSpend: z.number(),
      budgetThresholdTriggered: z.number(),
      actionRequested: ThresholdActionSchema,
    });
    const previousFreeze = z.object({
      leaseId: LeaseKeySchema,
      accountId: AwsAccountIdSchema,
      reason: z.object({
        type: z.literal("BudgetExceeded"),
        triggeredBudgetThreshold: z.number().gt(0),
        budget: z.number().optional(),
        totalSpend: z.number(),
      }),
    });

    const billed = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 120,
      breaches: breachesOf([freezeAt(60), alertAt(100)], {
        totalCostAccrued: 40,
        evaluatedSpend: 120,
        projection: null,
      }),
      insight: null,
      context: noContext,
    });
    const projected = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([
        predictedAlertAt(100),
        { dollarsSpent: 105, action: "FREEZE_ACCOUNT", triggerOn: "PREDICTED" },
      ]),
      insight,
      context,
    });
    const projectedAlert = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([predictedAlertAt(105)]),
      insight,
      context,
    });
    expect(billed.freeze).not.toBeNull();
    expect(billed.alert).not.toBeNull();
    expect(projected.freeze?.Detail.reason).toMatchObject({
      type: "BudgetExceeded",
      triggeredBy: "PREDICTED",
    });
    expect(projectedAlert.alert?.DetailType).toBe(
      EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
    );
    expect(projectedAlert.alert?.Detail).toMatchObject({
      triggeredBy: "PREDICTED",
    });

    for (const freeze of [billed.freeze, projected.freeze]) {
      expect(() => previousFreeze.parse(freeze!.Detail)).not.toThrow();
    }
    for (const alert of [billed.alert, projectedAlert.alert]) {
      expect(() => previousBudgetAlert.parse(alert!.Detail)).not.toThrow();
    }

    // A spend-rate alert is not a budget alert under another trigger: it has
    // its own detail type, so the previous release's budget-alert rule never
    // routes it, and its detail carries no dollar threshold either.
    const rateAlert = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], { rateLimits: [hourlyAlert(3)] }),
      insight,
      context,
    });
    expect(rateAlert.alert?.DetailType).toBe(
      EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
    );
    expect(rateAlert.alert?.DetailType).not.toBe(
      EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
    );
    expect(previousBudgetAlert.safeParse(rateAlert.alert!.Detail).success).toBe(
      false,
    );

    // A spend-rate freeze rides the freezing detail type the previous release
    // does subscribe to, but with a reason it does not know.
    const rateFreeze = selectSpendingControlEvents({
      lease,
      billedCostAccrued: 102,
      breaches: breachesOf([], { rateLimits: [hourlyFreeze(3)] }),
      insight,
      context,
    });
    expect(rateFreeze.freeze?.DetailType).toBe(
      EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
    );
    expect(rateFreeze.freeze?.Detail.reason.type).toBe("SpendRateExceeded");
    expect(previousFreeze.safeParse(rateFreeze.freeze!.Detail).success).toBe(
      false,
    );
  });
});

describe("thresholdFiredLog", () => {
  const figures = {
    evaluatedBy: "TOKEN_POLL" as const,
    billedCostAccrued: 98,
    hoursSinceLastRefresh: 2.5,
    costAtFreezeDecision: 104,
  };
  const reported: ReportedBreach = {
    triggeredBy: "REPORTED",
    action: "ALERT",
    thresholdDollars: 100,
    thresholdRate: null,
    thresholdRateBasis: null,
    spendAtFire: 102,
    predictedCostAtFire: 110,
    rateAtFire: 3.5,
    rateSourceAtFire: "HOURLY",
  };
  const predicted: PredictedBreach = {
    triggeredBy: "PREDICTED",
    action: "FREEZE_ACCOUNT",
    thresholdDollars: 105,
    thresholdRate: null,
    thresholdRateBasis: null,
    spendAtFire: 102,
    predictedCostAtFire: 110,
    rateAtFire: 3.5,
    rateSourceAtFire: "HOURLY",
  };
  const rateAlert: RateBreach = {
    triggeredBy: "RATE",
    action: "ALERT",
    thresholdDollars: null,
    thresholdRate: 3,
    thresholdRateBasis: "HOURLY",
    spendAtFire: 102,
    predictedCostAtFire: 110,
    rateAtFire: 3.5,
    rateSourceAtFire: "HOURLY",
  };
  const rateFreeze: RateBreach = {
    ...rateAlert,
    action: "FREEZE_ACCOUNT",
    thresholdRate: 50,
    thresholdRateBasis: "DAILY",
    rateAtFire: 72,
    rateSourceAtFire: "DAILY",
  };
  const rateFields = ["rateBasis", "thresholdRate", "measuredRate"];

  it("records a billed dollar crossing as BudgetThresholdFired, with no spend-rate fields", () => {
    const log = thresholdFiredLog(reported, figures);
    expect(log).toEqual({
      logDetailType: "BudgetThresholdFired",
      thresholdDollars: 100,
      triggeredBy: "REPORTED",
      action: "ALERT",
      evaluatedBy: "TOKEN_POLL",
      spendAtFire: 102,
      billedCostAtFire: 98,
      predictedCostAtFire: 110,
      hoursSinceLastRefresh: 2.5,
    });
    for (const key of [...rateFields, "costAtFreezeDecision"]) {
      expect(log).not.toHaveProperty(key);
    }
    expect(() => BudgetThresholdFiredLogSchema.parse(log)).not.toThrow();
  });

  it("records a projected dollar freeze as BudgetThresholdFired with the cost at the freeze decision", () => {
    const log = thresholdFiredLog(predicted, figures);
    expect(log).toEqual({
      logDetailType: "BudgetThresholdFired",
      thresholdDollars: 105,
      triggeredBy: "PREDICTED",
      action: "FREEZE_ACCOUNT",
      evaluatedBy: "TOKEN_POLL",
      spendAtFire: 102,
      billedCostAtFire: 98,
      predictedCostAtFire: 110,
      hoursSinceLastRefresh: 2.5,
      costAtFreezeDecision: 104,
    });
    for (const key of rateFields) {
      expect(log).not.toHaveProperty(key);
    }
    expect(() => BudgetThresholdFiredLogSchema.parse(log)).not.toThrow();
  });

  it("records a spend-rate ALERT crossing as SpendRateThresholdFired, with no dollar fields", () => {
    const log = thresholdFiredLog(rateAlert, figures);
    expect(log).toEqual({
      logDetailType: "SpendRateThresholdFired",
      rateBasis: "HOURLY",
      thresholdRate: 3,
      measuredRate: 3.5,
      action: "ALERT",
      evaluatedBy: "TOKEN_POLL",
      spendAtFire: 102,
      billedCostAtFire: 98,
      predictedCostAtFire: 110,
      hoursSinceLastRefresh: 2.5,
    });
    for (const key of [
      "thresholdDollars",
      "triggeredBy",
      "costAtFreezeDecision",
    ]) {
      expect(log).not.toHaveProperty(key);
    }
    expect(() => SpendRateThresholdFiredLogSchema.parse(log)).not.toThrow();
  });

  it("records a spend-rate FREEZE_ACCOUNT crossing as SpendRateThresholdFired with the cost at the freeze decision", () => {
    const log = thresholdFiredLog(rateFreeze, figures);
    expect(log).toEqual({
      logDetailType: "SpendRateThresholdFired",
      rateBasis: "DAILY",
      thresholdRate: 50,
      measuredRate: 72,
      action: "FREEZE_ACCOUNT",
      evaluatedBy: "TOKEN_POLL",
      spendAtFire: 102,
      billedCostAtFire: 98,
      predictedCostAtFire: 110,
      hoursSinceLastRefresh: 2.5,
      costAtFreezeDecision: 104,
    });
    for (const key of ["thresholdDollars", "triggeredBy"]) {
      expect(log).not.toHaveProperty(key);
    }
    expect(() => SpendRateThresholdFiredLogSchema.parse(log)).not.toThrow();
  });

  it.each([
    [null, null],
    [Number.NaN, null],
    [Number.POSITIVE_INFINITY, null],
    [Number.NEGATIVE_INFINITY, null],
    [-0.25, 0],
    [0, 0],
    [7, 7],
  ])(
    "records hoursSinceLastRefresh %s as %s",
    (hoursSinceLastRefresh, expected) => {
      for (const breach of [reported, predicted, rateAlert, rateFreeze]) {
        const log = thresholdFiredLog(breach, {
          ...figures,
          hoursSinceLastRefresh,
        });
        expect(log.hoursSinceLastRefresh).toBe(expected);
        const schema =
          log.logDetailType === "SpendRateThresholdFired"
            ? SpendRateThresholdFiredLogSchema
            : BudgetThresholdFiredLogSchema;
        expect(() => schema.parse(log)).not.toThrow();
      }
    },
  );

  it("logs one SpendRateThresholdFired per crossed limit while selection raises at most one alert and one freeze", () => {
    const breaches = evaluateSpendingControls({
      lease: {
        status: "Active",
        budgetThresholds: [],
        rateLimits: [hourlyAlert(10), hourlyAlert(12), dailyFreeze(50)],
        totalCostAccrued: 90,
        lastPredictedSpend: 95,
        lastEvaluatedHourlySpendRate: 2,
        lastEvaluatedDailySpendRate: 40,
      },
      evaluatedSpend: 102,
      projection: {
        predictedCost: 110,
        rateSource: "HOURLY",
        rates: rates(16, 60),
      },
    }).breaches;
    const logs = breaches.map((breach) => thresholdFiredLog(breach, figures));
    expect(
      logs.map((log) => ({
        logDetailType: log.logDetailType,
        thresholdRate:
          log.logDetailType === "SpendRateThresholdFired"
            ? log.thresholdRate
            : null,
        action: log.action,
      })),
    ).toEqual([
      {
        logDetailType: "SpendRateThresholdFired",
        thresholdRate: 10,
        action: "ALERT",
      },
      {
        logDetailType: "SpendRateThresholdFired",
        thresholdRate: 12,
        action: "ALERT",
      },
      {
        logDetailType: "SpendRateThresholdFired",
        thresholdRate: 50,
        action: "FREEZE_ACCOUNT",
      },
    ]);
    for (const log of logs) {
      expect(() => SpendRateThresholdFiredLogSchema.parse(log)).not.toThrow();
    }

    const selection = selectSpendingControlEvents({
      lease: {
        uuid: "750e8400-e29b-41d4-a716-446655440002",
        userEmail: "user@example.com",
        awsAccountId: "123456789012",
        maxSpend: 200,
        status: "Active",
      },
      billedCostAccrued: 102,
      breaches,
      insight: null,
      context: { hoursToBudgetExhaustion: null, lastReportedAt: undefined },
    });
    expect(selection.alert?.Detail).toMatchObject({
      rateBasis: "HOURLY",
      thresholdRate: 12,
    });
    expect(selection.freeze?.Detail.reason).toMatchObject({
      type: "SpendRateExceeded",
      rateBasis: "DAILY",
      thresholdRate: 50,
    });
  });
});

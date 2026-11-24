// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  BudgetThresholdFiredLogSchema,
  LeaseCostFallbackLogSchema,
  ProjectionAccuracyLogSchema,
  SpendRateComputedLogSchema,
  SpendRateThresholdFiredLogSchema,
  SubscribableLogSchema,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";

describe("SpendRateComputedLogSchema", () => {
  const validLog = {
    logDetailType: "SpendRateComputed",
    hourlyRate: 3.5,
    dailyRate: 52.0,
    rateUnavailable: false,
    costExplorerRefreshed: true,
  };

  test("parses a record whose flag agrees with its rates", () => {
    expect(() => SpendRateComputedLogSchema.parse(validLog)).not.toThrow();
    expect(() =>
      SpendRateComputedLogSchema.parse({
        ...validLog,
        hourlyRate: null,
        dailyRate: null,
        rateUnavailable: true,
      }),
    ).not.toThrow();
  });

  test("rejects a record whose flag contradicts its rates", () => {
    // The coverage figure is read off this flag, so it cannot disagree with
    // the rates it restates.
    expect(() =>
      SpendRateComputedLogSchema.parse({
        ...validLog,
        hourlyRate: null,
        dailyRate: null,
      }),
    ).toThrow();
    expect(() =>
      SpendRateComputedLogSchema.parse({ ...validLog, rateUnavailable: true }),
    ).toThrow();
  });

  test("parses a record whose rates the logger dropped", () => {
    // The logger removes null-valued keys before writing, so a lease with no
    // rate yet reaches the subscriber with neither key present.
    expect(() =>
      SpendRateComputedLogSchema.parse({
        logDetailType: "SpendRateComputed",
        rateUnavailable: true,
        costExplorerRefreshed: true,
      }),
    ).not.toThrow();
    expect(() =>
      SpendRateComputedLogSchema.parse({
        logDetailType: "SpendRateComputed",
        rateUnavailable: false,
        costExplorerRefreshed: true,
      }),
    ).toThrow();
  });

  test("stays a member of the subscribable union", () => {
    expect(SubscribableLogSchema.parse(validLog)).toMatchObject({
      logDetailType: "SpendRateComputed",
    });
  });
});

describe("LeaseCostFallbackLogSchema", () => {
  const validLog = {
    logDetailType: "LeaseCostFallback",
    fallbackLeaseCount: 2,
    monitoredLeaseCount: 5,
  };

  test("parses a run that fell back for some of the fleet", () => {
    expect(() => LeaseCostFallbackLogSchema.parse(validLog)).not.toThrow();
  });

  test("rejects a record emitted for no lease, which the emitter never produces", () => {
    expect(() =>
      LeaseCostFallbackLogSchema.parse({ ...validLog, fallbackLeaseCount: 0 }),
    ).toThrow();
  });

  test("stays a member of the subscribable union", () => {
    expect(SubscribableLogSchema.parse(validLog)).toMatchObject({
      logDetailType: "LeaseCostFallback",
    });
  });
});

describe("ProjectionAccuracyLogSchema", () => {
  const validLog = {
    logDetailType: "ProjectionAccuracy",
    predictedCost: 72.0,
    billedCostAccrued: 60.0,
    errorDollars: 12.0,
    errorPercent: 20.0,
    intervalHours: 8,
    rateSource: "HOURLY",
    algorithmId: "linear-max-v1",
  };

  test("parses a projection-accuracy record", () => {
    expect(() => ProjectionAccuracyLogSchema.parse(validLog)).not.toThrow();
    expect(() =>
      ProjectionAccuracyLogSchema.parse({
        ...validLog,
        billedCostAccrued: 0,
        // Restated with billedCostAccrued, because errorDollars is their difference.
        errorDollars: validLog.predictedCost,
        errorPercent: null,
      }),
    ).not.toThrow();
  });

  test("rejects an errorDollars that disagrees with the two figures beside it", () => {
    // This is the signal for whether predicted thresholds are safe to freeze on,
    // so a record whose difference contradicts its own operands is unreadable.
    expect(() =>
      ProjectionAccuracyLogSchema.parse({ ...validLog, errorDollars: 3.0 }),
    ).toThrow();
    // Float tolerance: the emitter does the subtraction.
    expect(() =>
      ProjectionAccuracyLogSchema.parse({
        ...validLog,
        errorDollars: 12.000000000000002,
      }),
    ).not.toThrow();
  });

  test("accepts a record whose null percent the logger dropped", () => {
    expect(() =>
      ProjectionAccuracyLogSchema.parse({
        logDetailType: "ProjectionAccuracy",
        predictedCost: 1102,
        billedCostAccrued: 1102,
        errorDollars: 0,
        intervalHours: 1,
        rateSource: "HOURLY",
        algorithmId: "linear-max-v1",
      }),
    ).not.toThrow();
  });

  test("accepts a percent alongside a zero billedCostAccrued", () => {
    expect(() =>
      ProjectionAccuracyLogSchema.parse({
        ...validLog,
        billedCostAccrued: 0,
        errorDollars: validLog.predictedCost,
      }),
    ).not.toThrow();
  });

  test("stays a member of the subscribable union", () => {
    expect(SubscribableLogSchema.parse(validLog)).toMatchObject({
      logDetailType: "ProjectionAccuracy",
    });
  });
});

const expectSingleIssue = (
  result: { success: boolean; error?: { issues: unknown[] } },
  issue: Record<string, unknown>,
) => {
  expect(result.success).toBe(false);
  expect(result.error?.issues).toEqual([expect.objectContaining(issue)]);
};

describe("BudgetThresholdFiredLogSchema", () => {
  const validLog = {
    logDetailType: "BudgetThresholdFired",
    thresholdDollars: 70.0,
    action: "ALERT",
    triggeredBy: "REPORTED",
    evaluatedBy: "TOKEN_POLL",
    spendAtFire: 71.0,
    billedCostAtFire: 60.0,
  };

  test("parses a threshold-breakdown record", () => {
    expect(() => BudgetThresholdFiredLogSchema.parse(validLog)).not.toThrow();
  });

  test.each([
    {
      name: "RATE (a crossed spend-rate limit logs SpendRateThresholdFired)",
      input: { ...validLog, triggeredBy: "RATE" },
      issue: { path: ["triggeredBy"] },
    },
    {
      name: "a missing thresholdDollars",
      input: { ...validLog, thresholdDollars: undefined },
      issue: { path: ["thresholdDollars"] },
    },
    {
      name: "a null thresholdDollars",
      input: { ...validLog, thresholdDollars: null },
      issue: { path: ["thresholdDollars"] },
    },
    {
      name: "a missing evaluatedBy",
      input: { ...validLog, evaluatedBy: undefined },
      issue: { path: ["evaluatedBy"] },
    },
    {
      name: "an unknown evaluatedBy",
      input: { ...validLog, evaluatedBy: "WORKER" },
      issue: { path: ["evaluatedBy"] },
    },
    {
      // Required, not nullish: the logger drops null keys.
      name: "a null spendAtFire",
      input: { ...validLog, spendAtFire: null },
      issue: { path: ["spendAtFire"] },
    },
    {
      name: "a missing spendAtFire",
      input: { ...validLog, spendAtFire: undefined },
      issue: { path: ["spendAtFire"] },
    },
    {
      name: "a null PREDICTED projection",
      input: {
        ...validLog,
        triggeredBy: "PREDICTED",
        predictedCostAtFire: null,
      },
      issue: {
        path: ["predictedCostAtFire"],
        message: "required on a PREDICTED breach",
      },
    },
  ])("rejects $name at the exact path", ({ input, issue }) => {
    expectSingleIssue(BudgetThresholdFiredLogSchema.safeParse(input), issue);
  });

  test("strips stray spend-rate fields rather than carrying them", () => {
    // Not strict: unknown keys are dropped, so a dollar record can never
    // forward a rate limit.
    const parsed = BudgetThresholdFiredLogSchema.parse({
      ...validLog,
      thresholdRate: 12,
      thresholdRateBasis: "HOURLY",
    });

    expect(parsed).toEqual(validLog);
  });

  test("requires the projection on a PREDICTED breach", () => {
    expect(() =>
      BudgetThresholdFiredLogSchema.parse({
        ...validLog,
        triggeredBy: "PREDICTED",
      }),
    ).toThrow();
    expect(() =>
      BudgetThresholdFiredLogSchema.parse({
        ...validLog,
        triggeredBy: "PREDICTED",
        predictedCostAtFire: 72.0,
      }),
    ).not.toThrow();
  });

  test("carries the freeze figure only on a freeze", () => {
    // The breakdown splits the overrun into detection and enforcement lag from
    // this field, so an alert carrying one is not interpretable.
    expect(() =>
      BudgetThresholdFiredLogSchema.parse({
        ...validLog,
        costAtFreezeDecision: 80.0,
      }),
    ).toThrow();
    expect(() =>
      BudgetThresholdFiredLogSchema.parse({
        ...validLog,
        action: "FREEZE_ACCOUNT",
        costAtFreezeDecision: 80.0,
      }),
    ).not.toThrow();
  });

  test("stays a member of the subscribable union", () => {
    expect(SubscribableLogSchema.parse(validLog)).toMatchObject({
      logDetailType: "BudgetThresholdFired",
    });
  });
});

describe("SpendRateThresholdFiredLogSchema", () => {
  const alertLog = {
    logDetailType: "SpendRateThresholdFired",
    rateBasis: "HOURLY",
    thresholdRate: 12,
    measuredRate: 15.5,
    action: "ALERT",
    evaluatedBy: "LEASE_MONITORING",
    spendAtFire: 60.0,
    billedCostAtFire: 60.0,
    predictedCostAtFire: 74.0,
    hoursSinceLastRefresh: 1.5,
  };
  const freezeLog = {
    ...alertLog,
    rateBasis: "DAILY",
    thresholdRate: 200,
    measuredRate: 240,
    action: "FREEZE_ACCOUNT",
    costAtFreezeDecision: 61.0,
  };

  test.each([
    { name: "ALERT", log: alertLog },
    { name: "FREEZE_ACCOUNT", log: freezeLog },
  ])("parses a valid $name record into the subscribable union", ({ log }) => {
    expect(SpendRateThresholdFiredLogSchema.parse(log)).toEqual(log);
    expect(SubscribableLogSchema.parse(log)).toMatchObject({
      logDetailType: "SpendRateThresholdFired",
    });
  });

  test.each([
    ...(
      [
        "rateBasis",
        "thresholdRate",
        "measuredRate",
        "evaluatedBy",
        "spendAtFire",
      ] as const
    ).map((field) => ({
      name: `a missing ${field}`,
      input: { ...alertLog, [field]: undefined },
      issue: { path: [field] },
    })),
    {
      // A RATE threshold is positive wherever it is configured or persisted.
      name: "a zero thresholdRate",
      input: { ...alertLog, thresholdRate: 0 },
      issue: { path: ["thresholdRate"] },
    },
    {
      name: "an unknown rate basis",
      input: { ...alertLog, rateBasis: "WEEKLY" },
      issue: { path: ["rateBasis"] },
    },
    {
      name: "an unknown evaluatedBy",
      input: { ...alertLog, evaluatedBy: "WORKER" },
      issue: { path: ["evaluatedBy"] },
    },
    {
      name: "a negative spendAtFire",
      input: { ...alertLog, spendAtFire: -1 },
      issue: { path: ["spendAtFire"] },
    },
    {
      name: "a freeze figure on ALERT",
      input: { ...alertLog, costAtFreezeDecision: 61.0 },
      issue: {
        path: ["costAtFreezeDecision"],
        message: "only set when the action is FREEZE_ACCOUNT",
      },
    },
  ])("rejects $name at the exact path", ({ input, issue }) => {
    expectSingleIssue(SpendRateThresholdFiredLogSchema.safeParse(input), issue);
  });
});

describe("the breakdown records accept what the BREACH# row actually holds", () => {
  // Each metric is emitted from the same values as its persisted row, and
  // BreachRecordSchema makes each counterpart .nullable(). Requiring `undefined`
  // would make the obvious projection fail and lose the record.
  const rateRow = {
    triggeredBy: "RATE" as const,
    action: "ALERT" as const,
    evaluatedBy: "LEASE_MONITORING" as const,
    thresholdDollars: null,
    thresholdRate: 12,
    thresholdRateBasis: "HOURLY" as const,
    rateAtFire: 15.5,
    rateSourceAtFire: "HOURLY" as const,
    billedCostAtFire: 60.0,
    predictedCostAtFire: null,
  };
  const dollarRow = {
    triggeredBy: "PREDICTED" as const,
    action: "ALERT" as const,
    evaluatedBy: "LEASE_MONITORING" as const,
    thresholdDollars: 70,
    billedCostAtFire: 60.0,
    predictedCostAtFire: 72.0,
  };

  const projectRateRow = (row: typeof rateRow) => ({
    logDetailType: "SpendRateThresholdFired",
    rateBasis: row.thresholdRateBasis,
    thresholdRate: row.thresholdRate,
    measuredRate: row.rateAtFire,
    action: row.action,
    evaluatedBy: row.evaluatedBy,
    // Lease Monitoring compares the bill; the row's evaluatedSpendAtFire is null.
    spendAtFire: row.billedCostAtFire,
    billedCostAtFire: row.billedCostAtFire,
    predictedCostAtFire: row.predictedCostAtFire,
    hoursSinceLastRefresh: null,
    costAtFreezeDecision: null,
  });

  test("a RATE row projects into SpendRateThresholdFired with its nulls", () => {
    expect(() =>
      SpendRateThresholdFiredLogSchema.parse(projectRateRow(rateRow)),
    ).not.toThrow();
  });

  test("a dollar row projects into BudgetThresholdFired with its nulls", () => {
    expect(() =>
      BudgetThresholdFiredLogSchema.parse({
        logDetailType: "BudgetThresholdFired",
        ...dollarRow,
        spendAtFire: dollarRow.billedCostAtFire,
        hoursSinceLastRefresh: null,
        costAtFreezeDecision: null,
      }),
    ).not.toThrow();
  });

  test("a magnitude the row rejects is rejected here too", () => {
    // BreachRecordSchema is .nonnegative() on these; a metric that admits a
    // negative records a state the system cannot produce, and the breakdown
    // splits overrun from exactly these fields.
    for (const override of [
      { billedCostAtFire: -1 },
      { thresholdDollars: -1 },
      { predictedCostAtFire: -1 },
      { spendAtFire: -1 },
    ]) {
      expect(() =>
        BudgetThresholdFiredLogSchema.parse({
          logDetailType: "BudgetThresholdFired",
          ...dollarRow,
          spendAtFire: dollarRow.billedCostAtFire,
          ...override,
        }),
      ).toThrow();
    }
    for (const override of [
      { billedCostAtFire: -1 },
      { thresholdRate: -1 },
      { rateAtFire: -1 },
    ]) {
      expect(() =>
        SpendRateThresholdFiredLogSchema.parse(
          projectRateRow({ ...rateRow, ...override }),
        ),
      ).toThrow();
    }
  });
});

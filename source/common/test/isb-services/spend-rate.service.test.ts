// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  ComputeProjectionInput,
  computeProjection,
  computeSpendRates,
  computeTimeToExhaustion,
  projectionRatePerHour,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/index.js";

const point = (timestamp: string, billedCostAccrued: number) => ({
  timestamp,
  billedCostAccrued,
});

const NO_RATES = {
  hourlyRate: null,
  dailyRate: null,
  hourlyRateWindowHours: null,
  dailyRateWindowHours: null,
};

describe("computeSpendRates", () => {
  // The design doc's worked example: $32.00 at 00:00, $60.00 at 08:00, and
  // $8.00 twenty-four hours before the newest reading.
  const workedExample = [
    point("2026-08-11T08:00:00.000Z", 60),
    point("2026-08-11T00:00:00.000Z", 32),
    point("2026-08-10T08:00:00.000Z", 8),
  ];

  it("reproduces the worked example to the cent", () => {
    expect(computeSpendRates(workedExample)).toEqual({
      hourlyRate: 3.5,
      hourlyRateWindowHours: 8,
      dailyRate: 52,
      dailyRateWindowHours: 24,
    });
  });

  it("measures the divisor from the timestamps rather than assuming an interval", () => {
    // Runs fire at arbitrary minutes, so real windows are fractional.
    const rates = computeSpendRates([
      point("2026-08-11T08:30:00.000Z", 46.25),
      point("2026-08-11T00:00:00.000Z", 8),
      point("2026-08-10T08:15:00.000Z", 5),
    ]);

    expect(rates.hourlyRateWindowHours).toBe(8.5);
    expect(rates.hourlyRate).toBe(38.25 / 8.5);
    expect(rates.dailyRateWindowHours).toBe(24.25);
    expect(rates.dailyRate).toBe((41.25 / 24.25) * 24);
  });

  it("carries full precision instead of rounding to cents", () => {
    const rates = computeSpendRates([
      point("2026-08-11T06:00:00.000Z", 45),
      point("2026-08-11T00:00:00.000Z", 32),
    ]);

    expect(rates.hourlyRate).toBe(13 / 6);
    expect(rates.hourlyRate).not.toBe(2.17);
  });

  it("clamps a restated, decreasing total to a zero rate and still reports the window", () => {
    const rates = computeSpendRates([
      point("2026-08-11T08:00:00.000Z", 55),
      point("2026-08-11T00:00:00.000Z", 60),
      point("2026-08-10T08:00:00.000Z", 70),
    ]);

    expect(rates).toEqual({
      hourlyRate: 0,
      hourlyRateWindowHours: 8,
      dailyRate: 0,
      dailyRateWindowHours: 24,
    });
  });

  it("picks the observation nearest 24 hours back in either direction", () => {
    const rates = computeSpendRates([
      point("2026-08-11T08:00:00.000Z", 60),
      point("2026-08-11T00:00:00.000Z", 32),
      // 21 hours back and 26 hours back: the 26-hour point is nearer to 24.
      point("2026-08-10T11:00:00.000Z", 20),
      point("2026-08-10T06:00:00.000Z", 8),
    ]);

    expect(rates.dailyRateWindowHours).toBe(26);
    expect(rates.dailyRate).toBe((52 / 26) * 24);
  });

  it("gives a tie to the more recent point", () => {
    const rates = computeSpendRates([
      point("2026-08-11T08:00:00.000Z", 60),
      point("2026-08-11T00:00:00.000Z", 32),
      // 23 hours back and 25 hours back are equally near to 24.
      point("2026-08-10T09:00:00.000Z", 20),
      point("2026-08-10T07:00:00.000Z", 8),
    ]);

    expect(rates.dailyRateWindowHours).toBe(23);
    expect(rates.dailyRate).toBe((40 / 23) * 24);
  });

  it("reports no daily rate when the nearest 24-hour point is the hourly rate's own predecessor", () => {
    const rates = computeSpendRates([
      point("2026-08-11T08:00:00.000Z", 60),
      point("2026-08-10T20:00:00.000Z", 32),
      point("2026-08-09T08:00:00.000Z", 8),
    ]);

    expect(rates).toEqual({
      hourlyRate: 28 / 12,
      hourlyRateWindowHours: 12,
      dailyRate: null,
      dailyRateWindowHours: null,
    });
  });

  it("reports no daily rate for a series of exactly two observations", () => {
    const rates = computeSpendRates([
      point("2026-08-11T08:00:00.000Z", 60),
      point("2026-08-11T00:00:00.000Z", 32),
    ]);

    expect(rates.hourlyRate).toBe(3.5);
    expect(rates.dailyRate).toBeNull();
    expect(rates.dailyRateWindowHours).toBeNull();
  });

  it.each([
    ["no observations", []],
    ["one observation", [point("2026-08-11T08:00:00.000Z", 60)]],
  ])("returns all-null rates with %s", (_label, observations) => {
    expect(computeSpendRates(observations)).toEqual(NO_RATES);
  });

  it("returns all-null rates rather than NaN when a timestamp is unparseable", () => {
    expect(
      computeSpendRates([
        point("not-a-timestamp", 60),
        point("also-not-a-timestamp", 32),
      ]),
    ).toEqual(NO_RATES);
    expect(
      computeSpendRates([
        point("2026-08-11T08:00:00.000Z", 60),
        point("not-a-timestamp", 32),
      ]),
    ).toEqual(NO_RATES);
  });

  it("returns all-null rates rather than dividing by zero when two observations share a timestamp", () => {
    expect(
      computeSpendRates([
        point("2026-08-11T08:00:00.000Z", 60),
        point("2026-08-11T08:00:00.000Z", 32),
      ]),
    ).toEqual(NO_RATES);
  });
});

const workedRates = {
  hourlyRate: 3.5,
  hourlyRateWindowHours: 8,
  dailyRate: 52,
  dailyRateWindowHours: 24,
};

function projectionAt(
  evaluatedAt: string,
  overrides: Partial<ComputeProjectionInput> = {},
) {
  return computeProjection({
    projectionAnchorCost: 60,
    lastReportedAt: "2026-08-11T08:00:00.000Z",
    evaluatedAt,
    rates: workedRates,
    recentIntervalHours: 8,
    ...overrides,
  });
}

/** Deterministic generator so the property checks are reproducible. */
function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x100000000;
  };
}

describe("computeProjection", () => {
  it.each([
    ["2026-08-11T08:00:00.000Z", 60],
    ["2026-08-11T09:00:00.000Z", 63.5],
    ["2026-08-11T10:00:00.000Z", 67],
    ["2026-08-11T11:00:00.000Z", 70.5],
  ])(
    "carries the worked example forward at $3.50/hour: %s -> $%s",
    (evaluatedAt, expected) => {
      const projection = projectionAt(evaluatedAt);

      expect(projection.predictedCost).toBe(expected);
      expect(projection.rateSource).toBe("HOURLY");
    },
  );

  it("uses the daily rate when it is the higher of the two", () => {
    const projection = projectionAt("2026-08-11T10:00:00.000Z", {
      rates: { ...workedRates, hourlyRate: 1, dailyRate: 72 },
    });

    expect(projection.rateSource).toBe("DAILY");
    expect(projection.predictedCost).toBe(66);
  });

  it("gives a tie to the hourly rate", () => {
    const projection = projectionAt("2026-08-11T09:00:00.000Z", {
      rates: { ...workedRates, hourlyRate: 2, dailyRate: 48 },
    });

    expect(projection.rateSource).toBe("HOURLY");
    expect(projection.predictedCost).toBe(62);
  });

  it("tops out at one measured interval for a lease that stopped spending", () => {
    const projection = projectionAt("2026-08-12T08:00:00.000Z");

    expect(projection.predictedCost).toBe(88);
  });

  it("caps at the recent interval even when the day-long average won", () => {
    const projection = projectionAt("2026-08-12T14:00:00.000Z", {
      rates: { ...workedRates, hourlyRate: 1, dailyRate: 72 },
    });

    expect(projection.rateSource).toBe("DAILY");
    expect(projection.predictedCost).toBe(60 + 3 * 8);
  });

  it("caps at the hourly rate's own window when the recent interval is not supplied", () => {
    const projection = projectionAt("2026-08-12T08:00:00.000Z", {
      recentIntervalHours: null,
    });

    expect(projection.predictedCost).toBe(88);
  });

  it.each([
    ["a zero recent interval", { recentIntervalHours: 0 }],
    [
      "no recent interval and no hourly window",
      {
        recentIntervalHours: null,
        rates: {
          hourlyRate: null,
          hourlyRateWindowHours: null,
          dailyRate: 52,
          dailyRateWindowHours: 24,
        },
      },
    ],
  ] as const)(
    "falls back to the projection anchor when no cap can be established: %s",
    (_label, overrides) => {
      const projection = projectionAt("2026-08-12T08:00:00.000Z", overrides);

      expect(projection).toEqual({
        predictedCost: 60,
        rateSource: null,
      });
    },
  );

  it("uses the daily rate when it is the only rate", () => {
    const projection = projectionAt("2026-08-11T11:00:00.000Z", {
      rates: { ...workedRates, hourlyRate: null, hourlyRateWindowHours: null },
    });

    expect(projection.rateSource).toBe("DAILY");
    expect(projection.predictedCost).toBe(60 + (52 / 24) * 3);
  });

  it("uses the hourly rate when it is the only rate", () => {
    const projection = projectionAt("2026-08-11T11:00:00.000Z", {
      rates: {
        ...workedRates,
        dailyRate: null,
        dailyRateWindowHours: null,
      },
    });

    expect(projection.predictedCost).toBe(70.5);
    expect(projection.rateSource).toBe("HOURLY");
  });

  it("holds at the projection anchor with a zero rate but still names the rate", () => {
    const projection = projectionAt("2026-08-11T11:00:00.000Z", {
      rates: { ...workedRates, hourlyRate: 0, dailyRate: 0 },
    });

    expect(projection).toEqual({
      predictedCost: 60,
      rateSource: "HOURLY",
    });
  });

  it("treats an evaluation before the reading as zero elapsed time", () => {
    const projection = projectionAt("2026-08-11T07:00:00.000Z");

    expect(projection.predictedCost).toBe(60);
  });

  it("falls back to the projection anchor when no rate exists", () => {
    const projection = computeProjection({
      projectionAnchorCost: 42.5,
      lastReportedAt: "2026-08-31T00:00:00.000Z",
      evaluatedAt: "2026-08-31T03:00:00.000Z",
      rates: {
        hourlyRate: null,
        dailyRate: null,
        hourlyRateWindowHours: null,
        dailyRateWindowHours: null,
      },
      recentIntervalHours: null,
    });

    expect(projection).toEqual({
      predictedCost: 42.5,
      rateSource: null,
    });
  });

  it("falls back to the projection anchor when a timestamp is unparseable", () => {
    const projection = projectionAt("not-a-timestamp");

    expect(projection.predictedCost).toBe(60);
    expect(projection.rateSource).toBeNull();
  });

  it("never projects below the projection anchor across restated series", () => {
    const random = seededRandom(20260811);
    for (let run = 0; run < 250; run++) {
      // Three readings, newest first, where any of them may have been restated
      // downward by Cost Explorer.
      const newest = 20 + random() * 200;
      const series = [
        { timestamp: "2026-08-11T08:00:00.000Z", billedCostAccrued: newest },
        {
          timestamp: "2026-08-11T00:00:00.000Z",
          billedCostAccrued: newest + (random() - 0.5) * 80,
        },
        {
          timestamp: "2026-08-10T08:00:00.000Z",
          billedCostAccrued: newest + (random() - 0.5) * 160,
        },
      ];
      const rates = computeSpendRates(series);
      const projection = computeProjection({
        projectionAnchorCost: newest,
        lastReportedAt: series[0]!.timestamp,
        evaluatedAt: `2026-08-11T${String(8 + Math.floor(random() * 16)).padStart(2, "0")}:00:00.000Z`,
        rates,
        recentIntervalHours: rates.hourlyRateWindowHours,
      });

      expect(projection.predictedCost).toBeGreaterThanOrEqual(newest);
    }
  });

  it("never extrapolates past one measured interval after spending stops", () => {
    const random = seededRandom(42);
    for (let run = 0; run < 250; run++) {
      const intervalHours = 1 + random() * 23;
      const rates = {
        hourlyRate: random() * 10,
        hourlyRateWindowHours: intervalHours,
        dailyRate: random() * 240,
        dailyRateWindowHours: 20 + random() * 8,
      };
      const idleHours = intervalHours + random() * 96;
      const lastReportedAt = "2026-08-11T08:00:00.000Z";
      const evaluatedAt = new Date(
        Date.parse(lastReportedAt) + idleHours * 3_600_000,
      ).toISOString();

      const projection = computeProjection({
        projectionAnchorCost: 60,
        lastReportedAt,
        evaluatedAt,
        rates,
        recentIntervalHours: intervalHours,
      });

      const ratePerHour = Math.max(rates.hourlyRate, rates.dailyRate / 24);
      expect(projection.predictedCost).toBeCloseTo(
        60 + ratePerHour * intervalHours,
        9,
      );
    }
  });
});

describe("projectionRatePerHour", () => {
  it("converts a winning daily rate to dollars per hour", () => {
    expect(
      projectionRatePerHour({ ...workedRates, hourlyRate: 1, dailyRate: 72 }),
    ).toEqual({ ratePerHour: 3, source: "DAILY" });
  });

  it("feeds the countdown the same per-hour figure the projection used", () => {
    const projection = projectionAt("2026-08-11T11:00:00.000Z");
    const rate = projectionRatePerHour(workedRates);

    expect(rate).toEqual({ ratePerHour: 3.5, source: "HOURLY" });
    expect(
      computeTimeToExhaustion({
        maxSpend: 100,
        predictedCost: projection.predictedCost,
        ratePerHour: rate!.ratePerHour,
      }),
    ).toBeCloseTo(8.4, 1);
  });

  it("is null with no rate at all", () => {
    expect(
      projectionRatePerHour({
        hourlyRate: null,
        dailyRate: null,
        hourlyRateWindowHours: null,
        dailyRateWindowHours: null,
      }),
    ).toBeNull();
  });
});

describe("computeTimeToExhaustion", () => {
  it("counts down the remaining budget at the per-hour rate: about 8.4 hours at 11:00", () => {
    expect(
      computeTimeToExhaustion({
        maxSpend: 100,
        predictedCost: 70.5,
        ratePerHour: 3.5,
      }),
    ).toBeCloseTo(8.4, 1);
  });

  it("is zero, not negative, once the budget is already projected spent", () => {
    expect(
      computeTimeToExhaustion({
        maxSpend: 70,
        predictedCost: 70.5,
        ratePerHour: 3.5,
      }),
    ).toBe(0);
  });

  it.each([
    [
      "no maxSpend",
      { maxSpend: undefined, predictedCost: 40, ratePerHour: 3.5 },
    ],
    ["no rate", { maxSpend: 100, predictedCost: 40, ratePerHour: null }],
    ["a zero rate", { maxSpend: 100, predictedCost: 40, ratePerHour: 0 }],
  ])("is null with %s, never Infinity or NaN", (_label, input) => {
    expect(computeTimeToExhaustion(input)).toBeNull();
  });
});

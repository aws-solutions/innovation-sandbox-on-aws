// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  colorChartsPaletteCategorical1,
  colorChartsPaletteCategorical2,
  colorChartsStatusNeutral,
} from "@cloudscape-design/design-tokens";
import { Settings } from "luxon";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  buildTokenCharts,
  TokenSpan,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/token-charts";
import { createMockBedrockTokenCostHistory } from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";
import {
  bandValues,
  CLAUDE_HAIKU,
  costRunsAsIso,
  loneHourUsage,
  NOVA_PRO,
  ONE_READING_SPAN,
  READINGS,
  sevenModels,
  SPAN,
  tokenRow,
  withoutCostAt,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/tokenChartFixtures";
import { UNATTRIBUTED_MODEL_ID } from "@amzn/innovation-sandbox-shared/types/cost-history.js";

const defaultZone = Settings.defaultZone;
beforeAll(() => {
  // Hours and days start where they do in UTC, whatever zone the tests run in.
  Settings.defaultZone = "utc";
});
afterAll(() => {
  Settings.defaultZone = defaultZone;
});

describe("buildTokenCharts", () => {
  it("counts the tokens used in each hour, by model", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    // The rows are lease-to-date totals; each hour is the change across it.
    expect(bandValues(tokens, "model")).toEqual({
      [NOVA_PRO]: [1200, 4700, 0, 2400, 3600],
      [CLAUDE_HAIKU]: [0, 0, 8400, 4700, 3700],
    });
  });

  it("counts the same hours by token type, to the same totals", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    const byType = bandValues(tokens, "tokenType");
    expect(byType).toEqual({
      Input: [1000, 4000, 2000, 3000, 4000],
      Output: [200, 700, 400, 600, 800],
      "Cache read": [0, 0, 5000, 3000, 2000],
      "Cache write": [0, 0, 1000, 500, 500],
    });
    const hourTotals = (byTitle: Record<string, number[]>) =>
      READINGS.map((_, index) =>
        Object.values(byTitle).reduce((sum, values) => sum + values[index], 0),
      );
    expect(hourTotals(byType)).toEqual(hourTotals(bandValues(tokens, "model")));
  });

  it("counts per day past two days", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const threeDaysLater = { to: new Date("2026-08-14T12:00:00.000Z") };

    expect(buildTokenCharts(tokens, "model", threeDaysLater).unit).toBe("day");
    // Every token on the 11th, none on the three days since.
    expect(bandValues(tokens, "model", threeDaysLater)).toEqual({
      [NOVA_PRO]: [11900, 0, 0, 0],
      [CLAUDE_HAIKU]: [16800, 0, 0, 0],
    });
  });

  it("measures a narrower range's first hour from the readings before it", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const lastTwoHours = { ...SPAN, from: new Date(READINGS[3]) };

    // 2,400 and 3,600 used in those hours, not the 8,300 counted by 10:00.
    expect(bandValues(tokens, "model", lastTwoHours)).toEqual({
      [NOVA_PRO]: [2400, 3600],
      [CLAUDE_HAIKU]: [4700, 3700],
    });
    // And the cost from the last priced reading before the range, the 1.50 at
    // 08:00, not from the unpriced 09:00 or from nothing.
    expect(costRunsAsIso(tokens, lastTwoHours)).toEqual([
      [
        { x: READINGS[3], y: 1.5 },
        { x: READINGS[4], y: 1.25 },
      ],
    ]);
  });

  it("leaves out readings after a range that ends partway through an hour", () => {
    const tokens = [
      tokenRow("2026-08-11T07:00:00.000Z", NOVA_PRO, 100),
      tokenRow("2026-08-11T10:10:00.000Z", NOVA_PRO, 200),
      tokenRow("2026-08-11T10:50:00.000Z", NOVA_PRO, 900),
    ];
    const span = {
      from: new Date("2026-08-11T09:00:00.000Z"),
      to: new Date("2026-08-11T10:30:00.000Z"),
    };

    expect(bandValues(tokens, "model", span)).toEqual({ [NOVA_PRO]: [0, 100] });
  });

  it("draws nothing for a range that starts after it ends, as one past an ended lease does", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const afterTheLease = {
      from: new Date("2026-08-14T12:00:00.000Z"),
      to: new Date(READINGS[4]),
    };

    const charts = buildTokenCharts(tokens, "model", afterTheLease);
    expect(charts.hasUsage).toBe(false);
    expect(charts.tokenBands).toEqual([]);
    expect(charts.costLine).toEqual([]);
  });

  it("leaves out readings before a range that starts partway through an hour", () => {
    const tokens = [
      tokenRow("2026-08-11T10:10:00.000Z", NOVA_PRO, 100),
      tokenRow("2026-08-11T10:50:00.000Z", NOVA_PRO, 300),
    ];
    const span = {
      from: new Date("2026-08-11T10:15:00.000Z"),
      to: new Date("2026-08-11T11:30:00.000Z"),
    };

    // Only the 10:50 reading's 200: the 10:10 one is the baseline.
    expect(bandValues(tokens, "model", span)).toEqual({ [NOVA_PRO]: [200, 0] });
  });

  it("counts a reading at the very end of a range in it", () => {
    const tokens = [
      tokenRow("2026-08-11T09:00:00.000Z", NOVA_PRO, 100),
      tokenRow("2026-08-11T11:00:00.000Z", NOVA_PRO, 300),
    ];
    const span = {
      from: new Date("2026-08-11T10:00:00.000Z"),
      to: new Date("2026-08-11T11:00:00.000Z"),
    };

    expect(bandValues(tokens, "model", span)).toEqual({ [NOVA_PRO]: [0, 200] });
  });

  it("keeps the cost axis at zero even where a period's cost fell", () => {
    const priced = (
      timestamp: string,
      input: number,
      monitoredBedrockTokenCost: number,
    ) => ({
      ...tokenRow(timestamp, NOVA_PRO, input),
      monitoredBedrockTokenCost,
    });
    const tokens = [priced(READINGS[0], 100, 2), priced(READINGS[1], 110, 1.5)];
    const span = { to: new Date("2026-08-11T08:30:00.000Z") };

    expect(buildTokenCharts(tokens, "model", span).costDomain[0]).toBe(0);
  });

  it("counts per hour up to two days, and per day past them", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const twoDays = new Date(READINGS[0]).getTime() + 2 * 24 * 60 * 60 * 1000;

    expect(
      buildTokenCharts(tokens, "model", { to: new Date(twoDays) }).unit,
    ).toBe("hour");
    expect(
      buildTokenCharts(tokens, "model", { to: new Date(twoDays + 1) }).unit,
    ).toBe("day");
  });

  it("spans both charts over every period, with or without a reading, priced or not", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    // Two idle hours after the newest reading.
    const span = { to: new Date("2026-08-11T13:30:00.000Z") };
    const domain = [
      ...READINGS,
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T13:00:00.000Z",
    ].map((at) => new Date(at));

    expect(buildTokenCharts(tokens, "model", span).xDomain).toEqual(domain);
    expect(
      buildTokenCharts(withoutCostAt(tokens, READINGS[4]), "model", span)
        .xDomain,
    ).toEqual(domain);
  });

  it("puts every band's points on the axis's periods, which is all a categorical axis draws", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    for (const stackBy of ["model", "tokenType"] as const) {
      const { tokenBands, xDomain } = buildTokenCharts(tokens, stackBy, SPAN);
      for (const band of tokenBands) {
        expect(band.type === "area" ? band.data.map(({ x }) => x) : []).toEqual(
          xDomain,
        );
      }
    }
  });

  it("leaves out a model that used nothing in the range, keeping the others' colors", () => {
    const tokens = [
      tokenRow(READINGS[0], NOVA_PRO, 100),
      tokenRow(READINGS[1], NOVA_PRO, 200),
      tokenRow(READINGS[3], NOVA_PRO, 200),
      tokenRow(READINGS[3], CLAUDE_HAIKU, 50),
      tokenRow(READINGS[4], NOVA_PRO, 200),
      tokenRow(READINGS[4], CLAUDE_HAIKU, 150),
    ];
    const colors = (span: TokenSpan) =>
      Object.fromEntries(
        buildTokenCharts(tokens, "model", span).tokenBands.map((band) => [
          band.title,
          band.color,
        ]),
      );

    expect(colors(SPAN)).toEqual({
      [NOVA_PRO]: colorChartsPaletteCategorical1,
      [CLAUDE_HAIKU]: colorChartsPaletteCategorical2,
    });
    // Nova Pro used nothing after 08:00.
    expect(colors({ ...SPAN, from: new Date(READINGS[3]) })).toEqual({
      [CLAUDE_HAIKU]: colorChartsPaletteCategorical2,
    });
  });

  it("draws a lone hour as a line from the hour before it", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const lone = tokens.filter((row) => row.timestamp === READINGS[4]);

    expect(bandValues(lone, "model")).toEqual({
      [NOVA_PRO]: [0, 11900],
      [CLAUDE_HAIKU]: [0, 16800],
    });
  });

  it("orders readings by time whatever order the rows arrive in", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const oldestFirst = [...tokens].reverse();

    expect(bandValues(oldestFirst, "model")).toEqual(
      bandValues(tokens, "model"),
    );
    expect(costRunsAsIso(oldestFirst)).toEqual(costRunsAsIso(tokens));
  });

  it("reads the monitored token cost from one row per reading rather than summing them", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    // 0.50, 1.50, then unpriced, 3.00 and 4.25 lease-to-date: summed across the
    // rows of a reading, the later hours would read far higher.
    expect(costRunsAsIso(tokens)).toEqual([
      [
        { x: READINGS[0], y: 0.5 },
        { x: READINGS[1], y: 1 },
      ],
      [
        { x: READINGS[3], y: 1.5 },
        { x: READINGS[4], y: 1.25 },
      ],
    ]);
  });

  it("carries nothing in where the reading before a narrower range was priced", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const lastHour = { ...SPAN, from: new Date(READINGS[4]) };

    expect(buildTokenCharts(tokens, "model", lastHour).carriesCostIn).toBe(
      false,
    );
  });

  it("carries into the next priced day what a gap day priced before its unpriced reading", () => {
    const priced = (
      timestamp: string,
      input: number,
      monitoredBedrockTokenCost: number,
    ) => ({
      ...tokenRow(timestamp, NOVA_PRO, input),
      monitoredBedrockTokenCost,
    });
    const tokens = [
      priced("2026-08-10T12:00:00.000Z", 100, 2),
      priced("2026-08-11T08:00:00.000Z", 200, 5),
      tokenRow("2026-08-11T20:00:00.000Z", NOVA_PRO, 300),
      priced("2026-08-12T12:00:00.000Z", 400, 9),
    ];
    const span = { to: new Date("2026-08-12T23:00:00.000Z") };

    // The 12th carries the 11th's $3 as well as its own $4: 9.00 less 2.00.
    expect(costRunsAsIso(tokens, span)).toEqual([
      [{ x: "2026-08-10T00:00:00.000Z", y: 2 }],
      [{ x: "2026-08-12T00:00:00.000Z", y: 7 }],
    ]);
  });

  it("leaves the first priced cost unknown where what came before the range is unknown", () => {
    const priced = (
      timestamp: string,
      input: number,
      monitoredBedrockTokenCost: number,
    ) => ({
      ...tokenRow(timestamp, NOVA_PRO, input),
      monitoredBedrockTokenCost,
    });
    // Measured from an unpriced reading, with the readings before it unknown.
    const tokens = [
      tokenRow(READINGS[0], NOVA_PRO, 100),
      priced(READINGS[1], 200, 40),
      priced(READINGS[2], 300, 41),
    ];
    const span = {
      from: new Date(Date.parse(READINGS[0]) + 1),
      to: new Date(READINGS[2]),
      unknownBefore: true,
    };

    const charts = buildTokenCharts(tokens, "model", span);

    // Not the 40.00 the lease had spent in all, but nothing, then the 1.00 after.
    expect(costRunsAsIso(tokens, span)).toEqual([[{ x: READINGS[2], y: 1 }]]);
    expect(charts.carriesCostIn).toBe(false);
    expect(bandValues(tokens, "model", span)).toEqual({
      [NOVA_PRO]: [0, 100, 100],
    });
  });

  it("draws a monitored token cost of 0 as a point at zero, not a gap", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const freeFirst = tokens.map((row) =>
      row.timestamp === READINGS[0]
        ? { ...row, monitoredBedrockTokenCost: 0 }
        : row,
    );

    expect(costRunsAsIso(freeFirst)[0][0]).toEqual({ x: READINGS[0], y: 0 });
  });

  it("draws every piece of the monitored token cost line in one color", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const { costLine } = buildTokenCharts(tokens, "model", SPAN);

    expect(costLine.map((series) => series.color)).toEqual([
      colorChartsPaletteCategorical1,
      colorChartsPaletteCategorical1,
    ]);
  });

  it("starts the token axis at zero, above the busiest hour", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    // 8,400 at 09:00 is the busiest hour's stack.
    const [bottom, top] = buildTokenCharts(tokens, "model", SPAN).tokenDomain;
    expect(bottom).toBe(0);
    expect(top).toBeGreaterThan(8400);
    expect(top).toBeLessThan(10_000);
  });

  it("keeps a floor of token axis above a handful of tokens", () => {
    const tokens = [tokenRow(READINGS[0], "m1", 3)];

    expect(
      buildTokenCharts(tokens, "model", ONE_READING_SPAN).tokenDomain,
    ).toEqual([0, 10]);
  });

  it("fits the cost axis to the costliest hour, with a floor of ten cents", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const tiny = tokens.map((row) =>
      row.monitoredBedrockTokenCost === undefined
        ? row
        : { ...row, monitoredBedrockTokenCost: 0.0003 },
    );

    // 1.50 at 10:00 is the costliest hour.
    const [, top] = buildTokenCharts(tokens, "model", SPAN).costDomain;
    expect(top).toBeGreaterThan(1.5);
    expect(top).toBeLessThan(2);
    expect(buildTokenCharts(tiny, "model", SPAN).costDomain).toEqual([0, 0.1]);
  });

  it("draws no zero cost before a lone reading that could not be priced", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const lone = tokens
      .filter((row) => row.timestamp === READINGS[0])
      .map(({ monitoredBedrockTokenCost: _dropped, ...row }) => row);

    expect(buildTokenCharts(lone, "model", ONE_READING_SPAN).costLine).toEqual(
      [],
    );
  });

  describe("past five models", () => {
    it("folds all but the five largest into one band", () => {
      const charts = buildTokenCharts(sevenModels, "model", ONE_READING_SPAN);

      expect(loneHourUsage(sevenModels)).toEqual({
        m3: 300,
        m4: 400,
        m5: 500,
        m6: 600,
        m7: 700,
        "Other models": 300,
      });
      expect(charts.foldedModels).toEqual(["m1", "m2"]);
      // Only the shared band is gray, so it does not read as one more model.
      const colors = charts.tokenBands.map((series) => series.color);
      expect(colors.at(-1)).toBe(colorChartsStatusNeutral);
      expect(colors.slice(0, -1)).not.toContain(colorChartsStatusNeutral);
    });

    it("leaves out the shared band and its note where the folded models used nothing in the range", () => {
      const later = sevenModels.map((row) =>
        row.modelId === "m1" || row.modelId === "m2"
          ? { ...row, timestamp: READINGS[1] }
          : { ...row, timestamp: READINGS[1], input: row.input * 2 },
      );
      const span = { ...SPAN, from: new Date(READINGS[1]) };
      const charts = buildTokenCharts(
        [...sevenModels, ...later],
        "model",
        span,
      );

      expect(charts.foldedModels).toEqual([]);
      expect(charts.tokenBands.map(({ title }) => title)).not.toContain(
        "Other models",
      );
    });

    it("keeps each model its own band at five models or fewer", () => {
      const models = ["m1", "m2", "m3", "m4", "m5"];
      const tokens = [
        ...models.map((modelId) => tokenRow(READINGS[0], modelId, 100)),
        tokenRow(READINGS[0], UNATTRIBUTED_MODEL_ID, 5),
      ];

      // Unattributed tokens are not a model, so they do not count toward five.
      expect(Object.keys(loneHourUsage(tokens))).toEqual([
        ...models,
        UNATTRIBUTED_MODEL_ID,
      ]);
      expect(
        buildTokenCharts(tokens, "model", ONE_READING_SPAN).foldedModels,
      ).toEqual([]);
    });

    it("ranks models by their lease-to-date tokens at the newest reading", () => {
      // m6 first appears at 08:00, just above m1, which barely grew: only a
      // newest-reading ranking keeps m6 over m1.
      const rows = (at: string, counts: [string, number][]) =>
        counts.map(([modelId, input]) => tokenRow(at, modelId, input));
      const steady: [string, number][] = [
        ["m2", 400],
        ["m3", 500],
        ["m4", 600],
        ["m5", 700],
        ["m7", 100],
      ];
      const tokens = [
        ...rows(READINGS[0], [["m1", 290], ...steady]),
        ...rows(READINGS[1], [["m1", 300], ...steady, ["m6", 310]]),
      ];

      const charts = buildTokenCharts(tokens, "model", {
        to: new Date("2026-08-11T08:30:00.000Z"),
      });

      expect(charts.tokenBands.map((band) => band.title)).toEqual([
        "m2",
        "m3",
        "m4",
        "m5",
        "m6",
        "Other models",
      ]);
      // Listed in the order they first appeared, not by size.
      expect(charts.foldedModels).toEqual(["m1", "m7"]);
    });

    it("breaks a tie at the cutoff in favor of the model seen first", () => {
      const tokens = [100, 100, 300, 400, 500, 600].map((input, index) =>
        tokenRow(READINGS[0], `m${index + 1}`, input),
      );

      expect(
        buildTokenCharts(tokens, "model", ONE_READING_SPAN).foldedModels,
      ).toEqual(["m2"]);
    });

    it("never folds unattributed tokens into the other models", () => {
      // More unattributed tokens than any model, so ranking it would take a slot.
      const tokens = [
        ...sevenModels,
        tokenRow(READINGS[0], UNATTRIBUTED_MODEL_ID, 10_000),
      ];

      expect(loneHourUsage(tokens)).toEqual({
        m3: 300,
        m4: 400,
        m5: 500,
        m6: 600,
        m7: 700,
        [UNATTRIBUTED_MODEL_ID]: 10_000,
        "Other models": 300,
      });
    });
  });
});

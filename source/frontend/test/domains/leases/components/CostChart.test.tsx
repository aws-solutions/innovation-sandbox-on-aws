// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { colorChartsThresholdNegative } from "@cloudscape-design/design-tokens";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import {
  buildCostChart,
  CostChart,
  CostChartBudget,
  costChartSeries,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart";
import { buildPredictedSegments } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { PredictedSegment } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  createMockCostHistory,
  createMockNeverOptedInCostHistory,
  LeaseHistoryFixtureData,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

type ChartData = Parameters<typeof buildCostChart>[0];

/**
 * What the cost section hands the chart for a fixture: its readings, its newest
 * figures, the lease's budget, and the segments built from them.
 */
const chartDataOf = ({
  result,
  current,
  budget,
}: LeaseHistoryFixtureData): ChartData => ({
  result,
  current,
  budget,
  predicted: buildPredictedSegments(result, current, undefined),
});

const lineDataOf = (data: ChartData, title: string) => {
  const found = costChartSeries(data).find(
    (candidate) => candidate.title === title,
  );
  return found?.type === "line" ? found.data : [];
};

const allLineDataOf = (data: ChartData, title: string) =>
  costChartSeries(data)
    .filter((candidate) => candidate.title === title)
    .map((candidate) => (candidate.type === "line" ? candidate.data : []));

// A cap far above what the lease has spent, the case that flattens the readings
// onto the axis when the chart is scaled to the budget.
const DISTANT_BUDGET: CostChartBudget = {
  maxSpend: 500,
  thresholds: [
    { dollarsSpent: 125, action: "ALERT" },
    { dollarsSpent: 250, action: "ALERT" },
    { dollarsSpent: 325, action: "FREEZE_ACCOUNT" },
  ],
};

/** One reading against DISTANT_BUDGET, with nothing projected. */
const billedAgainstDistantBudget = (billedCostAccrued: number): ChartData => {
  const base = createMockCostHistory().data;
  const { data } = createMockCostHistory({
    result: [{ timestamp: "2026-08-11T08:00:00.000Z", billedCostAccrued }],
    breaches: [],
    current: {
      ...base.current!,
      billedCostAccrued,
      predictedCost: billedCostAccrued,
    },
    budget: DISTANT_BUDGET,
  });
  return { ...chartDataOf(data), predicted: [] };
};

// Half an hour past the fixtures' last monitoring run, which is where the "Now"
// marker lands and what the forward look is measured from.
const NOW = new Date("2026-08-11T11:30:00.000Z");

// The one line the prediction is drawn as: what each monitoring run projected,
// carried to now, and forecast on from there.
const predictedOf = (data: ChartData) => lineDataOf(data, "Predicted spend");

const between = (points: readonly { x: Date }[], from: string, to: string) =>
  points
    .filter((point) => point.x >= new Date(from) && point.x <= new Date(to))
    .map((point) => point.x.toISOString());

describe("CostChart", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("holds each billed total flat from its reading to the next", () => {
    const data = chartDataOf(createMockCostHistory().data);

    const billed = lineDataOf(data, "Billed");

    expect(billed.at(0)).toEqual({
      x: new Date("2026-08-10T08:00:00.000Z"),
      y: 8,
    });
    expect(billed.at(-1)!.x.toISOString()).toEqual(data.current!.lastCheckedAt);
    // One level per reading, in the order the readings came, and no level the
    // readings did not report.
    expect([...new Set(billed.map((point) => point.y))]).toEqual([
      8, 18, 32, 60,
    ]);
  });

  it("reports the billed total at the same instants as the prediction", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // Half-hourly across each hold, on the grid the projected line uses, so hovering
    // before now reports what had been billed at that moment rather than the total
    // at one end of an eight-hour step.
    const billed = lineDataOf(data, "Billed");
    const overnight = billed.filter(
      (point) =>
        point.x >= new Date("2026-08-10T12:00:00.000Z") &&
        point.x <= new Date("2026-08-10T13:00:00.000Z"),
    );
    expect(overnight).toEqual([
      { x: new Date("2026-08-10T12:00:00.000Z"), y: 8 },
      { x: new Date("2026-08-10T12:30:00.000Z"), y: 8 },
      { x: new Date("2026-08-10T13:00:00.000Z"), y: 8 },
    ]);
  });

  it("holds each total to just short of the reading that replaces it", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // Never onto the same x: a step whose two points share one reports the older
    // total on both sides of it.
    const xs = lineDataOf(data, "Billed").map((point) => point.x.toISOString());
    expect(xs).toEqual([...new Set(xs)]);
    expect(xs).toEqual(
      expect.arrayContaining([
        "2026-08-10T15:59:59.999Z",
        "2026-08-10T16:00:00.000Z",
        "2026-08-10T23:59:59.999Z",
        "2026-08-11T00:00:00.000Z",
        "2026-08-11T07:59:59.999Z",
        "2026-08-11T08:00:00.000Z",
      ]),
    );
  });

  it("marks now between the readings and the forecast", () => {
    const data = chartDataOf(createMockCostHistory().data);

    expect(
      buildCostChart(data).series.find((series) => series.title === "Now"),
    ).toMatchObject({ type: "threshold", x: NOW });
  });

  it("keeps now in view when monitoring has stalled", () => {
    const { hoursToBudgetExhaustion: _dropped, ...stalled } =
      createMockCostHistory().data.current!;
    // Nothing checked since, so nothing to forecast from either.
    const { data: fixture } = createMockCostHistory({
      current: { ...stalled, lastCheckedAt: "2026-08-11T09:00:00.000Z" },
    });
    const data = { ...chartDataOf(fixture), predicted: [] };

    // The axis runs past the last reading to now, so the gap shows rather than
    // being hidden by an axis that stops where the readings do, and a twentieth of
    // the span past now, so the Now line is not drawn on the edge.
    expect(buildCostChart(data).xDomain).toEqual([
      new Date("2026-08-10T08:00:00.000Z"),
      new Date("2026-08-11T12:52:30.000Z"),
    ]);
  });

  it("draws every previous prediction as a single series", () => {
    const data = chartDataOf(createMockCostHistory().data);
    const previous: PredictedSegment[] = [0, 1, 2, 3].map((index) => ({
      fromTimestamp: `2026-08-09T0${index}:00:00.000Z`,
      toTimestamp: `2026-08-09T0${index + 1}:00:00.000Z`,
      startCost: index,
      endCost: index + 1,
      rate: 1,
    }));
    const withManySegments = {
      ...data,
      predicted: [data.predicted[0], ...previous.reverse()],
    };

    render(<CostChart {...withManySegments} />);

    // One line over all four segments, ending where the last of them does.
    const points = lineDataOf(withManySegments, "Previous estimates");
    expect(points.at(0)!.x.toISOString()).toBe("2026-08-09T00:00:00.000Z");
    expect(points.at(-1)!.x.toISOString()).toBe("2026-08-09T04:00:00.000Z");
    expect(screen.getAllByText("Previous estimates")).toHaveLength(1);
  });

  it("treats a historical-only response as previous estimates", () => {
    const data = chartDataOf(createMockCostHistory().data);
    const historicalOnly = {
      ...data,
      predicted: data.predicted.filter((segment) => segment.rateSource == null),
      range: { toTimestamp: "2026-08-11T08:00:00.000Z" },
    };

    const built = buildCostChart(historicalOnly);

    expect(
      built.series.some((series) => series.title === "Predicted spend"),
    ).toBe(false);
    expect(
      built.series.filter((series) => series.title === "Previous estimates"),
    ).toHaveLength(1);
    expect(lineDataOf(historicalOnly, "Previous estimates").at(-1)).toEqual({
      x: new Date("2026-08-11T08:00:00.000Z"),
      y: 46,
    });
    expect(built.hasForecast).toBe(false);
  });

  it("splits previous estimates at a monitoring gap rather than spanning it", () => {
    const data = chartDataOf(createMockCostHistory().data);
    const segment = (hour: number, spanHours: number): PredictedSegment => ({
      fromTimestamp: `2026-08-09T0${hour}:00:00.000Z`,
      toTimestamp: `2026-08-09T0${hour + spanHours}:00:00.000Z`,
      startCost: hour,
      endCost: hour + spanHours,
      rate: 1,
    });
    // 02:00 to 04:00 went unobserved, so no prediction covers it.
    const withGap = {
      ...data,
      predicted: [
        data.predicted[0],
        segment(4, 1),
        segment(1, 1),
        segment(0, 1),
      ],
    };

    render(<CostChart {...withGap} />);

    expect(
      allLineDataOf(withGap, "Previous estimates").map((run) =>
        run.map((point) => point.x.toISOString()),
      ),
    ).toEqual([
      [
        "2026-08-09T00:00:00.000Z",
        "2026-08-09T00:30:00.000Z",
        "2026-08-09T01:00:00.000Z",
        "2026-08-09T01:00:00.000Z",
        "2026-08-09T01:30:00.000Z",
        "2026-08-09T02:00:00.000Z",
      ],
      [
        "2026-08-09T04:00:00.000Z",
        "2026-08-09T04:30:00.000Z",
        "2026-08-09T05:00:00.000Z",
      ],
    ]);
    expect(screen.getAllByText("Previous estimates")).toHaveLength(2);
  });

  it("runs one predicted line from the newest run through now to exhaustion", () => {
    const data = chartDataOf(createMockCostHistory().data);

    render(<CostChart {...data} />);

    const predicted = predictedOf(data);
    expect(predicted.at(0)).toEqual({
      x: new Date("2026-08-11T08:00:00.000Z"),
      y: 60,
    });
    // One figure at now, rather than one from a stretch ending there and another
    // from the stretch that starts there.
    expect(
      predicted.filter((point) => point.x.getTime() === NOW.getTime()),
    ).toEqual([{ x: NOW, y: 72.25 }]);
    expect(predicted.at(-1)).toEqual({
      x: new Date("2026-08-11T19:24:00.000Z"),
      y: 100,
    });
    expect(
      screen.getByText(
        "Past the Now line, predicted spend is a forecast of money not yet spent. Projected thresholds are evaluated at each monitoring run, never against the forecast.",
      ),
    ).toBeInTheDocument();
  });

  it("carries the prediction from the newest reading up to now", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // Half an hour past the reading at $3.50/hour, so the line reaches $72.25 at now
    // -- the figure the summary above states -- with no gap before the "Now" marker.
    const predicted = predictedOf(data);
    expect(
      predicted.find(
        (point) => point.x.toISOString() === "2026-08-11T11:00:00.000Z",
      ),
    ).toEqual({ x: new Date("2026-08-11T11:00:00.000Z"), y: 70.5 });
    // One series, and one value per instant along it.
    const xs = predicted.map((point) => point.x.toISOString());
    expect(xs).toEqual([...new Set(xs)]);
    expect(
      costChartSeries(data).filter(
        (series) => series.title === "Predicted spend",
      ),
    ).toHaveLength(1);
  });

  it("stops the line at the newest reading where no rate has been established", () => {
    const {
      hourlyRate: _hourly,
      dailyRate: _daily,
      hoursToBudgetExhaustion: _exhaustion,
      ...withoutRates
    } = createMockCostHistory().data.current!;
    const data = chartDataOf(
      createMockCostHistory({ current: withoutRates }).data,
    );

    // Nothing to carry the prediction forward at and nothing to forecast, so it stops
    // at the reading and the gap to now is the honest picture.
    expect(predictedOf(data).at(-1)).toEqual({
      x: new Date("2026-08-11T11:00:00.000Z"),
      y: 70.5,
    });
  });

  it("samples the predicted line so a value can be read along it", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // Half-hourly over a window of a day and a half, either side of now: hovering an
    // hour out reports what is projected an hour out, not the total at either end.
    const predicted = predictedOf(data);
    expect(
      between(
        predicted,
        "2026-08-11T10:30:00.000Z",
        "2026-08-11T12:30:00.000Z",
      ),
    ).toEqual([
      "2026-08-11T10:30:00.000Z",
      "2026-08-11T11:00:00.000Z",
      "2026-08-11T11:30:00.000Z",
      "2026-08-11T12:00:00.000Z",
      "2026-08-11T12:30:00.000Z",
    ]);
    // $27.75 left to spend over the 7.9 hours from now to exhaustion.
    expect(
      predicted.find(
        (point) => point.x.toISOString() === "2026-08-11T12:00:00.000Z",
      )!.y,
    ).toBeCloseTo(72.25 + 27.75 * (0.5 / 7.9), 6);
  });

  it("keeps the samples clear of now, wherever the newest reading fell", () => {
    const base = chartDataOf(createMockCostHistory().data);
    const [live, ...previous] = base.predicted;
    // A reading at an odd minute: sampled from the reading, the last sample before
    // now would land a minute short of it.
    const data = {
      ...base,
      predicted: [
        { ...live!, toTimestamp: "2026-08-11T10:29:00.000Z", endCost: 68.7 },
        ...previous,
      ],
      current: { ...base.current!, lastCheckedAt: "2026-08-11T10:29:00.000Z" },
    };

    // The samples fall on the half hours around it instead, so pointing anywhere
    // near now reports now.
    expect(
      between(
        predictedOf(data),
        "2026-08-11T10:29:00.000Z",
        "2026-08-11T12:00:00.000Z",
      ),
    ).toEqual([
      "2026-08-11T10:29:00.000Z",
      "2026-08-11T11:00:00.000Z",
      "2026-08-11T11:30:00.000Z",
      "2026-08-11T12:00:00.000Z",
    ]);
  });

  it("widens the sampling interval with the window rather than the point count", () => {
    const base = createMockCostHistory().data;
    const { data: fixture } = createMockCostHistory({
      current: { ...base.current!, hoursToBudgetExhaustion: 24 * 365 },
    });
    const data = chartDataOf(fixture);

    // A year of exhaustion looks 27 hours forward, so the samples fall hourly and
    // the forecast stays a line rather than a thousand points.
    const forward = predictedOf(data).filter((point) => point.x >= NOW);
    expect(forward[1]!.x.getTime() - forward[0]!.x.getTime()).toBe(
      60 * 60 * 1000,
    );
    expect(forward.length).toBeLessThanOrEqual(81);
  });

  it("starts a whole-lease axis at the lease's start and ends it where the forecast does, not at a far-off expiry", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // A week-long lease a day and a half in: running the axis to expiry would put
    // every reading in the first fifth of it.
    const built = buildCostChart({
      ...data,
      leaseSpan: {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-17T00:00:00.000Z",
      },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-11T19:24:00.000Z"),
    ]);
  });

  it("caps a whole-lease axis at an expiry that comes before the forecast's end", () => {
    const data = chartDataOf(createMockCostHistory().data);

    const built = buildCostChart({
      ...data,
      leaseSpan: {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-11T15:00:00.000Z",
      },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-11T15:00:00.000Z"),
    ]);
  });

  it("ends a whole-lease axis at a lease end that has passed", () => {
    const data = chartDataOf(createMockCostHistory().data);

    const built = buildCostChart({
      ...data,
      leaseSpan: {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-11T11:00:00.000Z",
      },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-11T11:00:00.000Z"),
    ]);
  });

  it("closes the window on the readings where the lease has no end set", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // No duration means no end to run the axis to, so the forward look decides the
    // right-hand edge as it does without a lease span at all.
    const built = buildCostChart({
      ...data,
      leaseSpan: { from: "2026-08-10T00:00:00.000Z" },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T00:00:00.000Z"),
      new Date("2026-08-11T19:24:00.000Z"),
    ]);
  });

  it("stops the prediction at the lease end, whatever range was picked", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // A relative range on a lease that ended half an hour ago. No lease span comes
    // with a picked range, so the end date is the only thing that stops the carry
    // running on to now and accruing spend the lease was over for.
    const built = buildCostChart({
      ...data,
      range: { fromTimestamp: "2026-08-10T00:00:00.000Z" },
      leaseEndedAt: "2026-08-11T11:00:00.000Z",
    });
    const predicted = built.series.find(
      (series) => series.title === "Predicted spend",
    );

    // $3.50/hour over the half hour from the newest reading to the lease end, and
    // not a cent past it -- which is the figure the summary heads the section with.
    expect((predicted?.type === "line" ? predicted.data : []).at(-1)).toEqual({
      x: new Date("2026-08-11T11:00:00.000Z"),
      y: 70.5,
    });
    // Nothing left to forecast either: a lease that has ended cannot go on to reach
    // its budget.
    expect(built.hasForecast).toBe(false);
    // Now stays where now is. The gap between it and the end of the line is what
    // says the lease has ended, so the marker is not moved back to meet it.
    expect(built.series.find((series) => series.title === "Now")).toBeDefined();
  });

  it("claims no forecast where the range closes before now", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // A range closing a quarter hour past the newest reading and a quarter hour
    // short of now: a stretch past the reading is drawn, but none past now.
    const built = buildCostChart({
      ...data,
      range: {
        fromTimestamp: "2026-08-10T00:00:00.000Z",
        toTimestamp: "2026-08-11T11:15:00.000Z",
      },
    });

    // No "Now" marker fits in the window, so the caption must not send the reader
    // looking past a line that is not on the axis.
    expect(
      built.series.find((series) => series.title === "Now"),
    ).toBeUndefined();
    expect(built.hasForecast).toBe(false);
    // That stretch is the estimate carried at the $3.50/hour the run measured, not a
    // forecast interpolated towards the budget -- $71.375 rather than $71.378.
    const predicted = built.series.find(
      (series) => series.title === "Predicted spend",
    );
    expect((predicted?.type === "line" ? predicted.data : []).at(-1)).toEqual({
      x: new Date("2026-08-11T11:15:00.000Z"),
      y: 71.375,
    });
  });

  it("claims no forecast for a trajectory drawn wholly before now", () => {
    const base = createMockCostHistory().data;
    // Exhaustion known but no rate to carry at, so the trajectory inside a window
    // closing before now is drawn by the forecast rather than by the carry. It is
    // still nothing the caption can point past a "Now" line at.
    const {
      hourlyRate: _hourly,
      dailyRate: _daily,
      ...noRates
    } = base.current!;
    const data = chartDataOf(createMockCostHistory({ current: noRates }).data);

    const built = buildCostChart({
      ...data,
      range: {
        fromTimestamp: "2026-08-10T00:00:00.000Z",
        toTimestamp: "2026-08-11T11:15:00.000Z",
      },
    });

    const predicted = built.series.find(
      (series) => series.title === "Predicted spend",
    );
    expect(
      (predicted?.type === "line" ? predicted.data : []).at(-1)!.x,
    ).toEqual(new Date("2026-08-11T11:15:00.000Z"));
    expect(built.hasForecast).toBe(false);
  });

  it("names the figure each threshold is measured against", () => {
    const { data: fixture } = createMockCostHistory({
      budget: {
        maxSpend: 100,
        thresholds: [
          { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
          { dollarsSpent: 70, action: "FREEZE_ACCOUNT", triggerOn: "REPORTED" },
          { dollarsSpent: 90, action: "FREEZE_ACCOUNT" },
        ],
      },
    });
    const data = chartDataOf(fixture);

    render(<CostChart {...data} />);

    expect(costChartSeries(data).map((series) => series.title)).toEqual([
      "Billed",
      "Predicted spend",
      "Previous estimates",
      "Now",
      "Budget",
      "Alert at USD 70.00 (projected)",
      "Freeze at USD 70.00 (billed)",
      "Freeze at USD 90.00 (billed)",
    ]);
  });

  it("claims nothing about threshold evaluation when none fires on the prediction", () => {
    const { data: fixture } = createMockCostHistory({
      budget: {
        maxSpend: 100,
        thresholds: [{ dollarsSpent: 70, action: "ALERT" }],
      },
    });
    const data = chartDataOf(fixture);

    render(<CostChart {...data} />);

    expect(
      screen.getByText(
        "Past the Now line, predicted spend is a forecast of money not yet spent.",
      ),
    ).toBeInTheDocument();
  });

  it("draws nothing past now once the budget is already exhausted", () => {
    const base = createMockCostHistory().data;
    const { data: fixture } = createMockCostHistory({
      current: { ...base.current!, hoursToBudgetExhaustion: 0 },
    });
    const data = chartDataOf(fixture);

    render(<CostChart {...data} />);

    // The prediction still runs up to now; there is just nothing left to forecast,
    // and so nothing to explain.
    expect(predictedOf(data).at(-1)).toEqual({ x: NOW, y: 72.25 });
    expect(buildCostChart(data).hasForecast).toBe(false);
    expect(screen.queryByText(/forecast of money not yet spent/)).toBeNull();
  });

  it("ends the time axis at exhaustion when the budget runs out soon", () => {
    const data = chartDataOf(createMockCostHistory().data);

    expect(buildCostChart(data).xDomain).toEqual([
      new Date("2026-08-10T08:00:00.000Z"),
      new Date("2026-08-11T19:24:00.000Z"),
    ]);
  });

  it("looks no further forward than it looks back when exhaustion is distant", () => {
    const base = createMockCostHistory().data;
    const { data: fixture } = createMockCostHistory({
      current: { ...base.current!, hoursToBudgetExhaustion: 24 * 365 },
    });
    const data = chartDataOf(fixture);

    // 27 hours of readings, so 27 hours of forecast rather than the year it would
    // take this lease to spend its budget.
    expect(buildCostChart(data).xDomain).toEqual([
      new Date("2026-08-10T08:00:00.000Z"),
      new Date("2026-08-12T14:00:00.000Z"),
    ]);
    const predicted = predictedOf(data);
    expect(predicted.at(-1)!.x).toEqual(new Date("2026-08-12T14:00:00.000Z"));
    // Cut off, not rescaled: from $72.25 now, the slope is still the one that
    // reaches $100 a year from the reading rather than by the axis's edge.
    expect(predicted.at(-1)!.y).toBeCloseTo(72.33, 2);
  });

  it("takes the picked upper bound as given, leaving no room to forecast into", () => {
    const data = chartDataOf(createMockCostHistory().data);

    const built = buildCostChart({
      ...data,
      range: {
        fromTimestamp: "2026-08-10T16:00:00.000Z",
        toTimestamp: "2026-08-11T09:00:00.000Z",
      },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T08:00:00.000Z"),
      new Date("2026-08-11T09:00:00.000Z"),
    ]);
    expect(built.hasForecast).toBe(false);
    // Now is past the range that was asked for, and a marker off the end of the
    // axis is drawn on the axis.
    expect(built.series.filter((series) => series.title === "Now")).toEqual([]);
  });

  it("starts the axis where the readings start, not where the lookback did", () => {
    const data = chartDataOf(createMockCostHistory().data);

    // Twenty-seven hours of a young lease read over the last thirty days: the
    // lower bound says which readings to fetch, not what the axis has to cover.
    const built = buildCostChart({
      ...data,
      range: { fromTimestamp: "2026-07-12T11:00:00.000Z" },
    });

    expect(built.xDomain).toEqual([
      new Date("2026-08-10T08:00:00.000Z"),
      new Date("2026-08-11T19:24:00.000Z"),
    ]);
  });

  it("scales the cost axis to the readings, not to a budget far above them", () => {
    const data = billedAgainstDistantBudget(1.5);

    const built = buildCostChart(data);

    expect(built.yDomain![0]).toBe(0);
    expect(built.yDomain![1]).toBeCloseTo(1.65, 2);
    // Every limit is off the top, and a legend entry for a line nobody can see
    // reads as a line at zero.
    expect(built.series.map((series) => series.title)).toEqual([
      "Billed",
      "Now",
    ]);
  });

  it("brings a limit into view once the lease is spending towards it", () => {
    const data = billedAgainstDistantBudget(120);

    const built = buildCostChart(data);

    expect(built.yDomain![1]).toBeCloseTo(137.5, 2);
    expect(built.series.map((series) => series.title)).toEqual([
      "Billed",
      "Now",
      "Alert at USD 125.00 (billed)",
    ]);
  });

  it("keeps a dime of cost axis above a lease that has spent a fraction of a cent", () => {
    const data = billedAgainstDistantBudget(0.00016);

    const built = buildCostChart(data);

    // Fitted to the reading, every tick would fall between cents and read
    // USD 0.00.
    expect(built.yDomain).toEqual([0, 0.1]);
  });

  it("fits the cost axis to spend under a dollar rather than topping it out at one", () => {
    const data = billedAgainstDistantBudget(0.3);

    const built = buildCostChart(data);

    expect(built.yDomain![1]).toBeCloseTo(0.33, 5);
  });

  it("draws a lease that has spent nothing as a flat line on the same axis", () => {
    const data = billedAgainstDistantBudget(0);

    const built = buildCostChart(data);

    expect(built.yDomain).toEqual([0, 0.1]);
    expect(built.series.map((series) => series.title)).toEqual([
      "Billed",
      "Now",
    ]);
  });

  it("draws the staircase against the budget and thresholds when prediction is off", () => {
    const data = chartDataOf(createMockNeverOptedInCostHistory().data);

    render(<CostChart {...data} />);

    expect(costChartSeries(data).map((series) => series.title)).toEqual([
      "Billed",
      "Now",
      "Budget",
      "Alert at USD 50.00 (billed)",
    ]);
    expect(screen.queryByText(/forecast of money not yet spent/)).toBeNull();
  });

  it("puts the date and the time of each axis label on lines of their own", () => {
    const data = chartDataOf(createMockCostHistory().data);

    render(<CostChart {...data} />);

    const ticks = createWrapper().findMixedLineBarChart()!.findXTicks();
    expect(ticks.length).toBeGreaterThan(0);
    for (const tick of ticks) {
      const lines = [...tick.getElement().querySelectorAll("text")].map(
        (line) => line.textContent,
      );
      expect(lines).toEqual([
        expect.stringMatching(/\d{4}/),
        expect.stringMatching(/\d:\d{2}/),
      ]);
    }
  });

  it("offers to reset a picked range that has no readings in it, rather than saying the lease has none", async () => {
    const data = chartDataOf(createMockCostHistory({ result: [] }).data);
    const onResetRange = vi.fn();

    render(
      <CostChart
        {...data}
        range={{ fromTimestamp: "2026-08-11T11:00:00.000Z" }}
        onResetRange={onResetRange}
      />,
    );

    expect(screen.getByText("No data available")).toBeInTheDocument();
    expect(
      screen.queryByText("No cost readings for this lease yet"),
    ).toBeNull();
    await userEvent.click(
      screen.getByRole("button", { name: "Reset filters" }),
    );
    expect(onResetRange).toHaveBeenCalledOnce();
  });

  it("draws the budget and each threshold as a limit, in the negative threshold color", () => {
    const data = chartDataOf(createMockCostHistory().data);

    const limits = buildCostChart(data).series.filter(
      (series) => series.type === "threshold" && series.title !== "Now",
    );

    expect(limits.length).toBeGreaterThan(0);
    for (const limit of limits) {
      expect(limit.color).toBe(colorChartsThresholdNegative);
    }
  });

  it("renders the empty state when no reading has been recorded", () => {
    const data = chartDataOf(createMockCostHistory({ result: [] }).data);

    render(<CostChart {...data} />);

    expect(
      screen.getByText("No cost readings for this lease yet"),
    ).toBeInTheDocument();
  });

  it("renders the loading state while the history is being fetched", () => {
    const data = chartDataOf(createMockCostHistory().data);

    render(<CostChart {...data} loading />);

    expect(screen.getByText("Loading cost history")).toBeInTheDocument();
    expect(screen.queryByText("Billed")).toBeNull();
  });
});

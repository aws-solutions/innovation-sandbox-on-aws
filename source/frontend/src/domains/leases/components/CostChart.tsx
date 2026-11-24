// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Container,
  Header,
  MixedLineBarChart,
  MixedLineBarChartProps,
  SpaceBetween,
} from "@cloudscape-design/components";
import {
  colorChartsThresholdInfo,
  colorChartsThresholdNegative,
  colorChartsThresholdNeutral,
} from "@cloudscape-design/design-tokens";
import { DateTime } from "luxon";
import { ReactNode } from "react";

import {
  CostHistoryCurrent,
  CostHistoryResultRow,
  PredictedSegment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import {
  BudgetThreshold,
  ThresholdAction,
  ThresholdTriggerOn,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { formatCurrency } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

import { accruedSinceLastCheck } from "./cost-history-helpers";

type CostChartDatum = MixedLineBarChartProps.Datum<Date>;
type CostChartSeries = MixedLineBarChartProps.ChartSeries<Date>;

const PREDICTED_TITLE = "Predicted spend";

/**
 * The least the chart looks past the newest reading when nothing bounds it. Beyond
 * this it looks as far forward as there are readings to look back over: enough to
 * show budget exhaustion where it is near, never enough for a distant one to set
 * the scale.
 */
const FORWARD_LOOK_FLOOR_HOURS = 1;

/** Room above the highest line, so it does not sit on the top of the axis. */
export const COST_AXIS_HEADROOM = 1.1;

/**
 * The lowest the cost axis tops out at. Below a dime the ticks fall between cents
 * and round to the same label, and a lease that has spent next to nothing should
 * read as a flat line near zero rather than as a climb up an axis of fractions of a
 * cent.
 */
export const COST_AXIS_FLOOR = 0.1;

/**
 * How far above the highest cost drawn a limit may sit and still set the scale. A
 * budget many times the spend so far says nothing the summary above does not, and
 * flattens the readings onto the axis; one within reach is the most useful thing on
 * the chart.
 */
const LIMIT_IN_REACH_FACTOR = 2;

const THRESHOLD_ACTION_WORD: Record<ThresholdAction, string> = {
  ALERT: "Alert",
  FREEZE_ACCOUNT: "Freeze",
};

// Which figure a threshold is measured against, since two thresholds at the same
// dollar amount fire on different events and are drawn as the same flat line.
const THRESHOLD_FIGURE_WORD: Record<ThresholdTriggerOn, string> = {
  REPORTED: "billed",
  PREDICTED: "projected",
};

const thresholdTitle = (threshold: BudgetThreshold): string =>
  `${THRESHOLD_ACTION_WORD[threshold.action]} at ${formatCostAmount(
    threshold.dollarsSpent,
  )} (${THRESHOLD_FIGURE_WORD[threshold.triggerOn ?? "REPORTED"]})`;

const toDate = (timestamp: string): Date =>
  DateTime.fromISO(timestamp).toJSDate();

/**
 * How far short of the next reading a billed total stops being held. Sharing the x
 * puts two totals on one pixel, and Cloudscape's marker then takes the first of
 * them however far to the right of the step the cursor is -- so the step to $1.50
 * reads as $0.60 on both sides. A millisecond apart, each side of the step reports
 * the total that was current there.
 */
export const HOLD_GAP_MS = 1;

/**
 * A billed total holds flat from the reading that set it until just short of the
 * reading that replaces it, since Cloudscape interpolates straight between points
 * with no step interpolation to ask for. The newest reading holds to the last
 * monitoring run. Each hold carries the same sampled instants as the projected
 * lines, so that hovering anywhere before now reports what had been billed at that
 * moment beside what was predicted for it.
 */
const billedSteps = (
  result: CostHistoryResultRow[],
  grid: SampleGrid,
  lastCheckedAt?: string | null,
): CostChartDatum[] => {
  const ascending = [...result].reverse();
  return ascending.flatMap((row, index) => {
    const from = toDate(row.timestamp);
    const next = ascending[index + 1]?.timestamp;
    const heldUntil =
      next === undefined
        ? toDate(lastCheckedAt ?? row.timestamp)
        : new Date(toDate(next).getTime() - HOLD_GAP_MS);
    const reading = { x: from, y: row.billedCostAccrued };
    return heldUntil > from
      ? sampled(reading, { x: heldUntil, y: row.billedCostAccrued }, grid)
      : [reading];
  });
};

/**
 * Intervals a projected line is sampled at, narrowest first. A line drawn from its
 * two ends reports one of those two ends wherever it is hovered, so an estimate cast
 * hours into the future answers every question about it with its own start or finish.
 */
const SAMPLE_INTERVALS_MINUTES = [15, 30, 60, 180, 360, 720, 1440, 10080];

/** Points one projected line may be sampled into across the whole window. */
const SAMPLE_BUDGET = 80;

/**
 * How much of a step either side of a line's own ends is left free of samples.
 * Cloudscape reports whichever x lies nearest the cursor, so a sample a minute short
 * of one of those ends makes the figure there something to be hunted for with small
 * movements of the mouse. Now is one of those ends -- of the carried estimate, and of
 * the forecast that continues it -- and it is the figure a reader came for, so it
 * keeps a band of its own however the samples happen to fall around it.
 */
const SAMPLE_CLEARANCE = 0.5;

/**
 * Instants the projected lines are sampled at: every step away from the anchor, in
 * both directions, without end. One grid for the whole chart rather than one per
 * line, so that samples land on the same instants on every line -- hovering between
 * two readings reports the estimate and the forecast at one x -- and so that the
 * grid can be anchored where it matters most.
 */
type SampleGrid = {
  stepMs: number;
  anchorMs: number;
};

/**
 * How far apart the samples sit: the narrowest interval that keeps a line spanning
 * the whole window inside the budget, so a chart covering an afternoon reports every
 * quarter hour and one covering a year reports every week. Measured off the window
 * and not off each segment, so the points stay bounded however many segments there
 * are. Anchored on now, which puts a sample on round offsets from the present and
 * never a sliver away from it.
 */
function sampleGrid(window: [Date, Date] | undefined, now: Date): SampleGrid {
  const spanMs =
    window === undefined ? 0 : window[1].getTime() - window[0].getTime();
  const minutes =
    SAMPLE_INTERVALS_MINUTES.find(
      (candidate) => spanMs / (candidate * 60_000) <= SAMPLE_BUDGET,
    ) ?? SAMPLE_INTERVALS_MINUTES.at(-1)!;
  return { stepMs: minutes * 60_000, anchorMs: now.getTime() };
}

/**
 * A straight line between two points, with the grid's instants marked along it. The
 * ends are kept exactly and the interpolation is linear, which is what the chart
 * draws between two points anyway -- the samples change nothing about the line's
 * shape, only how much of it can be read off by hovering.
 */
function sampled(
  from: CostChartDatum,
  to: CostChartDatum,
  { stepMs, anchorMs }: SampleGrid,
): CostChartDatum[] {
  const fromMs = from.x.getTime();
  const spanMs = to.x.getTime() - fromMs;
  if (spanMs <= 0) {
    return [from, to];
  }
  const clearanceMs = stepMs * SAMPLE_CLEARANCE;
  const first = Math.ceil((fromMs + clearanceMs - anchorMs) / stepMs);
  const points: CostChartDatum[] = [from];
  for (
    let at = anchorMs + first * stepMs;
    at <= to.x.getTime() - clearanceMs;
    at += stepMs
  ) {
    points.push({
      x: new Date(at),
      y: from.y + ((to.y - from.y) * (at - fromMs)) / spanMs,
    });
  }
  points.push(to);
  return points;
}

const segmentPoints = (
  segment: PredictedSegment,
  grid: SampleGrid,
): CostChartDatum[] =>
  sampled(
    { x: toDate(segment.fromTimestamp), y: segment.startCost },
    { x: toDate(segment.toTimestamp), y: segment.endCost },
    grid,
  );

/** When budget exhaustion is projected for, or undefined where none is. */
const exhaustionInstant = (
  current: CostHistoryCurrent | null | undefined,
): Date | undefined => {
  const hours = current?.hoursToBudgetExhaustion;
  if (current == null || hours == null || hours <= 0) {
    return undefined;
  }
  return DateTime.fromISO(current.lastCheckedAt).plus({ hours }).toJSDate();
};

const earliestOf = (timestamps: string[]): Date | undefined =>
  timestamps
    .map(toDate)
    .reduce<Date | undefined>(
      (earliest, candidate) =>
        earliest === undefined || candidate < earliest ? candidate : earliest,
      undefined,
    );

const earlier = (one: Date, other: Date): Date => (one < other ? one : other);

/** Room past now, as a share of the span, so the Now line is not drawn on the edge. */
const NOW_MARGIN = 0.05;

const endPastNow = (start: Date, end: Date, now: Date): Date =>
  end > now
    ? end
    : DateTime.fromJSDate(now)
        .plus({ milliseconds: (now.getTime() - start.getTime()) * NOW_MARGIN })
        .toJSDate();

/**
 * The span both axes are fitted to. Left to itself Cloudscape fits to every
 * series, and the trajectory's far end -- budget exhaustion, which on a lease
 * spending cents an hour is a year out -- squeezes every reading into the left
 * edge of the plot.
 *
 * It starts at the oldest thing drawn and not at the lower bound that was asked
 * for. A lease twenty hours old read over the last thirty days has twenty-nine days
 * of nothing to the left of it, and every reading lands in a smudge against the
 * right-hand edge; the lower bound decides which readings are fetched, which is a
 * different question from what the axis has to cover. A lease span is the exception:
 * asking for the whole lease starts the axis at the lease's start, empty stretches
 * included.
 *
 * It ends at the last thing there is to show -- always including now, so that a
 * lease whose monitoring has stalled shows the gap rather than hiding it -- plus a
 * forward look for the trajectory to slope into, as far forward as there is data to
 * look back over. An end the picker gave, or a lease end that has passed, is taken
 * as given instead, so a span ending in the past leaves no forward room at all. A
 * lease end still to come only caps the axis.
 */
function chartWindow(
  data: CostChartData,
  exhaustedAt: Date | undefined,
  now: Date,
): [Date, Date] | undefined {
  const observedEnd = data.current?.lastCheckedAt ?? data.result[0]?.timestamp;
  const start = earliestOf([
    ...(data.leaseSpan === undefined ? [] : [data.leaseSpan.from]),
    ...data.result.map((row) => row.timestamp),
    ...data.predicted.map((segment) => segment.fromTimestamp),
  ]);
  if (observedEnd === undefined || start === undefined) {
    return undefined;
  }
  const rangeEnd = data.range?.toTimestamp;
  if (rangeEnd !== undefined) {
    return [start, toDate(rangeEnd)];
  }
  const leaseEnd =
    data.leaseSpan?.to === undefined ? undefined : toDate(data.leaseSpan.to);
  if (leaseEnd !== undefined && leaseEnd <= now) {
    return [start, leaseEnd];
  }
  const withinLease = (end: Date): Date =>
    leaseEnd === undefined ? end : earlier(end, leaseEnd);
  const newest = DateTime.fromISO(observedEnd);
  if (exhaustedAt === undefined) {
    return [start, withinLease(endPastNow(start, newest.toJSDate(), now))];
  }
  const observedHours = newest.diff(DateTime.fromJSDate(start), "hours").hours;
  const forwardLimit = newest
    .plus({ hours: Math.max(observedHours, FORWARD_LOOK_FLOOR_HOURS) })
    .toJSDate();
  const end = exhaustedAt < forwardLimit ? exhaustedAt : forwardLimit;
  return [start, withinLease(endPastNow(start, end, now))];
}

/**
 * The newest run's projection carried on at the rate that run measured, to the
 * instant the prediction runs through. Undefined where there is nothing to carry --
 * no rate to carry at, or a run that is already the later of the two.
 */
function carriedPoint(
  from: CostChartDatum,
  current: CostHistoryCurrent | null | undefined,
  until: Date,
): CostChartDatum | undefined {
  if (current == null) {
    return undefined;
  }
  const carried = accruedSinceLastCheck(current, until);
  return carried.hours > 0
    ? { x: until, y: from.y + carried.accrued }
    : undefined;
}

/**
 * The forecast from where the prediction reaches the present on towards the budget,
 * cut off at the window's edge. The cost it reaches there is interpolated, so the
 * slope is the projected one whether or not exhaustion itself is in view.
 */
function forecastPoints(
  from: CostChartDatum,
  maxSpend: number,
  exhaustedAt: Date,
  windowEnd: Date,
  grid: SampleGrid,
): CostChartDatum[] {
  const projectedSpan = exhaustedAt.getTime() - from.x.getTime();
  const end = exhaustedAt < windowEnd ? exhaustedAt : windowEnd;
  if (projectedSpan <= 0 || end <= from.x) {
    return [];
  }
  const reached = (end.getTime() - from.x.getTime()) / projectedSpan;
  return sampled(
    from,
    { x: end, y: from.y + reached * (maxSpend - from.y) },
    grid,
  );
}

/**
 * The top of the cost axis: the highest cost drawn, stretched to the next limit
 * where that limit is within reach. Fitting to the budget instead puts a $1.50
 * reading on the floor of a $500 axis, where neither the total nor its shape can be
 * read. This way each limit comes into view as the lease approaches it.
 */
function costAxisTop(
  series: CostChartSeries[],
  budget: CostChartBudget,
): number | undefined {
  const drawn = series.flatMap((candidate) =>
    candidate.type === "line" ? candidate.data.map((point) => point.y) : [],
  );
  if (drawn.length === 0) {
    return undefined;
  }
  const highest = Math.max(...drawn);
  const inReach = [
    ...budget.thresholds.map((threshold) => threshold.dollarsSpent),
    ...(budget.maxSpend == null ? [] : [budget.maxSpend]),
  ].filter(
    (limit) => limit > highest && limit <= highest * LIMIT_IN_REACH_FACTOR,
  );
  const top =
    (inReach.length === 0 ? highest : Math.min(...inReach)) *
    COST_AXIS_HEADROOM;
  // A chart whose lines are all below zero is left for Cloudscape to fit.
  return top < 0 ? undefined : Math.max(top, COST_AXIS_FLOOR);
}

/**
 * Segments grouped where one ends exactly where the next begins. Cloudscape draws
 * a series as a single line and offers no way to break it, so a skipped monitoring
 * run would otherwise be spanned by a line nobody predicted.
 */
const contiguousRuns = (segments: PredictedSegment[]): PredictedSegment[][] => {
  const runs: PredictedSegment[][] = [];
  for (const segment of segments) {
    const open = runs.at(-1);
    const meets =
      open !== undefined &&
      toDate(open.at(-1)!.toTimestamp).getTime() ===
        toDate(segment.fromTimestamp).getTime();
    if (meets) {
      open.push(segment);
    } else {
      runs.push([segment]);
    }
  }
  return runs;
};

/**
 * The bounds the picker asked for, either of which may stand alone. Only the upper
 * one bounds the axis; the lower one bounds which readings were fetched, and the
 * axis starts at the oldest that came back.
 */
type CostChartRange = {
  fromTimestamp?: string;
  toTimestamp?: string;
};

/**
 * The lease's own length, passed only when the whole lease is what was asked for. A
 * lease that has not ended gives its expiry, and one with no duration set gives no
 * end at all -- the window then closes where the readings and the forecast do.
 */
export type CostChartLeaseSpan = {
  from: string;
  to?: string;
};

/** The lease's budget and thresholds, from the lease. */
export type CostChartBudget = {
  maxSpend?: number;
  thresholds: BudgetThreshold[];
};

type CostChartData = {
  result: CostHistoryResultRow[];
  predicted: PredictedSegment[];
  current?: CostHistoryCurrent | null;
  budget: CostChartBudget;
  range?: CostChartRange;
  leaseSpan?: CostChartLeaseSpan;
  /**
   * When the lease ended, for one that has. Unlike the span, this is passed whatever
   * range was picked: it caps how far the prediction is carried, which is a fact
   * about the lease rather than about the stretch of it being looked at.
   */
  leaseEndedAt?: string;
};

type CostChartProps = CostChartData & {
  loading?: boolean;
  actions?: ReactNode;
  /** Puts the picker back on the whole lease, offered where a range has no readings. */
  onResetRange?: () => void;
};

const NoReadingsInRange = ({ onReset }: { onReset: () => void }) => (
  <Box textAlign="center" color="inherit">
    <Box variant="strong" color="inherit">
      No data available
    </Box>
    <Box variant="p" color="inherit">
      There are no cost readings in the selected range.
    </Box>
    <Button onClick={onReset}>Reset filters</Button>
  </Box>
);

type ChartBuild = {
  series: CostChartSeries[];
  /** Whether the predicted line runs past now, which is what the caption explains. */
  hasForecast: boolean;
  xDomain?: [Date, Date];
  yDomain?: [number, number];
};

/** What every series is drawn against, derived once and shared by all of them. */
type ChartFrame = {
  grid: SampleGrid;
  window: [Date, Date] | undefined;
  exhaustedAt: Date | undefined;
  now: Date;
  /**
   * Whether now is somewhere the chart can draw it. A picked range ending in the
   * past has no room for it, and a marker off the end of the axis is drawn on the
   * axis.
   */
  showsNow: boolean;
  /**
   * When the lease ended, for one that has. It caps how far the prediction is drawn:
   * nothing accrues after a lease ends, and the headline caps its estimate at the
   * same instant for the same reason.
   */
  leaseEndsAt: Date | undefined;
};

/**
 * What the prediction says the lease has spent, as one line: what the newest
 * monitoring run projected, carried from that run to now at the rate it measured,
 * and forecast on from there towards the budget. One line and not three, because
 * that is one question -- what is this lease predicted to have spent at a given
 * moment -- and a series per answer names each stretch in the legend and reports
 * two figures at the instants where two of them meet.
 */
function predictedLine(
  live: PredictedSegment,
  data: CostChartData,
  frame: ChartFrame,
): { points: CostChartDatum[]; hasForecast: boolean } {
  const { current, budget } = data;
  const { grid, window, exhaustedAt, now, leaseEndsAt } = frame;
  const atNewestRun: CostChartDatum = {
    x: toDate(live.toTimestamp),
    y: live.endCost,
  };
  const points: CostChartDatum[] = [...segmentPoints(live, grid)];
  if (window === undefined) {
    return { points, hasForecast: false };
  }

  // The furthest the line is drawn: the window's own edge, or the lease's end where
  // it ended before that. Nothing accrues after a lease ends, and the headline caps
  // its estimate at the same instant for the same reason.
  const predictedThrough =
    leaseEndsAt === undefined ? window[1] : earlier(window[1], leaseEndsAt);

  // A reading is up to a monitoring interval old, so the projection made on it is
  // carried the rest of the way at the rate that run measured, rather than left to
  // stop short. Up to the present only -- past that the line is a forecast instead,
  // which is a different claim even where the rate makes it the same slope.
  const carryTo = earlier(now, predictedThrough);
  const atCarried =
    carryTo >= window[0]
      ? carriedPoint(atNewestRun, current, carryTo)
      : undefined;
  if (atCarried !== undefined) {
    points.push(...sampled(atNewestRun, atCarried, grid).slice(1));
  }

  if (budget.maxSpend == null || exhaustedAt === undefined) {
    return { points, hasForecast: false };
  }

  // From wherever the line reaches the present: a forecast starting at a reading
  // an hour behind the present would cross the stretch it continues.
  const forecast = forecastPoints(
    atCarried ?? atNewestRun,
    budget.maxSpend,
    exhaustedAt,
    predictedThrough,
    grid,
  );
  points.push(...forecast.slice(1));
  // A window closing at or before the present shows nothing the caption has to
  // explain, however much of the trajectory was drawn inside it.
  return {
    points,
    hasForecast: forecast.length > 0 && predictedThrough > now,
  };
}

/**
 * The budget and threshold lines the axis reaches. Limits beyond the top are left
 * out rather than clipped: Cloudscape lists every series in the legend, drawn or
 * not, so a $500 budget would be named beside a chart that tops out at $11.
 */
function limitSeries(
  budget: CostChartBudget,
  top: number | undefined,
): CostChartSeries[] {
  const withinAxis = (limit: number) => top === undefined || limit <= top;
  const series: CostChartSeries[] = [];

  if (budget.maxSpend != null && withinAxis(budget.maxSpend)) {
    series.push({
      title: "Budget",
      type: "threshold",
      y: budget.maxSpend,
      valueFormatter: formatCostAmount,
      color: colorChartsThresholdNegative,
    });
  }

  for (const threshold of budget.thresholds) {
    if (withinAxis(threshold.dollarsSpent)) {
      series.push({
        title: thresholdTitle(threshold),
        type: "threshold",
        y: threshold.dollarsSpent,
        valueFormatter: formatCostAmount,
        color: colorChartsThresholdNegative,
      });
    }
  }
  return series;
}

/**
 * The series and the domains together, because a limit is only drawn where the
 * axis reaches it and the axis is scaled from the lines that were drawn.
 */
export function buildCostChart(data: CostChartData): ChartBuild {
  // A budget line has nowhere to sit until one reading places the time axis.
  if (data.result.length === 0) {
    return { series: [], hasForecast: false };
  }

  const { predicted, current, budget } = data;
  const now = new Date();
  const exhaustedAt = exhaustionInstant(current);
  const window = chartWindow(data, exhaustedAt, now);
  const grid = sampleGrid(window, now);
  const live = predicted.find((segment) => segment.rateSource != null);
  const previous = predicted.filter((segment) => segment.rateSource == null);
  const series: CostChartSeries[] = [
    {
      title: "Billed",
      type: "line",
      data: billedSteps(data.result, grid, current?.lastCheckedAt),
      valueFormatter: formatCostAmount,
    },
  ];

  const showsNow = window !== undefined && now >= window[0] && now <= window[1];
  const frame: ChartFrame = {
    grid,
    window,
    exhaustedAt,
    now,
    showsNow,
    leaseEndsAt:
      data.leaseEndedAt === undefined ? undefined : toDate(data.leaseEndedAt),
  };

  const prediction =
    live === undefined ? undefined : predictedLine(live, data, frame);
  if (prediction !== undefined) {
    series.push({
      title: PREDICTED_TITLE,
      type: "line",
      data: prediction.points,
      valueFormatter: formatCostAmount,
    });
  }

  // One series per run rather than per segment: Cloudscape gives a legend entry
  // per series and cannot group them, so a week-old lease would list dozens.
  for (const run of contiguousRuns([...previous].reverse())) {
    series.push({
      title: "Previous estimates",
      type: "line",
      color: colorChartsThresholdNeutral,
      data: run.flatMap((segment) => segmentPoints(segment, grid)),
      valueFormatter: formatCostAmount,
    });
  }

  // Where the billed steps stop being history and the trajectory starts being a
  // guess. A vertical line rather than a dot on the newest reading: the newest
  // reading is not now, and the gap between them is the point.
  if (showsNow) {
    series.push({
      title: "Now",
      type: "threshold",
      x: now,
      color: colorChartsThresholdInfo,
    });
  }

  // Scaled from the lines alone, so the limits are placed against an axis they
  // did not stretch.
  const top = costAxisTop(series, budget);
  series.push(...limitSeries(budget, top));

  const yDomain: [number, number] | undefined =
    top === undefined ? undefined : [0, top];
  return {
    series,
    hasForecast: prediction?.hasForecast ?? false,
    ...(window === undefined ? {} : { xDomain: window }),
    ...(yDomain === undefined ? {} : { yDomain }),
  };
}

export const costChartSeries = (data: CostChartData): CostChartSeries[] =>
  buildCostChart(data).series;

/**
 * The chart's own container, shared with the caller so that a range that fails to
 * load keeps the picker in the header it was picked from rather than moving it.
 */
export const CostChartContainer = ({
  actions,
  children,
}: {
  actions?: ReactNode;
  children: ReactNode;
}) => (
  <Container
    header={
      <Header
        variant="h2"
        description="Billed spend as steps, against the spend predicted at each monitoring run."
        actions={actions}
      >
        Spend over time
      </Header>
    }
  >
    {children}
  </Container>
);

export const CostChart = ({
  loading,
  actions,
  onResetRange,
  ...data
}: CostChartProps) => {
  const { series, hasForecast, xDomain, yDomain } = buildCostChart(data);
  const hasProjectedThreshold = data.budget.thresholds.some(
    (threshold) => threshold.triggerOn === "PREDICTED",
  );

  return (
    <CostChartContainer actions={actions}>
      <SpaceBetween size="xs">
        <MixedLineBarChart<Date>
          series={series}
          xScaleType="time"
          xTitle="Time"
          yTitle="Spend"
          ariaLabel="Spend over time"
          hideFilter
          statusType={loading ? "loading" : "finished"}
          loadingText="Loading cost history"
          {...(xDomain === undefined ? {} : { xDomain })}
          {...(yDomain === undefined ? {} : { yDomain })}
          xTickFormatter={(x) => {
            // On two lines, so the first label reaches half as far under the y axis.
            const at = DateTime.fromJSDate(x);
            return `${at.toLocaleString(DateTime.DATE_SHORT)}\n${at.toLocaleString(DateTime.TIME_SIMPLE)}`;
          }}
          yTickFormatter={formatCurrency}
          empty={
            data.range === undefined || onResetRange === undefined ? (
              <Box textAlign="center" color="inherit" variant="p">
                No cost readings for this lease yet
              </Box>
            ) : (
              <NoReadingsInRange onReset={onResetRange} />
            )
          }
        />
        {hasForecast && (
          <Box variant="small">
            {hasProjectedThreshold
              ? "Past the Now line, predicted spend is a forecast of money not yet spent. Projected thresholds are evaluated at each monitoring run, never against the forecast."
              : "Past the Now line, predicted spend is a forecast of money not yet spent."}
          </Box>
        )}
      </SpaceBetween>
    </CostChartContainer>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AreaChartProps,
  MixedLineBarChartProps,
} from "@cloudscape-design/components";
import {
  colorChartsPaletteCategorical1,
  colorChartsPaletteCategorical2,
  colorChartsPaletteCategorical3,
  colorChartsPaletteCategorical4,
  colorChartsPaletteCategorical5,
  colorChartsPaletteCategorical6,
  colorChartsStatusNeutral,
} from "@cloudscape-design/design-tokens";
import { DateTime, Duration } from "luxon";

import {
  COST_AXIS_FLOOR,
  COST_AXIS_HEADROOM,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart";
import {
  TokenSeriesRow,
  TokenType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import { UNATTRIBUTED_MODEL_ID } from "@amzn/innovation-sandbox-shared/types/cost-history.js";

// The Bedrock token panel's data: the lease's lease-to-date token rows turned into
// the tokens and the cost used in each hour or day of a span, ready for the charts.

/** What the token stack is divided by. */
export type TokenStackDimension = "model" | "tokenType";

/** How long each point of the charts covers. */
export type TokenPeriodUnit = "hour" | "day";

/**
 * The picked range's start, if it has one, and where the charts end: when the data
 * was read, or wherever the range or the lease stops short of it. `unknownBefore`
 * where what was spent before the start is unknown rather than nothing, as where
 * the readings before a range did not arrive.
 */
export type TokenSpan = { from?: Date; to: Date; unknownBefore?: boolean };

export const DERIVED_COST_TITLE = "Estimated Bedrock token cost";

export const OTHER_MODELS_TITLE = "Other models";

const TOKEN_TYPE_LABELS: Record<TokenType, string> = {
  input: "Input",
  output: "Output",
  cacheRead: "Cache read",
  cacheWrite: "Cache write",
};

const TOKEN_TYPES = Object.keys(TOKEN_TYPE_LABELS) as TokenType[];

/** The most models the chart names; the rest share one band, so it stays readable. */
const MAX_NAMED_MODELS = 5;

/**
 * The chart's own first colors, pinned to each band by its place across the whole
 * lease, so a band keeps its color in a range that leaves out the bands before it.
 * One for each named model and one for unattributed tokens.
 */
const BAND_COLORS = [
  colorChartsPaletteCategorical1,
  colorChartsPaletteCategorical2,
  colorChartsPaletteCategorical3,
  colorChartsPaletteCategorical4,
  colorChartsPaletteCategorical5,
  colorChartsPaletteCategorical6,
];

/** Up to this span the charts count per hour; past it, per day. */
const HOURLY_SPAN_MS = Duration.fromObject({ days: 2 }).toMillis();

/**
 * The lowest the token axis tops out at, so a handful of tokens does not climb an
 * axis of fractions of a token.
 */
const TOKEN_AXIS_FLOOR = 10;

const tokenCountFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 0,
});

export const formatTokenCount = (count: number): string =>
  tokenCountFormatter.format(count);

/** Every row sharing one timestamp: the lease's whole cumulative count then. */
type TokenReading = {
  at: Date;
  rows: TokenSeriesRow[];
  /**
   * Lease-wide as of the reading, and repeated on each of its rows, so it is read
   * from one row and never summed across them. It prices only the tokens attributed
   * to a model: absent where any of them could not be priced or none were counted.
   */
  monitoredBedrockTokenCost: number | undefined;
};

/**
 * The rows grouped into readings, oldest first. Each reading repeats every region
 * and model the lease has used so far, so a model missing from one had counted
 * nothing yet.
 */
function groupByTimestampAsc(tokens: TokenSeriesRow[]): TokenReading[] {
  const byTimestamp = new Map<string, TokenSeriesRow[]>();
  for (const row of tokens) {
    const rows = byTimestamp.get(row.timestamp);
    if (rows === undefined) {
      byTimestamp.set(row.timestamp, [row]);
    } else {
      rows.push(row);
    }
  }
  return [...byTimestamp.entries()]
    .map(([timestamp, rows]) => ({
      at: new Date(timestamp),
      rows,
      monitoredBedrockTokenCost: rows[0].monitoredBedrockTokenCost,
    }))
    .sort((a, b) => a.at.getTime() - b.at.getTime());
}

const rowTotal = (row: TokenSeriesRow): number =>
  TOKEN_TYPES.reduce((total, type) => total + row[type], 0);

/** Every token the lease has counted at its newest reading, and when that was. */
export function tokensUsedSoFar(
  tokens: TokenSeriesRow[],
): { total: number; at: Date } | undefined {
  const newest = groupByTimestampAsc(tokens).at(-1);
  if (newest === undefined) {
    return undefined;
  }
  return {
    total: newest.rows.reduce((sum, row) => sum + rowTotal(row), 0),
    at: newest.at,
  };
}

/** One row's counts under the keys the stack is divided by. */
const SLICES: Record<
  TokenStackDimension,
  (row: TokenSeriesRow) => [string, number][]
> = {
  model: (row) => [[row.modelId, rowTotal(row)]],
  tokenType: (row) =>
    TOKEN_TYPES.map((type) => [TOKEN_TYPE_LABELS[type], row[type]]),
};

/** A reading's lease-to-date counts by model or by token type, summed across regions. */
function countsOf(
  reading: TokenReading,
  stackBy: TokenStackDimension,
): Map<string, number> {
  const counts = new Map<string, number>();
  for (const row of reading.rows) {
    for (const [key, count] of SLICES[stackBy](row)) {
      counts.set(key, (counts.get(key) ?? 0) + count);
    }
  }
  return counts;
}

/** Every key the stack is divided by, in the order the lease first counted it. */
function stackKeysOf(
  readings: TokenReading[],
  stackBy: TokenStackDimension,
): string[] {
  return [
    ...new Set(
      readings.flatMap(({ rows }) =>
        rows.flatMap((row) => SLICES[stackBy](row).map(([key]) => key)),
      ),
    ),
  ];
}

/**
 * The models that share one last band, in the order they first appeared. The
 * models with the most tokens at the newest reading keep their own bands; the
 * counts are lease-to-date, so the newest reading is the largest, and a tie goes to
 * the model that appeared first. Unattributed tokens are never folded, so they stay
 * apart from every model's.
 */
function foldedModelsOf(keys: string[], newest: Map<string, number>): string[] {
  const models = keys.filter((key) => key !== UNATTRIBUTED_MODEL_ID);
  const largest = new Set(
    [...models]
      .sort((a, b) => (newest.get(b) ?? 0) - (newest.get(a) ?? 0))
      .slice(0, MAX_NAMED_MODELS),
  );
  return models.filter((key) => !largest.has(key));
}

/**
 * The newest reading before `instant` that `matches`, searched from the newest down
 * since the readings are oldest first.
 */
function newestBefore(
  readings: TokenReading[],
  instant: Date,
  matches: (reading: TokenReading) => boolean = () => true,
): TokenReading | undefined {
  for (let index = readings.length - 1; index >= 0; index -= 1) {
    const reading = readings[index];
    if (reading.at < instant && matches(reading)) {
      return reading;
    }
  }
  return undefined;
}

const pricedBefore = (
  readings: TokenReading[],
  instant: Date,
): TokenReading | undefined =>
  newestBefore(
    readings,
    instant,
    ({ monitoredBedrockTokenCost }) => monitoredBedrockTokenCost !== undefined,
  );

/** One point of the charts: the hour or day starting at `start`. */
type Period = { start: Date; end: Date };

/**
 * The hours, or for a span past two days the days, from the one holding `from` to
 * the one holding `to`: at least two, so that a lone period still draws a shape.
 */
function periodsOf(
  from: Date,
  to: Date,
): { unit: TokenPeriodUnit; periods: Period[] } {
  const unit: TokenPeriodUnit =
    to.getTime() - from.getTime() <= HOURLY_SPAN_MS ? "hour" : "day";
  const step = unit === "hour" ? { hours: 1 } : { days: 1 };
  const last = DateTime.fromJSDate(to).startOf(unit);
  const first = DateTime.min(
    DateTime.fromJSDate(from).startOf(unit),
    last.minus(step),
  );
  const periods: Period[] = [];
  for (let start = first; start <= last; start = start.plus(step)) {
    periods.push({
      start: start.toJSDate(),
      end: start.plus(step).toJSDate(),
    });
  }
  return { unit, periods };
}

/** What one period used: tokens per key, and their cost, null where it is unknown. */
type PeriodUsage = {
  start: Date;
  tokens: Map<string, number>;
  cost: number | null;
};

/**
 * Each period's usage, as the counts at its end less the counts at its start, read
 * only within the span. The counts are lease-to-date, so readings before the span
 * still set where its first period starts from. A period's cost is unknown where
 * its newest reading could not be priced; the baseline then stays put, so the next
 * priced period carries the cost it missed, since the monitored cost is lease-to-date
 * too.
 */
function usageByPeriod(
  readings: TokenReading[],
  periods: Period[],
  span: { from: Date; to: Date; unknownBefore?: boolean },
  stackBy: TokenStackDimension,
): PeriodUsage[] {
  // The last priced cost before the span, which its first period counts from: none
  // means nothing was spent, unless what came before is unknown, when the first
  // priced period has nothing to count from and is left unknown too.
  let baselineCost =
    pricedBefore(readings, span.from)?.monitoredBedrockTokenCost ??
    (span.unknownBefore === true ? undefined : 0);
  let nextReading = 0;
  let counts = new Map<string, number>();
  // Before any reading nothing has been used, which costs nothing.
  let latestCost: number | undefined = 0;
  const readUntil = (instant: number) => {
    const reached = nextReading;
    while (
      nextReading < readings.length &&
      readings[nextReading].at.getTime() < instant
    ) {
      latestCost = readings[nextReading].monitoredBedrockTokenCost;
      nextReading += 1;
    }
    // Lease-to-date, so only the last reading passed sets the counts.
    if (nextReading > reached) {
      counts = countsOf(readings[nextReading - 1], stackBy);
    }
  };
  return periods.map(({ start, end }) => {
    readUntil(Math.max(start.getTime(), span.from.getTime()));
    const before = counts;
    // Just past the span's end, so that a reading at the end is in it.
    readUntil(Math.min(end.getTime(), span.to.getTime() + 1));
    const tokens = new Map<string, number>();
    for (const [key, count] of counts) {
      tokens.set(key, count - (before.get(key) ?? 0));
    }
    if (latestCost === undefined) {
      return { start, tokens, cost: null };
    }
    const cost = baselineCost === undefined ? null : latestCost - baselineCost;
    baselineCost = latestCost;
    return { start, tokens, cost };
  });
}

/** One band of the token stack, at zero in the periods its keys used nothing. */
const tokenBand = (
  title: string,
  keys: string[],
  usage: PeriodUsage[],
  color: string,
): AreaChartProps.AreaSeries<Date> => ({
  title,
  type: "area",
  data: usage.map(({ start, tokens }) => ({
    x: start,
    y: keys.reduce((sum, key) => sum + (tokens.get(key) ?? 0), 0),
  })),
  valueFormatter: formatTokenCount,
  color,
});

/**
 * The token stack: a band per key, the smallest models past the first few folded
 * into one, and no band for a key that used nothing in the span.
 */
function tokenBandsOf(
  readings: TokenReading[],
  usage: PeriodUsage[],
  stackBy: TokenStackDimension,
): { tokenBands: AreaChartProps.AreaSeries<Date>[]; foldedModels: string[] } {
  const keys = stackKeysOf(readings, stackBy);
  const newest = readings.at(-1);
  const foldedModels =
    stackBy === "model" && newest !== undefined
      ? foldedModelsOf(keys, countsOf(newest, stackBy))
      : [];
  const folded = new Set(foldedModels);
  const titles = [
    ...keys.filter((key) => !folded.has(key)),
    ...(folded.size > 0 ? [OTHER_MODELS_TITLE] : []),
  ];
  const tokenBands = titles
    .map((title, index) =>
      title === OTHER_MODELS_TITLE
        ? // Neutral, so the folded models do not read as one more model.
          tokenBand(title, foldedModels, usage, colorChartsStatusNeutral)
        : tokenBand(title, [title], usage, BAND_COLORS[index]),
    )
    // A band that used nothing in the span would only add a zero to the legend.
    .filter((band) => band.data.some(({ y }) => y > 0));
  const drawsOther = tokenBands.some(
    ({ title }) => title === OTHER_MODELS_TITLE,
  );
  return { tokenBands, foldedModels: drawsOther ? foldedModels : [] };
}

/**
 * The cost line in runs split wherever a period's cost is unknown. Cloudscape joins
 * every point of a series, so each run is a series of its own and an unknown
 * period shows as a gap rather than a fall to zero.
 */
function costRuns(
  usage: PeriodUsage[],
): MixedLineBarChartProps.Datum<Date>[][] {
  const runs: MixedLineBarChartProps.Datum<Date>[][] = [];
  let open: MixedLineBarChartProps.Datum<Date>[] | undefined;
  for (const { start, cost } of usage) {
    if (cost === null) {
      open = undefined;
    } else if (open === undefined) {
      open = [{ x: start, y: cost }];
      runs.push(open);
    } else {
      open.push({ x: start, y: cost });
    }
  }
  return runs;
}

/**
 * The cost line, one series per run. A lease with no priced reading draws no line,
 * rather than a zero before its first reading.
 */
function costLineOf(
  readings: TokenReading[],
  usage: PeriodUsage[],
): MixedLineBarChartProps.ChartSeries<Date>[] {
  if (
    !readings.some(
      ({ monitoredBedrockTokenCost }) =>
        monitoredBedrockTokenCost !== undefined,
    )
  ) {
    return [];
  }
  // One color for every run: each is a piece of the same line, and with the legend
  // hidden a change of color at a gap would read as another series.
  return costRuns(usage).map((run) => ({
    title: DERIVED_COST_TITLE,
    type: "line",
    data: run,
    valueFormatter: formatCostAmount,
    color: colorChartsPaletteCategorical1,
  }));
}

/** What the notes under the cost line say about the periods that could not be priced. */
function unpricedNotesOf(
  readings: TokenReading[],
  usage: PeriodUsage[],
  span: { from: Date; unknownBefore?: boolean },
  drawsLine: boolean,
): Pick<TokenCharts, "hasCostGap" | "endsUnpriced" | "carriesCostIn"> {
  const { from } = span;
  const unpriced = usage.map(({ cost }) => cost === null);
  const lastPriced = unpriced.lastIndexOf(false);
  const readingBefore = newestBefore(readings, from);
  return {
    // Unpriced periods after the last priced one are where the line stops, not a gap.
    hasCostGap: unpriced.slice(0, Math.max(lastPriced, 0)).some(Boolean),
    endsUnpriced: unpriced.at(-1) ?? false,
    // Only where there is a priced cost to carry from: with none, the first priced
    // period is unknown rather than carrying anything.
    carriesCostIn:
      drawsLine &&
      readingBefore !== undefined &&
      readingBefore.monitoredBedrockTokenCost === undefined &&
      (span.unknownBefore !== true ||
        pricedBefore(readings, from) !== undefined),
  };
}

/** The most tokens used in any one period: the top of its stack. */
const highestPeriodTokens = (usage: PeriodUsage[]): number =>
  Math.max(
    0,
    ...usage.map(({ tokens }) =>
      [...tokens.values()].reduce((sum, count) => sum + count, 0),
    ),
  );

/** Both axes from zero, with room above the top. */
function axisDomainsOf(
  highestTokens: number,
  costLine: MixedLineBarChartProps.ChartSeries<Date>[],
): Pick<TokenCharts, "tokenDomain" | "costDomain"> {
  const costs = costLine.flatMap((series) =>
    series.type === "line" ? series.data.map(({ y }) => y) : [],
  );
  return {
    tokenDomain: [
      0,
      Math.max(highestTokens * COST_AXIS_HEADROOM, TOKEN_AXIS_FLOOR),
    ],
    costDomain: [
      0,
      Math.max(Math.max(0, ...costs) * COST_AXIS_HEADROOM, COST_AXIS_FLOOR),
    ],
  };
}

const hasUnattributedTokens = (readings: TokenReading[]): boolean =>
  readings.some(({ rows }) =>
    rows.some(
      (row) => row.modelId === UNATTRIBUTED_MODEL_ID && rowTotal(row) > 0,
    ),
  );

export type TokenCharts = {
  unit: TokenPeriodUnit;
  tokenBands: AreaChartProps.Series<Date>[];
  /** The models folded into the shared band, which the chart names below it. */
  foldedModels: string[];
  costLine: MixedLineBarChartProps.ChartSeries<Date>[];
  /** Whether a period with an unknown cost comes before a priced one, leaving a gap. */
  hasCostGap: boolean;
  /** Whether the newest period's cost is unknown, so the line stops before it. */
  endsUnpriced: boolean;
  /**
   * Whether the reading before the span could not be priced, so the span's first
   * priced period also carries the cost of tokens from before it.
   */
  carriesCostIn: boolean;
  /** Whether some counted tokens could not be matched to a model, and so went unpriced. */
  hasUnattributed: boolean;
  /** Whether any token was used in the span. */
  hasUsage: boolean;
  xDomain?: Date[];
  tokenDomain: [number, number];
  costDomain: [number, number];
};

/** Nothing to draw: no reading at all, none by the span's end, or a range that starts after it ends. */
const NO_CHARTS: TokenCharts = {
  unit: "hour",
  tokenBands: [],
  foldedModels: [],
  costLine: [],
  hasCostGap: false,
  endsUnpriced: false,
  carriesCostIn: false,
  hasUnattributed: false,
  hasUsage: false,
  tokenDomain: [0, TOKEN_AXIS_FLOOR],
  costDomain: [0, COST_AXIS_FLOOR],
};

/**
 * The tokens and the cost used in each hour, or each day, of the span: the tokens
 * stacked by model or by token type, and the cost as a line. Per period rather than
 * lease-to-date, so a burst reads as a peak where it happened however recent it is.
 * `tokens` is the whole lease's rows, so that the span's first period is measured
 * from the readings before it.
 */
export function buildTokenCharts(
  tokens: TokenSeriesRow[],
  stackBy: TokenStackDimension,
  span: TokenSpan,
): TokenCharts {
  const readings = groupByTimestampAsc(tokens);
  const first = readings.at(0);
  const from = new Date(
    Math.max(first?.at.getTime() ?? 0, span.from?.getTime() ?? 0),
  );
  // A range that starts after it ends, as one past an ended lease does, has nothing in it.
  if (first === undefined || from > span.to) {
    return NO_CHARTS;
  }
  const { unit, periods } = periodsOf(from, span.to);
  const usage = usageByPeriod(
    readings,
    periods,
    { from, to: span.to, unknownBefore: span.unknownBefore },
    stackBy,
  );
  const { tokenBands, foldedModels } = tokenBandsOf(readings, usage, stackBy);
  const costLine = costLineOf(readings, usage);
  const highestTokens = highestPeriodTokens(usage);
  return {
    unit,
    tokenBands,
    foldedModels,
    costLine,
    ...unpricedNotesOf(
      readings,
      usage,
      { from, unknownBefore: span.unknownBefore },
      costLine.length > 0,
    ),
    hasUnattributed: hasUnattributedTokens(readings),
    hasUsage: highestTokens > 0,
    xDomain: periods.map(({ start }) => start),
    ...axisDomainsOf(highestTokens, costLine),
  };
}

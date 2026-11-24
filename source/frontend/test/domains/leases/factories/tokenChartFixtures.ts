// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  buildTokenCharts,
  TokenSpan,
  TokenStackDimension,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/token-charts";
import { TokenSeriesRow } from "@amzn/innovation-sandbox-frontend/domains/leases/types";

export const NOVA_PRO = "amazon.nova-pro-v1:0";
export const CLAUDE_HAIKU = "anthropic.claude-3-5-haiku-20241022-v1:0";

/** The cost history factory's readings, an hour apart. */
export const READINGS = [
  "2026-08-11T07:00:00.000Z",
  "2026-08-11T08:00:00.000Z",
  "2026-08-11T09:00:00.000Z",
  "2026-08-11T10:00:00.000Z",
  "2026-08-11T11:00:00.000Z",
];

/** Half an hour after the newest reading, so the charts count per hour. */
export const SPAN: TokenSpan = { to: new Date("2026-08-11T11:30:00.000Z") };

/** The hour holding a lone 07:00 reading, and the one before it. */
export const ONE_READING_SPAN: TokenSpan = {
  to: new Date("2026-08-11T07:30:00.000Z"),
};

/** Each band's value per period, by title. */
export const bandValues = (
  tokens: TokenSeriesRow[],
  stackBy: TokenStackDimension,
  span: TokenSpan = SPAN,
): Record<string, number[]> =>
  Object.fromEntries(
    buildTokenCharts(tokens, stackBy, span).tokenBands.map((band) => [
      band.title,
      band.type === "area" ? band.data.map((point) => point.y) : [],
    ]),
  );

/** The cost line's runs, as ISO instants and costs. */
export const costRunsAsIso = (
  tokens: TokenSeriesRow[],
  span: TokenSpan = SPAN,
) =>
  buildTokenCharts(tokens, "model", span).costLine.map((run) =>
    run.type === "line"
      ? run.data.map((point) => ({ x: point.x.toISOString(), y: point.y }))
      : [],
  );

/** Each band's value in the hour of a lone 07:00 reading, by title. */
export const loneHourUsage = (tokens: TokenSeriesRow[]) =>
  Object.fromEntries(
    Object.entries(bandValues(tokens, "model", ONE_READING_SPAN)).map(
      ([title, values]) => [title, values.at(-1)],
    ),
  );

export const tokenRow = (
  timestamp: string,
  modelId: string,
  input: number,
): TokenSeriesRow => ({
  timestamp,
  region: "us-east-1",
  modelId,
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

export const withoutCostAt = (
  tokens: TokenSeriesRow[],
  ...timestamps: string[]
) =>
  tokens.map((row) =>
    timestamps.includes(row.timestamp)
      ? (({ monitoredBedrockTokenCost: _dropped, ...rest }) => rest)(row)
      : row,
  );

/** Seven models at one reading, m1 with the fewest tokens and m7 the most. */
export const sevenModels = [100, 200, 300, 400, 500, 600, 700].map(
  (input, index) => tokenRow(READINGS[0], `m${index + 1}`, input),
);

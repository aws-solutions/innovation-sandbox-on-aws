// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";

import {
  CostHistoryCurrent,
  RateBasis,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";

const shareFormatter = new Intl.NumberFormat(undefined, {
  style: "percent",
  maximumFractionDigits: 1,
});

const percentFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

/** The period word `formatCostRate` takes, so a DAILY figure is never labelled per hour. */
export const RATE_BASIS_UNIT: Record<RateBasis, "hour" | "day"> = {
  HOURLY: "hour",
  DAILY: "day",
};

// The endpoint makes the smallest share a residual so the column sums to 1.00,
// so this scales the fraction and never re-rounds it.
export const formatShare = (shareOfBilledCost: number): string =>
  shareFormatter.format(shareOfBilledCost);

/** A figure the API already expresses in percent, e.g. 112 -> "112%". */
export const formatPercent = (percent: number): string =>
  `${percentFormatter.format(percent)}%`;

/** A signed percentage change as an arrow and a magnitude, e.g. "↑ 112%". */
export const formatChangePercent = (changePercent: number): string => {
  if (changePercent > 0) {
    return `↑ ${formatPercent(changePercent)}`;
  }
  if (changePercent < 0) {
    return `↓ ${formatPercent(-changePercent)}`;
  }
  return formatPercent(0);
};

/** A rate in the same terms as `formatCostAmount`, e.g. "< USD 0.01/hour". */
export const formatCostRate = (
  dollarsPerUnit: number,
  basis: "hour" | "day",
): string => `${formatCostAmount(dollarsPerUnit)}/${basis}`;

/**
 * The hourly rate to carry a reading forward at: the one the reading's own
 * prediction was made on, so that carrying it on is a continuation of that
 * prediction and not a second, differently-based one. Either rate stands in for the
 * other where only one exists.
 */
function carryRate(current: CostHistoryCurrent): number | undefined {
  const perHour = current.hourlyRate ?? undefined;
  const perDay = current.dailyRate == null ? undefined : current.dailyRate / 24;
  return current.rateSource === "DAILY"
    ? (perDay ?? perHour)
    : (perHour ?? perDay);
}

/**
 * What has accrued since the newest monitoring run, at the rate that run measured,
 * and the hours it accrued over. A reading is up to a monitoring interval old by the
 * time anyone reads it, so an estimate that stops where the reading does stops short
 * of now -- on the chart as a gap before the "Now" marker, and in the summary as a
 * figure labelled "now" that is an hour stale. Zero where no rate has been
 * established yet, or where the newest run is not in the past.
 */
export function accruedSinceLastCheck(
  current: CostHistoryCurrent,
  now: Date,
): { accrued: number; hours: number } {
  const hourlyRate = carryRate(current);
  const hours = DateTime.fromJSDate(now).diff(
    DateTime.fromISO(current.lastCheckedAt),
    "hours",
  ).hours;
  if (hourlyRate == null || hours <= 0) {
    return { accrued: 0, hours: 0 };
  }
  return { accrued: hourlyRate * hours, hours };
}

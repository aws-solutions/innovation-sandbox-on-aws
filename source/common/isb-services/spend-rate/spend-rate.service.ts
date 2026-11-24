// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";

import {
  ComputeProjectionInput,
  ComputeTimeToExhaustionInput,
  CostObservationPoint,
  CostProjection,
  RateSource,
  SpendRates,
} from "./spend-rate.types.js";

const NO_RATES: SpendRates = {
  hourlyRate: null,
  dailyRate: null,
  hourlyRateWindowHours: null,
  dailyRateWindowHours: null,
};

const DAILY_WINDOW_HOURS = 24;

/**
 * Hourly and daily spend rates from a lease's observation series, newest
 * first. Each rate is differenced across a reporting interval measured from
 * the two timestamps, never an assumed one: the hourly rate against the second
 * newest observation, the daily rate against the observation nearest 24 hours
 * before the newest, in either direction, ties to the more recent point. Both
 * carry full precision and are clamped at zero, since Cost Explorer restates
 * prior periods. A rate is null rather than wrong: fewer than two observations,
 * an unusable interval, or a daily point that is the hourly rate's own
 * predecessor all yield null, and each window is null exactly when its rate is.
 */
export function computeSpendRates(
  observations: CostObservationPoint[],
): SpendRates {
  const newest = observations[0];
  const secondNewest = observations[1];
  if (newest === undefined || secondNewest === undefined) {
    return NO_RATES;
  }
  const newestAt = DateTime.fromISO(newest.timestamp, { zone: "utc" });
  const hourly = rateOver(newest, secondNewest, newestAt);
  if (hourly === null) {
    return NO_RATES;
  }

  const dailyPoint = nearestToDailyWindow(observations.slice(1), newestAt);
  const daily =
    dailyPoint === secondNewest ? null : rateOver(newest, dailyPoint, newestAt);
  return {
    hourlyRate: hourly.rate,
    hourlyRateWindowHours: hourly.windowHours,
    dailyRate: daily === null ? null : daily.rate * DAILY_WINDOW_HOURS,
    dailyRateWindowHours: daily === null ? null : daily.windowHours,
  };
}

/** Dollars per hour between two observations, or null when the interval is unusable. */
function rateOver(
  newest: CostObservationPoint,
  earlier: CostObservationPoint,
  newestAt: DateTime,
): { rate: number; windowHours: number } | null {
  const earlierAt = DateTime.fromISO(earlier.timestamp, { zone: "utc" });
  const windowHours = newestAt.diff(earlierAt, "hours").hours;
  if (!Number.isFinite(windowHours) || windowHours <= 0) {
    return null;
  }
  return {
    rate: Math.max(
      0,
      (newest.billedCostAccrued - earlier.billedCostAccrued) / windowHours,
    ),
    windowHours,
  };
}

/** The candidate closest to 24 hours before the newest observation; a tie goes to the more recent one. */
function nearestToDailyWindow(
  candidates: CostObservationPoint[],
  newestAt: DateTime,
): CostObservationPoint {
  const target = newestAt.minus({ hours: DAILY_WINDOW_HOURS });
  let nearest = candidates[0]!;
  let nearestDistance = distanceFrom(target, nearest);
  for (const candidate of candidates.slice(1)) {
    const distance = distanceFrom(target, candidate);
    // Candidates run newest first, so an older candidate only wins outright.
    if (distance < nearestDistance) {
      nearest = candidate;
      nearestDistance = distance;
    }
  }
  return nearest;
}

function distanceFrom(target: DateTime, point: CostObservationPoint): number {
  const at = DateTime.fromISO(point.timestamp, { zone: "utc" });
  return Math.abs(at.diff(target, "hours").hours);
}

/**
 * Carries the supplied spend anchor forward at the higher of the two rates,
 * `max(hourlyRate, dailyRate / 24)`, for the hours since that reading. The
 * hours are capped at the interval between the two newest observations,
 * whichever rate won: once a refresh is overdue the rate has stopped describing
 * the lease, so the figure holds flat rather than rising without limit. With no
 * rate, or when the elapsed time or the cap cannot be established, the
 * projection is the anchor cost and `rateSource` is null, so a caller never
 * presents an unchanged anchor as an extrapolated estimate.
 */
export function computeProjection(
  input: ComputeProjectionInput,
): CostProjection {
  const { projectionAnchorCost, rates } = input;
  const fallback: CostProjection = {
    predictedCost: projectionAnchorCost,
    rateSource: null,
  };
  const winner = projectionRatePerHour(rates);
  if (winner === null) {
    return fallback;
  }
  const elapsedHours = hoursBetween(input.lastReportedAt, input.evaluatedAt);
  // The projection never extrapolates further than it measured, so a cap it
  // cannot establish makes the projection unavailable rather than unbounded.
  const capHours = input.recentIntervalHours ?? rates.hourlyRateWindowHours;
  if (elapsedHours === null || capHours === null || capHours <= 0) {
    return fallback;
  }
  const hours = Math.min(Math.max(0, elapsedHours), capHours);
  return {
    predictedCost: projectionAnchorCost + winner.ratePerHour * hours,
    rateSource: winner.source,
  };
}

/**
 * Hours until the budget is spent at the given per-hour rate, from the
 * projected figure. Null rather than infinite or undefined where there is no
 * budget, no rate, or a zero rate; zero rather than negative where the budget
 * is already projected spent.
 */
export function computeTimeToExhaustion(
  input: ComputeTimeToExhaustionInput,
): number | null {
  const { maxSpend, ratePerHour } = input;
  if (
    maxSpend === undefined ||
    ratePerHour === null ||
    !Number.isFinite(ratePerHour) ||
    ratePerHour <= 0
  ) {
    return null;
  }
  return Math.max(0, (maxSpend - input.predictedCost) / ratePerHour);
}

function dailyPerHour(dailyRate: number | null): number | null {
  return dailyRate === null ? null : dailyRate / DAILY_WINDOW_HOURS;
}

/**
 * The rate the projection carries forward, in dollars per hour, and which of
 * the two it is: `max(hourlyRate, dailyRate / 24)`, a tie going to the shorter
 * window. Exported so the exhaustion countdown is fed the same per-hour figure
 * the projection used, never a per-day one.
 */
export function projectionRatePerHour(
  rates: SpendRates,
): { ratePerHour: number; source: RateSource } | null {
  const daily = dailyPerHour(rates.dailyRate);
  if (rates.hourlyRate === null) {
    return daily === null ? null : { ratePerHour: daily, source: "DAILY" };
  }
  if (daily !== null && daily > rates.hourlyRate) {
    return { ratePerHour: daily, source: "DAILY" };
  }
  return { ratePerHour: rates.hourlyRate, source: "HOURLY" };
}

/**
 * Elapsed hours, or null when either timestamp is unparseable. Returned
 * unclamped: the projection floors it at zero, while a caller dividing by it
 * needs a non-positive span rejected rather than floored.
 */
export function hoursBetween(from: string, to: string): number | null {
  const hours = DateTime.fromISO(to, { zone: "utc" }).diff(
    DateTime.fromISO(from, { zone: "utc" }),
    "hours",
  ).hours;
  return Number.isFinite(hours) ? hours : null;
}

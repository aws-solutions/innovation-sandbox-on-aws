// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * A single stored cost reading, ordered by timestamp. Shape mirrors the
 * stored cost-history row; only the fields the rate math needs are required
 * here.
 */
export interface CostObservationPoint {
  timestamp: string; // ISO 8601
  billedCostAccrued: number;
}

/**
 * Measured spend rates. Each rate carries the unit its
 * name implies (dollars/hour vs dollars/day). A rate is null when it cannot
 * be measured (fewer than two observations, or no distinct daily window) —
 * never zero, never a guess. Window fields are null exactly when their rate
 * is null.
 */
export interface SpendRates {
  hourlyRate: number | null;
  dailyRate: number | null;
  hourlyRateWindowHours: number | null;
  dailyRateWindowHours: number | null;
}

export type RateSource = "HOURLY" | "DAILY";

export interface ComputeProjectionInput {
  /** Spend value from which the projection begins. */
  projectionAnchorCost: number;
  /** Timestamp of the newest observation. */
  lastReportedAt: string; // ISO 8601
  /** "Now" = the instant of the current monitoring run. */
  evaluatedAt: string; // ISO 8601
  rates: SpendRates;
  /**
   * Extrapolation cap: hours between the two newest observations. Null when
   * unknown, in which case the hourly rate's own window caps the projection.
   */
  recentIntervalHours: number | null;
}

/**
 * Cost projection. `predictedCost` falls back to the billed total when no
 * rate exists. `rateSource` names the rate that won
 * `max(hourlyRate, dailyRate / 24)`; null when no rate exists.
 */
export interface CostProjection {
  predictedCost: number;
  rateSource: RateSource | null;
}

export interface ComputeTimeToExhaustionInput {
  maxSpend: number | undefined;
  predictedCost: number;
  /** Dollars per hour; the summed rate where Bedrock token monitoring is on. */
  ratePerHour: number | null;
}

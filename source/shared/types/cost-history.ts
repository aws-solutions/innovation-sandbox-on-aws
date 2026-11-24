// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/**
 * Response contracts for `GET /leases/{leaseId}/costSummary`, `/costHistory`,
 * `/bedrockTokenHistory` and `/breachHistory`.
 *
 * The single shared definition the producer and the frontend both import, so the
 * two cannot drift. Hand-written TypeScript, not a Zod schema: this is a
 * projection of the stored rows, not the rows.
 *
 * `{leaseId}` in the path is the base64url composite key the other lease routes
 * use, NOT `leaseUuid` (this table's partition key).
 *
 * NULL-UNTIL-A-RATE-EXISTS: seven `current` fields are null in a lease's
 * first reporting interval, and for the life of one that never opted into
 * prediction, because each needs a second observation to difference against:
 *   1. hourlyRate
 *   2. dailyRate
 *   3. hourlyRateWindowHours
 *   4. dailyRateWindowHours
 *   5. rateSource
 *   6. hoursToBudgetExhaustion
 *   7. each services[].changePercent
 * `predictedCost` is the deliberate exception: it falls back to the reported
 * total, so it is never null. A client distinguishes "first interval" from
 * "never opted in" via the lease's own `predictiveBudgetEnabled` (returned by
 * the existing lease route), not via any flag on this response.
 *
 * ABSENT-OR-NULL: a member the producer sets to `null` is declared `?: T | null`,
 * because restJson1 omits any member whose value is null, so the consumer never
 * sees the null it was given. A client reads either as "no value" -- `x == null`,
 * not `x === null`.
 */

export const BreachTriggeredBySchema = z.enum([
  "REPORTED",
  "PREDICTED",
  "RATE",
  "MAX_SPEND",
  "DURATION",
  "EXPIRY",
]);
/**
 * Budget thresholds only: excludes `MAX_SPEND` and `EXPIRY`, the lease's cap
 * and end, which terminate, and `DURATION`, which is measured in time.
 */
export const ThresholdTriggeredBySchema = BreachTriggeredBySchema.exclude([
  "MAX_SPEND",
  "DURATION",
  "EXPIRY",
]);
/**
 * Dollar thresholds only. A `RATE` crossing has its own alert event, freeze
 * reason and telemetry record, so the dollar-threshold contracts exclude it.
 */
export const DollarThresholdTriggeredBySchema =
  ThresholdTriggeredBySchema.exclude(["RATE"]);
export const BreachActionSchema = z.enum([
  "ALERT",
  "FREEZE_ACCOUNT",
  "TERMINATE",
]);
export const RateBasisSchema = z.enum(["HOURLY", "DAILY"]);
export const BreachEvaluatedBySchema = z.enum([
  "LEASE_MONITORING",
  "TOKEN_POLL",
]);
export const InsightKindSchema = z.enum([
  "COMPOSITION",
  "CHANGE",
  "NEW_ENTRANT",
]);

export type RateBasis = z.infer<typeof RateBasisSchema>;
export type BreachTriggeredBy = z.infer<typeof BreachTriggeredBySchema>;
export type BreachAction = z.infer<typeof BreachActionSchema>;
export type BreachEvaluatedBy = z.infer<typeof BreachEvaluatedBySchema>;
export type InsightKind = z.infer<typeof InsightKindSchema>;

/**
 * Why rows were dropped, as a class rather than a detail. The version gate is an
 * exact range, so a rolling deploy makes a newer writer's rows unreadable here --
 * expected and self-healing, so it is separated from corruption to keep a caller
 * alarming on corruption from being paged for every deploy.
 */
export type DroppedRecordReason =
  "SCHEMA_VALIDATION" | "SCHEMA_VERSION_UNSUPPORTED";

/** Per-service cumulative cost, keyed by Cost Explorer service name. */
export type ServiceBreakdown = Record<string, number>;

/** One row of the paginated reported series. */
export interface CostHistoryResultRow {
  timestamp: string;
  billedCostAccrued: number;
  /** Null where no rate existed when the row was written. */
  predictedCostAtRefresh?: number | null;
  /**
   * Absent where the deployment collects no breakdown, or on a
   * fallback-served lease. Absent is not the same as an empty object.
   */
  serviceBreakdown?: ServiceBreakdown;
}

/**
 * Bedrock token counts, one per token type. A new token type also needs a member on
 * the Smithy `TokenSeriesRow`, or the API drops it from the response.
 */
export interface TokenCounts {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** The token types Bedrock counts, which are also the ones a rate is quoted for. */
export type TokenType = keyof TokenCounts;

/**
 * The model key for counts that could not be placed on a model: a model
 * list-metrics no longer reports (idle for two weeks) or a series the per-model
 * queries do not match. A real ModelId always contains a dot, so this cannot
 * collide with one.
 */
export const UNATTRIBUTED_MODEL_ID = "unattributed";

/**
 * One flattened Bedrock token row: cumulative counts per timestamp per region
 * per model. `monitoredBedrockTokenCost` is lease-wide as of this timestamp, so it repeats
 * across rows sharing a timestamp -- summing across rows double-counts.
 */
export interface TokenSeriesRow extends TokenCounts {
  timestamp: string;
  region: string;
  /** The Bedrock ModelId, or `UNATTRIBUTED_MODEL_ID` for counts not matched to a model. */
  modelId: string;
  /**
   * Prices only the tokens attributed to a model, each at the rate when it was
   * counted; a token with no rate adds nothing. Absent only on older rows saved
   * unpriced.
   */
  monitoredBedrockTokenCost?: number;
}

/** A threshold that actually fired, from the stored BREACH records. */
export interface BreachEntry {
  timestamp: string;
  triggeredBy: BreachTriggeredBy;
  action: BreachAction;
  /** Null on a RATE, DURATION or EXPIRY breach. */
  thresholdDollars?: number | null;
  /** The cap exceeded, on a RATE breach; null otherwise. */
  thresholdRate?: number | null;
  /** HOURLY | DAILY on a RATE breach; null otherwise. */
  thresholdRateBasis?: RateBasis | null;
  /** The hours before the lease's end, on a DURATION breach; null otherwise. */
  thresholdHoursRemaining?: number | null;
  billedCostAtFire: number;
  predictedCostAtFire?: number | null;
  /** Null on a MAX_SPEND, DURATION or EXPIRY breach, and where no rate was in force. */
  rateAtFire?: number | null;
  rateSourceAtFire?: RateBasis | null;
  evaluatedBy: BreachEvaluatedBy;
  /**
   * Spend at the time of the breach where the evaluator compared a figure
   * other than the bill alone. Null on a LEASE_MONITORING breach. On a
   * TOKEN_POLL breach, the spend with the monitored Bedrock token cost
   * substituted for the billed Bedrock slice, never below the billed total.
   */
  evaluatedSpendAtFire?: number | null;
  /**
   * The monitored Bedrock term substituted into it, before its floor at
   * the billed total; only the token poll measures one.
   */
  monitoredBedrockTokenCostAtFire?: number | null;
  insight?: BreachInsight | null;
}

/** The insight sent in the notification, stored verbatim. */
export interface BreachInsight {
  kind: InsightKind;
  service: string;
  amount: number;
  /** COMPOSITION; share of the spend figure used for the threshold comparison. */
  shareOfComparedSpend?: number;
  /** CHANGE; signed, so a fall is negative. */
  changePercent?: number;
}

/** One newest-observation per-service figure with its change since the prior one. */
export interface CurrentServiceEntry {
  service: string;
  amount: number;
  shareOfBilledCost: number;
  /** Null until a second observation exists to difference against. */
  changePercent?: number | null;
}

/**
 * Lease-level headline figures, computed from the newest data. Everything here
 * describes the instant given by `lastCheckedAt`, so it can be up to an hour old.
 */
export interface CostHistoryCurrent {
  billedCostAccrued: number;
  /**
   * Never null: with no rate it falls back to the figure the projection is
   * anchored on, the lease's `lastEvaluatedSpend` where Bedrock token monitoring is
   * on and that is present, and the reported total otherwise.
   */
  predictedCost: number;

  /** Null until a rate exists (see file header). */
  hourlyRate?: number | null;
  dailyRate?: number | null;

  /**
   * The measurement window behind each rate, in hours. The window has to be
   * shown beside the rate: it is the only thing that stops a rate extrapolated
   * from a short window being read as established. Null exactly when the
   * matching rate is null.
   */
  hourlyRateWindowHours?: number | null;
  dailyRateWindowHours?: number | null;

  /** Null until a rate exists. */
  rateSource?: RateBasis | null;
  /** Null when maxSpend unset, or the rate is 0 or unavailable. */
  hoursToBudgetExhaustion?: number | null;

  latestPeriodStart: string;
  lastReportedAt: string;
  lastCheckedAt: string;

  /**
   * Newest per-service figures. Empty means no share can be expressed -- no
   * breakdown collected, a fallback-served lease, a breakdown covering only part of
   * the billed total, or a non-positive `billedCostAccrued` -- NOT that nothing was
   * spent. Where non-empty, shares sum to 1.00 because the smallest is a residual.
   */
  services: CurrentServiceEntry[];
}

/** The `data` payload of the cost-summary response. */
export interface CostSummaryData {
  /**
   * Lease-level headline figures. **Null when no reading is available** -- none
   * yet, the lease never checked, or the newest reading unreadable -- which is
   * not the same as a lease with no spend: a zeroed block would read "$0.00
   * spent" on a lease that may be at its cap.
   */
  current?: CostHistoryCurrent | null;
}

/** The `data` payload of the cost-history response. */
export interface CostHistoryData {
  /**
   * The paginated reported series, newest first -- every read in this table is
   * `ScanIndexForward: false`, so every array in these payloads arrives
   * newest-first and a client differencing one must walk backwards.
   */
  result: CostHistoryResultRow[];
  nextPageIdentifier?: string | null;
}

/** The `data` payload of the Bedrock token-history response. */
export interface BedrockTokenHistoryData {
  /** The paginated token series, flattened per region per model, newest first. */
  result: TokenSeriesRow[];
  nextPageIdentifier?: string | null;
}

/** The `data` payload of the breach-history response. */
export interface BreachHistoryData {
  /** The paginated thresholds that fired, newest first. */
  result: BreachEntry[];
  nextPageIdentifier?: string | null;
}

/** The full `GET /leases/{leaseId}/costSummary` response body. */
export interface CostSummaryResponse {
  status: "success";
  data: CostSummaryData;
}

/**
 * The full `GET /leases/{leaseId}/costHistory` response body. `status` is
 * JSend's, as every other ISB response carries it (leases-handler.ts:272-277);
 * not typed via `JSendSuccessResponse`, whose `data` is `Record<string, any>`
 * and would erase the shape above.
 */
export interface CostHistoryResponse {
  status: "success";
  data: CostHistoryData;
}

/** The full `GET /leases/{leaseId}/bedrockTokenHistory` response body. */
export interface BedrockTokenHistoryResponse {
  status: "success";
  data: BedrockTokenHistoryData;
}

/** The full `GET /leases/{leaseId}/breachHistory` response body. */
export interface BreachHistoryResponse {
  status: "success";
  data: BreachHistoryData;
}

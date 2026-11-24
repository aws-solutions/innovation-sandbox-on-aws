// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from "@aws-lambda-powertools/logger";

import { LeaseCostHistoryStore } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import { BreachRecord } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  CostProjection,
  RateSource,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import { ServiceBreakdown } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import {
  BudgetThreshold,
  DurationThreshold,
  RateLimitEntry,
  ThresholdAction,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { MonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";

/**
 * The projection and the rate that carried it, as recorded at fire time. The
 * three are populated together or not at all: a projection is only worth
 * recording while a rate carries it, and the rate is stored in its own unit,
 * so the source names it.
 */
export type ProjectionAtFire =
  | {
      predictedCostAtFire: number;
      rateAtFire: number;
      rateSourceAtFire: RateSource;
    }
  | { predictedCostAtFire: null; rateAtFire: null; rateSourceAtFire: null };

interface DollarThresholdBreach {
  action: ThresholdAction;
  thresholdDollars: number;
  thresholdRate: null;
  thresholdRateBasis: null;
  /**
   * The current spend when the breach fired. A REPORTED threshold compares
   * this figure directly; for a PREDICTED threshold it is context alongside
   * `predictedCostAtFire`.
   */
  spendAtFire: number;
}

/** A dollar threshold crossed by the billed total; the projection is context. */
export type ReportedBreach = DollarThresholdBreach &
  ProjectionAtFire & { triggeredBy: "REPORTED" };

/** A dollar threshold crossed by the projection, which a rate must have carried. */
export type PredictedBreach = DollarThresholdBreach &
  Extract<ProjectionAtFire, { rateAtFire: number }> & {
    triggeredBy: "PREDICTED";
  };

/** A spend-rate limit crossed by the measured rate of the same basis. */
export interface RateBreach {
  triggeredBy: "RATE";
  action: ThresholdAction;
  thresholdDollars: null;
  thresholdRate: number;
  thresholdRateBasis: RateSource;
  /** Current spend when the rate crossed its cap; context rather than the compared value. */
  spendAtFire: number;
  predictedCostAtFire: number | null;
  /** The measured figure that exceeded the cap, and which rate it was. */
  rateAtFire: number;
  rateSourceAtFire: RateSource;
}

/**
 * A newly breached threshold, one per crossing. Selection for events is
 * narrower than persistence: at most one alert and one freeze per cycle, but a
 * breach record for every entry here. Discriminated on `triggeredBy` so the
 * fields each kind populates are compile-time facts for whoever persists or
 * emits it.
 */
export type ThresholdBreach = ReportedBreach | PredictedBreach | RateBreach;

/**
 * The lease's `maxSpend` reached, which terminates it. Never configured on a
 * template, and compared against spend so far, so it names no projection or
 * rate.
 */
export interface MaxSpendBreach {
  triggeredBy: "MAX_SPEND";
  action: "TERMINATE";
  /** The lease's `maxSpend`. */
  thresholdDollars: number;
  /** Current spend compared against `maxSpend`: the bill or the token poll's evaluated spend. */
  spendAtFire: number;
  thresholdRate: null;
  thresholdRateBasis: null;
  predictedCostAtFire: null;
  rateAtFire: null;
  rateSourceAtFire: null;
}

/**
 * REPORTED-threshold crossings against the caller's figure (the bill, or the
 * token poll's evaluated spend), by the straddle Lease Monitoring has always
 * applied. A threshold without `triggerOn` is a REPORTED threshold.
 */
export interface EvaluateReportedThresholdsInput {
  thresholds: BudgetThreshold[] | undefined;
  /** The stored `lastEvaluatedSpend`, or a stand-in before one exists. */
  previousEvaluatedSpend: number;
  evaluatedSpend: number;
  /**
   * This run's projection, or null when none ran. Recorded on each breach as
   * context only while a rate is in force.
   */
  predictedCost: number | null;
  rates: SpendRates;
  rateSource: RateSource | null;
}

/**
 * De-duplication is stateless: fire where `previous < threshold <= current`,
 * the same straddle as the reported thresholds. Previous values are the scalars
 * stored on the lease record and advance every run (with no rate the stored
 * figure is the reported total, and nothing is evaluated against it), so
 * null/undefined — compared as zero — arises only before the first evaluation.
 */
export interface EvaluatePredictedThresholdsInput {
  thresholds: BudgetThreshold[] | undefined;
  /** The stored `lastPredictedSpend`. */
  previousPredictedCost: number | null | undefined;
  predictedCost: number;
  /** At-fire context recorded on each breach. */
  evaluatedSpend: number;
  /** The measured rates: rateSource selects the value stored as rateAtFire. */
  rates: SpendRates;
  /** Null while no rate is in force, when `predictedCost` is the reported total. */
  rateSource: RateSource | null;
}

export interface EvaluateRateCapsInput {
  /** Empty when none is configured. */
  rateLimits: RateLimitEntry[];
  rates: SpendRates;
  previousHourlyRate: number | null | undefined;
  previousDailyRate: number | null | undefined;
  /** At-fire context recorded on each breach. */
  evaluatedSpend: number;
  predictedCost: number | null;
}

/** The lease fields evaluation reads: its configuration and last run's scalars. */
export type ThresholdEvaluationLease = Pick<
  MonitoredLease,
  | "status"
  | "budgetThresholds"
  | "rateLimits"
  | "totalCostAccrued"
  | "lastEvaluatedSpend"
  | "lastPredictedSpend"
  | "lastEvaluatedHourlySpendRate"
  | "lastEvaluatedDailySpendRate"
>;

/**
 * This run's projection and the rates it was computed from. Both come from one
 * spend-rate computation, so `rateSource` always names a measured rate.
 */
export type RunProjection = Pick<
  CostProjection,
  "predictedCost" | "rateSource"
> & {
  rates: SpendRates;
};

export interface EvaluateSpendingControlsInput {
  lease: ThresholdEvaluationLease;
  evaluatedSpend: number;
  /**
   * Null where predictive controls are off for the lease: only REPORTED
   * thresholds are evaluated, `lastEvaluatedSpend` is still this run's compared
   * figure, and the projection and rate scalars are returned as stored.
   */
  projection: RunProjection | null;
}

/**
 * Every newly breached threshold this run, plus the de-duplication scalars to
 * store for the next one. `lastEvaluatedSpend` is this run's compared figure on
 * every run. The projection and rate scalars advance whenever a projection
 * ran, whether or not anything fired, so a threshold crossed while evaluation
 * was suppressed is silently past when evaluation resumes rather than firing
 * late.
 */
export interface SpendingControlsEvaluation {
  breaches: ThresholdBreach[];
  lastEvaluatedSpend: number;
  lastPredictedSpend: number | null;
  lastEvaluatedHourlySpendRate: number | null;
  lastEvaluatedDailySpendRate: number | null;
}

export type { ServiceBreakdown };

/**
 * The insight sent with a notification and stored verbatim on the breach
 * record, so the two cannot diverge. Shaped by the store's schema.
 */
export type BreachInsight = NonNullable<BreachRecord["insight"]>;

export interface SelectBreachInsightInput {
  /** The newest observation's breakdown; undefined where none is stored. */
  newestBreakdown: ServiceBreakdown | undefined;
  /**
   * The observation before it; undefined on a lease's first observation or
   * where none is stored. Without it only a COMPOSITION insight is possible.
   */
  previousBreakdown: ServiceBreakdown | undefined;
  /** The newest observation's total, which shares are taken of. */
  billedCostAccrued: number;
}

/** The billed breakdown and the monitored Bedrock token cost not yet billed. */
export interface SelectComparedSpendInsightInput extends SelectBreachInsightInput {
  /**
   * The token poll's monitored term less the billed slice it replaced,
   * floored at zero. Null where none was substituted.
   */
  unbilledBedrockTokenCost: number | null;
}

/** A breach row as handed to the store, which assigns the sort key and metadata. */
export type NewBreachRecord = Omit<BreachRecord, "sk" | "meta">;

/** The one store method persistence needs; the cost-history store satisfies it. */
export type BreachRecordStore = Pick<
  LeaseCostHistoryStore,
  "appendBreachRecord"
>;

/**
 * Which schedule evaluated the run. The token poll owns evaluation while
 * Bedrock token monitoring is on, calculates every evaluated-spend figure it
 * compares, and alone measures the monitored Bedrock term inside them.
 * Lease Monitoring compares the bill.
 */
export type BreachEvaluator =
  | { evaluatedBy: "LEASE_MONITORING" }
  | {
      evaluatedBy: "TOKEN_POLL";
      /** Null where no monitored cost was substituted: no priced token row yet, or no billed slice to replace. */
      monitoredBedrockTokenCostAtFire: number | null;
    };

/** One run's newly breached thresholds for one lease, from either evaluator. */
export interface PersistBreachRecordsInput {
  leaseUuid: string;
  /**
   * Cost Explorer's own total at fire time, stated by the caller rather than
   * taken from the breaches: a breach records the figure it was compared
   * against, which may carry a monitored Bedrock term, and a breach record
   * is audit evidence, so an estimate must not arrive under a billed name.
   */
  billedCostAtFire: number;
  evaluator: BreachEvaluator;
  /** Every threshold breach to record this run, or the `maxSpend` breach. */
  breaches: (ThresholdBreach | MaxSpendBreach)[];
  /**
   * The insight the notification names, stored verbatim on every row of the
   * run so the email and the record cannot diverge. Null where none was
   * available.
   */
  insight: BreachInsight | null;
  /**
   * Expiry, epoch seconds. Supplied rather than derived here: the anchor it is
   * taken from is decided once for the whole cost-history table, so a lease's
   * breach rows and its cost observations expire together.
   */
  ttl: number;
}

/** Keyed as the cost-history module keys the same store, so one object can serve both. */
export interface BreachRecordServices {
  costHistoryStore: BreachRecordStore;
}

/** One lease's `maxSpend` breach, from whichever evaluator reached it. */
export interface PersistMaxSpendBreachInput {
  leaseUuid: string;
  /** When the lease started: the earliest an earlier `maxSpend` breach can be. */
  leaseStartDate: string;
  /** The lease's `maxSpend`, which the breach names as its threshold. */
  maxSpend: number;
  /** The figure the `maxSpend` check compared. */
  comparedCost: number;
  /** Cost Explorer's own total, as on every breach row. */
  billedCostAtFire: number;
  evaluator: BreachEvaluator;
  /** Expiry, epoch seconds, as on every breach row. */
  ttl: number;
}

/**
 * The append, and the read that keeps a lease to one `maxSpend` breach per cap
 * and one expiry breach per end.
 */
export interface TerminatingBreachServices {
  costHistoryStore: Pick<
    LeaseCostHistoryStore,
    "appendBreachRecord" | "listBreachRecords"
  >;
  logger: Logger;
}

/** What reading a lease's breach history needs. */
export interface ReadBreachHistoryServices {
  costHistoryStore: Pick<LeaseCostHistoryStore, "listBreachRecords">;
  /** Logs a warning if the read fails. */
  logger: Logger;
}

/** One run's newly reached duration thresholds for one lease; only Lease Monitoring checks them. */
export interface PersistDurationBreachesInput {
  leaseUuid: string;
  /** Cost Explorer's own total, recorded as context: a duration threshold compares no spend. */
  billedCostAtFire: number;
  /** Every duration threshold newly reached this run; each becomes its own row. */
  thresholds: DurationThreshold[];
  /** The row's TTL, epoch seconds, as on every breach row. */
  ttl: number;
}

/** One lease's end, which Lease Monitoring found passed. */
export interface PersistExpiryBreachInput {
  leaseUuid: string;
  /** The lease's end: an expiry breach recorded since then is this one's. */
  expirationDate: string;
  /** Cost Explorer's own total, recorded as context: an expiry compares no spend. */
  billedCostAtFire: number;
  /** The row's TTL, epoch seconds, as on every breach row. */
  ttl: number;
}

/** The lease identity and budget a spending-control event names. */
export type SpendingControlEventLease = Pick<
  MonitoredLease,
  "uuid" | "userEmail" | "awsAccountId" | "maxSpend" | "status"
>;

/** Run-level figures every spending-control event carries beside the breach's own. */
export interface SpendingControlEventContext {
  /**
   * Hours until `maxSpend` at the current rate, from the projection step;
   * null with no rate, a rate of zero, or no budget. Finite or null, never
   * Infinity: the alert schema rejects a non-finite number, and the
   * notification would be lost with it.
   */
  hoursToBudgetExhaustion: number | null;
  /**
   * When the last confirmed figure was observed: the newest stored
   * observation's timestamp, which exists with or without a rate; undefined
   * where none is stored. ISO 8601 with a `Z` suffix, as the observations
   * carry it; the alert schema rejects an offset form.
   */
  lastReportedAt: string | undefined;
  /**
   * The rate the countdown burns at, in its own unit, where it is not the rate
   * that carried the projection: on the token poll, the remainder plus the
   * monitored Bedrock rate. The alert carries it beside its own rate,
   * which stays the one the breach records; absent, the alert carries none.
   */
  countdownRate?: { rate: number; rateSource: RateSource } | null;
  /** The monitored Bedrock token cost not yet billed; absent where none was substituted. */
  unbilledBedrockTokenCost?: number | null;
}

export interface SelectSpendingControlEventsInput {
  lease: SpendingControlEventLease;
  /**
   * Cost Explorer's own total this run, carried as the billed figure. The
   * same figure `PersistBreachRecordsInput.billedCostAtFire` carries, for
   * the same reason.
   */
  billedCostAccrued: number;
  /** Every newly breached threshold this run. */
  breaches: ThresholdBreach[];
  /** The insight the notification names; null where none was available. */
  insight: BreachInsight | null;
  context: SpendingControlEventContext;
}

/**
 * What one run publishes for a lease's spending controls: at most one freeze
 * request and at most one alert. Selection is narrower than persistence,
 * which records every breach.
 */
export interface SpendingControlsEventSelection {
  freeze: LeaseFreezingThresholdBreachedAlert | null;
  alert:
    | LeaseBudgetThresholdBreachedAlert
    | LeaseSpendRateThresholdBreachedAlert
    | null;
}

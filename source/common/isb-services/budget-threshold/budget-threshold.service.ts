// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  BreachInsightSchema,
  BreachRecord,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  RateSource,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import type {
  BudgetThresholdFiredLog,
  SpendRateThresholdFiredLog,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  BudgetThreshold,
  ThresholdAction,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";

import {
  BreachEvaluator,
  BreachInsight,
  BreachRecordServices,
  EvaluatePredictedThresholdsInput,
  EvaluateRateCapsInput,
  EvaluateReportedThresholdsInput,
  EvaluateSpendingControlsInput,
  MaxSpendBreach,
  NewBreachRecord,
  PersistBreachRecordsInput,
  PersistDurationBreachesInput,
  PersistExpiryBreachInput,
  PersistMaxSpendBreachInput,
  PredictedBreach,
  ProjectionAtFire,
  RateBreach,
  ReadBreachHistoryServices,
  ReportedBreach,
  SelectBreachInsightInput,
  SelectComparedSpendInsightInput,
  SelectSpendingControlEventsInput,
  ServiceBreakdown,
  SpendingControlEventContext,
  SpendingControlsEvaluation,
  SpendingControlsEventSelection,
  TerminatingBreachServices,
  ThresholdBreach,
} from "./budget-threshold.types.js";

// Every function here is pure -- no store, no clock -- except the persist
// functions, which write through the store they are handed, and
// persistMaxSpendBreach and persistExpiryBreach, which read the store and the
// clock. Callers inject the figures.

const NO_RATES: SpendRates = {
  hourlyRate: null,
  dailyRate: null,
  hourlyRateWindowHours: null,
  dailyRateWindowHours: null,
};

const NO_PROJECTION_AT_FIRE: ProjectionAtFire = {
  predictedCostAtFire: null,
  rateAtFire: null,
  rateSourceAtFire: null,
};

/**
 * The straddle every threshold kind shares: the line was not yet reached last
 * run and is reached now. A missing previous value compares as zero, so the
 * first figure ever measured, or the first after a run where it was
 * unmeasured, crosses every line below it.
 */
function crossedThisRun(
  previous: number | null | undefined,
  line: number,
  current: number,
): boolean {
  return (previous ?? 0) < line && line <= current;
}

/** A threshold without triggerOn is a REPORTED threshold: today's behavior. */
function triggersOn(threshold: BudgetThreshold): "REPORTED" | "PREDICTED" {
  return threshold.triggerOn ?? "REPORTED";
}

/** The dollar thresholds of one kind whose line the figure crossed this run. */
function crossedThresholds(
  thresholds: BudgetThreshold[] | undefined,
  kind: "REPORTED" | "PREDICTED",
  previous: number | null | undefined,
  current: number,
): BudgetThreshold[] {
  return (thresholds ?? []).filter(
    (threshold) =>
      triggersOn(threshold) === kind &&
      crossedThisRun(previous, threshold.dollarsSpent, current),
  );
}

/** The rate the projection was carried at, in its own unit. */
function selectedRate(
  rates: SpendRates,
  rateSource: RateSource | null,
): number | null {
  if (rateSource === null) {
    return null;
  }
  return rateSource === "HOURLY" ? rates.hourlyRate : rates.dailyRate;
}

/**
 * What of the projection is recorded on a breach: nothing while no rate is in
 * force, because the projection is then the reported total under another
 * name; otherwise the figure and the rate that carried it, together.
 */
function projectionAtFire(
  predictedCost: number | null,
  rate: number | null,
  rateSource: RateSource | null,
): ProjectionAtFire {
  if (predictedCost === null || rate === null || rateSource === null) {
    return NO_PROJECTION_AT_FIRE;
  }
  return {
    predictedCostAtFire: predictedCost,
    rateAtFire: rate,
    rateSourceAtFire: rateSource,
  };
}

function reportedBreach(
  threshold: BudgetThreshold,
  evaluatedSpend: number,
  projection: ProjectionAtFire,
): ReportedBreach {
  return {
    triggeredBy: "REPORTED",
    action: threshold.action,
    thresholdDollars: threshold.dollarsSpent,
    thresholdRate: null,
    thresholdRateBasis: null,
    spendAtFire: evaluatedSpend,
    ...projection,
  };
}

/**
 * REPORTED-threshold crossings against the caller's figure. A lease with no
 * `triggerOn` anywhere gets exactly the breach set Lease Monitoring produces
 * from `totalCostAccrued`. The projection is context only, so on its own this
 * evaluation never fails on it: a source naming an unmeasured rate leaves the
 * context empty. (The composite evaluation below does fail on it.)
 */
export function evaluateReportedThresholds(
  input: EvaluateReportedThresholdsInput,
): ReportedBreach[] {
  const projection = projectionAtFire(
    input.predictedCost,
    selectedRate(input.rates, input.rateSource),
    input.rateSource,
  );
  return crossedThresholds(
    input.thresholds,
    "REPORTED",
    input.previousEvaluatedSpend,
    input.evaluatedSpend,
  ).map((threshold) =>
    reportedBreach(threshold, input.evaluatedSpend, projection),
  );
}

/**
 * PREDICTED-threshold crossings, de-duplicated against the last evaluated
 * figure. While no rate is in force nothing is evaluated: the projection is
 * then the reported total under another name, and a projected breach must
 * carry the rate that carried it. The caller still stores that figure as
 * `lastPredictedSpend`, so a line the billed total passes in that state is
 * already behind the scalar when a rate appears and never fires.
 */
export function evaluatePredictedThresholds(
  input: EvaluatePredictedThresholdsInput,
): PredictedBreach[] {
  const { predictedCost, evaluatedSpend, rateSource } = input;
  if (rateSource === null) {
    return [];
  }
  const rate = selectedRate(input.rates, rateSource);
  if (rate === null) {
    // The source and the rates come from one computation. Disagreement is a
    // caller bug, and a record of a crossing evaluated on this projection
    // would not be truthful.
    throw new Error(`rateSource ${rateSource} names an unmeasured rate`);
  }
  return crossedThresholds(
    input.thresholds,
    "PREDICTED",
    input.previousPredictedCost,
    predictedCost,
  ).map((threshold) => ({
    triggeredBy: "PREDICTED",
    action: threshold.action,
    thresholdDollars: threshold.dollarsSpent,
    thresholdRate: null,
    thresholdRateBasis: null,
    spendAtFire: evaluatedSpend,
    predictedCostAtFire: predictedCost,
    rateAtFire: rate,
    rateSourceAtFire: rateSource,
  }));
}

/**
 * Spend-rate limit crossings. Each configured limit is its own threshold,
 * compared against the measured rate of its basis without conversion and
 * de-duplicated against that rate's stored value, so a rate sitting above a
 * limit fires once per crossing rather than on every run. Several limits on
 * one basis share that basis's stored rate, so one jump can cross several at
 * once; each becomes its own breach. An unmeasured rate cannot cross a limit.
 */
export function evaluateRateCaps(input: EvaluateRateCapsInput): RateBreach[] {
  const { rateLimits, rates, evaluatedSpend, predictedCost } = input;
  const measured = {
    HOURLY: { rate: rates.hourlyRate, previous: input.previousHourlyRate },
    DAILY: { rate: rates.dailyRate, previous: input.previousDailyRate },
  } as const;
  const breaches: RateBreach[] = [];
  for (const limit of rateLimits) {
    const { rate, previous } = measured[limit.basis];
    if (rate === null || !crossedThisRun(previous, limit.rate, rate)) {
      continue;
    }
    breaches.push({
      triggeredBy: "RATE",
      action: limit.action,
      thresholdDollars: null,
      thresholdRate: limit.rate,
      thresholdRateBasis: limit.basis,
      spendAtFire: evaluatedSpend,
      predictedCostAtFire: predictedCost,
      rateAtFire: rate,
      rateSourceAtFire: limit.basis,
    });
  }
  return breaches;
}

/**
 * The daily rate is null whenever the observation nearest 24 hours back is
 * the one the hourly rate already used: a window artifact, not a drop in spend.
 * So while the hourly rate is still measured the stored daily scalar holds,
 * and a cap the rate never fell below does not alert a second time. With both
 * rates unmeasured nothing is held: the series has gone quiet, and a rate
 * that appears later is a fresh crossing.
 */
function nextDailyRate(
  rates: SpendRates,
  previousDailyRate: number | null | undefined,
): number | null {
  if (rates.dailyRate !== null) {
    return rates.dailyRate;
  }
  return rates.hourlyRate === null ? null : (previousDailyRate ?? null);
}

/**
 * Everything one monitoring run evaluates against a lease's spending controls.
 * `maxSpend` termination is not here: it stays reported-only in the handlers
 * and never sees a projected figure. A projection whose source names an
 * unmeasured rate fails the whole evaluation for this lease and run; nothing
 * is recorded, so the next run re-evaluates the same crossings.
 *
 * The stored figures are the ones the last check compared. Before the first
 * check stores `lastEvaluatedSpend`, the billed total stands in for it.
 */
export function evaluateSpendingControls(
  input: EvaluateSpendingControlsInput,
): SpendingControlsEvaluation {
  const { lease, projection, evaluatedSpend } = input;
  const rates = projection?.rates ?? NO_RATES;
  const rateSource = projection?.rateSource ?? null;

  const breaches: SpendingControlsEvaluation["breaches"] =
    evaluateReportedThresholds({
      thresholds: lease.budgetThresholds,
      previousEvaluatedSpend:
        lease.lastEvaluatedSpend ?? lease.totalCostAccrued,
      evaluatedSpend,
      predictedCost: projection === null ? null : projection.predictedCost,
      rates,
      rateSource,
    });

  if (projection === null) {
    return {
      breaches,
      lastEvaluatedSpend: evaluatedSpend,
      lastPredictedSpend: lease.lastPredictedSpend ?? null,
      lastEvaluatedHourlySpendRate: lease.lastEvaluatedHourlySpendRate ?? null,
      lastEvaluatedDailySpendRate: lease.lastEvaluatedDailySpendRate ?? null,
    };
  }

  // A frozen lease has already been acted on: keep measuring and projecting,
  // but stop alerting. Predicted crossings and rate caps are noise until it is
  // unfrozen; reported thresholds are unchanged.
  if (lease.status !== "Frozen") {
    breaches.push(
      ...evaluatePredictedThresholds({
        thresholds: lease.budgetThresholds,
        previousPredictedCost: lease.lastPredictedSpend ?? 0,
        predictedCost: projection.predictedCost,
        evaluatedSpend,
        rates,
        rateSource,
      }),
      ...evaluateRateCaps({
        rateLimits: lease.rateLimits ?? [],
        rates,
        previousHourlyRate: lease.lastEvaluatedHourlySpendRate,
        previousDailyRate: lease.lastEvaluatedDailySpendRate,
        evaluatedSpend,
        predictedCost: projection.predictedCost,
      }),
    );
  }

  return {
    breaches,
    lastEvaluatedSpend: evaluatedSpend,
    lastPredictedSpend: projection.predictedCost,
    lastEvaluatedHourlySpendRate: rates.hourlyRate,
    lastEvaluatedDailySpendRate: nextDailyRate(
      rates,
      lease.lastEvaluatedDailySpendRate,
    ),
  };
}

/** A service appearing this interval must be at least this share of the total. */
const NEW_ENTRANT_MIN_SHARE = 0.1;
/** The largest dollar mover must have moved at least this much, either way. */
const CHANGE_MIN_PERCENT = 25;
/**
 * Both floors are inclusive whatever the magnitude of the figures: a ratio
 * that is exactly a tenth or a quarter in dollars can land a rounding error
 * short of it in binary.
 */
const FLOOR_TOLERANCE = 1e-9;

type BreakdownEntry = [service: string, amount: number];

/** The item with the largest key; the earlier one on a tie. */
function largestBy<T>(items: T[], key: (item: T) => number): T | undefined {
  return items.reduce<T | undefined>(
    (largest, item) =>
      largest === undefined || key(item) > key(largest) ? item : largest,
    undefined,
  );
}

/**
 * Only a service the breach record can carry may be named: its schema excludes
 * markup and control characters from the name, and Cost Explorer service names
 * include seller-authored Marketplace titles. A service it cannot carry is
 * passed over for the next one rather than costing the sentence.
 */
function nameableEntries(breakdown: ServiceBreakdown): BreakdownEntry[] {
  return Object.entries(breakdown).filter(
    ([service]) => BreachInsightSchema.shape.service.safeParse(service).success,
  );
}

/**
 * The largest service that cost nothing last interval, absent or billed at
 * zero alike, and costs at least the share floor now. Without the floor a
 * service appearing at two cents would outrank a doubling one.
 */
function newEntrant(
  newest: BreakdownEntry[],
  previous: ServiceBreakdown,
  billedCostAccrued: number,
): BreachInsight | null {
  const entrant = largestBy(
    newest.filter(
      ([service, amount]) =>
        (previous[service] ?? 0) <= 0 &&
        amount / billedCostAccrued >= NEW_ENTRANT_MIN_SHARE - FLOOR_TOLERANCE,
    ),
    ([, amount]) => amount,
  );
  if (entrant === undefined) {
    return null;
  }
  return { kind: "NEW_ENTRANT", service: entrant[0], amount: entrant[1] };
}

/**
 * The service whose spend moved the most in dollars, either way, if it rose or
 * fell by at least the percent floor. Ranked by dollars and reported as a
 * percent: ranking by percent would let one cent becoming five read 400% and
 * beat a service that nearly doubled. A service that cost nothing last
 * interval has no percent to report and is the new entrant's case, not this
 * one; a service that has since vanished fell by 100%.
 */
function largestChange(
  newest: BreakdownEntry[],
  previous: ServiceBreakdown,
): BreachInsight | null {
  const newestAmounts = new Map(newest);
  const candidates = nameableEntries(previous)
    .filter(([, previousAmount]) => previousAmount > 0)
    .map(([service, previousAmount]) => {
      const amount = newestAmounts.get(service) ?? 0;
      return {
        service,
        amount,
        change: amount - previousAmount,
        changePercent: ((amount - previousAmount) / previousAmount) * 100,
      };
    });
  const top = largestBy(candidates, (candidate) => Math.abs(candidate.change));
  if (
    top === undefined ||
    Math.abs(top.changePercent) < CHANGE_MIN_PERCENT - FLOOR_TOLERANCE
  ) {
    return null;
  }
  return {
    kind: "CHANGE",
    service: top.service,
    amount: top.amount,
    changePercent: top.changePercent,
  };
}

/**
 * The one insight a notification names about what drove the spend, chosen by
 * precedence because on a real interval all three usually apply: a new
 * entrant worth naming, else the largest mover if it moved enough, else the
 * largest service. Null where no breakdown is stored, where it names no
 * service the record can carry, or where the total is zero and no share can
 * be taken; the notification then omits the sentence rather than hedging it.
 */
export function selectBreachInsight(
  input: SelectBreachInsightInput,
): BreachInsight | null {
  const { newestBreakdown, previousBreakdown, billedCostAccrued } = input;
  if (newestBreakdown === undefined || billedCostAccrued <= 0) {
    return null;
  }
  const newest = nameableEntries(newestBreakdown);
  const largest = largestBy(newest, ([, amount]) => amount);
  if (largest === undefined) {
    return null;
  }
  // An empty previous map carries no service to difference against, the same
  // "unavailable" an empty newest map is; without this every service in the
  // newest map would read as new.
  if (
    previousBreakdown !== undefined &&
    Object.keys(previousBreakdown).length > 0
  ) {
    const insight =
      newEntrant(newest, previousBreakdown, billedCostAccrued) ??
      largestChange(newest, previousBreakdown);
    if (insight !== null) {
      return insight;
    }
  }
  return {
    kind: "COMPOSITION",
    service: largest[0],
    amount: largest[1],
    shareOfComparedSpend: largest[1] / billedCostAccrued,
  };
}

/**
 * The name the insight gives the monitored Bedrock token cost the bill
 * has not caught up with yet.
 */
export const UNBILLED_BEDROCK_INSIGHT_SERVICE =
  "Amazon Bedrock token usage not yet billed";

/**
 * The insight over the bill plus the monitored Bedrock token cost it has
 * not caught up with. That unbilled cost stands beside the billed services as
 * an entry of its own, since the bill carries one token-priced Bedrock slice
 * rather than one per service, and every share is taken of the bill plus it. A
 * new entrant or a change is still drawn from the billed breakdown, since the
 * previous run's unbilled cost is not stored, unless the unbilled cost is
 * larger than every billed service: it is then named as the largest, so a
 * lease spending mostly on tokens is never described by its bill. With
 * nothing unbilled, or no billed service to rank it against, as where the
 * breakdown is off or Cost Explorer has not reported yet, this is
 * `selectBreachInsight`.
 *
 * Sandbox Spaces estimated token cost is not an entry: its inference runs in
 * the lease's account, so the bill already counts those tokens, and so does
 * the monitored term where that region is read.
 *
 * The total is the bill plus the unbilled cost, never below the bill, so no
 * billed service's share of it passes 100%.
 */
export function selectComparedSpendInsight(
  input: SelectComparedSpendInsightInput,
): BreachInsight | null {
  const unbilled = input.unbilledBedrockTokenCost ?? 0;
  const largestBilled = largestBy(
    nameableEntries(input.newestBreakdown ?? {}),
    ([, amount]) => amount,
  );
  if (unbilled <= 0 || largestBilled === undefined) {
    return selectBreachInsight(input);
  }
  const total = input.billedCostAccrued + unbilled;
  if (total <= 0) {
    return null;
  }
  if (unbilled > largestBilled[1]) {
    return {
      kind: "COMPOSITION",
      service: UNBILLED_BEDROCK_INSIGHT_SERVICE,
      amount: unbilled,
      shareOfComparedSpend: unbilled / total,
    };
  }
  const insight = selectBreachInsight(input);
  return insight?.kind === "COMPOSITION"
    ? { ...insight, shareOfComparedSpend: insight.amount / total }
    : insight;
}

/** Who evaluated the run, and the poll's monitored Bedrock term. */
function evaluatorFields(
  evaluator: BreachEvaluator,
): Pick<NewBreachRecord, "evaluatedBy" | "monitoredBedrockTokenCostAtFire"> {
  if (evaluator.evaluatedBy === "TOKEN_POLL") {
    return {
      evaluatedBy: "TOKEN_POLL",
      monitoredBedrockTokenCostAtFire:
        evaluator.monitoredBedrockTokenCostAtFire,
    };
  }
  return {
    evaluatedBy: evaluator.evaluatedBy,
    monitoredBedrockTokenCostAtFire: null,
  };
}

/**
 * The row one breach becomes. Each field is named rather than spread from the
 * caller's objects, so a field added to one of them cannot reach the strict
 * row schema unseen. The billed total is the caller's, not the breach's: a
 * breach records the figure it was compared against, which is the billed
 * total only where nothing was substituted or added into it.
 */
function breachRecordRow(
  input: PersistBreachRecordsInput,
  breach: ThresholdBreach | MaxSpendBreach,
): NewBreachRecord {
  return {
    leaseUuid: input.leaseUuid,
    triggeredBy: breach.triggeredBy,
    action: breach.action,
    thresholdDollars: breach.thresholdDollars,
    thresholdRate: breach.thresholdRate,
    thresholdRateBasis: breach.thresholdRateBasis,
    thresholdHoursRemaining: null,
    billedCostAtFire: input.billedCostAtFire,
    predictedCostAtFire: breach.predictedCostAtFire,
    ...evaluatorFields(input.evaluator),
    // The poll calculates every evaluated-spend figure it compares; Lease
    // Monitoring uses the bill as is.
    evaluatedSpendAtFire:
      input.evaluator.evaluatedBy === "TOKEN_POLL" ? breach.spendAtFire : null,
    rateAtFire: breach.rateAtFire,
    rateSourceAtFire: breach.rateSourceAtFire,
    insight: input.insight,
    ttl: input.ttl,
  };
}

/**
 * Appends one breach record per newly breached threshold, stamped with the
 * evaluator that claimed the run. Persistence is broader than event
 * selection, which raises at most one alert and one freeze per run. These rows
 * exist for display and audit; threshold events never read them.
 *
 * Appends are awaited one at a time, as the store requires: each is a
 * conditional write keyed on a normal ISO-millisecond timestamp, and on a
 * collision the store retries a bounded number of times
 * (`BREACH_SK_ATTEMPTS`), each with a fresh millisecond later than the one
 * that collided. Appends in parallel would contend for those same
 * milliseconds and spend that bound on each other. A failed append propagates
 * with the earlier rows already written, and a retry would append those again,
 * since the sort key is wall-clock-derived. Callers isolate the failure per
 * lease rather than retry the batch.
 */
export async function persistBreachRecords(
  input: PersistBreachRecordsInput,
  services: BreachRecordServices,
): Promise<BreachRecord[]> {
  return appendInOrder(
    input.breaches.map((breach) => breachRecordRow(input, breach)),
    services,
  );
}

/** One append at a time, for the reason {@link persistBreachRecords} gives. */
async function appendInOrder(
  rows: NewBreachRecord[],
  services: BreachRecordServices,
): Promise<BreachRecord[]> {
  const records: BreachRecord[] = [];
  for (const row of rows) {
    records.push(await services.costHistoryStore.appendBreachRecord(row));
  }
  return records;
}

/** The breach a run that reaches `maxSpend` records beside the termination. */
function maxSpendBreach(
  maxSpend: number,
  comparedCost: number,
): MaxSpendBreach {
  return {
    triggeredBy: "MAX_SPEND",
    action: "TERMINATE",
    thresholdDollars: maxSpend,
    spendAtFire: comparedCost,
    thresholdRate: null,
    thresholdRateBasis: null,
    predictedCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
  };
}

/**
 * Appends the lease's `maxSpend` breach unless its history already holds one at
 * this cap. Each evaluator checks `maxSpend` against its own figure, and a
 * termination that has not landed is sent again, so without the read a lease
 * could get a row from each evaluator and from each resend. Matched on the cap
 * too, so reaching a raised cap is still recorded.
 *
 * The read covers the lease's start to this run, so a row the other evaluator
 * writes while this run is underway is missed and both append; so can two
 * writers in the same instant. A failed read appends anyway, since a duplicate
 * row can be reconciled and a missing one cannot.
 */
export async function persistMaxSpendBreach(
  input: PersistMaxSpendBreachInput,
  services: TerminatingBreachServices,
): Promise<BreachRecord[]> {
  const recorded = await hasBreach(
    {
      leaseUuid: input.leaseUuid,
      from: input.leaseStartDate,
      kind: "maxSpend",
      matches: (row) =>
        row.triggeredBy === "MAX_SPEND" &&
        row.thresholdDollars === input.maxSpend,
    },
    services,
  );
  if (recorded) {
    return [];
  }
  return persistBreachRecords(
    {
      leaseUuid: input.leaseUuid,
      billedCostAtFire: input.billedCostAtFire,
      evaluator: input.evaluator,
      breaches: [maxSpendBreach(input.maxSpend, input.comparedCost)],
      insight: null,
      ttl: input.ttl,
    },
    services,
  );
}

/** Which of a lease's breach rows to read. */
interface BreachHistoryQuery {
  leaseUuid: string;
  /** The start of the read window. The window ends now. */
  from: string;
  /** Names the breach in the warning a failed read logs. */
  kind: string;
  /** Which rows to keep. */
  matches: (row: BreachRecord) => boolean;
}

/** Whether the lease's breach history from `from` to now holds a row `matches` accepts. */
async function hasBreach(
  query: BreachHistoryQuery,
  services: TerminatingBreachServices,
): Promise<boolean> {
  return (await readBreachHistory(query, services)).length > 0;
}

/**
 * The lease's breach rows from `from` to now that `matches` accepts. If the
 * read fails, logs a warning and returns no rows. If the store drops rows it
 * cannot read, logs a warning and returns the rest.
 */
async function readBreachHistory(
  query: BreachHistoryQuery,
  services: ReadBreachHistoryServices,
): Promise<BreachRecord[]> {
  try {
    const { result, droppedRecordCount, droppedRecordReason } =
      await services.costHistoryStore.listBreachRecords(query.leaseUuid, {
        from: query.from,
        to: nowAsIsoDatetimeString(),
      });
    if (droppedRecordCount > 0) {
      services.logger.warn(
        `breach history for lease ${query.leaseUuid} dropped ${droppedRecordCount} unreadable rows; an earlier ${query.kind} breach may be missed`,
        { leaseId: query.leaseUuid, droppedRecordCount, droppedRecordReason },
      );
    }
    return result.filter(query.matches);
  } catch (error) {
    services.logger.warn(
      `breach history for lease ${query.leaseUuid} could not be read; assuming no earlier ${query.kind} breach`,
      { leaseId: query.leaseUuid, error },
    );
    return [];
  }
}

/** What a duration or expiry row names; the rest of the row is the same for both. */
type LeaseEndBreach =
  | {
      triggeredBy: "DURATION";
      action: ThresholdAction;
      thresholdHoursRemaining: number;
    }
  | {
      triggeredBy: "EXPIRY";
      action: "TERMINATE";
      thresholdHoursRemaining: null;
    };

/**
 * The row a duration threshold or the lease's end becomes. Only Lease
 * Monitoring checks either, against time rather than spend, so the billed total
 * is context and every other figure is null.
 */
function leaseEndRecordRow(
  input: PersistDurationBreachesInput | PersistExpiryBreachInput,
  breach: LeaseEndBreach,
): NewBreachRecord {
  return {
    leaseUuid: input.leaseUuid,
    triggeredBy: breach.triggeredBy,
    action: breach.action,
    thresholdDollars: null,
    thresholdRate: null,
    thresholdRateBasis: null,
    thresholdHoursRemaining: breach.thresholdHoursRemaining,
    billedCostAtFire: input.billedCostAtFire,
    predictedCostAtFire: null,
    evaluatedBy: "LEASE_MONITORING",
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    insight: null,
    ttl: input.ttl,
  };
}

/**
 * Appends one breach record per newly reached duration threshold. Every one is
 * recorded, as every budget breach is, though a run publishes at most one
 * duration alert and one freeze. A threshold is newly reached against the
 * lease's last check, so no read is needed; as with the budget rows, a run that
 * fails before the lease is written repeats the row on the next.
 */
export async function persistDurationBreaches(
  input: PersistDurationBreachesInput,
  services: BreachRecordServices,
): Promise<BreachRecord[]> {
  return appendInOrder(
    input.thresholds.map((threshold) =>
      leaseEndRecordRow(input, {
        triggeredBy: "DURATION",
        action: threshold.action,
        thresholdHoursRemaining: threshold.hoursRemaining,
      }),
    ),
    services,
  );
}

/**
 * Appends the lease's expiry breach unless its history holds one since the
 * lease's end. The expiry is sent again on every run until the termination
 * lands, so without the read each run would add a row. Read from the end
 * rather than the start, so an expiry recorded before the lease was extended
 * does not hide the one at its new end. A failed read appends anyway, as for
 * `maxSpend`.
 */
export async function persistExpiryBreach(
  input: PersistExpiryBreachInput,
  services: TerminatingBreachServices,
): Promise<BreachRecord[]> {
  // An end set through the API may carry no milliseconds, which the read's
  // bounds need; one that does not parse fails the read like any other error.
  const end =
    parseDatetime(input.expirationDate).toISO() ?? input.expirationDate;
  const recorded = await hasBreach(
    {
      leaseUuid: input.leaseUuid,
      from: end,
      kind: "expiry",
      matches: (row) => row.triggeredBy === "EXPIRY",
    },
    services,
  );
  if (recorded) {
    return [];
  }
  return appendInOrder(
    [
      leaseEndRecordRow(input, {
        triggeredBy: "EXPIRY",
        action: "TERMINATE",
        thresholdHoursRemaining: null,
      }),
    ],
    services,
  );
}

/**
 * The record one crossed threshold logs. Every crossing gets one, whether or
 * not selection raises an event for it, so the counts are per crossing rather
 * than per lifecycle transition.
 */
export function thresholdFiredLog(
  breach: ThresholdBreach,
  figures: {
    evaluatedBy: BreachEvaluator["evaluatedBy"];
    billedCostAccrued: number;
    hoursSinceLastRefresh: number | null;
    costAtFreezeDecision: number;
  },
): BudgetThresholdFiredLog | SpendRateThresholdFiredLog {
  const common = {
    action: breach.action,
    evaluatedBy: figures.evaluatedBy,
    spendAtFire: breach.spendAtFire,
    billedCostAtFire: figures.billedCostAccrued,
    predictedCostAtFire: breach.predictedCostAtFire,
    hoursSinceLastRefresh:
      figures.hoursSinceLastRefresh === null ||
      !Number.isFinite(figures.hoursSinceLastRefresh)
        ? null
        : Math.max(0, figures.hoursSinceLastRefresh),
    ...(breach.action === "FREEZE_ACCOUNT"
      ? { costAtFreezeDecision: figures.costAtFreezeDecision }
      : {}),
  };
  if (breach.triggeredBy === "RATE") {
    return {
      logDetailType: "SpendRateThresholdFired",
      rateBasis: breach.thresholdRateBasis,
      thresholdRate: breach.thresholdRate,
      measuredRate: breach.rateAtFire,
      ...common,
    };
  }
  return {
    logDetailType: "BudgetThresholdFired",
    thresholdDollars: breach.thresholdDollars,
    triggeredBy: breach.triggeredBy,
    ...common,
  };
}

type DollarBreach = ReportedBreach | PredictedBreach;

function isDollarBreach(breach: ThresholdBreach): breach is DollarBreach {
  return breach.triggeredBy !== "RATE";
}

function isRateBreach(breach: ThresholdBreach): breach is RateBreach {
  return breach.triggeredBy === "RATE";
}

/**
 * The freeze one run requests, from the dollar thresholds that ask for one.
 * Two crossed in one run name the largest, the same choice the alert makes,
 * so the figure on the freeze is the highest line the spend passed rather
 * than whichever the template happened to list first.
 */
function freezeEvent(
  input: SelectSpendingControlEventsInput,
  breach: DollarBreach,
): LeaseFreezingThresholdBreachedAlert {
  const { lease } = input;
  const crossed = {
    type: "BudgetExceeded",
    triggeredBudgetThreshold: breach.thresholdDollars,
    budget: lease.maxSpend,
    totalSpend: input.billedCostAccrued,
  } as const;
  return new LeaseFreezingThresholdBreachedAlert({
    leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
    accountId: lease.awsAccountId,
    // Only a projected dollar crossing carries `rateSource`; it qualifies the
    // projection that crossed. Absent rather than null: the field is optional
    // on this event, and a null fails the lifecycle manager's parse before it
    // freezes anything, so the freeze this threshold asked for would be lost.
    reason:
      breach.triggeredBy === "PREDICTED"
        ? {
            ...crossed,
            triggeredBy: "PREDICTED",
            rateSource: breach.rateSourceAtFire,
          }
        : { ...crossed, triggeredBy: "REPORTED" },
  });
}

/**
 * The alert for a crossed dollar threshold. A predicted crossing must carry
 * the projection and the rate behind it, which its breach guarantees; a
 * reported one carries them as context, null while no rate is in force.
 */
function dollarAlertEvent(
  input: SelectSpendingControlEventsInput,
  breach: DollarBreach,
): LeaseBudgetThresholdBreachedAlert {
  const { lease, context } = input;
  const common = {
    leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
    accountId: lease.awsAccountId,
    budget: lease.maxSpend,
    totalSpend: input.billedCostAccrued,
    budgetThresholdTriggered: breach.thresholdDollars,
    actionRequested: breach.action,
    hoursToBudgetExhaustion: context.hoursToBudgetExhaustion,
    lastReportedAt: context.lastReportedAt,
    insight: input.insight,
    ...countdownAndUnbilledFields(context),
  };
  if (breach.triggeredBy === "PREDICTED") {
    return new LeaseBudgetThresholdBreachedAlert({
      ...common,
      triggeredBy: "PREDICTED",
      predictedCost: breach.predictedCostAtFire,
      rate: breach.rateAtFire,
      rateSource: breach.rateSourceAtFire,
    });
  }
  return new LeaseBudgetThresholdBreachedAlert({
    ...common,
    triggeredBy: "REPORTED",
    predictedCost: breach.predictedCostAtFire,
    rate: breach.rateAtFire,
    rateSource: breach.rateSourceAtFire,
  });
}

/**
 * The countdown's own rate and the unbilled Bedrock cost, as every alert
 * carries them: dollar-threshold and spend-rate alerts alike.
 */
function countdownAndUnbilledFields(context: SpendingControlEventContext) {
  return {
    countdownRate: context.countdownRate?.rate,
    countdownRateSource: context.countdownRate?.rateSource,
    unbilledBedrockTokenCost: context.unbilledBedrockTokenCost,
  };
}

/** The same event and lifecycle transition as a dollar freeze, with a SpendRateExceeded reason. */
function rateFreezeEvent(
  input: SelectSpendingControlEventsInput,
  breach: RateBreach,
): LeaseFreezingThresholdBreachedAlert {
  const { lease } = input;
  return new LeaseFreezingThresholdBreachedAlert({
    leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
    accountId: lease.awsAccountId,
    reason: {
      type: "SpendRateExceeded",
      rateBasis: breach.thresholdRateBasis,
      thresholdRate: breach.thresholdRate,
      measuredRate: breach.rateAtFire,
      budget: lease.maxSpend,
      totalSpend: input.billedCostAccrued,
    },
  });
}

function rateAlertEvent(
  input: SelectSpendingControlEventsInput,
  breach: RateBreach,
): LeaseSpendRateThresholdBreachedAlert {
  const { lease, context } = input;
  return new LeaseSpendRateThresholdBreachedAlert({
    leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
    accountId: lease.awsAccountId,
    rateBasis: breach.thresholdRateBasis,
    thresholdRate: breach.thresholdRate,
    measuredRate: breach.rateAtFire,
    budget: lease.maxSpend,
    totalSpend: input.billedCostAccrued,
    predictedCost: breach.predictedCostAtFire,
    hoursToBudgetExhaustion: context.hoursToBudgetExhaustion,
    lastReportedAt: context.lastReportedAt,
    insight: input.insight,
    ...countdownAndUnbilledFields(context),
  });
}

/**
 * Highest line first; where the billed total and the projection crossed the
 * same line, the billed one first, since a confirmed figure outranks an
 * estimate. Template order decides nothing.
 */
function byLineThenBilled(a: DollarBreach, b: DollarBreach): number {
  if (a.thresholdDollars !== b.thresholdDollars) {
    return b.thresholdDollars - a.thresholdDollars;
  }
  return (
    Number(a.triggeredBy === "PREDICTED") -
    Number(b.triggeredBy === "PREDICTED")
  );
}

/**
 * The cap exceeded by the larger share of its own limit first, the more
 * serious crossing whatever the two units; the hourly one on a tie. Emission
 * order decides nothing.
 */
function byShareThenHourly(a: RateBreach, b: RateBreach): number {
  const shareA = a.rateAtFire / a.thresholdRate;
  const shareB = b.rateAtFire / b.thresholdRate;
  if (shareA !== shareB) {
    return shareB - shareA;
  }
  return (
    Number(a.thresholdRateBasis !== "HOURLY") -
    Number(b.thresholdRateBasis !== "HOURLY")
  );
}

/** The highest crossed limit taking `action`; the earlier one on a tie. */
function highestRateLimit(
  breaches: RateBreach[],
  action: RateBreach["action"],
): RateBreach | undefined {
  return largestBy(
    breaches.filter((breach) => breach.action === action),
    (breach) => breach.thresholdRate,
  );
}

/**
 * The alert and freeze candidates for one basis, by the rule the dollar
 * thresholds follow: the highest crossed ALERT limit is the alert, the highest
 * crossed FREEZE limit the freeze, and a freeze at or above the alert
 * suppresses it. A lower freeze beside a higher alert yields both.
 */
function basisCandidates(breaches: RateBreach[]): {
  alert: RateBreach | undefined;
  freeze: RateBreach | undefined;
} {
  const alert = highestRateLimit(breaches, "ALERT");
  const freeze = highestRateLimit(breaches, "FREEZE_ACCOUNT");
  const suppressed =
    alert !== undefined &&
    freeze !== undefined &&
    freeze.thresholdRate >= alert.thresholdRate;
  return { alert: suppressed ? undefined : alert, freeze };
}

/**
 * The rate alert and rate freeze one run may raise. Each basis is resolved on
 * its own, since an hourly and a daily limit are not on one line, so a freeze
 * in one basis does not suppress an alert in the other. Across the two bases
 * one alert and one freeze survive, each the limit exceeded by the larger
 * share of itself, the hourly one on a tie.
 */
function selectRateCandidates(breaches: RateBreach[]): {
  alert: RateBreach | undefined;
  freeze: RateBreach | undefined;
} {
  const hourly = basisCandidates(
    breaches.filter((breach) => breach.thresholdRateBasis === "HOURLY"),
  );
  const daily = basisCandidates(
    breaches.filter((breach) => breach.thresholdRateBasis === "DAILY"),
  );
  const mostExceeded = (candidates: (RateBreach | undefined)[]) =>
    candidates
      .filter((breach): breach is RateBreach => breach !== undefined)
      .sort(byShareThenHourly)[0];
  return {
    alert: mostExceeded([hourly.alert, daily.alert]),
    freeze: mostExceeded([hourly.freeze, daily.freeze]),
  };
}

/**
 * The events one run publishes for a lease's spending controls, by the rules
 * Lease Monitoring has always applied: the largest crossed dollar threshold
 * is the one alerted on, whichever figure crossed it, and a threshold that
 * freezes requests the freeze instead of alerting. A freeze below a crossed
 * alert yields both. One at the same line suppresses the alert whichever of
 * the two the template listed first: the handler let template order decide
 * that case, and here the freeze always wins, since it is a largest crossed
 * threshold. `maxSpend` termination and expiry are not here: they return
 * early in the handler and clobber everything below.
 *
 * At most one alert and one freeze a run. A crossed dollar threshold owns the
 * alert slot, so a rate limit crossed in the same run is recorded but not
 * alerted; its breach record is what the lease view shows. A dollar freeze
 * outranks a rate freeze. Without a dollar freeze, a rate freeze may pair with
 * a dollar alert.
 *
 * Only an Active lease can be frozen, so a lease in any other status gets no
 * freeze, and a freeze it could not get suppresses no alert: a dollar freeze
 * is dropped before ranking, and a rate freeze before same-basis suppression.
 */
export function selectSpendingControlEvents(
  input: SelectSpendingControlEventsInput,
): SpendingControlsEventSelection {
  const canFreeze = input.lease.status === "Active";
  const usable = (breach: ThresholdBreach) =>
    canFreeze || breach.action !== "FREEZE_ACCOUNT";
  const ranked = input.breaches
    .filter(isDollarBreach)
    .filter(usable)
    .sort(byLineThenBilled);
  const largest = ranked[0];
  const freezing = ranked.find((breach) => breach.action === "FREEZE_ACCOUNT");
  const rate = selectRateCandidates(
    input.breaches.filter(isRateBreach).filter(usable),
  );
  let freeze: LeaseFreezingThresholdBreachedAlert | null = null;
  if (freezing !== undefined) {
    freeze = freezeEvent(input, freezing);
  } else if (rate.freeze !== undefined) {
    freeze = rateFreezeEvent(input, rate.freeze);
  }
  if (largest !== undefined) {
    const suppressed =
      freezing !== undefined &&
      freezing.thresholdDollars >= largest.thresholdDollars;
    return {
      freeze,
      alert: suppressed ? null : dollarAlertEvent(input, largest),
    };
  }
  return {
    freeze,
    alert: rate.alert === undefined ? null : rateAlertEvent(input, rate.alert),
  };
}

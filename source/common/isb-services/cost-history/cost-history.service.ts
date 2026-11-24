// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime } from "luxon";

import {
  toBreachEntry,
  toCostHistoryResultRow,
  toTokenSeriesRows,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/cost-history-api.types.js";
import { COST_SK_PREFIX } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import { CostHistoryPageOptions } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  calculateCostHistoryTtl,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { remainderSeries } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";
import { LeaseDailyCostBucket } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import {
  computeProjection,
  computeSpendRates,
  computeTimeToExhaustion,
  projectionRatePerHour,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/index.js";
import { parseDatetime } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  BedrockTokenHistoryData,
  BreachHistoryData,
  CostHistoryCurrent,
  CostHistoryData,
  CostSummaryData,
  CurrentServiceEntry,
  ServiceBreakdown,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { Lease } from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  BedrockTokenSource,
  CostHistoryServices,
  CostQueryAnchor,
  LeaseHistoryPageRequest,
  NewCostObservation,
  RecentObservationPoint,
  RecentObservations,
  RecordCostObservationInput,
  RecordCostObservationResult,
} from "./cost-history.types.js";

/**
 * Below this a re-read total counts as unchanged. Resuming from an anchor
 * subtracts and re-adds the anchor day, so an identical Cost Explorer response
 * can differ from the stored figure by floating-point noise; without this every
 * hourly run would append a row carrying no information.
 */
const UNCHANGED_COST_TOLERANCE = 1e-6;

/**
 * Where the fleet's next Cost Explorer query starts: the earliest day any
 * tag-served lease still needs re-read. A lease resumes from its newest stored
 * observation's `latestPeriodStart`, inclusive, because that day was still
 * filling when it was stored; a lease with no observation falls back to its
 * `startDate`.
 */
export function costQueryWindowStart(
  anchors: CostQueryAnchor[],
): DateTime<true> | undefined {
  let earliest: DateTime<true> | undefined;
  for (const anchor of anchors) {
    const candidate = DateTime.fromISO(
      anchor.newest?.latestPeriodStart ?? anchor.startDate,
      { zone: "utc" },
    );
    if (!candidate.isValid) {
      throw new Error(
        `Unparseable resume date for the cost query window: ${anchor.newest?.latestPeriodStart ?? anchor.startDate}`,
      );
    }
    if (earliest === undefined || candidate < earliest) {
      earliest = candidate;
    }
  }
  return earliest;
}

/**
 * Builds this run's reading from the lease's newest observation and appends
 * the row only when the cumulative total moved, or when it is the first to
 * carry a token slice after monitoring is switched on. A lease with no
 * history counts as $0.00, so a first reading of $0.00 writes no row and the
 * lease keeps resuming from its start. The caller writes `lastCheckedDate` on
 * the lease every run regardless, so "we looked and nothing had moved" is
 * still recorded.
 */
export async function recordCostObservation(
  input: RecordCostObservationInput,
  services: CostHistoryServices,
): Promise<RecordCostObservationResult> {
  const { lease, anchor: newest } = input;
  if (!newest.complete) {
    services.logger.warn(
      "newest cost observation is unreadable; nothing appended this run",
      {
        leaseUuid: lease.uuid,
        droppedRecordCount: newest.droppedRecordCount,
        droppedRecordReason: newest.droppedRecordReason,
      },
    );
    return {
      status: "ANCHOR_UNREADABLE",
      droppedRecordReason: newest.droppedRecordReason,
    };
  }

  const observation = buildCostObservation(input, newest.result);
  if (observation === null) {
    return {
      status: "NO_DATA",
      billedCostAccrued: newest.result?.billedCostAccrued,
    };
  }
  const anchorCost = newest.result?.billedCostAccrued ?? 0;
  // The first reading with a token slice after monitoring is switched on is
  // kept even with an unchanged total: the token poll counts monitored
  // Bedrock cost only beside a stored slice.
  const startsSlice =
    newest.result !== undefined &&
    !carriesBedrockTokenSlice(newest.result) &&
    observation.billedBedrockTokenCost !== null;
  if (
    !startsSlice &&
    Math.abs(observation.billedCostAccrued - anchorCost) <=
      UNCHANGED_COST_TOLERANCE
  ) {
    return { status: "UNCHANGED", billedCostAccrued: anchorCost };
  }

  await services.costHistoryStore.appendCostObservation(observation);
  return { status: "APPENDED", observation };
}

/**
 * The row this run would append, or null when the source carries no day on or
 * after the anchor day. Pure, so the arithmetic is testable without a store.
 */
export function buildCostObservation(
  input: Omit<RecordCostObservationInput, "anchor">,
  anchor: CostObservation | undefined,
): NewCostObservation | null {
  const { lease, source } = input;
  const reading =
    source.kind === "TAG"
      ? readingFromDailyBuckets(anchor, source.buckets)
      : readingFromFallbackTotal(source.billedCostAccrued, lease.startDate);
  if (reading === null) {
    return null;
  }
  return {
    leaseUuid: lease.uuid,
    ...reading,
    billedCostDelta:
      reading.billedCostAccrued - (anchor?.billedCostAccrued ?? 0),
    predictedCostAtRefresh: input.predictedCostAtRefresh,
    // A fallback reading is the account's total re-summed from the lease's
    // start day, so its token slice is the account's slice re-summed from that
    // same day rather than resumed from the anchor.
    ...(source.kind === "TAG"
      ? bedrockTokenReading(
          anchor,
          input.bedrockTokens,
          reading.latestPeriodStart,
          lease.startDate,
        )
      : fallbackBedrockTokenReading(
          input.bedrockTokens,
          reading.latestPeriodStart,
        )),
    ttl: calculateCostHistoryTtl({
      retentionDays: input.retentionDays,
      expirationDate: lease.expirationDate,
      startDate: lease.startDate,
      leaseDurationInHours: lease.leaseDurationInHours,
    }),
  };
}

type CostReading = Pick<
  NewCostObservation,
  | "billedCostAccrued"
  | "latestPeriodStart"
  | "latestPeriodAmount"
  | "serviceBreakdown"
  | "latestPeriodServiceAmounts"
  | "breakdownCoversFrom"
>;

/**
 * Resumes from the anchor: its cumulative less its own still-filling day, plus
 * every bucket from that day onward. The anchor day is re-read in full because
 * Cost Explorer keeps filling it for hours after ISB first saw it; adding only
 * the days after it would drop that growth for good.
 */
function readingFromDailyBuckets(
  anchor: CostObservation | undefined,
  buckets: Record<string, LeaseDailyCostBucket>,
): CostReading | null {
  const days = Object.keys(buckets)
    .filter((day) => anchor === undefined || day >= anchor.latestPeriodStart)
    .sort(); // NOSONAR typescript:S2871: YYYY-MM-DD keys sort chronologically in default string order.
  const newestDay = days.at(-1);
  if (newestDay === undefined) {
    return null;
  }

  let billedCostAccrued =
    anchor === undefined
      ? 0
      : anchor.billedCostAccrued - anchor.latestPeriodAmount;
  for (const day of days) {
    billedCostAccrued += buckets[day]!.amount;
  }
  const reading: CostReading = {
    billedCostAccrued,
    latestPeriodStart: newestDay,
    latestPeriodAmount: buckets[newestDay]!.amount,
  };

  const breakdownOn = days.every(
    (day) => buckets[day]!.serviceAmounts !== undefined,
  );
  if (!breakdownOn) {
    return reading;
  }
  return {
    ...reading,
    ...serviceBreakdownFrom(anchor, buckets, days),
  };
}

/**
 * The same three-term correction per service. An anchor without a breakdown
 * (the breakdown was turned on for a lease that already had history) cannot be
 * corrected, so the breakdown starts over from the anchor day and
 * `breakdownCoversFrom` marks where it becomes complete.
 */
function serviceBreakdownFrom(
  anchor: CostObservation | undefined,
  buckets: Record<string, LeaseDailyCostBucket>,
  days: string[],
): Pick<
  CostReading,
  "serviceBreakdown" | "latestPeriodServiceAmounts" | "breakdownCoversFrom"
> {
  const anchorBreakdown = anchor?.serviceBreakdown;
  const anchorDayAmounts = anchor?.latestPeriodServiceAmounts;
  const carried =
    anchorBreakdown !== undefined && anchorDayAmounts !== undefined;
  const serviceBreakdown: Record<string, number> = { ...anchorBreakdown };
  for (const [service, amount] of Object.entries(anchorDayAmounts ?? {})) {
    serviceBreakdown[service] = (serviceBreakdown[service] ?? 0) - amount;
  }
  for (const day of days) {
    for (const [service, amount] of Object.entries(
      buckets[day]!.serviceAmounts ?? {},
    )) {
      serviceBreakdown[service] = (serviceBreakdown[service] ?? 0) + amount;
    }
  }
  const newestDay = days.at(-1)!;
  const result: ReturnType<typeof serviceBreakdownFrom> = {
    serviceBreakdown,
    latestPeriodServiceAmounts: { ...buckets[newestDay]!.serviceAmounts },
  };
  // A carried breakdown keeps its boundary. Otherwise the breakdown covers
  // everything unless the anchor holds spend from before its own day that this
  // run cannot attribute; a fallback row, or a lease still in its first billed
  // day, holds none.
  const unattributedBeforeAnchorDay =
    anchor !== undefined &&
    anchor.billedCostAccrued - anchor.latestPeriodAmount !== 0;
  const uncarriedCoversFrom = unattributedBeforeAnchorDay ? days[0] : undefined;
  const coversFrom = carried
    ? anchor?.breakdownCoversFrom
    : uncarriedCoversFrom;
  if (coversFrom !== undefined) {
    result.breakdownCoversFrom = coversFrom;
  }
  return result;
}

type BedrockTokenReading = Pick<
  NewCostObservation,
  "billedBedrockTokenCost" | "latestPeriodBedrockTokenAmount"
>;

/** Whether the anchor's token slice can be resumed rather than re-summed. */
function carriesBedrockTokenSlice(
  anchor: CostObservation | undefined,
): anchor is CostObservation & {
  billedBedrockTokenCost: number;
  latestPeriodBedrockTokenAmount: number;
} {
  return (
    anchor?.billedBedrockTokenCost != null &&
    anchor.latestPeriodBedrockTokenAmount !== undefined
  );
}

/**
 * Where the next token-priced Bedrock query starts: as for the cost query,
 * except that a lease whose newest observation carries no slice is re-read
 * from its `startDate`, where `bedrockTokenReading` re-sums it from.
 */
export function bedrockTokenQueryWindowStart(
  anchors: CostQueryAnchor[],
): DateTime<true> | undefined {
  return costQueryWindowStart(
    anchors.map((anchor) => ({
      startDate: anchor.startDate,
      newest: carriesBedrockTokenSlice(anchor.newest)
        ? anchor.newest
        : undefined,
    })),
  );
}

/**
 * The token-priced Bedrock slice, anchored like the total: the anchor's figure
 * less its own anchor-day amount, plus every day from the anchor day onward.
 * An anchor without that amount (written while monitoring was off) has no
 * slice to resume, so the slice is re-summed from the lease's start day, where
 * the token poll's monitored count also starts. Restarting it at the
 * anchor day instead would leave the earlier token spend in both the reported
 * total and the monitored count. 0.00, never absent, for a monitored
 * lease with no token spend; null when monitoring is off.
 */
function bedrockTokenReading(
  anchor: CostObservation | undefined,
  tokens: BedrockTokenSource | null,
  latestPeriodStart: string,
  startDate: string,
): BedrockTokenReading {
  if (tokens === null) {
    return { billedBedrockTokenCost: null };
  }
  const resumed = carriesBedrockTokenSlice(anchor);
  const fromDay = resumed
    ? anchor.latestPeriodStart
    : parseDatetime(startDate).toFormat("yyyy-MM-dd");
  let billedBedrockTokenCost = resumed
    ? anchor.billedBedrockTokenCost - anchor.latestPeriodBedrockTokenAmount
    : 0;
  for (const [day, cost] of Object.entries(tokens.costByDay)) {
    // Bounded above by this reading's anchor day: the two queries run one after
    // the other, so a day only the token query saw would be carried whole now
    // and added again by the next run.
    if (day >= fromDay && day <= latestPeriodStart) {
      billedBedrockTokenCost += cost;
    }
  }
  return {
    billedBedrockTokenCost,
    latestPeriodBedrockTokenAmount: tokens.costByDay[latestPeriodStart] ?? 0,
  };
}

/**
 * The token-priced Bedrock slice beside a fallback total: every day of the
 * account's slice from the lease's start day on, so a previous tenant's spend
 * on an earlier day is never subtracted. Like the total, the whole slice is
 * stored as the still-filling amount from the start day, so nothing is carried
 * and a later tag-served run re-sums the slice from that day. 0.00, never
 * absent, for a monitored lease with no token spend; null when monitoring is
 * off.
 */
function fallbackBedrockTokenReading(
  tokens: BedrockTokenSource | null,
  startDay: string,
): BedrockTokenReading {
  if (tokens === null) {
    return { billedBedrockTokenCost: null };
  }
  let billedBedrockTokenCost = 0;
  for (const [day, cost] of Object.entries(tokens.costByDay)) {
    if (day >= startDay) {
      billedBedrockTokenCost += cost;
    }
  }
  return {
    billedBedrockTokenCost,
    latestPeriodBedrockTokenAmount: billedBedrockTokenCost,
  };
}

/**
 * The fallback query yields one total re-summed from the lease's start and no
 * per-day figure, so the whole total is the still-filling amount from the start
 * day. Stored that way, the row is a safe anchor: the window for this lease
 * never narrows, and a later tag-served run re-sums every bucket in full
 * instead of double counting a day.
 */
function readingFromFallbackTotal(
  billedCostAccrued: number,
  startDate: string,
): CostReading {
  return {
    billedCostAccrued,
    latestPeriodStart: DateTime.fromISO(startDate, { zone: "utc" }).toFormat(
      "yyyy-MM-dd",
    ),
    latestPeriodAmount: billedCostAccrued,
  };
}

/**
 * The newest-first observation series for the rate math. At most one row is
 * appended per hourly run, so `hoursBack + 2` rows always covers the window and
 * the two newest observations the hourly rate needs whatever their age. Each
 * point also carries its row's service breakdown, which the notification
 * insight differences across the two newest rows. An unreadable series yields
 * no series rather than a shortened one: a hole would produce a confidently
 * wrong rate where none produces no rate.
 */
export async function getRecentObservations(
  input: { leaseUuid: string; hoursBack: number },
  services: CostHistoryServices,
): Promise<RecentObservations> {
  const recent = await services.costHistoryStore.getRecentCostObservations(
    input.leaseUuid,
    { limit: input.hoursBack + 2 },
  );
  if (!recent.complete) {
    services.logger.warn(
      "cost observation series is unreadable; no rate this run",
      {
        leaseUuid: input.leaseUuid,
        droppedRecordCount: recent.droppedRecordCount,
        droppedRecordReason: recent.droppedRecordReason,
      },
    );
    return {
      points: [],
      droppedRecordCount: recent.droppedRecordCount,
      droppedRecordReason: recent.droppedRecordReason,
    };
  }
  const points = recent.result.map((row) => ({
    timestamp: row.sk.slice(COST_SK_PREFIX.length),
    billedCostAccrued: row.billedCostAccrued,
    serviceBreakdown: row.serviceBreakdown,
    breakdownCoversFrom: row.breakdownCoversFrom,
    latestPeriodStart: row.latestPeriodStart,
    billedBedrockTokenCost: row.billedBedrockTokenCost,
  }));
  const newest = points[0];
  if (newest === undefined) {
    return { points: [] };
  }
  const newestAt = DateTime.fromISO(newest.timestamp, { zone: "utc" });
  return {
    points: points.filter((point, index) => {
      if (index < 2) {
        return true;
      }
      const observedAt = DateTime.fromISO(point.timestamp, { zone: "utc" });
      return newestAt.diff(observedAt, "hours").hours <= input.hoursBack;
    }),
  };
}

/**
 * Lookback for the observation series, shared by every caller so a rate and the
 * window reported beside it are measured over the same span. The daily-rate anchor
 * is the observation nearest 24h back, which with 1-3 Cost Explorer refreshes a day
 * can sit well past 24h.
 */
export const OBSERVATION_LOOKBACK_HOURS = 48;

const SHARE_DECIMAL_PLACES = 2;
const EXHAUSTION_DECIMAL_PLACES = 1;

type ObservedLease = Extract<Lease, { lastCheckedDate: string }>;

function pageOptions(input: LeaseHistoryPageRequest): CostHistoryPageOptions {
  return {
    pageSize: input.maxResults,
    ...(input.pageIdentifier === undefined
      ? {}
      : { pageIdentifier: input.pageIdentifier }),
    ...(input.range === undefined ? {} : { window: input.range }),
  };
}

/**
 * The `data` payload of `GET /leases/{leaseId}/costSummary`: the lease-level
 * headline figures from the newest reading, whatever range a chart is browsing.
 */
export async function buildCostSummaryData(
  input: { lease: Lease },
  services: CostHistoryServices,
): Promise<CostSummaryData> {
  const { lease } = input;
  // The rate series and the monitored Bedrock term are independent reads.
  const [observations, monitoredBedrockTokenCost] = await Promise.all([
    getRecentObservations(
      { leaseUuid: lease.uuid, hoursBack: OBSERVATION_LOOKBACK_HOURS },
      services,
    ),
    lease.bedrockTokenMonitoringEnabled === true
      ? newestMonitoredBedrockTokenCost(lease.uuid, services)
      : null,
  ]);

  return {
    current: buildCostHistoryCurrent({
      lease,
      points: observations.points,
      monitoredBedrockTokenCost,
    }),
  };
}

/**
 * The `data` payload of `GET /leases/{leaseId}/costHistory`: a page of the
 * reported series. `range` restricts which observations are considered at all,
 * and the cursor pages within it.
 */
export async function buildCostHistoryData(
  input: LeaseHistoryPageRequest,
  services: CostHistoryServices,
): Promise<CostHistoryData> {
  const page = await services.costHistoryStore.listCostObservations(
    input.lease.uuid,
    pageOptions(input),
  );

  return {
    result: page.result.map(toCostHistoryResultRow),
    nextPageIdentifier: page.nextPageIdentifier,
  };
}

/**
 * The `data` payload of `GET /leases/{leaseId}/bedrockTokenHistory`: a page of
 * the flattened token series.
 */
export async function buildBedrockTokenHistoryData(
  input: LeaseHistoryPageRequest,
  services: CostHistoryServices,
): Promise<BedrockTokenHistoryData> {
  const page = await services.costHistoryStore.listBedrockTokenRows(
    input.lease.uuid,
    pageOptions(input),
  );

  return {
    result: page.result.flatMap(toTokenSeriesRows),
    nextPageIdentifier: page.nextPageIdentifier,
  };
}

/**
 * The `data` payload of `GET /leases/{leaseId}/breachHistory`: a page of the
 * thresholds that fired.
 */
export async function buildBreachHistoryData(
  input: LeaseHistoryPageRequest,
  services: CostHistoryServices,
): Promise<BreachHistoryData> {
  const page = await services.costHistoryStore.listBreachRecordPage(
    input.lease.uuid,
    pageOptions(input),
  );

  return {
    result: page.result.map(toBreachEntry),
    nextPageIdentifier: page.nextPageIdentifier,
  };
}

async function newestMonitoredBedrockTokenCost(
  leaseUuid: string,
  services: CostHistoryServices,
): Promise<number | null> {
  const newest =
    await services.costHistoryStore.getNewestBedrockTokenRow(leaseUuid);
  if (!newest.complete) {
    // The response does not say the term is missing, so without this log an
    // unreadable row is indistinguishable from a lease with no Bedrock cost.
    services.logger.warn(
      "newest bedrock token row is unreadable; no monitored Bedrock token cost this read",
      {
        leaseUuid,
        droppedRecordCount: newest.droppedRecordCount,
        droppedRecordReason: newest.droppedRecordReason,
      },
    );
    return null;
  }
  return newest.result?.monitoredBedrockTokenCost ?? null;
}

/**
 * The lease-level headline figures, or null when the newest reading is
 * unavailable — a zeroed block would read as "$0.00 spent" on a lease that may
 * be at its cap. The last run's figures are read back rather than recomputed, so
 * this block carries the same numbers that run's alert quoted; only what the run
 * did not persist is derived here, from those same persisted rates.
 */
function buildCostHistoryCurrent(input: {
  lease: Lease;
  points: RecentObservationPoint[];
  monitoredBedrockTokenCost: number | null;
}): CostHistoryCurrent | null {
  const { lease } = input;
  const newest = input.points[0];
  if (newest === undefined || !("lastCheckedDate" in lease)) {
    return null;
  }

  const monitored = lease.bedrockTokenMonitoringEnabled === true;
  // The monitored term is substituted only where both it and the billed slice are
  // known; otherwise the lease is measured as an unmonitored one, as the poll
  // measures it.
  const hasMonitoredBedrockTokenCost =
    monitored &&
    input.monitoredBedrockTokenCost !== null &&
    newest.billedBedrockTokenCost !== null;
  const rates = monitored
    ? remainderRates(lease, input.points, hasMonitoredBedrockTokenCost)
    : persistedRates(lease, input.points);
  const evaluatedSpend = monitored ? (lease.lastEvaluatedSpend ?? null) : null;
  const projection = computeProjection({
    projectionAnchorCost: evaluatedSpend ?? newest.billedCostAccrued,
    lastReportedAt: newest.timestamp,
    evaluatedAt: lease.lastCheckedDate,
    rates,
    recentIntervalHours: rates.hourlyRateWindowHours,
  });
  // The basis the persisted rates themselves carry. The projection drops it when
  // it cannot measure a cap to extrapolate over, but the rates it was told about
  // are still the ones this block reports.
  const basis = projectionRatePerHour(rates);
  const hasRate = basis !== null;
  // A stored figure with no rate behind it is a billed total, not a projection.
  const predictedCost =
    (hasRate ? lease.lastPredictedSpend : null) ?? projection.predictedCost;
  // Where token monitoring is on the poll persisted the summed rates, remainder
  // plus monitored Bedrock, which the caps compare against and the countdown burns at.
  const summed = monitored ? persistedRates(lease, input.points) : null;
  const hoursToBudgetExhaustion = computeTimeToExhaustion({
    maxSpend: lease.maxSpend,
    predictedCost,
    ratePerHour:
      (summed === null ? basis : projectionRatePerHour(summed))?.ratePerHour ??
      null,
  });

  return {
    billedCostAccrued: newest.billedCostAccrued,
    predictedCost,
    hourlyRate: rates.hourlyRate,
    dailyRate: rates.dailyRate,
    hourlyRateWindowHours: rates.hourlyRateWindowHours,
    dailyRateWindowHours: rates.dailyRateWindowHours,
    rateSource: basis?.source ?? null,
    hoursToBudgetExhaustion:
      hoursToBudgetExhaustion === null
        ? null
        : roundTo(hoursToBudgetExhaustion, EXHAUSTION_DECIMAL_PLACES),
    latestPeriodStart: newest.latestPeriodStart,
    lastReportedAt: newest.timestamp,
    lastCheckedAt: lease.lastCheckedDate,
    services: buildCurrentServices(
      newest.billedCostAccrued,
      newest.breakdownCoversFrom === undefined
        ? newest.serviceBreakdown
        : undefined,
      hasRate ? input.points[1]?.serviceBreakdown : undefined,
    ),
  };
}

/**
 * The rates the projection carried forward on a lease with token monitoring on:
 * each observation less its billed Bedrock slice, differenced as the poll does.
 * They are not persisted, since the persisted pair holds the summed rates.
 */
function remainderRates(
  lease: ObservedLease,
  points: RecentObservationPoint[],
  hasMonitoredBedrockTokenCost: boolean,
): SpendRates {
  if (lease.predictiveBudgetEnabled !== true) {
    return {
      hourlyRate: null,
      dailyRate: null,
      hourlyRateWindowHours: null,
      dailyRateWindowHours: null,
    };
  }
  return computeSpendRates(
    remainderSeries(points, hasMonitoredBedrockTokenCost),
  );
}

/**
 * The rates the last run persisted, with the window each was measured over. The
 * windows are not persisted, so they are re-measured from the series and each is
 * dropped with its own rate rather than shown beside a rate nobody computed. The
 * opt-in governs prediction, not recording: a lease that never opted in still has
 * a series, but nothing was ever projected from it.
 */
function persistedRates(
  lease: ObservedLease,
  points: RecentObservationPoint[],
): SpendRates {
  const hourlyRate =
    lease.predictiveBudgetEnabled === true
      ? (lease.lastEvaluatedHourlySpendRate ?? null)
      : null;
  const dailyRate =
    lease.predictiveBudgetEnabled === true
      ? (lease.lastEvaluatedDailySpendRate ?? null)
      : null;
  const measured = computeSpendRates(points);
  return {
    hourlyRate,
    dailyRate,
    hourlyRateWindowHours:
      hourlyRate === null ? null : measured.hourlyRateWindowHours,
    dailyRateWindowHours:
      dailyRate === null ? null : measured.dailyRateWindowHours,
  };
}

/**
 * The newest per-service figures, ranked by amount. Empty where no share can be
 * expressed: no breakdown stored, a breakdown that covers only part of the
 * reported total, or a non-positive total. A partial breakdown is withheld rather
 * than shared out, because the residual would hand the uncovered history to the
 * smallest service.
 */
function buildCurrentServices(
  billedCostAccrued: number,
  breakdown: ServiceBreakdown | undefined,
  previous: ServiceBreakdown | undefined,
): CurrentServiceEntry[] {
  if (breakdown === undefined || billedCostAccrued <= 0) {
    return [];
  }
  const ranked = Object.entries(breakdown).sort(
    ([, left], [, right]) => right - left,
  );
  const shares = sharesOfTotal(ranked, billedCostAccrued);
  return ranked.map(([service, amount], index) => ({
    service,
    amount,
    shareOfBilledCost: shares[index]!,
    changePercent: changePercentSince(amount, previous?.[service]),
  }));
}

/**
 * Each share against the reported total, the smallest as the residual, so the
 * array sums to 1.00. Rounding every share independently does not: 1.50 of 60.00
 * is exactly 0.025, which rounds up and makes the array total 1.01. Each share is
 * therefore the step between rounded running totals, which holds the head within
 * half a cent of the exact figure however long the tail is; a head rounding up
 * would otherwise leave nothing for the residual and total more than 1.00. The
 * residual is floored so a breakdown out-running the total yields no negative slice.
 */
function sharesOfTotal(
  ranked: [string, number][],
  billedCostAccrued: number,
): number[] {
  const shares: number[] = [];
  let exactSoFar = 0;
  let roundedSoFar = 0;
  for (const [, amount] of ranked.slice(0, -1)) {
    exactSoFar += amount / billedCostAccrued;
    const runningTotal = roundTo(exactSoFar, SHARE_DECIMAL_PLACES);
    shares.push(roundTo(runningTotal - roundedSoFar, SHARE_DECIMAL_PLACES));
    roundedSoFar = runningTotal;
  }
  if (ranked.length > 0) {
    shares.push(Math.max(0, roundTo(1 - roundedSoFar, SHARE_DECIMAL_PLACES)));
  }
  return shares;
}

/**
 * Whole percent, signed, so a fall is negative. Null where there is nothing to
 * difference against.
 */
function changePercentSince(
  amount: number,
  previousAmount: number | undefined,
): number | null {
  if (previousAmount === undefined || previousAmount <= 0) {
    return null;
  }
  return Math.round(((amount - previousAmount) / previousAmount) * 100);
}

function roundTo(value: number, decimalPlaces: number): number {
  const factor = 10 ** decimalPlaces;
  return Math.round(value * factor) / factor;
}

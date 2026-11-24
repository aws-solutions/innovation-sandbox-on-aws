// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";
import { DateTime } from "luxon";

import { COST_SK_PREFIX } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import {
  LeaseCostHistoryStore,
  NewestRecordResult,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  calculateCostHistoryTtl,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  newestCopyOfEachLease,
  PersistedMonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import {
  evaluateSpendingControls,
  persistBreachRecords,
  persistDurationBreaches,
  persistExpiryBreach,
  persistMaxSpendBreach,
  RunProjection,
  selectBreachInsight,
  selectSpendingControlEvents,
  SpendingControlsEvaluation,
  ThresholdBreach,
  thresholdFiredLog,
} from "@amzn/innovation-sandbox-commons/isb-services/budget-threshold/index.js";
import {
  BedrockTokenCostReport,
  CostExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import {
  bedrockTokenQueryWindowStart,
  BedrockTokenSource,
  buildCostObservation,
  CostHistoryServices,
  costQueryWindowStart,
  getRecentObservations,
  LeaseCostSource,
  OBSERVATION_LOOKBACK_HOURS,
  RecentObservationPoint,
  recordCostObservation,
  RecordCostObservationInput,
  RecordCostObservationResult,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  computeProjection,
  computeSpendRates,
  computeTimeToExhaustion,
  projectionRatePerHour,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/index.js";
import {
  LeaseMonitoringEnvironment,
  LeaseMonitoringEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-monitoring-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { searchableLeaseProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  IsbEvent,
  IsbEventBridgeClient,
} from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { DurationThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const serviceName = "LeaseMonitoring";
const tracer = new Tracer();

type BreachedDurationThreshold = DurationThreshold & {
  leaseExpirationDate: string;
};
const logger = new Logger({ serviceName });

/** Names the projection strategy on accuracy records so a later one stays comparable. */
const PROJECTION_ALGORITHM_ID = "linear-max-v1";

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseMonitoringEnvironmentSchema,
  moduleName: "lease-monitoring",
})
  .use(isbConfigMiddleware())
  .handler(performAccountMonitoringScan);

type ScanContext = Context &
  ValidatedEnvironment<LeaseMonitoringEnvironment> &
  ContextWithConfig;

interface ScanServices {
  isbEventBridge: IsbEventBridgeClient;
  leaseStore: LeaseStore;
  costHistory: CostHistoryServices & {
    costHistoryStore: LeaseCostHistoryStore;
  };
}

/** What one run learned about a lease before thresholds are evaluated. */
interface LeaseObservation {
  /**
   * This run's billed total. `totalCostAccrued`, the breach rows' billed total,
   * and the `maxSpend` and threshold checks use it as is.
   */
  billedCostAccrued: number;
  /** Timestamp of the newest `COST` row after any append this run; undefined where none is known. */
  newestObservedAt: string | undefined;
  /** Whether a row was appended this run, because the total moved. */
  appended: boolean;
  /** Per-service totals of the newest row and the one before it, for the insight. */
  newestBreakdown: Record<string, number> | undefined;
  previousBreakdown: Record<string, number> | undefined;
  /** Rates and the projection, where the lease opted in and the series allowed one. */
  projection: RunProjection | null;
  hoursToBudgetExhaustion: number | null;
}

export async function performAccountMonitoringScan(
  _event: EventBridgeEvent<string, unknown>,
  context: ScanContext,
): Promise<string> {
  const costExplorerService = IsbServices.costExplorer(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const leaseStore = IsbServices.leaseStore(context.env);
  const services: ScanServices = {
    isbEventBridge: IsbServices.isbEventBridge(context.env),
    leaseStore,
    costHistory: {
      costHistoryStore: IsbServices.leaseCostHistoryStore(context.env),
      logger,
    },
  };

  // A lease frozen between the two queries comes back from both; it is
  // processed once. The Frozen query runs second, so a tie keeps its copy.
  const monitoredLeases = newestCopyOfEachLease([
    ...(await collect(
      stream(leaseStore, leaseStore.findByStatus, {
        status: "Active",
      }),
    )),
    ...(await collect(
      stream(leaseStore, leaseStore.findByStatus, {
        status: "Frozen",
      }),
    )),
  ] as PersistedMonitoredLease[]);
  logger.debug(
    `Running cost monitoring for ${JSON.stringify(
      monitoredLeases.map((lease) => [lease.awsAccountId, lease.uuid]),
    )}`,
  );

  const currentDateTime = now();
  const anchors = await readAnchors(monitoredLeases, services);
  const sources = await readCostSources(
    costExplorerService,
    monitoredLeases,
    anchors,
    currentDateTime,
    context.globalConfig.leases.serviceBreakdownEnabled,
  );
  const tokenSources = await readTokenSources(
    costExplorerService,
    monitoredLeases,
    anchors,
    sources,
    currentDateTime,
  );

  let eventCount = 0;
  for (const lease of monitoredLeases) {
    // Each lease is observed, evaluated, persisted and published on its own,
    // so a failure part-way through the scan leaves earlier leases complete
    // and later ones untouched for the next run.
    eventCount += await processLease({
      lease,
      anchor: anchors.get(lease.uuid)!,
      source: sources.get(lease.uuid)!,
      tokens: tokenSources.get(lease.uuid)!,
      currentDateTime,
      retentionDays: context.globalConfig.leases.ttl,
      services,
    });
  }

  return `completed lease monitoring scan for ${monitoredLeases.length} leases and generated ${eventCount} events`;
}

type Anchor = NewestRecordResult<CostObservation>;

/**
 * Each lease's newest stored observation, read once: it sizes the query window
 * and anchors the reading. A read that throws is recorded as null, so that one
 * lease resumes from its start and still gets reported-cost enforcement
 * instead of ending the scan for the fleet.
 */
async function readAnchors(
  leases: PersistedMonitoredLease[],
  services: ScanServices,
): Promise<Map<string, Anchor | null>> {
  const anchors = new Map<string, Anchor | null>();
  for (const lease of leases) {
    try {
      anchors.set(
        lease.uuid,
        await services.costHistory.costHistoryStore.getNewestCostObservation(
          lease.uuid,
        ),
      );
    } catch (error) {
      logger.error(
        `newest cost observation read failed for lease ${lease.uuid}; continuing without an anchor`,
        {
          ...searchableLeaseProperties(lease),
          error: error instanceof Error ? error : String(error),
        },
      );
      anchors.set(lease.uuid, null);
    }
  }
  return anchors;
}

/**
 * The tag-grouped daily query, resumed from the fleet's earliest anchor day, for
 * every lease it covers; the legacy account query for the rest. A lease absent
 * from the tag report never received its tag, or has no tagged spend yet, and
 * is re-summed from its start by account.
 */
async function readCostSources(
  costExplorerService: CostExplorerService,
  leases: PersistedMonitoredLease[],
  anchors: Map<string, Anchor | null>,
  currentDateTime: DateTime<true>,
  includeServiceBreakdown: boolean,
): Promise<Map<string, LeaseCostSource>> {
  const sources = new Map<string, LeaseCostSource>();
  if (leases.length === 0) {
    return sources;
  }

  const dailyReport = await costExplorerService.getDailyCostForLeasesByTag(
    leases,
    queryWindowStart(leases, anchors),
    currentDateTime,
    { includeServiceBreakdown },
  );

  const fallbackLeases: PersistedMonitoredLease[] = [];
  for (const lease of leases) {
    const buckets = dailyReport.buckets[lease.uuid];
    if (buckets === undefined) {
      fallbackLeases.push(lease);
    } else {
      sources.set(lease.uuid, { kind: "TAG", buckets });
    }
  }
  if (fallbackLeases.length === 0) {
    return sources;
  }
  // Emitted per run, not per lease: the count is the signal and one record per
  // run keeps a fleet-wide tag outage from filling the log group.
  logger.warn(
    `${fallbackLeases.length} of ${leases.length} monitored leases are absent from the tag-grouped cost report; re-summing their spend by account`,
    {
      logDetailType: "LeaseCostFallback",
      fallbackLeaseCount: fallbackLeases.length,
      monitoredLeaseCount: leases.length,
    },
  );

  // prettier-ignore
  const fallbackReport = await costExplorerService.getCostForLeases( // NOSONAR typescript:S1874: Preserve spend tracking for leases absent from the tag-grouped report.
    Object.fromEntries(
      fallbackLeases.map((lease) => [
        lease.awsAccountId,
        DateTime.fromISO(lease.startDate, { zone: "utc" }),
      ]),
    ),
    currentDateTime,
  );
  for (const lease of fallbackLeases) {
    sources.set(lease.uuid, {
      kind: "FALLBACK",
      billedCostAccrued: fallbackReport.getCost(lease.awsAccountId),
    });
  }
  return sources;
}

/** The fleet's earliest anchor day; the main Cost Explorer query resumes from it. */
function queryWindowStart(
  leases: PersistedMonitoredLease[],
  anchors: Map<string, Anchor | null>,
): DateTime<true> {
  return costQueryWindowStart(queryAnchors(leases, anchors))!;
}

/** Where the token query resumes: as above, but for the slice each lease carries. */
function tokenQueryWindowStart(
  leases: PersistedMonitoredLease[],
  anchors: Map<string, Anchor | null>,
): DateTime<true> {
  return bedrockTokenQueryWindowStart(queryAnchors(leases, anchors))!;
}

function queryAnchors(
  leases: PersistedMonitoredLease[],
  anchors: Map<string, Anchor | null>,
) {
  return leases.map((lease) => ({
    startDate: lease.startDate,
    newest: anchorRow(anchors.get(lease.uuid)),
  }));
}

/**
 * Marks a monitored lease whose token query failed this run. Its cost row is
 * withheld so the anchor holds: a row written without the slice would move
 * the anchor day past token spend the next run could no longer re-read.
 */
const TOKEN_SLICE_UNAVAILABLE = Object.freeze({ unavailable: true as const });

/** A lease's token slice: null where it is not monitored, unavailable where the query failed. */
type TokenSlice = BedrockTokenSource | null | typeof TOKEN_SLICE_UNAVAILABLE;

const isUnavailable = (
  slice: TokenSlice,
): slice is typeof TOKEN_SLICE_UNAVAILABLE => slice === TOKEN_SLICE_UNAVAILABLE;

/**
 * The token-priced Bedrock slice for every lease, from one usage-type query
 * from the earliest day a tag-served monitored lease resumes its slice from,
 * issued only when some monitored lease was served by tag so a deployment
 * that never opted in never pays for it. A monitored lease the fallback served
 * is absent from that query as it is from the main one, so its slice comes
 * from a second query grouped by account, issued only when there is such a
 * lease. A failed query leaves every monitored lease it serves unavailable for
 * the run; the reported total and its enforcement are unaffected.
 */
async function readTokenSources(
  costExplorerService: CostExplorerService,
  leases: PersistedMonitoredLease[],
  anchors: Map<string, Anchor | null>,
  sources: Map<string, LeaseCostSource>,
  currentDateTime: DateTime<true>,
): Promise<Map<string, TokenSlice>> {
  const monitored = leases.filter(
    (lease) => lease.bedrockTokenMonitoringEnabled,
  );
  const fallbackServed = monitored.filter(
    (lease) => sources.get(lease.uuid)?.kind === "FALLBACK",
  );
  // A lease the fallback served is absent from the tag-grouped report, so it has
  // nothing to read from the tag-grouped token query either.
  const tagServed = monitored.filter(
    (lease) => !fallbackServed.includes(lease),
  );
  let report: BedrockTokenCostReport | undefined;
  if (tagServed.length > 0) {
    try {
      report = await costExplorerService.getBedrockTokenCostByLease(
        tagServed,
        tokenQueryWindowStart(tagServed, anchors),
        currentDateTime,
      );
    } catch (error) {
      logger.error(
        "Bedrock token cost query failed; the tag-served monitored leases keep their anchors and write no cost row this run",
        {
          leaseIds: tagServed.map((lease) => lease.uuid),
          error: error instanceof Error ? error : String(error),
        },
      );
    }
  }
  const accountReport = await readFallbackTokenCost(
    costExplorerService,
    fallbackServed,
    currentDateTime,
  );
  return new Map(
    leases.map((lease) => [
      lease.uuid,
      tokenSlice(lease, sources.get(lease.uuid)!, report, accountReport),
    ]),
  );
}

/**
 * The account-grouped slice for the monitored leases the fallback served, from
 * the earliest of their start days, since each is re-summed from its own start
 * day as its total is. Undefined where there is no such lease or the query
 * failed.
 */
async function readFallbackTokenCost(
  costExplorerService: CostExplorerService,
  leases: PersistedMonitoredLease[],
  currentDateTime: DateTime<true>,
): Promise<BedrockTokenCostReport | undefined> {
  if (leases.length === 0) {
    return undefined;
  }
  try {
    return await costExplorerService.getBedrockTokenCostByAccount(
      leases.map((lease) => lease.awsAccountId),
      DateTime.min(
        ...leases.map((lease) =>
          DateTime.fromISO(lease.startDate, { zone: "utc" }).startOf("day"),
        ),
      )!,
      currentDateTime,
    );
  } catch (error) {
    logger.error(
      "Bedrock token cost query by account failed; the fallback-served monitored leases keep their anchors and write no cost row this run",
      {
        leaseIds: leases.map((lease) => lease.uuid),
        error: error instanceof Error ? error : String(error),
      },
    );
    return undefined;
  }
}

/** A fallback-served lease's slice is keyed by its account, the way its total was read. */
function tokenSlice(
  lease: PersistedMonitoredLease,
  source: LeaseCostSource,
  report: BedrockTokenCostReport | undefined,
  accountReport: BedrockTokenCostReport | undefined,
): TokenSlice {
  if (!lease.bedrockTokenMonitoringEnabled) {
    return null;
  }
  const [served, key] =
    source.kind === "FALLBACK"
      ? [accountReport, lease.awsAccountId]
      : [report, lease.uuid];
  if (served === undefined) {
    return TOKEN_SLICE_UNAVAILABLE;
  }
  return { costByDay: served.costByDay(key) };
}

function anchorRow(
  anchor: Anchor | null | undefined,
): CostObservation | undefined {
  return anchor?.complete ? anchor.result : undefined;
}

async function processLease(props: {
  lease: PersistedMonitoredLease;
  anchor: Anchor | null;
  source: LeaseCostSource;
  tokens: TokenSlice;
  currentDateTime: DateTime<true>;
  retentionDays: number;
  services: ScanServices;
}): Promise<number> {
  const { lease, currentDateTime, services } = props;
  const observation = await observeLease(props);
  const { billedCostAccrued } = observation;

  const terminal = terminalEvent(lease, billedCostAccrued, currentDateTime);
  await recordMaxSpendBreach(props, billedCostAccrued);
  await recordExpiryBreach(props, terminal, billedCostAccrued);
  const { events, evaluation } =
    terminal === null
      ? await spendingControlEvents(props, observation)
      : { events: [terminal], evaluation: null };

  if (events.length === 0) {
    logger.info(`no new lease events detected for lease ${lease.uuid}`, {
      ...searchableLeaseProperties(lease),
    });
  } else {
    await services.isbEventBridge.sendIsbEvents(tracer, ...events);
  }

  await writeLeaseRecord(
    lease,
    observation,
    evaluation,
    currentDateTime,
    services,
  );
  return events.length;
}

/**
 * Records this run's reading and, where the lease opted in, the rates and
 * projection derived from its series. Fails open: a cost-history error never
 * stops reported-cost enforcement for this lease or the rest of the scan. The
 * enforcement figure comes from what Cost Explorer reported this run, so a
 * failed append or an unreadable anchor delays nothing; only the row, the
 * rates and the projection are given up.
 */
async function observeLease(props: {
  lease: PersistedMonitoredLease;
  anchor: Anchor | null;
  source: LeaseCostSource;
  tokens: TokenSlice;
  currentDateTime: DateTime<true>;
  retentionDays: number;
  services: ScanServices;
}): Promise<LeaseObservation> {
  const {
    lease,
    anchor,
    source,
    tokens,
    currentDateTime,
    retentionDays,
    services,
  } = props;
  const anchorObservation = anchorRow(anchor);
  const reading = {
    lease,
    source,
    predictedCostAtRefresh: priorProjection(lease),
    // The slice never enters the billed figure; null here only satisfies the
    // input type. An unavailable slice withholds the row below.
    bedrockTokens: isUnavailable(tokens) ? null : tokens,
    retentionDays,
  };
  const sourceFigure = sourceBilledCostAccrued(reading, anchorObservation);
  const unobserved: LeaseObservation = {
    billedCostAccrued: sourceFigure,
    newestObservedAt: observedAt(anchorObservation),
    appended: false,
    newestBreakdown: anchorObservation?.serviceBreakdown,
    previousBreakdown: undefined,
    projection: null,
    hoursToBudgetExhaustion: null,
  };
  if (anchor === null || isUnavailable(tokens)) {
    return unobserved;
  }
  try {
    // The series is read before the append so the new row can be placed on it
    // without depending on a read-after-write of the same table.
    const series = lease.predictiveBudgetEnabled
      ? await readSeries(lease, services)
      : [];
    // The observation is recorded for every monitored lease; the opt-in
    // governs prediction, not recording.
    const recorded = await recordCostObservation(
      { ...reading, anchor },
      services.costHistory,
    );
    return observationFrom(
      lease,
      recorded,
      sourceFigure,
      anchorObservation,
      series,
      currentDateTime,
    );
  } catch (error) {
    logger.error(
      `cost-history recording failed for lease ${lease.uuid}; continuing scan`,
      {
        ...searchableLeaseProperties(lease),
        error: error instanceof Error ? error : String(error),
      },
    );
    return unobserved;
  }
}

/**
 * The projection standing before this reading re-bases it. A stored figure
 * with no rate behind it is the spend so far, carried as a placeholder, not a
 * projection, so the row records null for it.
 */
function priorProjection(lease: PersistedMonitoredLease): number | null {
  if (
    lease.lastEvaluatedHourlySpendRate == null &&
    lease.lastEvaluatedDailySpendRate == null
  ) {
    return null;
  }
  return lease.lastPredictedSpend ?? null;
}

/**
 * The figure this run stands on, taken from Cost Explorer alone: the account
 * total for a fallback-served lease, the anchored re-sum for a tag-served one.
 * Falls back to the stored total only if the reading itself cannot be built.
 */
function sourceBilledCostAccrued(
  reading: Omit<RecordCostObservationInput, "anchor">,
  anchor: CostObservation | undefined,
): number {
  if (reading.source.kind === "FALLBACK") {
    return reading.source.billedCostAccrued;
  }
  try {
    return (
      buildCostObservation(reading, anchor)?.billedCostAccrued ??
      reading.lease.totalCostAccrued
    );
  } catch (error) {
    logger.warn(
      `cost observation build failed for lease ${reading.lease.uuid}; using stored total`,
      {
        ...searchableLeaseProperties(reading.lease),
        error: error instanceof Error ? error : String(error),
      },
    );
    return reading.lease.totalCostAccrued;
  }
}

/** The observation series, or none: a failed read costs the rate, never the row or the enforcement. */
async function readSeries(
  lease: PersistedMonitoredLease,
  services: ScanServices,
): Promise<RecentObservationPoint[]> {
  try {
    return (
      await getRecentObservations(
        { leaseUuid: lease.uuid, hoursBack: OBSERVATION_LOOKBACK_HOURS },
        services.costHistory,
      )
    ).points;
  } catch (error) {
    logger.warn(
      `observation series read failed for lease ${lease.uuid}; no rate this run`,
      {
        ...searchableLeaseProperties(lease),
        error: error instanceof Error ? error : String(error),
      },
    );
    return [];
  }
}

function observationFrom(
  lease: PersistedMonitoredLease,
  recorded: RecordCostObservationResult,
  sourceFigure: number,
  anchor: CostObservation | undefined,
  series: RecentObservationPoint[],
  currentDateTime: DateTime<true>,
): LeaseObservation {
  const evaluatedAt = currentDateTime.toISO();
  const appended = recorded.status === "APPENDED";
  const billedCostAccrued = figureFrom(recorded) ?? sourceFigure;
  const newestBreakdown = appended
    ? recorded.observation.serviceBreakdown
    : anchor?.serviceBreakdown;
  const previousBreakdown = appended
    ? anchor?.serviceBreakdown
    : series[1]?.serviceBreakdown;
  const newestObservedAt = appended ? evaluatedAt : observedAt(anchor);

  const base: LeaseObservation = {
    billedCostAccrued,
    newestObservedAt,
    appended,
    newestBreakdown,
    previousBreakdown,
    projection: null,
    hoursToBudgetExhaustion: null,
  };
  // A readable series always carries the anchor row, so an anchor with no
  // series means the read was withheld; an unreadable anchor withholds it too.
  // Neither is "no history": projecting from it would write the billed total
  // over the stored figure and re-arm every fired threshold.
  const seriesWithheld =
    recorded.status === "ANCHOR_UNREADABLE" ||
    (anchor !== undefined && series.length === 0);
  if (!lease.predictiveBudgetEnabled || seriesWithheld) {
    return base;
  }

  const priorRates = computeSpendRates(series);
  const currentSeries = appended
    ? [{ timestamp: evaluatedAt, billedCostAccrued }, ...series]
    : series;
  const rates = computeSpendRates(currentSeries);
  const newest = currentSeries[0];
  const projection = computeProjection({
    projectionAnchorCost: newest?.billedCostAccrued ?? billedCostAccrued,
    lastReportedAt: newest?.timestamp ?? evaluatedAt,
    evaluatedAt,
    rates,
    recentIntervalHours: rates.hourlyRateWindowHours,
  });
  logSpendRate(lease, rates, appended);
  if (appended && anchor !== undefined) {
    logProjectionAccuracy(
      lease,
      anchor,
      billedCostAccrued,
      priorRates,
      evaluatedAt,
    );
  }
  return {
    ...base,
    projection: {
      predictedCost: projection.predictedCost,
      rateSource: projection.rateSource,
      rates,
    },
    hoursToBudgetExhaustion: computeTimeToExhaustion({
      maxSpend: lease.maxSpend,
      predictedCost: projection.predictedCost,
      ratePerHour: projectionRatePerHour(rates)?.ratePerHour ?? null,
    }),
  };
}

/** The cumulative figure this run stands on, or undefined when nothing could be observed. */
function figureFrom(recorded: RecordCostObservationResult): number | undefined {
  switch (recorded.status) {
    case "APPENDED":
      return recorded.observation.billedCostAccrued;
    case "UNCHANGED":
    case "NO_DATA":
      return recorded.billedCostAccrued;
    case "ANCHOR_UNREADABLE":
      return undefined;
  }
}

function observedAt(row: CostObservation | undefined): string | undefined {
  return row?.sk.slice(COST_SK_PREFIX.length);
}

function logSpendRate(
  lease: PersistedMonitoredLease,
  rates: SpendRates,
  costExplorerRefreshed: boolean,
): void {
  logger.info(`spend rates computed for lease ${lease.uuid}`, {
    ...searchableLeaseProperties(lease),
    logDetailType: "SpendRateComputed",
    hourlyRate: rates.hourlyRate,
    dailyRate: rates.dailyRate,
    rateUnavailable: rates.hourlyRate === null && rates.dailyRate === null,
    costExplorerRefreshed,
  } satisfies SubscribableLog);
}

/**
 * How far the projection from the previous reading missed the one that just
 * arrived: the anchor's total carried forward at its rate, cap included, less
 * the new total. Differenced on the rate term alone, so the figure stays a
 * statement about the rate rather than about anything measured elsewhere.
 */
function logProjectionAccuracy(
  lease: PersistedMonitoredLease,
  anchor: CostObservation,
  billedCostAccrued: number,
  priorRates: SpendRates,
  evaluatedAt: string,
): void {
  const anchoredAt = observedAt(anchor);
  if (anchoredAt === undefined) {
    return;
  }
  const intervalHours = DateTime.fromISO(evaluatedAt, { zone: "utc" }).diff(
    DateTime.fromISO(anchoredAt, { zone: "utc" }),
    "hours",
  ).hours;
  if (!Number.isFinite(intervalHours) || intervalHours < 0) {
    return;
  }
  const projection = computeProjection({
    projectionAnchorCost: anchor.billedCostAccrued,
    lastReportedAt: anchoredAt,
    evaluatedAt,
    rates: priorRates,
    recentIntervalHours: priorRates.hourlyRateWindowHours,
  });
  if (projection.rateSource === null) {
    return;
  }
  const errorDollars = projection.predictedCost - billedCostAccrued;
  logger.info(`projection accuracy for lease ${lease.uuid}`, {
    ...searchableLeaseProperties(lease),
    logDetailType: "ProjectionAccuracy",
    predictedCost: projection.predictedCost,
    billedCostAccrued,
    errorDollars,
    errorPercent:
      billedCostAccrued === 0 ? null : (errorDollars / billedCostAccrued) * 100,
    intervalHours,
    rateSource: projection.rateSource,
    algorithmId: PROJECTION_ALGORITHM_ID,
  } satisfies SubscribableLog);
}

/**
 * `maxSpend` termination and expiry clobber every other event. `spend` is this
 * run's billed total.
 */
function terminalEvent(
  lease: PersistedMonitoredLease,
  spend: number,
  currentDateTime: DateTime<true>,
): IsbEvent | null {
  if (lease.maxSpend !== undefined && spend >= lease.maxSpend) {
    logger.info(
      `Lease (${lease.uuid}) budget exceeded, sending message to ISB bus`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    return new LeaseBudgetExceededAlert({
      leaseId: {
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      },
      accountId: lease.awsAccountId,
      budget: lease.maxSpend,
      totalSpend: spend,
      detectedBy: "LEASE_MONITORING",
    });
  }
  if (isExpired(lease, currentDateTime)) {
    logger.info(`Lease (${lease.uuid}) expired, sending message to ISB bus`, {
      ...searchableLeaseProperties(lease),
    });
    return new LeaseExpiredAlert({
      leaseId: {
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      },
      accountId: lease.awsAccountId,
      leaseExpirationDate: lease.expirationDate,
    });
  }
  return null;
}

/**
 * The audit row for a run over `maxSpend`. The termination is sent on every
 * such run, but the row only where the lease's breach history holds none at
 * this cap, so a termination that has not landed adds no row each hour, and
 * neither does one the token poll already recorded. Best effort and written
 * before the event, as the threshold rows are.
 */
async function recordMaxSpendBreach(
  props: {
    lease: PersistedMonitoredLease;
    retentionDays: number;
    services: ScanServices;
  },
  billedCostAccrued: number,
): Promise<void> {
  const { lease } = props;
  if (lease.maxSpend === undefined || billedCostAccrued < lease.maxSpend) {
    return;
  }
  const maxSpend = lease.maxSpend;
  await writeBreachRows(lease, () =>
    persistMaxSpendBreach(
      {
        leaseUuid: lease.uuid,
        billedCostAtFire: billedCostAccrued,
        evaluator: { evaluatedBy: "LEASE_MONITORING" },
        maxSpend,
        comparedCost: billedCostAccrued,
        leaseStartDate: lease.startDate,
        ttl: breachRowTtl(props),
      },
      { costHistoryStore: props.services.costHistory.costHistoryStore, logger },
    ),
  );
}

/**
 * The audit row for a run that finds the lease's end passed, where the expiry
 * is what the run sends: a lease also over `maxSpend` records that breach
 * instead. The expiry is sent on every such run, but the row only where the
 * lease's breach history holds none since that end, so a termination that has
 * not landed adds no row each hour. Best effort and written before the event,
 * as the threshold rows are.
 */
async function recordExpiryBreach(
  props: {
    lease: PersistedMonitoredLease;
    retentionDays: number;
    services: ScanServices;
  },
  terminal: IsbEvent | null,
  billedCostAccrued: number,
): Promise<void> {
  if (!(terminal instanceof LeaseExpiredAlert)) {
    return;
  }
  const { lease } = props;
  await writeBreachRows(lease, () =>
    persistExpiryBreach(
      {
        leaseUuid: lease.uuid,
        expirationDate: terminal.Detail.leaseExpirationDate,
        billedCostAtFire: billedCostAccrued,
        ttl: breachRowTtl(props),
      },
      { costHistoryStore: props.services.costHistory.costHistoryStore, logger },
    ),
  );
}

/**
 * Breach rows are best effort: the crossing is already signaled by the event,
 * so a failed write is logged and the run publishes without its row.
 */
async function writeBreachRows(
  lease: PersistedMonitoredLease,
  write: () => Promise<unknown>,
): Promise<void> {
  try {
    await write();
  } catch (error) {
    logger.error(
      `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
      {
        ...searchableLeaseProperties(lease),
        error: error instanceof Error ? error : String(error),
      },
    );
  }
}

/** A breach row expires with the lease's cost observations. */
function breachRowTtl(props: {
  lease: PersistedMonitoredLease;
  retentionDays: number;
}): number {
  const { lease } = props;
  return calculateCostHistoryTtl({
    retentionDays: props.retentionDays,
    expirationDate: lease.expirationDate,
    startDate: lease.startDate,
    leaseDurationInHours: lease.leaseDurationInHours,
  });
}

/**
 * Spending controls (dollar thresholds and spend-rate limits) through the
 * shared evaluator, and duration thresholds. A spending-control freeze
 * outranks a duration freeze, and at most one spending-control event of each
 * kind is published per run while every breach is recorded, duration
 * thresholds included, except a dollar freeze another evaluator already
 * recorded at the same threshold. On a lease with Bedrock token monitoring on the
 * token poll owns every dollar threshold and the de-duplication scalars, so
 * nothing is evaluated here; the rates and projection were still computed for
 * the row and the metrics.
 */
async function spendingControlEvents(
  props: {
    lease: PersistedMonitoredLease;
    currentDateTime: DateTime<true>;
    retentionDays: number;
    services: ScanServices;
  },
  observation: LeaseObservation,
): Promise<{
  events: IsbEvent[];
  evaluation: SpendingControlsEvaluation | null;
}> {
  const { lease, currentDateTime, services } = props;
  const duration = durationEvents(lease, currentDateTime);
  // Written before the events for the reason the budget rows below are.
  if (duration.breached.length > 0) {
    await writeBreachRows(lease, () =>
      persistDurationBreaches(
        {
          leaseUuid: lease.uuid,
          billedCostAtFire: observation.billedCostAccrued,
          thresholds: duration.breached,
          ttl: breachRowTtl(props),
        },
        services.costHistory,
      ),
    );
  }
  const evaluation = lease.bedrockTokenMonitoringEnabled
    ? null
    : evaluateSpendingControls({
        lease,
        evaluatedSpend: observation.billedCostAccrued,
        projection: observation.projection,
      });
  if (evaluation === null || evaluation.breaches.length === 0) {
    return {
      events: [duration.freeze, duration.alert].filter(isEvent),
      evaluation,
    };
  }

  const insight = selectBreachInsight({
    newestBreakdown: observation.newestBreakdown,
    previousBreakdown: observation.previousBreakdown,
    billedCostAccrued: observation.billedCostAccrued,
  });
  // The audit rows are best effort: the crossing is already signalled by the
  // event and the log record below, and advancing the lease's figures keeps it
  // from being re-evaluated and re-written every run. They are written before
  // the event and the lease record deliberately: if a later write fails, the
  // scalar stays put and the next run repeats this row, which is visible and
  // reconcilable by timestamp and threshold. Writing them afterwards would
  // lose the row for good once the scalar had advanced. The `BREACH#` key is
  // wall-clock derived, so the append cannot be made idempotent from here.
  await writeBreachRows(lease, () =>
    persistBreachRecords(
      {
        leaseUuid: lease.uuid,
        billedCostAtFire: observation.billedCostAccrued,
        evaluator: { evaluatedBy: "LEASE_MONITORING" },
        breaches: evaluation.breaches,
        insight,
        ttl: breachRowTtl(props),
      },
      services.costHistory,
    ),
  );
  for (const breach of evaluation.breaches) {
    logThresholdFired(lease, breach, observation, currentDateTime);
  }

  const selection = selectSpendingControlEvents({
    lease,
    billedCostAccrued: observation.billedCostAccrued,
    breaches: evaluation.breaches,
    insight,
    context: {
      hoursToBudgetExhaustion: observation.hoursToBudgetExhaustion,
      lastReportedAt: observation.newestObservedAt,
    },
  });
  return {
    events: [
      selection.freeze ?? duration.freeze,
      selection.alert,
      duration.alert,
    ].filter(isEvent),
    evaluation,
  };
}

function isEvent(event: IsbEvent | null): event is IsbEvent {
  return event !== null;
}

function logThresholdFired(
  lease: PersistedMonitoredLease,
  breach: ThresholdBreach,
  observation: LeaseObservation,
  currentDateTime: DateTime<true>,
): void {
  const hoursSinceLastRefresh =
    observation.newestObservedAt === undefined
      ? null
      : currentDateTime.diff(
          DateTime.fromISO(observation.newestObservedAt, { zone: "utc" }),
          "hours",
        ).hours;
  logger.info(
    `Lease (${lease.uuid}) ${breach.triggeredBy} threshold crossed, ${breach.action}`,
    {
      ...searchableLeaseProperties(lease),
      // Like the breach row, this holds the billed total.
      ...thresholdFiredLog(breach, {
        evaluatedBy: "LEASE_MONITORING",
        billedCostAccrued: observation.billedCostAccrued,
        hoursSinceLastRefresh,
        costAtFreezeDecision: observation.billedCostAccrued,
      }),
    } satisfies SubscribableLog,
  );
}

/**
 * Writes only the fields this Lambda owns. The lease was read at scan start,
 * and other writers (freeze, termination, locks, admin edits) may have changed
 * it since, so writing the whole item would revert them. Where Bedrock token
 * monitoring is off the de-duplication scalars from this run's evaluation are
 * written too; where it is on, the poll owns them.
 */
async function writeLeaseRecord(
  lease: PersistedMonitoredLease,
  observation: LeaseObservation,
  evaluation: SpendingControlsEvaluation | null,
  currentDateTime: DateTime<true>,
  services: ScanServices,
): Promise<void> {
  const costScalars = {
    leaseId: lease.uuid,
    userEmail: lease.userEmail,
    totalCostAccrued: observation.billedCostAccrued,
    lastCheckedDate: currentDateTime.toISO(),
  };
  if (lease.bedrockTokenMonitoringEnabled) {
    await services.leaseStore.updateMonitoringCostFields(costScalars);
    return;
  }
  await services.leaseStore.updateMonitoringOwnedFields({
    ...costScalars,
    lastEvaluatedSpend: nextLastEvaluatedSpend(lease, evaluation),
    ...(evaluation !== null && observation.projection !== null
      ? {
          projection: {
            lastPredictedSpend: evaluation.lastPredictedSpend,
            lastEvaluatedHourlySpendRate:
              evaluation.lastEvaluatedHourlySpendRate,
            lastEvaluatedDailySpendRate: evaluation.lastEvaluatedDailySpendRate,
          },
        }
      : {}),
  });
}

/**
 * The figure the next check compares against. A run that checks nothing keeps
 * it; while no figure is stored, that is the billed total from before this
 * run, which the new total would otherwise replace. A stored figure above the
 * stored bill is one the token poll wrote before Bedrock token monitoring was
 * switched off, ahead of the bill by the monitored Bedrock term. It is
 * kept until the bill catches up, because storing the lower bill would re-arm
 * thresholds the poll already fired. This Lambda's own figure equals the bill
 * it stores beside it, so a bill that falls still re-arms them.
 */
function nextLastEvaluatedSpend(
  lease: PersistedMonitoredLease,
  evaluation: SpendingControlsEvaluation | null,
): number {
  const stored = lease.lastEvaluatedSpend;
  const evaluated =
    evaluation?.lastEvaluatedSpend ?? stored ?? lease.totalCostAccrued;
  if (stored != null && stored > lease.totalCostAccrued) {
    return Math.max(evaluated, stored);
  }
  return evaluated;
}

function isExpired(
  lease: PersistedMonitoredLease,
  currentDate: DateTime,
): lease is PersistedMonitoredLease & { expirationDate: string } {
  return (
    lease.expirationDate !== undefined &&
    DateTime.fromISO(lease.expirationDate, { zone: "utc" }) < currentDate
  );
}

/** Every duration threshold newly reached this run, and the freeze and alert they request. */
function durationEvents(
  lease: PersistedMonitoredLease,
  currentDateTime: DateTime<true>,
): {
  breached: BreachedDurationThreshold[];
  freeze: IsbEvent | null;
  alert: IsbEvent | null;
} {
  const breached = detectNewlyBreachedDurationThresholds(
    lease,
    currentDateTime,
  );
  const eligibleBreaches =
    lease.status === "Active"
      ? breached
      : breached.filter((threshold) => threshold.action !== "FREEZE_ACCOUNT");
  const latest = getLatestDurationThreshold(eligibleBreaches);
  const freezing = eligibleBreaches.find(
    (threshold) => threshold.action === "FREEZE_ACCOUNT",
  );
  let freeze: IsbEvent | null = null;
  if (freezing) {
    logger.info(
      `Lease (${lease.uuid}) freezing duration threshold crossed ` +
        `(threshold: ${freezing.hoursRemaining} hours remaining) ` +
        `requesting freeze`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    freeze = new LeaseFreezingThresholdBreachedAlert({
      leaseId: {
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      },
      accountId: lease.awsAccountId,
      reason: {
        type: "Expired",
        triggeredDurationThreshold: freezing.hoursRemaining,
        leaseDurationInHours: lease.leaseDurationInHours!,
      },
    });
  }
  let alert: IsbEvent | null = null;
  if (latest && latest.action != "FREEZE_ACCOUNT") {
    logger.info(
      `Lease (${lease.uuid}) duration threshold crossed ` +
        `(threshold: ${latest.hoursRemaining} hours remaining) ` +
        `sending message to ISB bus`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    alert = new LeaseDurationThresholdBreachedAlert({
      leaseId: {
        userEmail: lease.userEmail,
        uuid: lease.uuid,
      },
      accountId: lease.awsAccountId,
      triggeredDurationThreshold: latest.hoursRemaining,
      leaseDurationInHours: Math.round(
        DateTime.fromISO(
          lease.expirationDate!, // NOSONAR typescript:S4325 -- required by tsc; threshold detector guarantees expiration, persisted type keeps it optional
          { zone: "utc" },
        ).diff(DateTime.fromISO(lease.startDate, { zone: "utc" }), "hour")
          .hours,
      ),
      actionRequested: latest.action,
    });
  }
  return { breached, freeze, alert };
}

function detectNewlyBreachedDurationThresholds(
  lease: PersistedMonitoredLease,
  currentDate: DateTime,
) {
  const leaseExpirationDate = lease.expirationDate;
  if (leaseExpirationDate === undefined) {
    return [];
  }
  const newlyExceededThresholds: BreachedDurationThreshold[] = [];
  const expirationDate = DateTime.fromISO(leaseExpirationDate, {
    zone: "utc",
  });
  const lastCheckedDate = DateTime.fromISO(lease.lastCheckedDate, {
    zone: "utc",
  });

  for (const durationThreshold of lease.durationThresholds ?? []) {
    const thresholdDate = expirationDate.minus({
      hours: durationThreshold.hoursRemaining,
    });

    if (
      lastCheckedDate < thresholdDate && //newly exceeded
      thresholdDate <= currentDate
    ) {
      newlyExceededThresholds.push({
        ...durationThreshold,
        leaseExpirationDate,
      });
    }
  }

  return newlyExceededThresholds;
}

function getLatestDurationThreshold(durationThresholds: DurationThreshold[]) {
  if (durationThresholds.length == 0) {
    return undefined;
  }
  return durationThresholds.reduce(
    (prev, current) =>
      prev.hoursRemaining < current.hoursRemaining ? prev : current,
    durationThresholds[0]!, // NOSONAR typescript:S4325 -- required by tsc under noUncheckedIndexedAccess; non-empty check above guarantees it
  );
}

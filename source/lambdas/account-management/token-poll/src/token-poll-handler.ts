// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { parse as parseArn } from "@aws-sdk/util-arn-parser";
import { Context, EventBridgeEvent } from "aws-lambda";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";

import { COST_SK_PREFIX } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import { LeaseCostHistoryStore } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BedrockTokenRow,
  calculateCostHistoryTtl,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { newestCopyOfEachLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import {
  createRegionalPriceLookup,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import {
  accumulateTokenUsage,
  BedrockPricing,
  BedrockRateSource,
  BedrockWindowCost,
  BilledObservationPoint,
  computeLeaseFigures,
  createBedrockPricing,
  forEachBounded,
  LeaseFigures,
  listLinkedAccounts,
  MissingSinkError,
  parseSinkIds,
  priceTokens,
  readRegionTokenUsage,
  RegionTokenUsage,
  sinkArn,
  subtractTokens,
  TokenUsageLease,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";
import {
  evaluatePredictedThresholds,
  evaluateRateCaps,
  evaluateReportedThresholds,
  persistBreachRecords,
  persistMaxSpendBreach,
  selectComparedSpendInsight,
  selectSpendingControlEvents,
  ServiceBreakdown,
  SpendingControlsEvaluation,
  ThresholdBreach,
  thresholdFiredLog,
} from "@amzn/innovation-sandbox-commons/isb-services/budget-threshold/index.js";
import {
  getRecentObservations,
  OBSERVATION_LOOKBACK_HOURS,
  RecentObservations,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  computeTimeToExhaustion,
  projectionRatePerHour,
  RateSource,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/index.js";
import {
  TokenPollEnvironment,
  TokenPollEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/token-poll-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  LogPatterns,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  IsbEvent,
  IsbEventBridgeClient,
} from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { parseDatetime } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { UNATTRIBUTED_MODEL_ID } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import type {
  Lease,
  LeaseStatus,
  MonitoredLease,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { isMonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";

const TOKEN_POLL_CONFIG = {
  STARTING_DELAY: 1000,
  MAX_ATTEMPTS: 5,
};

// Not every monitored status: Provisioning is omitted deliberately, and a plain
// array of the union compiles when incomplete, so the omission would otherwise
// read as a missed case. A provisioning lease's user has no access yet, so there
// is no Bedrock invocation to count, and the counts are cumulative
// lease-to-date, so the run after it turns Active loses nothing. Matches the
// statuses the lease-monitoring scan reads.
const MONITORED_STATUSES: MonitoredLeaseStatus[] = ["Active", "Frozen"];

/**
 * Leases are read and recorded this many at a time. One after another the
 * per-lease phase stops fitting the run's timeout at a few hundred leases.
 */
const PER_LEASE_CONCURRENCY = 16;

/** The windows the monitored Bedrock rates are measured over. */
const BEDROCK_HOURLY_WINDOW = { hours: 1 };
const BEDROCK_DAILY_WINDOW = { hours: 24 };

type PollContext = Context &
  ValidatedEnvironment<TokenPollEnvironment> &
  ContextWithConfig;

interface PollServices {
  leaseStore: LeaseStore;
  costHistoryStore: LeaseCostHistoryStore;
  isbEventBridge: IsbEventBridgeClient;
  rates: BedrockRateSource;
  /** `leases.ttl` from global config, in days. */
  retentionDays: number;
  /** Minutes between scheduled runs. */
  pollIntervalMinutes: number;
}

/** A lease and its newest rows, read once before the metrics so every window starts after the stored anchor. */
interface LeaseState {
  lease: MonitoredLease;
  /** The newest cost observation, or undefined before the first. */
  cost: CostObservation | undefined;
  /** The newest token row, or undefined before the first. */
  previous: BedrockTokenRow | undefined;
}

/** The monitored Bedrock token cost an hour and a day before this run. */
interface BedrockCostsBefore {
  hourAgo: number | null;
  dayAgo: number | null;
}

/** What the rates difference over, read from stored rows. */
interface RateInputs {
  observations: BilledObservationPoint[];
  bedrockCostsBefore: BedrockCostsBefore;
}

const NO_RATE_INPUTS: RateInputs = {
  observations: [],
  bedrockCostsBefore: { hourAgo: null, dayAgo: null },
};

const serviceName = "TokenPoll";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: TokenPollEnvironmentSchema,
  moduleName: "token-poll",
})
  .use(isbConfigMiddleware())
  .handler(pollBedrockTokenUsage);

export async function pollBedrockTokenUsage(
  _event: EventBridgeEvent<string, unknown>,
  context: PollContext,
): Promise<string> {
  const leaseStore = IsbServices.leaseStore(context.env);
  const accountPoolConfigStore = IsbServices.accountPoolStackConfigStore(
    context.env,
  );
  // Deployment-wide inputs, checked before any call so a bad deployment fails
  // on its first run rather than on the first lease that opts in.
  const sinkIds = parseSinkIds(context.env.OAM_SINK_IDS_JSON);
  const { partition, accountId } = parseArn(context.invokedFunctionArn);

  const scanned = await fetchMonitoredLeases(leaseStore);
  const leases = scanned.leases.filter(
    (lease) => lease.bedrockTokenMonitoringEnabled,
  );
  // The schedule is static, so this is what keeps the per-region calls off a
  // deployment that never opted in. A skipped scan is named so the outcome
  // cannot be read as "nobody opted in".
  if (leases.length === 0) {
    const outcome =
      scanned.skippedStatuses.length === 0
        ? "no lease has Bedrock token monitoring enabled"
        : `no lease to poll; skipped lease status scans: ${scanned.skippedStatuses.join(", ")}`;
    logger.debug(outcome);
    return outcome;
  }

  // The regions a lease can spend in. Bedrock token metrics are per region and
  // an invocation in one produces no metric in the other, so every managed
  // region has to be read. The store caches the parsed parameter, so this is
  // not an SSM call on every run.
  const { isbManagedRegions } = await accountPoolConfigStore.get();
  logger.debug(
    `polling Bedrock token usage for ${leases.length} leases ` +
      `across ${isbManagedRegions.join(", ")}`,
  );

  const linkedAccounts = await listLinkedAccountsByRegion(
    context,
    isbManagedRegions,
    (region) => {
      const sinkId = sinkIds.get(region);
      if (sinkId === undefined) {
        throw new MissingSinkError(region);
      }
      return sinkArn({ partition, accountId, region, sinkId });
    },
    leases.length,
  );
  const unlinked = flagUnlinkedLeases(leases, linkedAccounts);

  const now = DateTime.utc();
  const pricing = bedrockPricingFor(context.env);
  const services: PollServices = {
    leaseStore,
    costHistoryStore: IsbServices.leaseCostHistoryStore(context.env),
    isbEventBridge: IsbServices.isbEventBridge(context.env),
    rates: pricing.source,
    retentionDays: context.globalConfig.leases.ttl,
    pollIntervalMinutes: Number(context.env.TOKEN_POLL_INTERVAL_MINUTES),
  };
  const states = await readAnchors(leases, services.costHistoryStore);
  const usage = await readTokenUsage(
    context,
    [...linkedAccounts.keys()],
    states,
    now,
  );
  // Where the price lookup failed, the counts are left for the next run to
  // read again rather than saved unpriced.
  const priced = await pricing.loadPrices(modelsToPrice(usage));
  const recorded = await recordLeases(
    states,
    priced ? usage : null,
    now,
    services,
  );

  return (
    `polled ${leases.length} token-monitored leases in ` +
    `${linkedAccounts.size} of ${isbManagedRegions.length} managed regions, ` +
    `${unlinked} lease-region pairs unlinked, ` +
    `${recorded.rowsAppended} token rows appended, ` +
    `${recorded.recordsUpdated} lease records updated`
  );
}

/**
 * Usage in every region is priced from the poll's regional prices, each
 * region's models listed through a Bedrock client in that region.
 */
function bedrockPricingFor(env: TokenPollEnvironment): BedrockPricing {
  return createBedrockPricing({
    logger,
    modelPricing: createRegionalPriceLookup({
      priceCache: IsbServices.bedrockPriceCache(env),
      pricingServices: { pricingClient: IsbClients.pricing(env), logger },
      regionalBedrock: (region) => IsbClients.regionalBedrock(env, region),
    }),
  });
}

/**
 * Every region and model this run's readings counted, each once: a run prices
 * only the counts it adds.
 */
function modelsToPrice(usage: RegionTokenUsage[]): RegionModel[] {
  const toPrice = new Map<string, Set<string>>();
  const add = (region: string, modelIds: string[]) => {
    const models = toPrice.get(region) ?? new Set<string>();
    for (const modelId of modelIds) {
      if (modelId !== UNATTRIBUTED_MODEL_ID) {
        models.add(modelId);
      }
    }
    toPrice.set(region, models);
  };
  for (const { region, leases } of usage) {
    for (const { tokens } of Object.values(leases)) {
      add(region, Object.keys(tokens));
    }
  }
  return [...toPrice].flatMap(([region, models]) =>
    [...models].map((modelId) => ({ region, modelId })),
  );
}

/**
 * Per region, the accounts whose link is attached to the hub's sink: the
 * accounts whose metrics can be read at all. One OAM client per region, built
 * for this invocation, on the Lambda's own credentials. A region that cannot
 * be listed is left out of the map and skipped for the run, so nothing is
 * recorded for it while the other regions proceed; no region at all is a
 * failed run, not a quiet one.
 */
async function listLinkedAccountsByRegion(
  context: PollContext,
  regions: string[],
  sinkArnFor: (region: string) => string,
  leaseCount: number,
): Promise<Map<string, Set<string>>> {
  // async so a region without a sink rejects its own entry instead of the run
  const listed = await Promise.allSettled(
    regions.map(async (region) =>
      listLinkedAccounts(
        IsbClients.oam(context.env, region),
        sinkArnFor(region),
      ),
    ),
  );

  const linked = new Map<string, Set<string>>();
  listed.forEach((result, index) => {
    const region = regions[index]!;
    if (result.status === "fulfilled") {
      linked.set(region, result.value);
      return;
    }
    logger.warn(
      `${LogPatterns.ObservabilityRegionUnreadable.pattern}: skipping the region this run, its linked accounts could not be listed`,
      {
        region,
        leasesAffected: leaseCount,
        errorName: result.reason?.name,
        error: result.reason?.message,
      },
    );
  });
  if (linked.size === 0) {
    throw new Error(
      `no managed region could be read this run (${regions.join(", ")})`,
    );
  }
  return linked;
}

/**
 * A lease whose account has no link in a region reads exactly like an idle
 * lease there: an empty metric series with a Complete status. The gap is
 * reported here instead of being inferred from the data. The lease stays in
 * the run and is still evaluated.
 */
function flagUnlinkedLeases(
  leases: MonitoredLease[],
  linkedByRegion: Map<string, Set<string>>,
): number {
  let unlinked = 0;
  for (const lease of leases) {
    for (const [region, accounts] of linkedByRegion) {
      if (accounts.has(lease.awsAccountId)) {
        continue;
      }
      unlinked++;
      logger.warn(
        `${LogPatterns.ObservabilityLinkMissing.pattern}: the lease account has no link to the hub sink in this region`,
        { leaseId: lease.uuid, awsAccountId: lease.awsAccountId, region },
      );
    }
  }
  return unlinked;
}

/**
 * Each lease's newest cost observation and token row. A lease whose rows
 * cannot be read is left out of the run: reading its metrics from lease start
 * would count them twice, and composing without its billed total would write
 * a figure that re-arms every fired threshold. Its anchors hold, so the next
 * run picks it up where this one left it.
 */
async function readAnchors(
  leases: MonitoredLease[],
  store: LeaseCostHistoryStore,
): Promise<LeaseState[]> {
  const states: LeaseState[] = [];
  await forEachBounded(leases, PER_LEASE_CONCURRENCY, async (lease) => {
    try {
      const [cost, token] = await Promise.all([
        store.getNewestCostObservation(lease.uuid),
        store.getNewestBedrockTokenRow(lease.uuid),
      ]);
      if (!cost.complete || !token.complete) {
        logger.warn(
          "skipping a lease this run: its newest cost history row is unreadable",
          {
            leaseId: lease.uuid,
            costRowReadable: cost.complete,
            tokenRowReadable: token.complete,
          },
        );
        return;
      }
      states.push({ lease, cost: cost.result, previous: token.result });
    } catch (error) {
      logger.warn(
        "skipping a lease this run: its newest cost history rows could not be read",
        { leaseId: lease.uuid, error: (error as Error).message },
      );
    }
  });
  return states;
}

/**
 * Every readable region's token counts, all regions read at once. A region
 * whose read fails is left out, so its anchors hold and the next run re-reads
 * the same window while the other regions record. No region at all is a
 * failed run, not a quiet one.
 */
async function readTokenUsage(
  context: PollContext,
  regions: string[],
  states: LeaseState[],
  now: DateTime<true>,
): Promise<RegionTokenUsage[]> {
  const leases: TokenUsageLease[] = states.map(({ lease, previous }) => ({
    leaseId: lease.uuid,
    awsAccountId: lease.awsAccountId,
    startDate: lease.startDate,
    coveredThrough: previous?.coveredThrough ?? {},
  }));
  const reads = await Promise.allSettled(
    regions.map((region) =>
      readRegionTokenUsage({
        cloudWatch: IsbClients.regionalCloudWatch(context.env, region),
        leases,
        nowMs: now.toMillis(),
        logger,
      }),
    ),
  );
  const usage: RegionTokenUsage[] = [];
  reads.forEach((read, index) => {
    if (read.status === "fulfilled") {
      usage.push(read.value);
      return;
    }
    logger.warn(
      `${LogPatterns.ObservabilityRegionUnreadable.pattern}: skipping the region this run, its token metrics could not be read`,
      {
        region: regions[index],
        leasesAffected: states.length,
        errorName: read.reason?.name,
        error: read.reason?.message,
      },
    );
  });
  if (usage.length === 0) {
    throw new Error(
      `no region's token metrics could be read this run (${regions.join(", ")})`,
    );
  }
  return usage;
}

/** Every lease in turn, a bounded number at a time; one lease's failure costs that lease, not the run. */
async function recordLeases(
  states: LeaseState[],
  usage: RegionTokenUsage[] | null,
  now: DateTime<true>,
  services: PollServices,
): Promise<{ rowsAppended: number; recordsUpdated: number }> {
  const recorded = { rowsAppended: 0, recordsUpdated: 0 };
  await forEachBounded(states, PER_LEASE_CONCURRENCY, async (state) => {
    try {
      const { rowAppended } = await recordLease(state, usage, now, services);
      if (rowAppended) {
        recorded.rowsAppended += 1;
      }
      recorded.recordsUpdated += 1;
    } catch (error) {
      logger.error(
        `token poll failed for lease ${state.lease.uuid}; continuing with the others`,
        { error },
      );
    }
  });
  return recorded;
}

/**
 * One lease; resolves to whether a row was appended, which happens where the
 * counts moved. The lease record's figures
 * are then recomputed from stored rows, never from the poll's own previous
 * output, every threshold is evaluated against them, and the figures the next
 * run de-duplicates against are written through the poll's scoped update,
 * which leaves `totalCostAccrued` to Lease Monitoring. A run whose figure
 * is at or above `maxSpend` raises that in place of the threshold events.
 */
async function recordLease(
  state: LeaseState,
  usage: RegionTokenUsage[] | null,
  now: DateTime<true>,
  services: PollServices,
): Promise<{ rowAppended: boolean }> {
  const { lease, cost, previous } = state;
  // Null both where predictive budget controls are off and where a rate input
  // is unreadable: a rate from a series with a hole is confidently wrong, so
  // the projection and the caps sit this run out and the figures the previous
  // run wrote for them stand; writing the base figure over a standing
  // projection would re-arm fired thresholds. The dollar thresholds still
  // compare evaluated spend, which needs nothing from the series. Null
  // too where no usage is passed because prices failed to load.
  const inputs =
    usage !== null && lease.predictiveBudgetEnabled === true
      ? await readRateInputs(lease, now, services)
      : null;
  // With no usage, the stored row stands and the counts are read next run.
  const appended =
    usage === null
      ? undefined
      : await appendTokenRow(lease, previous, usage, services);
  const rowAppended = appended !== undefined;
  const projecting = inputs !== null;
  const current = appended ?? previous;
  // Where prices failed to load, the stored counts can trail a newer bill, so
  // no monitored token cost is substituted in this run.
  const monitoredBedrockTokenCost =
    usage === null ? null : (current?.monitoredBedrockTokenCost ?? null);
  const figures = computeLeaseFigures({
    ...billedTerms(lease, cost),
    monitoredBedrockTokenCost,
    evaluatedAt: now.toISO(),
    observations: (inputs ?? NO_RATE_INPUTS).observations,
    bedrockWindows: bedrockWindowCosts(
      current,
      (inputs ?? NO_RATE_INPUTS).bedrockCostsBefore,
    ),
  });
  const evaluation = evaluateThresholds(lease, figures, projecting);
  const budgetExceeded = budgetExceededEvent(lease, evaluation);
  if (budgetExceeded === null) {
    await raiseBreaches({ lease, cost, figures, evaluation, now }, services);
  } else {
    await recordMaxSpendBreach(
      {
        lease,
        cost,
        figures,
        evaluation,
        maxSpend: budgetExceeded.Detail.budget,
      },
      services,
    );
    await services.isbEventBridge.sendIsbEvents(tracer, budgetExceeded);
  }
  await services.leaseStore.updateTokenPollOwnedFields({
    leaseId: lease.uuid,
    userEmail: lease.userEmail,
    // A term that is unavailable this run lowers evaluated spend with no
    // spend having fallen, so it never lowers the figure the reported
    // thresholds de-duplicate against: when the term returns, only crossings
    // above what was already compared fire.
    lastEvaluatedSpend:
      figures.monitoredBedrockTokenCost === null
        ? Math.max(evaluation.lastEvaluatedSpend, lease.lastEvaluatedSpend ?? 0)
        : evaluation.lastEvaluatedSpend,
    // Likewise for the projection, but only where a priced monitored value exists
    // and was left out because the billed Bedrock slice is unknown. A lease
    // with no monitored value at all is projected from the bill alone, and that
    // projection may fall and re-arm the predicted thresholds as designed.
    lastPredictedSpend:
      evaluation.lastPredictedSpend !== null &&
      monitoredBedrockTokenCost !== null &&
      figures.monitoredBedrockTokenCost === null
        ? Math.max(evaluation.lastPredictedSpend, lease.lastPredictedSpend ?? 0)
        : evaluation.lastPredictedSpend,
    lastEvaluatedHourlySpendRate: evaluation.lastEvaluatedHourlySpendRate,
    lastEvaluatedDailySpendRate: evaluation.lastEvaluatedDailySpendRate,
  });
  logger.debug(`token poll figures for lease ${lease.uuid}`, {
    leaseId: lease.uuid,
    rowAppended,
    breaches: evaluation.breaches.length,
    ...figures,
  });
  return { rowAppended };
}

/**
 * Every threshold on the lease against this run's figures: dollar thresholds
 * against evaluated spend and the projection built on it, each
 * de-duplicated against the figure the previous run wrote, and the rate caps
 * against the summed rates. Where this run measured no rates, only the
 * reported thresholds are evaluated and the projection figures the previous
 * run wrote are returned unchanged. A frozen lease has already been acted on,
 * so its predicted crossings and caps are not raised again until it is
 * unfrozen; its figures still advance, so a crossing while frozen is past
 * when evaluation resumes rather than firing late.
 */
function evaluateThresholds(
  lease: MonitoredLease,
  figures: LeaseFigures,
  projecting: boolean,
): SpendingControlsEvaluation {
  const evaluatedSpend = figures.evaluatedSpend;
  const breaches: ThresholdBreach[] = evaluateReportedThresholds({
    thresholds: lease.budgetThresholds,
    // Evaluated spend is what is compared, so it is what de-duplicates;
    // absent before the first run, which compares as zero.
    previousEvaluatedSpend: lease.lastEvaluatedSpend ?? 0,
    evaluatedSpend,
    predictedCost: projecting ? figures.predictedCost : null,
    rates: figures.remainder,
    rateSource: figures.rateSource,
  });
  if (!projecting) {
    return {
      breaches,
      lastEvaluatedSpend: evaluatedSpend,
      lastPredictedSpend: lease.lastPredictedSpend ?? null,
      lastEvaluatedHourlySpendRate: lease.lastEvaluatedHourlySpendRate ?? null,
      lastEvaluatedDailySpendRate: lease.lastEvaluatedDailySpendRate ?? null,
    };
  }
  const summed = summedRates(figures);
  if (lease.status !== "Frozen") {
    breaches.push(
      ...evaluatePredictedThresholds({
        thresholds: lease.budgetThresholds,
        previousPredictedCost: lease.lastPredictedSpend ?? 0,
        predictedCost: figures.predictedCost,
        evaluatedSpend,
        rates: figures.remainder,
        rateSource: figures.rateSource,
      }),
      ...evaluateRateCaps({
        rateLimits: lease.rateLimits ?? [],
        rates: summed,
        previousHourlyRate: lease.lastEvaluatedHourlySpendRate,
        previousDailyRate: lease.lastEvaluatedDailySpendRate,
        evaluatedSpend: figures.evaluatedSpend,
        predictedCost: figures.predictedCost,
      }),
    );
  }
  return {
    breaches,
    lastEvaluatedSpend: evaluatedSpend,
    lastPredictedSpend: figures.predictedCost,
    lastEvaluatedHourlySpendRate: summed.hourlyRate,
    // As the shared evaluator does: a daily rate that cannot be measured this
    // run holds the previous one while an hourly one exists, so the daily cap
    // does not re-arm on a flicker.
    lastEvaluatedDailySpendRate:
      summed.dailyRate ??
      (summed.hourlyRate === null
        ? null
        : (lease.lastEvaluatedDailySpendRate ?? null)),
  };
}

/** The remainder plus monitored Bedrock rates, shaped as the rate caps compare them. */
function summedRates(figures: LeaseFigures): SpendRates {
  return {
    hourlyRate: figures.rates.summedHourlyRate,
    dailyRate: figures.rates.summedDailyRate,
    hourlyRateWindowHours: figures.remainder.hourlyRateWindowHours,
    dailyRateWindowHours: figures.remainder.dailyRateWindowHours,
  };
}

/**
 * The summed rate the countdown burns at, in its own unit: whichever of the
 * hourly and daily rates the projection would carry, as it picks between them.
 */
function countdownRate(
  summed: SpendRates,
): { rate: number; rateSource: RateSource } | null {
  const selected = projectionRatePerHour(summed);
  if (selected === null) {
    return null;
  }
  const rate =
    selected.source === "HOURLY" ? summed.hourlyRate : summed.dailyRate;
  return rate === null ? null : { rate, rateSource: selected.source };
}

/**
 * `maxSpend` termination on the figure the reported thresholds compare, raised
 * on every run while that figure is at or above it, as Lease Monitoring does
 * on the bill. A crossing alone would miss a `maxSpend` lowered below current
 * spend and an event the account lifecycle manager failed on. The poll stops
 * sending once the lease leaves the monitored statuses, and the lifecycle
 * manager skips a repeat for a lease that has already ended.
 */
function budgetExceededEvent(
  lease: MonitoredLease,
  evaluation: SpendingControlsEvaluation,
): LeaseBudgetExceededAlert | null {
  const { maxSpend } = lease;
  const totalSpend = evaluation.lastEvaluatedSpend;
  if (maxSpend === undefined || totalSpend < maxSpend) {
    return null;
  }
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
    budget: maxSpend,
    totalSpend,
    detectedBy: "TOKEN_POLL",
  });
}

/**
 * The audit row for a run at or above `maxSpend`, unless the lease's breach
 * history already holds one at this cap, as it does after an earlier run or
 * where Lease Monitoring recorded it first. Written before the termination is
 * sent and best effort, as the threshold rows are: the termination is sent
 * whether or not the row is written.
 */
async function recordMaxSpendBreach(
  input: {
    lease: MonitoredLease;
    cost: CostObservation | undefined;
    figures: LeaseFigures;
    evaluation: SpendingControlsEvaluation;
    maxSpend: number;
  },
  services: PollServices,
): Promise<void> {
  const { lease, figures } = input;
  try {
    await persistMaxSpendBreach(
      {
        leaseUuid: lease.uuid,
        // Cost Explorer's own total, as on the threshold rows.
        billedCostAtFire: input.cost?.billedCostAccrued ?? 0,
        evaluator: {
          evaluatedBy: "TOKEN_POLL",
          monitoredBedrockTokenCostAtFire: figures.monitoredBedrockTokenCost,
        },
        maxSpend: input.maxSpend,
        comparedCost: input.evaluation.lastEvaluatedSpend,
        leaseStartDate: lease.startDate,
        ttl: calculateCostHistoryTtl({
          retentionDays: services.retentionDays,
          expirationDate: lease.expirationDate,
          startDate: lease.startDate,
          leaseDurationInHours: lease.leaseDurationInHours,
        }),
      },
      { costHistoryStore: services.costHistoryStore, logger },
    );
  } catch (error) {
    logger.error(
      `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
      { ...searchableLeaseProperties(lease), error },
    );
  }
}

/**
 * The newly breached thresholds: one log record and one audit row each. At
 * most one freeze and one alert are published. The rows are written before
 * the events and best effort, as Lease Monitoring writes them: the crossing
 * is signaled by the event and the log record, and advancing the lease's
 * figures keeps it from being raised again every run.
 */
async function raiseBreaches(
  input: {
    lease: MonitoredLease;
    cost: CostObservation | undefined;
    figures: LeaseFigures;
    evaluation: SpendingControlsEvaluation;
    now: DateTime<true>;
  },
  services: PollServices,
): Promise<void> {
  const { lease, cost, figures, evaluation } = input;
  if (evaluation.breaches.length === 0) {
    return;
  }
  // Cost Explorer's own total, for the audit rows, the log records and the
  // events: a breach record states the figure it compared against, and an
  // estimate must not arrive under a billed name.
  const billedCostAccrued = cost?.billedCostAccrued ?? 0;
  const reportedAt =
    cost === undefined ? undefined : cost.sk.slice(COST_SK_PREFIX.length);
  for (const breach of evaluation.breaches) {
    logThresholdFired(
      lease,
      breach,
      { evaluatedSpend: figures.evaluatedSpend, billedCostAccrued, reportedAt },
      input.now,
    );
  }
  // The monitored term less the billed slice it replaced, which is zero before
  // Cost Explorer has reported anything.
  const unbilledBedrockTokenCost =
    figures.monitoredBedrockTokenCost === null
      ? null
      : Math.max(
          0,
          figures.monitoredBedrockTokenCost -
            (cost?.billedBedrockTokenCost ?? 0),
        );
  const insight = selectComparedSpendInsight({
    newestBreakdown: cost?.serviceBreakdown,
    previousBreakdown:
      cost?.serviceBreakdown === undefined
        ? undefined
        : await readPreviousBreakdown(lease.uuid, services.costHistoryStore),
    billedCostAccrued,
    unbilledBedrockTokenCost,
  });
  try {
    await persistBreachRecords(
      {
        leaseUuid: lease.uuid,
        billedCostAtFire: billedCostAccrued,
        evaluator: {
          evaluatedBy: "TOKEN_POLL",
          monitoredBedrockTokenCostAtFire: figures.monitoredBedrockTokenCost,
        },
        breaches: evaluation.breaches,
        insight,
        ttl: calculateCostHistoryTtl({
          retentionDays: services.retentionDays,
          expirationDate: lease.expirationDate,
          startDate: lease.startDate,
          leaseDurationInHours: lease.leaseDurationInHours,
        }),
      },
      { costHistoryStore: services.costHistoryStore },
    );
  } catch (error) {
    logger.error(
      `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
      { ...searchableLeaseProperties(lease), error },
    );
  }

  const summed = summedRates(figures);
  const selection = selectSpendingControlEvents({
    lease,
    billedCostAccrued,
    breaches: evaluation.breaches,
    insight,
    context: {
      // The countdown burns at the summed rate: from here on Bedrock keeps
      // accruing, and leaving it out understates the burn on exactly the lease
      // monitoring exists for.
      hoursToBudgetExhaustion: computeTimeToExhaustion({
        maxSpend: lease.maxSpend,
        predictedCost: figures.predictedCost,
        ratePerHour: projectionRatePerHour(summed)?.ratePerHour ?? null,
      }),
      lastReportedAt: reportedAt,
      // The alert names the rate its countdown burns at beside the remainder
      // rate that carried the projection, which the breach row records.
      countdownRate: countdownRate(summed),
      unbilledBedrockTokenCost,
    },
  });
  const raised: (IsbEvent | null)[] = [selection.freeze, selection.alert];
  const events = raised.filter(isEvent);
  if (events.length > 0) {
    await services.isbEventBridge.sendIsbEvents(tracer, ...events);
  }
}

function isEvent(event: IsbEvent | null): event is IsbEvent {
  return event !== null;
}

/**
 * The per-service totals of the observation before the newest one, which the
 * insight differences the newest against. Read only once a threshold has
 * crossed, and only the two newest rows. The insight is a sentence in the
 * notification, so a read that fails costs the comparison, not the breach.
 */
async function readPreviousBreakdown(
  leaseUuid: string,
  store: LeaseCostHistoryStore,
): Promise<ServiceBreakdown | undefined> {
  try {
    const recent = await store.getRecentCostObservations(leaseUuid, {
      limit: 2,
    });
    return recent.complete ? recent.result[1]?.serviceBreakdown : undefined;
  } catch (error) {
    logger.warn(
      `previous cost observation for lease ${leaseUuid} could not be read; raising the breach without a comparison insight`,
      { leaseId: leaseUuid, error: (error as Error).message },
    );
    return undefined;
  }
}

/**
 * The billed total under the billed name, as on the breach row, and on a
 * freeze evaluated spend.
 */
function logThresholdFired(
  lease: MonitoredLease,
  breach: ThresholdBreach,
  figures: {
    evaluatedSpend: number;
    billedCostAccrued: number;
    reportedAt: string | undefined;
  },
  now: DateTime<true>,
): void {
  const { reportedAt } = figures;
  const hoursSinceLastRefresh =
    reportedAt === undefined
      ? null
      : now.diff(DateTime.fromISO(reportedAt, { zone: "utc" }), "hours").hours;
  logger.info(
    `Lease (${lease.uuid}) ${breach.triggeredBy} threshold crossed, ${breach.action}`,
    {
      ...searchableLeaseProperties(lease),
      ...thresholdFiredLog(breach, {
        evaluatedBy: "TOKEN_POLL",
        billedCostAccrued: figures.billedCostAccrued,
        hoursSinceLastRefresh,
        costAtFreezeDecision: figures.evaluatedSpend,
      }),
    } satisfies SubscribableLog,
  );
}

/**
 * The billed terms of evaluated spend. Before Cost Explorer has reported
 * anything for the lease both are zero, not missing: evaluated spend is then
 * the monitored Bedrock term alone, which is what the poll exists to see
 * while the bill lags.
 */
function billedTerms(
  lease: MonitoredLease,
  cost: CostObservation | undefined,
): {
  billedCostAccrued: number;
  billedBedrockTokenCost: number | null;
  reportedAt: string;
} {
  if (cost === undefined) {
    return {
      billedCostAccrued: 0,
      billedBedrockTokenCost: 0,
      reportedAt: lease.startDate,
    };
  }
  return {
    billedCostAccrued: cost.billedCostAccrued,
    billedBedrockTokenCost: cost.billedBedrockTokenCost,
    reportedAt: cost.sk.slice(COST_SK_PREFIX.length),
  };
}

/**
 * The lease's counts since its anchors, appended as a row where any moved. Its
 * cost is the previous row's plus the counts added since it, priced at this
 * run's rates, so earlier tokens are never priced again: a count with no rate
 * adds nothing, then or later, and a previous row with no cost counts as 0.
 */
async function appendTokenRow(
  lease: MonitoredLease,
  previous: BedrockTokenRow | undefined,
  usage: RegionTokenUsage[],
  services: PollServices,
): Promise<BedrockTokenRow | undefined> {
  const cumulative = accumulateTokenUsage(
    lease.uuid,
    previous === undefined
      ? null
      : { tokens: previous.tokens, coveredThrough: previous.coveredThrough },
    usage,
  );
  if (cumulative === null) {
    return undefined;
  }
  const addedCost = priceTokens({
    leaseId: lease.uuid,
    tokens: subtractTokens(cumulative.tokens, previous?.tokens ?? {}),
    rates: services.rates,
    logger,
  });
  return services.costHistoryStore.appendBedrockTokenRow({
    leaseUuid: lease.uuid,
    tokens: cumulative.tokens,
    coveredThrough: cumulative.coveredThrough,
    monitoredBedrockTokenCost:
      (previous?.monitoredBedrockTokenCost ?? 0) + addedCost,
    monitoredBedrockTokenCostDelta: addedCost,
    ttl: calculateCostHistoryTtl({
      retentionDays: services.retentionDays,
      expirationDate: lease.expirationDate,
      startDate: lease.startDate,
      leaseDurationInHours: lease.leaseDurationInHours,
    }),
  });
}

/**
 * What the rates difference over: the cost observations over the same
 * lookback the plain spend rates use, and the monitored Bedrock token cost as it stood
 * an hour and a day before this run. Null where any of it is unreadable or
 * cannot be read at all, since a rate over a series with a hole is confidently
 * wrong; the reported thresholds need none of it, so a failed read costs the
 * rate, not the run.
 */
async function readRateInputs(
  lease: MonitoredLease,
  now: DateTime<true>,
  services: PollServices,
): Promise<RateInputs | null> {
  let observations: RecentObservations;
  let hourAgo: number | null | undefined;
  let dayAgo: number | null | undefined;
  // A row is keyed when it is written, just after its run's `now`, so the row
  // from one window back sits just after `now` less the window. Looking half an
  // interval past that point finds it, unless this run or that row's write is
  // half an interval late.
  const slackMinutes = services.pollIntervalMinutes / 2;
  try {
    [observations, hourAgo, dayAgo] = await Promise.all([
      getRecentObservations(
        { leaseUuid: lease.uuid, hoursBack: OBSERVATION_LOOKBACK_HOURS },
        { costHistoryStore: services.costHistoryStore, logger },
      ),
      bedrockCostAt(
        lease,
        now.minus(BEDROCK_HOURLY_WINDOW),
        slackMinutes,
        services,
      ),
      bedrockCostAt(
        lease,
        now.minus(BEDROCK_DAILY_WINDOW),
        slackMinutes,
        services,
      ),
    ]);
  } catch (error) {
    logger.warn(
      `rate inputs for lease ${lease.uuid} could not be read; no rate this run`,
      { leaseId: lease.uuid, error: (error as Error).message },
    );
    return null;
  }
  if (observations.droppedRecordCount !== undefined) {
    return null;
  }
  if (hourAgo === undefined || dayAgo === undefined) {
    return null;
  }
  return {
    observations: observations.points,
    bedrockCostsBefore: { hourAgo, dayAgo },
  };
}

/**
 * Monitored Bedrock dollars accrued in the hour and the day before this
 * run: the current value less the value then. Each row prices only the counts it
 * adds, so a rate change never reads as usage. Measured only where the lease
 * has a monitored value, since the windows are compared only then.
 */
function bedrockWindowCosts(
  current: BedrockTokenRow | undefined,
  before: BedrockCostsBefore,
): BedrockWindowCost {
  if (current?.monitoredBedrockTokenCost == null) {
    return { lastHour: null, lastDay: null };
  }
  return {
    lastHour: windowCost(current.monitoredBedrockTokenCost, before.hourAgo),
    lastDay: windowCost(current.monitoredBedrockTokenCost, before.dayAgo),
  };
}

function windowCost(now: number, before: number | null): number | null {
  return before === null ? null : now - before;
}

/**
 * The monitored Bedrock token cost at a window's start: the cost on the newest
 * row at or before `slackMinutes` past the start, since the figure is flat
 * between rows. Zero where that row has no cost or the lease had started by the
 * window start but no row existed yet, null where the lease had not started by
 * then, and undefined where the row is unreadable.
 */
async function bedrockCostAt(
  lease: MonitoredLease,
  windowStart: DateTime<true>,
  slackMinutes: number,
  services: PollServices,
): Promise<number | null | undefined> {
  const rowCutoff = windowStart.plus({ minutes: slackMinutes }).toISO();
  const row =
    await services.costHistoryStore.getNewestBedrockTokenRowAtOrBefore(
      lease.uuid,
      rowCutoff,
    );
  if (!row.complete) {
    logger.warn(
      "an earlier bedrock token row is unreadable; no rate this run",
      {
        leaseId: lease.uuid,
        at: rowCutoff,
        droppedRecordCount: row.droppedRecordCount,
        droppedRecordReason: row.droppedRecordReason,
      },
    );
    return undefined;
  }
  if (row.result !== undefined) {
    return row.result.monitoredBedrockTokenCost ?? 0;
  }
  return parseDatetime(lease.startDate) <= windowStart ? 0 : null;
}

/**
 * Active and frozen leases, retried on the throttling and transient DynamoDB
 * errors a scan raises. The poll runs six times an hour, so a scan that fails
 * outright loses a whole interval of token counts. A status whose scan fails
 * every attempt is reported and skipped rather than failing the run, so the
 * statuses that did scan keep their interval.
 */
async function fetchMonitoredLeases(leaseStore: LeaseStore): Promise<{
  leases: MonitoredLease[];
  skippedStatuses: MonitoredLeaseStatus[];
}> {
  const scans = await Promise.allSettled(
    MONITORED_STATUSES.map((status) =>
      backOff(() => collect(scanLeases(leaseStore, status)), {
        numOfAttempts: TOKEN_POLL_CONFIG.MAX_ATTEMPTS,
        jitter: "full",
        startingDelay: TOKEN_POLL_CONFIG.STARTING_DELAY,
        retry(error) {
          if (
            error.name === "ThrottlingException" ||
            error.name === "ProvisionedThroughputExceededException" ||
            error.name === "ServiceUnavailableException" ||
            error.name === "InternalServerError"
          ) {
            logger.warn("Retrying lease scan due to error", {
              error: error.message,
            });
            return true;
          }
          return false;
        },
      }),
    ),
  );

  const leases: Lease[] = [];
  const skippedStatuses: MonitoredLeaseStatus[] = [];
  scans.forEach((scan, index) => {
    const status = MONITORED_STATUSES[index]!;
    if (scan.status === "fulfilled") {
      leases.push(...scan.value);
      return;
    }
    skippedStatuses.push(status);
    logger.warn(
      `${LogPatterns.LeaseScanSkipped.pattern}: giving up on a lease scan, skipping this status for the run`,
      { status, error: scan.reason?.message },
    );
  });
  // Every status failing is a broken run, which must not read as "no lease
  // opted in" and return success.
  if (skippedStatuses.length === MONITORED_STATUSES.length) {
    throw new Error("no lease status could be scanned this run");
  }

  // Narrowing by status, not re-parsing: the store already validated every row
  // against LeaseSchema, whose Active and Frozen members are
  // MonitoredLeaseSchema. Rows that failed are dropped inside the store, which
  // is where scanLeases reports them. A lease whose status changed between
  // the two scans comes back from both; it is polled once. Frozen results
  // come last, so a tie keeps the Frozen copy.
  return {
    leases: newestCopyOfEachLease(leases.filter(isMonitoredLease)),
    skippedStatuses,
  };
}

/**
 * Pages one status, surfacing the rows the store dropped. `findByStatus`
 * validates each row and returns the failures as an error string beside the
 * valid ones; `stream` discards that string, so it is read here instead —
 * otherwise a malformed lease leaves the poll silently short.
 */
function scanLeases(
  leaseStore: LeaseStore,
  status: MonitoredLeaseStatus,
): AsyncGenerator<Lease> {
  return stream(
    leaseStore,
    async (props: { status: LeaseStatus; pageIdentifier?: string }) => {
      const page = await leaseStore.findByStatus(props);
      if (page.error) {
        logger.warn(
          `${LogPatterns.DataValidationWarning.pattern}: dropped leases that failed schema validation - ${page.error}`,
          { status },
        );
      }
      return page;
    },
    { status },
  );
}

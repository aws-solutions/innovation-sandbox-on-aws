// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudWatchClient,
  GetMetricDataCommandOutput,
  MetricDataQuery,
  paginateGetMetricData,
  paginateListMetrics,
} from "@aws-sdk/client-cloudwatch";
import { DateTime } from "luxon";

import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { parseDatetime } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  TokenCounts,
  TokenType,
  UNATTRIBUTED_MODEL_ID,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

const BEDROCK_METRIC_NAMESPACE = "AWS/Bedrock";
const BEDROCK_MODEL_DIMENSION = "ModelId";

/**
 * The four token metrics, which do not overlap: InputTokenCount excludes both
 * cache counts. A misspelt name returns an empty series rather than an error,
 * so the test pins these against a live list-metrics response.
 */
export const BEDROCK_TOKEN_METRICS: Readonly<Record<TokenType, string>> = {
  input: "InputTokenCount",
  output: "OutputTokenCount",
  cacheRead: "CacheReadInputTokenCount",
  cacheWrite: "CacheWriteInputTokenCount",
};
export const TOKEN_TYPES = Object.keys(BEDROCK_TOKEN_METRICS) as TokenType[];

/**
 * Seconds per bucket. Every window is derived from a resume anchor in units of
 * this period, so the two must move together. Five minutes keeps about 63 days
 * of backfill resolution where one minute keeps 15.
 */
export const BEDROCK_METRIC_PERIOD_SECONDS = 300;
const PERIOD_MS = BEDROCK_METRIC_PERIOD_SECONDS * 1000;

/**
 * Data points are stamped with the invocation time and can reach CloudWatch
 * minutes later, so a bucket is read only once it has been closed this long;
 * anchoring past it earlier would lose its tail.
 */
const SETTLING_MS = 2 * PERIOD_MS;

/** GetMetricData accepts at most this many queries in one call. */
export const MAX_QUERIES_PER_CALL = 500;

/**
 * Window batches read at once. Idle leases hold their anchors, so a fleet
 * drifts toward a batch per idle lease, and read one after another they would
 * not fit a run. Five keeps a region well under GetMetricData's request quota.
 */
export const MAX_CONCURRENT_WINDOW_READS = 5;

/**
 * A new metric can take up to fifteen minutes to appear in list-metrics, so a
 * per-model shortfall in buckets younger than this may just be an unlisted
 * model and is waited out; in older buckets it cannot be.
 */
const LIST_METRICS_LAG_MS = 60 * 60 * 1000;

/** CloudWatch keeps five-minute buckets this long; older ones read as empty. */
const RETENTION_MS = 63 * 24 * 60 * 60 * 1000;

export interface TokenUsageLease {
  leaseId: string;
  awsAccountId: string;
  /** ISO 8601. The window starts here where the region has no anchor yet. */
  startDate: string;
  /** Region -> ISO 8601 timestamp of the newest bucket already counted there. */
  coveredThrough: Record<string, string>;
}

export interface LeaseTokenUsage {
  /** modelId -> per-type sums over the buckets this reading covers. */
  tokens: Record<string, TokenCounts>;
  /**
   * The CloudWatch timestamp of the newest bucket this reading covers, which is
   * the bucket's start, not its close: the lease's next anchor in this region,
   * whose next window begins one period after it.
   */
  coveredThrough: string;
}

export interface RegionTokenUsage {
  /** The region read, as the client resolved it; the key the anchors are stored under. */
  region: string;
  /**
   * leaseId -> the counts that moved and the anchor to store with them. A lease
   * with nothing to add is absent, as is one whose movement could not yet be
   * attributed to models; both keep their anchor, so the next run re-reads the
   * same buckets and counts nothing twice.
   */
  leases: Record<string, LeaseTokenUsage>;
}

export interface ReadRegionTokenUsageInput {
  /** Configured for the region to read; the region is taken from it. */
  cloudWatch: CloudWatchClient;
  leases: TokenUsageLease[];
  /** Epoch milliseconds. */
  nowMs: number;
  logger: Logger;
}

/** Every query in one call shares the window, so leases are batched by window start. */
interface WindowBatch {
  startMs: number;
  leases: TokenUsageLease[];
}

/** One window read as a unit; `pastListingLag` means list-metrics has had time to list every model in it. */
interface Window extends WindowBatch {
  endMs: number;
  pastListingLag: boolean;
}

/**
 * One query and what asked for it. The response is keyed by `Id` alone and does
 * not echo `AccountId`, so the id is the only join back to the lease: a position
 * in this table, unique by construction.
 */
interface TokenQuery {
  id: string;
  leaseId: string;
  /** null for the dimensionless, account-wide series. */
  modelId: string | null;
  tokenType: TokenType;
  query: MetricDataQuery;
}

/** Per-model counts for one lease, or null to hold its anchor. */
type Attribution = Record<string, TokenCounts> | null;

const zeroCounts = (): TokenCounts => ({
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});
const moved = (counts: TokenCounts) =>
  TOKEN_TYPES.some((type) => counts[type] > 0);
const bucketStart = (ms: number) => Math.floor(ms / PERIOD_MS) * PERIOD_MS;

/**
 * One region's token counts for the window after each lease's anchor. Probe
 * first: the dimensionless series, four metrics a lease, equals the sum over
 * models, so it finds the leases that spent for the price of four metrics.
 * Then fan out to the per-model series only for those leases.
 */
export async function readRegionTokenUsage(
  input: ReadRegionTokenUsageInput,
): Promise<RegionTokenUsage> {
  const region = await input.cloudWatch.config.region();
  const endMs = bucketStart(input.nowMs - SETTLING_MS);
  const settledMs = bucketStart(input.nowMs - LIST_METRICS_LAG_MS);
  const modelIdsByAccount = new Map<string, Promise<string[]>>();
  const leases: Record<string, LeaseTokenUsage> = {};
  await forEachBounded(
    windowBatches(input, region, endMs),
    MAX_CONCURRENT_WINDOW_READS,
    async (batch) => {
      const windows = splitAtListingLag(batch, settledMs, endMs);
      const attributions: Map<string, Attribution>[] = [];
      for (const window of windows) {
        attributions.push(
          await readWindow(input, region, window, modelIdsByAccount),
        );
      }
      for (const lease of batch.leases) {
        const reading = leaseReading(windows, attributions, lease.leaseId);
        if (reading !== null) {
          leases[lease.leaseId] = reading;
        }
      }
    },
  );
  return { region, leases };
}

/** Runs `work` over `items` with at most `limit` in flight. */
export async function forEachBounded<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(limit, items.length) },
    async () => {
      while (next < items.length) {
        const item = items[next]!;
        next += 1;
        await work(item);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * A window reaching back past the listing lag is read in two parts, so a
 * shortfall in the young part is told apart from one in the old part.
 */
function splitAtListingLag(
  batch: WindowBatch,
  settledMs: number,
  endMs: number,
): Window[] {
  if (batch.startMs < settledMs && settledMs < endMs) {
    return [
      { ...batch, endMs: settledMs, pastListingLag: true },
      { ...batch, startMs: settledMs, endMs, pastListingLag: false },
    ];
  }
  return [{ ...batch, endMs, pastListingLag: endMs <= settledMs }];
}

/**
 * One lease's counts over the parts of its window that can be recorded, with
 * the anchor those parts run to. A part that holds ends the reading there, so
 * a recurring shortfall delays the lease's counts by the listing lag rather
 * than freezing them.
 */
function leaseReading(
  windows: Window[],
  attributions: Map<string, Attribution>[],
  leaseId: string,
): LeaseTokenUsage | null {
  const tokens: Record<string, TokenCounts> = {};
  let coveredThroughMs: number | null = null;
  for (const [index, window] of windows.entries()) {
    const part = attributions[index]!.get(leaseId);
    if (part === null) {
      break;
    }
    if (part !== undefined) {
      mergeCounts(tokens, part);
      coveredThroughMs = window.endMs - PERIOD_MS;
    }
  }
  if (coveredThroughMs === null) {
    return null;
  }
  return {
    tokens,
    coveredThrough: DateTime.fromMillis(coveredThroughMs, {
      zone: "utc",
    }).toISO()!,
  };
}

/**
 * Leases sharing a window start share a call. Anchors drift apart as idle
 * leases hold theirs, so the number of calls tends toward the number of
 * distinct anchors; metrics, not calls, are what is billed, and the batches
 * are read a few at a time so the calls fit the run.
 */
function windowBatches(
  input: ReadRegionTokenUsageInput,
  region: string,
  endMs: number,
): WindowBatch[] {
  const byStart = new Map<number, TokenUsageLease[]>();
  for (const lease of input.leases) {
    const startMs = windowStart(input, region, lease, endMs);
    if (startMs === null) {
      continue;
    }
    const batch = byStart.get(startMs) ?? [];
    batch.push(lease);
    byStart.set(startMs, batch);
  }
  return [...byStart].map(([startMs, batched]) => ({
    startMs,
    leases: batched,
  }));
}

/**
 * Where this lease's window begins in the region, or null to leave the lease
 * out of this run: absent from the result it keeps its anchor, and every other
 * lease is still read. StartTime is inclusive and EndTime exclusive, so the
 * window begins one period after the anchor; starting at the anchor re-reads
 * the bucket already counted.
 */
function windowStart(
  input: ReadRegionTokenUsageInput,
  region: string,
  lease: TokenUsageLease,
  endMs: number,
): number | null {
  const anchor = lease.coveredThrough[region];
  const details = {
    leaseId: lease.leaseId,
    region,
    anchor,
    startDate: lease.startDate,
  };
  let startMs =
    anchor === undefined
      ? bucketStart(parseDatetime(lease.startDate).toMillis())
      : bucketStart(parseDatetime(anchor).toMillis()) + PERIOD_MS;
  if (Number.isNaN(startMs)) {
    input.logger.warn(
      "Bedrock token usage not read: the lease's anchor or start date is not a date",
      details,
    );
    return null;
  }
  const oldestReadable = bucketStart(input.nowMs - RETENTION_MS);
  if (startMs < oldestReadable) {
    // Buckets past retention read as empty. Behind an anchor that means counts
    // were lost, which is said rather than implied.
    if (anchor !== undefined) {
      input.logger.warn(
        "Bedrock token counts before CloudWatch retention are lost; the window starts at the oldest bucket still held",
        {
          leaseId: lease.leaseId,
          region,
          from: DateTime.fromMillis(startMs, { zone: "utc" }).toISO()!,
        },
      );
    }
    startMs = oldestReadable;
  }
  if (startMs > bucketStart(input.nowMs)) {
    input.logger.warn(
      "Bedrock token usage not read: the lease's anchor or start date is in the future",
      details,
    );
    return null;
  }
  // Nothing complete to read yet: a lease started, or an anchor set, inside
  // the settling window is simply picked up by a later run.
  return startMs < endMs ? startMs : null;
}

/** leaseId -> attribution, for the leases whose probe moved in this window. */
async function readWindow(
  input: ReadRegionTokenUsageInput,
  region: string,
  window: Window,
  modelIdsByAccount: Map<string, Promise<string[]>>,
): Promise<Map<string, Attribution>> {
  const probed = await readCounts(input, window, () => [null]);
  const probeOf = (leaseId: string) => probed.get(leaseId)!.get(null)!;
  const spending = window.leases.filter((lease) =>
    moved(probeOf(lease.leaseId)),
  );
  const attributions = new Map<string, Attribution>();
  if (spending.length === 0) {
    return attributions;
  }

  const listed = new Map<string, string[]>();
  for (const lease of spending) {
    listed.set(
      lease.awsAccountId,
      await modelIdsFor(
        input.cloudWatch,
        modelIdsByAccount,
        lease.awsAccountId,
      ),
    );
  }
  const fannedOut = await readCounts(
    input,
    { ...window, leases: spending },
    (lease) => listed.get(lease.awsAccountId)!,
  );
  for (const lease of spending) {
    attributions.set(
      lease.leaseId,
      attributed(
        input.logger,
        region,
        window.pastListingLag,
        lease.leaseId,
        probeOf(lease.leaseId),
        fannedOut.get(lease.leaseId)!,
      ),
    );
  }
  return attributions;
}

/**
 * The account-wide probe is the sum over models, so a shortfall means a model
 * the fan-out did not see. In buckets younger than the listing lag that may be
 * a model not yet listed, so the anchor is held and the same buckets are read
 * again next run. In older buckets waiting cannot help, so the shortfall is
 * recorded unattributed and the anchor advances, keeping the count and losing
 * only its price. Per-model counts above the probe are recorded as they are.
 */
function attributed(
  logger: Logger,
  region: string,
  pastListingLag: boolean,
  leaseId: string,
  probe: TokenCounts,
  perModel: Map<string | null, TokenCounts>,
): Attribution {
  const shortfall = zeroCounts();
  const recorded: Record<string, TokenCounts> = {};
  for (const [modelId, counts] of perModel) {
    if (modelId !== null && moved(counts)) {
      recorded[modelId] = counts;
    }
  }
  for (const type of TOKEN_TYPES) {
    shortfall[type] = probe[type];
    for (const counts of perModel.values()) {
      shortfall[type] -= counts[type];
    }
  }
  const under = TOKEN_TYPES.some((type) => shortfall[type] > 0);
  const over = TOKEN_TYPES.some((type) => shortfall[type] < 0);
  if (!under && !over) {
    return recorded;
  }
  const details = {
    leaseId,
    region,
    shortfall,
    modelIds: Object.keys(recorded),
  };
  if (under && !pastListingLag) {
    logger.warn(
      `${LogPatterns.BedrockTokensUnattributed.pattern}: the per-model counts fall short of the account-wide counts, holding the lease's anchor this run`,
      details,
    );
    return null;
  }
  if (under) {
    logger.warn(
      `${LogPatterns.BedrockTokensUnattributed.pattern}: the per-model counts fall short of the account-wide counts in buckets list-metrics has had time to cover, recording the shortfall as ${UNATTRIBUTED_MODEL_ID}`,
      details,
    );
    const unattributed = zeroCounts();
    for (const type of TOKEN_TYPES) {
      unattributed[type] = Math.max(0, shortfall[type]);
    }
    recorded[UNATTRIBUTED_MODEL_ID] = unattributed;
  }
  if (over) {
    logger.warn(
      `${LogPatterns.BedrockTokensUnattributed.pattern}: the per-model counts exceed the account-wide counts, recording the per-model counts`,
      details,
    );
  }
  return recorded;
}

/** Adds `part`'s per-model counts into `into`, model by model and type by type. */
export function mergeCounts(
  into: Record<string, TokenCounts>,
  part: Record<string, TokenCounts>,
): void {
  for (const [modelId, counts] of Object.entries(part)) {
    const total = (into[modelId] ??= zeroCounts());
    for (const type of TOKEN_TYPES) {
      total[type] += counts[type];
    }
  }
}

/** leaseId -> modelId (null for the probe) -> per-type sums over the window. */
async function readCounts(
  input: ReadRegionTokenUsageInput,
  window: Window,
  modelsOf: (lease: TokenUsageLease) => (string | null)[],
): Promise<Map<string, Map<string | null, TokenCounts>>> {
  const queries: TokenQuery[] = [];
  for (const lease of window.leases) {
    for (const modelId of modelsOf(lease)) {
      for (const tokenType of TOKEN_TYPES) {
        const id = `q${queries.length}`;
        queries.push({
          id,
          leaseId: lease.leaseId,
          modelId,
          tokenType,
          query: metricQuery(id, lease.awsAccountId, tokenType, modelId),
        });
      }
    }
  }
  const sums = await fetchSums(input.cloudWatch, input.logger, window, queries);

  const counts = new Map<string, Map<string | null, TokenCounts>>();
  for (const lease of window.leases) {
    counts.set(
      lease.leaseId,
      new Map(modelsOf(lease).map((modelId) => [modelId, zeroCounts()])),
    );
  }
  for (const query of queries) {
    const sum = sums.get(query.id);
    if (sum === undefined) {
      throw new Error(`GetMetricData returned no result for query ${query.id}`);
    }
    counts.get(query.leaseId)!.get(query.modelId)![query.tokenType] = sum;
  }
  return counts;
}

function metricQuery(
  id: string,
  accountId: string,
  tokenType: TokenType,
  modelId: string | null,
): MetricDataQuery {
  return {
    Id: id,
    // A field on the query, not a dimension: as a dimension it returns an
    // empty series rather than an error.
    AccountId: accountId,
    MetricStat: {
      Metric: {
        Namespace: BEDROCK_METRIC_NAMESPACE,
        MetricName: BEDROCK_TOKEN_METRICS[tokenType],
        Dimensions:
          modelId === null
            ? undefined
            : [{ Name: BEDROCK_MODEL_DIMENSION, Value: modelId }],
      },
      Period: BEDROCK_METRIC_PERIOD_SECONDS,
      Stat: "Sum",
    },
  };
}

/**
 * Query id -> sum of the returned per-bucket sums, at most 500 queries a call
 * and every page followed: stopping at the first page truncates the counts
 * silently. A result in any state other than complete or continued is a
 * failure, not a zero.
 */
async function fetchSums(
  cloudWatch: CloudWatchClient,
  logger: Logger,
  window: Window,
  queries: TokenQuery[],
): Promise<Map<string, number>> {
  const sums = new Map<string, number>();
  for (let i = 0; i < queries.length; i += MAX_QUERIES_PER_CALL) {
    const chunk = queries.slice(i, i + MAX_QUERIES_PER_CALL);
    const ids = new Set(chunk.map((query) => query.id));
    const pages = paginateGetMetricData(
      { client: cloudWatch },
      {
        StartTime: new Date(window.startMs),
        EndTime: new Date(window.endMs),
        MetricDataQueries: chunk.map((query) => query.query),
      },
    );
    for await (const page of pages) {
      if (page.Messages?.length) {
        logger.warn("GetMetricData returned messages", {
          messages: page.Messages,
        });
      }
      addPageSums(page, ids, sums);
    }
  }
  return sums;
}

/** Adds one page's per-query sums into `sums`; a result that is not usable fails the read. */
function addPageSums(
  page: GetMetricDataCommandOutput,
  ids: Set<string>,
  sums: Map<string, number>,
): void {
  for (const result of page.MetricDataResults ?? []) {
    if (result.Id === undefined || !ids.has(result.Id)) {
      throw new Error(
        `GetMetricData returned a result for an unknown query id: ${result.Id}`,
      );
    }
    if (
      result.StatusCode !== "Complete" &&
      !(result.StatusCode === "PartialData" && page.NextToken)
    ) {
      const messages = result.Messages?.map((message) => message.Value);
      throw new Error(
        `GetMetricData failed for query ${result.Id}: ${result.StatusCode} ${messages?.join("; ") ?? ""}`.trimEnd(),
      );
    }
    const pageSum = (result.Values ?? []).reduce(
      (total, value) => total + value,
      0,
    );
    sums.set(result.Id, (sums.get(result.Id) ?? 0) + pageSum);
  }
}

/** One list-metrics call per account and run, however many batches ask at once. */
function modelIdsFor(
  cloudWatch: CloudWatchClient,
  cache: Map<string, Promise<string[]>>,
  accountId: string,
): Promise<string[]> {
  let listing = cache.get(accountId);
  if (listing === undefined) {
    listing = listModelIds(cloudWatch, accountId);
    cache.set(accountId, listing);
  }
  return listing;
}

/** The `ModelId` values the account has emitted Bedrock metrics for. */
async function listModelIds(
  cloudWatch: CloudWatchClient,
  accountId: string,
): Promise<string[]> {
  const modelIds = new Set<string>();
  const pages = paginateListMetrics(
    { client: cloudWatch },
    {
      Namespace: BEDROCK_METRIC_NAMESPACE,
      Dimensions: [{ Name: BEDROCK_MODEL_DIMENSION }],
      IncludeLinkedAccounts: true,
      OwningAccount: accountId,
    },
  );
  for await (const page of pages) {
    for (const metric of page.Metrics ?? []) {
      const modelId = metric.Dimensions?.find(
        (dimension) => dimension.Name === BEDROCK_MODEL_DIMENSION,
      )?.Value;
      if (modelId) {
        modelIds.add(modelId);
      }
    }
  }
  return [...modelIds].sort((a, b) => a.localeCompare(b));
}

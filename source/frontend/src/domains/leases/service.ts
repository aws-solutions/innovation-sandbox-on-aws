// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";

import {
  GetLeaseAssignmentsResponse,
  LeaseView,
  UpdateLeaseAssignmentsResponse,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  AssignmentPrincipalRef,
  BedrockTokenHistoryData,
  BreachHistoryData,
  CostHistoryCurrent,
  CostHistoryData,
  CostHistoryPageOptions,
  CostHistoryRange,
  CostHistoryResultRow,
  CostSummaryData,
  LeasePatchRequest,
  NewLeaseRequest,
  PredictedSegment,
  SharedLeasesResponse,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { registerApiSingletonReset } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";

import {
  createLeaseClient,
  SharedLeaseQueryAccessType,
  SmithyLeaseApi,
  SmithyLeaseClient,
} from "./smithy-client";

// The generated client does not enforce the model's range, and the endpoint 400s
// outside it.
export const COST_HISTORY_MAX_RESULTS = 100;

// How much cost history one drain holds: it stops once it has this many cost
// readings, past any span the spend chart stays legible over.
export const COST_HISTORY_MAX_READINGS = 5_000;

// How much token data one drain holds: it stops once it has this many token
// series rows, roughly 30 to 40 MB of them. A page carries up to 100 readings,
// each flattened to a row per region and model, so how many rows a page adds
// follows how many models the lease has used.
export const COST_HISTORY_MAX_TOKEN_ROWS = 200_000;

// The bound that does not depend on the server ending the sequence, which a drain
// the section is blocked on needs. A cost drain reaches the readings cap first; a
// token drain can reach this one first, but only past 20,000 readings, months of
// a lease busy at every poll. A breach drain has no other cap, so this one stops
// it, at 20,000 breaches.
export const COST_HISTORY_MAX_PAGES = 200;

/**
 * The segment from an older reading's total to what the newer reading projected
 * for its own instant, or undefined where the newer one projected nothing or the
 * span is not positive.
 */
const historicalSegment = (
  newer: CostHistoryResultRow,
  older: CostHistoryResultRow,
): PredictedSegment | undefined => {
  if (newer.predictedCostAtRefresh == null) {
    return undefined;
  }
  const from = DateTime.fromISO(older.timestamp);
  const to = DateTime.fromISO(newer.timestamp);
  const hours = to.diff(from, "hours").hours;
  if (!from.isValid || !to.isValid || hours <= 0) {
    return undefined;
  }
  return {
    fromTimestamp: older.timestamp,
    toTimestamp: newer.timestamp,
    startCost: older.billedCostAccrued,
    endCost: newer.predictedCostAtRefresh,
    rate: (newer.predictedCostAtRefresh - older.billedCostAccrued) / hours,
    rateSource: null,
  };
};

/**
 * The segment from the newest reading to the instant `current` describes, where
 * the range holds that reading. Its rate is the segment's own slope, so what the
 * chart draws and what it labels cannot disagree. Undefined where no projection
 * was made, so a billed figure is never drawn as an estimate.
 */
const currentSegment = (
  current: CostHistoryCurrent,
  range: CostHistoryRange | undefined,
): PredictedSegment | undefined => {
  const from = DateTime.fromISO(current.lastReportedAt);
  const to = DateTime.fromISO(current.lastCheckedAt);
  const hours = to.diff(from, "hours").hours;
  const inRange =
    (range?.afterTimestamp === undefined ||
      DateTime.fromISO(range.afterTimestamp) <= from) &&
    (range?.beforeTimestamp === undefined ||
      from < DateTime.fromISO(range.beforeTimestamp));
  if (
    current.rateSource == null ||
    !inRange ||
    !from.isValid ||
    !to.isValid ||
    hours <= 0
  ) {
    return undefined;
  }
  return {
    fromTimestamp: current.lastReportedAt,
    toTimestamp: current.lastCheckedAt,
    startCost: current.billedCostAccrued,
    endCost: current.predictedCost,
    rate: (current.predictedCost - current.billedCostAccrued) / hours,
    rateSource: current.rateSource,
  };
};

/**
 * The projection segments the spend chart draws, newest first: the current
 * one, then one per consecutive pair of the range's readings, which arrive
 * newest first. Built over the whole drain, so no pair is lost to a page
 * boundary.
 */
export const buildPredictedSegments = (
  result: CostHistoryResultRow[],
  current: CostHistoryCurrent | null | undefined,
  range: CostHistoryRange | undefined,
): PredictedSegment[] => {
  const currentProjection =
    current == null ? undefined : currentSegment(current, range);
  const segments: PredictedSegment[] =
    currentProjection === undefined ? [] : [currentProjection];
  for (let index = 0; index + 1 < result.length; index++) {
    const segment = historicalSegment(result[index], result[index + 1]);
    if (segment !== undefined) {
      segments.push(segment);
    }
  }
  return segments;
};

const clampMaxResults = (
  options: CostHistoryPageOptions,
): CostHistoryPageOptions => {
  const { maxResults, ...rest } = options;
  return {
    ...rest,
    ...(maxResults === undefined
      ? {}
      : {
          maxResults: Math.min(
            Math.max(Math.trunc(maxResults), 1),
            COST_HISTORY_MAX_RESULTS,
          ),
        }),
  };
};

type HistoryPage<Row> = {
  result: Row[];
  nextPageIdentifier?: string | null;
};

type HistoryDrain<Row> = {
  /** Names the history in what a drain that stops or fails says. */
  label: string;
  read: (options: CostHistoryPageOptions) => Promise<HistoryPage<Row>>;
  /** The rows the drain stops at, once it holds them. */
  cap: number;
  /** The page size to ask for, given the rows held so far; full pages if unset. */
  pageSize?: (rows: number) => number;
};

/**
 * Drains one history's opaque cursor before exposing data to the section that
 * asked for it, so it never labels a partial page as the whole selected range.
 * The drain is capped rather than run to exhaustion: the section renders nothing
 * until it finishes, so the length of the sequence cannot be left to the server.
 * Stopping early keeps the unconsumed cursor, which is how the range says it is
 * unfinished.
 */
const drainHistory = async <Row>(
  { label, read, cap, pageSize }: HistoryDrain<Row>,
  range: CostHistoryRange | undefined,
): Promise<{ result: Row[]; nextPageIdentifier: string | null }> => {
  const result: Row[] = [];
  const seenPageIdentifiers = new Set<string>();
  let pageIdentifier: string | undefined;
  let pages = 0;

  do {
    const page = await read({
      ...range,
      maxResults: pageSize?.(result.length) ?? COST_HISTORY_MAX_RESULTS,
      ...(pageIdentifier === undefined ? {} : { pageIdentifier }),
    });
    pages++;
    result.push(...page.result);

    const nextPageIdentifier = page.nextPageIdentifier ?? undefined;
    if (
      nextPageIdentifier !== undefined &&
      seenPageIdentifiers.has(nextPageIdentifier)
    ) {
      throw new Error(`Lease ${label} returned a repeated page cursor.`);
    }
    if (nextPageIdentifier !== undefined) {
      seenPageIdentifiers.add(nextPageIdentifier);
    }
    pageIdentifier = nextPageIdentifier;
  } while (
    pageIdentifier !== undefined &&
    result.length < cap &&
    pages < COST_HISTORY_MAX_PAGES
  );

  if (pageIdentifier !== undefined) {
    console.warn(
      `[LeaseService] The ${label} drain stopped at ${result.length} rows and ${pages} pages (caps ${cap} and ${COST_HISTORY_MAX_PAGES}). The range is reported as unfinished.`,
    );
  }

  return { result, nextPageIdentifier: pageIdentifier ?? null };
};

export class LeaseService {
  constructor(private readonly api: SmithyLeaseApi) {}

  async getLeases(userEmail?: string): Promise<LeaseView[]> {
    let allLeases: LeaseView[] = [];
    let nextPageIdentifier: string | null = null;

    // keep calling the API until all leases are collected
    do {
      const response = await this.api.listLeases(
        nextPageIdentifier ?? undefined,
        userEmail,
      );
      allLeases = [...allLeases, ...response.result];
      nextPageIdentifier = response.nextPageIdentifier;
    } while (nextPageIdentifier !== null);

    return allLeases;
  }

  async getLeaseById(id: string): Promise<LeaseView | undefined> {
    return this.api.getLease(id);
  }

  async requestNewLease(request: NewLeaseRequest): Promise<void> {
    await this.api.requestLease(request);
  }

  async updateLease(request: LeasePatchRequest): Promise<void> {
    await this.api.updateLease(request);
  }

  async reviewLease(leaseId: string, approve: boolean): Promise<void> {
    await this.api.reviewLease(leaseId, approve);
  }

  async terminateLease(leaseId: string): Promise<void> {
    await this.api.terminateLease(leaseId);
  }

  async freezeLease(leaseId: string): Promise<void> {
    await this.api.freezeLease(leaseId);
  }

  async unfreezeLease(leaseId: string): Promise<void> {
    await this.api.unfreezeLease(leaseId);
  }

  async getAssignments(leaseId: string): Promise<GetLeaseAssignmentsResponse> {
    return this.api.getAssignments(leaseId);
  }

  async updateAssignments(
    leaseId: string,
    assignments: AssignmentPrincipalRef[],
  ): Promise<UpdateLeaseAssignmentsResponse> {
    return this.api.updateAssignments(leaseId, assignments);
  }

  async getSharedLeases(
    userId: string,
    accessType: SharedLeaseQueryAccessType,
  ): Promise<SharedLeasesResponse> {
    const allResults: SharedLeasesResponse["result"] = [];
    let nextPageIdentifier: string | undefined;
    const maxResults = 100;
    const MAX_PAGES = 50;
    let pageCount = 0;

    do {
      const response = await this.api.listSharedLeases(
        userId,
        accessType,
        maxResults,
        nextPageIdentifier,
      );
      allResults.push(...response.result);
      nextPageIdentifier = response.nextPageIdentifier ?? undefined;
      pageCount++;
    } while (nextPageIdentifier && pageCount < MAX_PAGES);

    if (pageCount >= MAX_PAGES && nextPageIdentifier) {
      console.warn(
        `[LeaseService] getSharedLeases hit MAX_PAGES (${MAX_PAGES}) limit. Results may be incomplete.`,
      );
    }

    return {
      result: allResults,
      nextPageIdentifier: nextPageIdentifier ?? null,
    };
  }

  async getLeaseCostSummary(leaseId: string): Promise<CostSummaryData> {
    return this.api.getLeaseCostSummary(leaseId);
  }

  async getLeaseCostHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<CostHistoryData> {
    return this.api.getLeaseCostHistory(leaseId, clampMaxResults(options));
  }

  async getLeaseBedrockTokenHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BedrockTokenHistoryData> {
    return this.api.getLeaseBedrockTokenHistory(
      leaseId,
      clampMaxResults(options),
    );
  }

  async getLeaseBreachHistory(
    leaseId: string,
    options: CostHistoryPageOptions,
  ): Promise<BreachHistoryData> {
    return this.api.getLeaseBreachHistory(leaseId, clampMaxResults(options));
  }

  async getMergedLeaseCostHistory(
    leaseId: string,
    range?: CostHistoryRange,
  ): Promise<CostHistoryData> {
    return drainHistory(
      {
        label: "cost history",
        read: (options) => this.getLeaseCostHistory(leaseId, options),
        cap: COST_HISTORY_MAX_READINGS,
        // No more readings than the cap still has room for: a page can return
        // fewer than it was asked for, so a full page after it would carry the
        // total past the cap.
        pageSize: (readings) =>
          Math.min(
            COST_HISTORY_MAX_RESULTS,
            COST_HISTORY_MAX_READINGS - readings,
          ),
      },
      range,
    );
  }

  async getMergedLeaseBedrockTokenHistory(
    leaseId: string,
    range?: CostHistoryRange,
  ): Promise<BedrockTokenHistoryData> {
    // Full pages throughout: a page's readings each add a row per region and
    // model, so no page size keeps the total to its cap.
    return drainHistory(
      {
        label: "Bedrock token history",
        read: (options) => this.getLeaseBedrockTokenHistory(leaseId, options),
        cap: COST_HISTORY_MAX_TOKEN_ROWS,
      },
      range,
    );
  }

  async getMergedLeaseBreachHistory(
    leaseId: string,
    range?: CostHistoryRange,
  ): Promise<BreachHistoryData> {
    // No cap of its own: the page cap stops it.
    return drainHistory(
      {
        label: "breach history",
        read: (options) => this.getLeaseBreachHistory(leaseId, options),
        cap: Number.POSITIVE_INFINITY,
      },
      range,
    );
  }
}

let leaseService: LeaseService | undefined;

// Lazily-initialized singleton.
export function getLeaseService(): LeaseService {
  leaseService ??= new LeaseService(new SmithyLeaseClient(createLeaseClient()));
  return leaseService;
}

registerApiSingletonReset(() => {
  leaseService = undefined;
});

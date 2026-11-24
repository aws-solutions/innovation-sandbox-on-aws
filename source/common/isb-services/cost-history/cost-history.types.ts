// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import {
  CostHistoryPageOptions,
  CostHistoryWindow,
  NewestRecordResult,
  PagedQueryResult,
  RecentCostObservationsResult,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BedrockTokenRow,
  BreachRecord,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { LeaseDailyCostBucket } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { CostObservationPoint } from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import type { DroppedRecordReason } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import {
  Lease,
  MonitoredLease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

/**
 * Narrow structural view of the cost-history store this module needs,
 * declared consumer-side; the concrete store satisfies it structurally.
 */
export interface CostHistoryStoreLike {
  appendCostObservation(row: NewCostObservation): Promise<unknown>;
  getNewestCostObservation(
    leaseUuid: string,
  ): Promise<NewestRecordResult<CostObservation>>;
  getRecentCostObservations(
    leaseUuid: string,
    options: { limit: number },
  ): Promise<RecentCostObservationsResult>;
  getNewestBedrockTokenRow(
    leaseUuid: string,
  ): Promise<NewestRecordResult<BedrockTokenRow>>;
  listCostObservations(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<CostObservation>>;
  listBreachRecordPage(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BreachRecord>>;
  listBedrockTokenRows(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BedrockTokenRow>>;
}

/** A cost observation row ready to append; the store stamps `sk` and `meta`. */
export type NewCostObservation = Omit<CostObservation, "sk" | "meta">;

/**
 * A stored reading for the rate math, plus the breakdown the insight differences
 * and the fields the cost history API's headline figures read off the newest row.
 */
export type RecentObservationPoint = CostObservationPoint &
  Pick<
    CostObservation,
    | "serviceBreakdown"
    | "breakdownCoversFrom"
    | "latestPeriodStart"
    | "billedBedrockTokenCost"
  >;

/**
 * The series, and what reading it lost. The drop pair is carried rather than only
 * logged, so a caller cannot read an empty series as a lease with no spend.
 */
export interface RecentObservations {
  points: RecentObservationPoint[];
  droppedRecordCount?: number;
  droppedRecordReason?: DroppedRecordReason;
}

/**
 * Where this run's spend for a lease came from. A tag-served lease carries the
 * per-day buckets the anchoring arithmetic resumes from; a lease the legacy
 * account fallback served has only a total re-summed from its start, so its
 * row is stored so that a later run re-sums in full rather than resuming.
 */
export type LeaseCostSource =
  | { kind: "TAG"; buckets: Record<string, LeaseDailyCostBucket> }
  | { kind: "FALLBACK"; billedCostAccrued: number };

export interface RecordCostObservationInput {
  lease: MonitoredLease;
  /**
   * The lease's newest stored observation, read once by the caller: it sizes
   * the fleet query window before the Cost Explorer call and anchors this
   * run's reading after it.
   */
  anchor: NewestRecordResult<CostObservation>;
  source: LeaseCostSource;
  /** Projection standing before this reading re-based it; null while no rate existed. */
  predictedCostAtRefresh: number | null;
  /** The token-priced Bedrock slice this run; null when monitoring is off for the lease. */
  bedrockTokens: BedrockTokenSource | null;
  /** `leases.ttl` from global config, in days. */
  retentionDays: number;
}

/**
 * What the usage-type query yielded for one lease: the token-priced cost per
 * `yyyy-MM-dd` day, grouped by the lease tag over the main query's window for
 * a tag-served lease, and by account from no later than its start day for a
 * fallback-served one. Empty for a monitored lease with no token spend, which
 * stores 0.00 rather than nothing.
 */
export interface BedrockTokenSource {
  costByDay: Record<string, number>;
}

/**
 * What the run should write to the lease record: `billedCostAccrued` is the figure
 * evaluation used, so `totalCostAccrued` is written from exactly this number.
 * `NO_DATA` means the source carried nothing for the lease this run, so the
 * anchor's figure stands (undefined when there is no anchor either). An
 * unreadable anchor is not "no history": treating it so would restart the
 * cumulative from zero and re-arm every fired threshold.
 */
export type RecordCostObservationResult =
  | { status: "APPENDED"; observation: NewCostObservation }
  | { status: "UNCHANGED"; billedCostAccrued: number }
  | { status: "NO_DATA"; billedCostAccrued: number | undefined }
  | { status: "ANCHOR_UNREADABLE"; droppedRecordReason: DroppedRecordReason };

/** A lease's resume point for the fleet-wide query window. */
export interface CostQueryAnchor {
  startDate: string; // ISO 8601
  newest: CostObservation | undefined;
}

export interface CostHistoryServices {
  costHistoryStore: CostHistoryStoreLike;
  logger: Logger;
}

/**
 * One page of a lease history read. `range` restricts which rows are considered
 * at all, and the cursor pages within it.
 */
export interface LeaseHistoryPageRequest {
  lease: Lease;
  maxResults: number;
  pageIdentifier?: string;
  range?: CostHistoryWindow;
}

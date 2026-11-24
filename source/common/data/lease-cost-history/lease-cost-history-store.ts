// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BedrockTokenRow,
  BedrockTokenSkSchema,
  BreachRecord,
  BreachSkSchema,
  CostObservation,
  CostSkSchema,
  IsoMillisSchema,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import type { DroppedRecordReason } from "@amzn/innovation-sandbox-shared/types/cost-history.js";

export type CostHistoryWindow = { from: string; to: string };

/** One page of one row type, newest first, optionally restricted to a window. */
export type CostHistoryPageOptions = {
  pageSize: number;
  pageIdentifier?: string;
  window?: CostHistoryWindow;
};

/**
 * Versioned envelope for an opaque cost-history page cursor, for any of the three
 * row types. The type is the prefix of `key.sk`, so a cursor cannot be replayed
 * against another type's read, and the original key condition is carried with the
 * DynamoDB key so it cannot be replayed against a different bounded or unbounded
 * query either.
 */
export const CostHistoryPageIdentifierSchema = z
  .object({
    version: z.literal(1),
    key: z
      .object({
        // The partition key's own shape, as every other lease identifier in the
        // model spells it. The reader also equality-checks this against the lease
        // being read, so the pin is what a forged cursor fails first rather than
        // the only thing standing between one and another lease's rows.
        leaseUuid: z.uuid(),
        sk: z.union([CostSkSchema, BedrockTokenSkSchema, BreachSkSchema]),
      })
      .strict(),
    window: z
      .object({ from: IsoMillisSchema, to: IsoMillisSchema })
      .strict()
      .nullable(),
  })
  .strict();

/**
 * The cursor for a page that resumes below `key`, the last row the page read, or
 * where a size budget stopped it, the last row it kept: the next page's rows are the
 * ones strictly older than it. Validated on the way out as well as in, so the store
 * cannot mint a cursor it would then reject.
 */
export function encodeCostHistoryPageIdentifier(
  key: Record<string, unknown>,
  window: CostHistoryWindow | null,
): string {
  return base64EncodeCompositeKey(
    CostHistoryPageIdentifierSchema.parse({ version: 1, key, window }),
  )!;
}

export class InvalidCostHistoryPageIdentifierError extends Error {
  public constructor() {
    super("pageIdentifier is not a valid pagination cursor.");
    this.name = "InvalidCostHistoryPageIdentifierError";
  }
}

/**
 * A count and a reason class, never the zod message, which names stored attributes
 * and sort-key patterns. The implementation logs the detail instead.
 */
type DroppedRecords = {
  droppedRecordCount?: number;
  droppedRecordReason?: DroppedRecordReason;
};

/** Rows newest-first with no cursor. */
export type WindowedQueryResult<T> = DroppedRecords & {
  result: T[];
};

/** The same, plus an opaque cursor. */
export type PagedQueryResult<T> = WindowedQueryResult<T> & {
  nextPageIdentifier: string | null;
};

/**
 * One newest row. Discriminated so a caller cannot read a corrupt newest row as
 * an absent one: this is the resume anchor and the source of the reported total,
 * so treating corruption as "no history" restarts the cumulative from zero and
 * re-arms every fired threshold.
 */
export type NewestRecordResult<T> =
  | { complete: true; result?: T }
  | {
      complete: false;
      droppedRecordCount: number;
      droppedRecordReason: DroppedRecordReason;
    };

/**
 * A window read whose drop is required, not discriminated: withholding the whole
 * window would discard every readable row over one unparseable row.
 */
export type AuditedWindowQueryResult<T> = {
  result: T[];
  droppedRecordCount: number;
  droppedRecordReason: DroppedRecordReason | null;
};

/**
 * Discriminated so a caller cannot reach a shortened series. Withholding is
 * all-or-nothing: this series feeds the spend rate, and a series with a hole yields
 * a confidently wrong rate where no series yields no rate. One dropped row
 * therefore costs the rate, so check `droppedRecordReason` before alarming.
 */
export type RecentCostObservationsResult =
  | { complete: true; result: CostObservation[] }
  | {
      complete: false;
      droppedRecordCount: number;
      droppedRecordReason: DroppedRecordReason;
    };

/**
 * Store for the lease cost history table.
 *
 * An abstract class rather than an interface, following CleanupReportStore.
 *
 * Three record types share one partition, discriminated by sort-key prefix. The
 * API reads one type per request, each paged on its own.
 *
 * Rows are appended, never updated.
 */
export abstract class LeaseCostHistoryStore {
  /** Append a reported cost observation (`COST#<timestamp>`). */
  abstract appendCostObservation(
    row: Omit<CostObservation, "sk" | "meta">,
  ): Promise<CostObservation>;

  /** Append a Bedrock token row (`BEDROCK_TOKEN#<timestamp>`). */
  abstract appendBedrockTokenRow(
    row: Omit<BedrockTokenRow, "sk" | "meta">,
  ): Promise<BedrockTokenRow>;

  /**
   * Append a threshold breach record (`BREACH#<timestamp>`).
   *
   * Three obligations on the caller, none of them inferable from the signature:
   *
   * 1. THROWS on any write failure, rather than returning a result, so a fired
   *    threshold can never end up with no audit row and no signal. Isolate the call
   *    per lease so one lease's failure does not end a fleet scan.
   * 2. NOT IDEMPOTENT. The sort key is wall-clock-derived, so a retry appends the
   *    same logical breach again. Anything counting fires must de-duplicate on
   *    `triggeredBy` plus that branch's threshold field. No run identifier is
   *    carried.
   * 3. AWAIT EACH APPEND. On collision the implementation walks the timestamp
   *    forward a millisecond at a time, bounded, so parallel appends sharing one
   *    `now()` can exhaust the walk and throw.
   */
  abstract appendBreachRecord(
    row: Omit<BreachRecord, "sk" | "meta">,
  ): Promise<BreachRecord>;

  /**
   * The newest COST observation for a lease, or an empty result where the
   * lease has none. Implemented with `ScanIndexForward: false, Limit: 1` over
   * `begins_with(sk, "COST#")` -- this is the resume anchor for the narrowed
   * query window and the source of the reported total.
   */
  abstract getNewestCostObservation(
    leaseUuid: string,
  ): Promise<NewestRecordResult<CostObservation>>;

  /** The newest BEDROCK_TOKEN row for a lease. Same shape as above. */
  abstract getNewestBedrockTokenRow(
    leaseUuid: string,
  ): Promise<NewestRecordResult<BedrockTokenRow>>;

  /**
   * The newest BEDROCK_TOKEN row stamped at or before `timestamp` (ISO 8601):
   * the monitored Bedrock figure as it stood at that instant, since rows land only
   * when counts move and the figure is flat between them. Same shape as above.
   */
  abstract getNewestBedrockTokenRowAtOrBefore(
    leaseUuid: string,
    timestamp: string,
  ): Promise<NewestRecordResult<BedrockTokenRow>>;

  /**
   * The most recent COST observations for a lease, newest first. Callers ask
   * for enough rows to reach 24 hours back for the daily spend rate. Not
   * paginated -- it is a bounded lookback, not a page.
   *
   * Returns a discriminated result rather than an optional error field, because
   * this feeds the spend rate and a partial series is worse here than none.
   */
  abstract getRecentCostObservations(
    leaseUuid: string,
    options: { limit: number },
  ): Promise<RecentCostObservationsResult>;

  /**
   * Paginated COST observations for the API, newest first. Returns a
   * `PagedQueryResult` whose `nextPageIdentifier` is an opaque cursor.
   *
   * `window` restricts which observations are visible at all, and pagination then
   * runs inside it. Both bounds or neither: a single sort-key condition is all
   * DynamoDB allows, so one bound would have to be an open-ended comparison that
   * also takes the rows sorting below `COST#`. Callers fill the missing side.
   */
  abstract listCostObservations(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<CostObservation>>;

  /**
   * Paginated BREACH records for the API, newest first, paged and windowed as
   * {@link listCostObservations} is.
   */
  abstract listBreachRecordPage(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BreachRecord>>;

  /**
   * Every BREACH record within a window. Not paginated, for a caller that needs
   * the whole window in one read.
   */
  abstract listBreachRecords(
    leaseUuid: string,
    options: { from: string; to: string },
  ): Promise<AuditedWindowQueryResult<BreachRecord>>;

  /**
   * Paginated BEDROCK_TOKEN rows for the API, newest first, paged and windowed as
   * {@link listCostObservations} is. They are written every poll while counts move,
   * so a page also stops at a size budget, which can end it short of `pageSize`
   * with a cursor still to follow; never in the middle of a row, since each row is
   * one whole reading.
   */
  abstract listBedrockTokenRows(
    leaseUuid: string,
    options: CostHistoryPageOptions,
  ): Promise<PagedQueryResult<BedrockTokenRow>>;
}

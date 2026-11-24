// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { z } from "zod";

/**
 * IDC user id, e.g. "6468b488-8041-70f5-1a43-d72b09d909aa".
 * Shared across all Sandbox Spaces usage item shapes that carry a userId.
 */
export const SandboxSpacesUserIdSchema = z
  .string()
  .regex(/^[a-zA-Z0-9-]+$/)
  .min(5)
  .max(300);

// ─── Lease-scoped Sandbox Spaces usage ───────────────────────────────────────
//
// Bedrock bills four token types at four different rates, so a turn's cost is
// only correct when all four are metered separately. Spend is denominated in
// USD to match the lease's existing cost fields (`maxSpend`,
// `totalCostAccrued`) rather than in tokens or cents.

/**
 * Thrown when a persisted Sandbox Spaces usage item cannot be parsed.
 * Callers must not silently treat malformed persisted data as zero; reporting
 * paths may propagate the error or explicitly omit the affected value.
 */
export class MalformedSandboxSpacesUsageRecordError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MalformedSandboxSpacesUsageRecordError";
  }
}

/** Number of decimal places estimated token cost is rounded to before it is banked. */
export const SPEND_DECIMAL_PLACES = 6;

/**
 * Rounds a USD amount to {@link SPEND_DECIMAL_PLACES}. Per-token rates are
 * quoted to more places than that, so rounding at the write boundary keeps the
 * counters from accumulating float drift across thousands of turns.
 */
export function roundSpend(usd: number): number {
  const factor = 10 ** SPEND_DECIMAL_PLACES;
  return Math.round(usd * factor) / factor;
}

/** The four Bedrock token types, each billed at its own rate. */
export const SandboxSpacesTokenUsageSchema = z.object({
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
});

export type SandboxSpacesTokenUsage = z.infer<
  typeof SandboxSpacesTokenUsageSchema
>;

/** Base fields shared by lease-scoped Sandbox Spaces usage records. */
export const LeaseSandboxSpacesUsageSchema = z.object({
  leaseId: z.uuid(),
  sandboxSpacesEstimatedTokenCostAccrued: z.number().nonnegative(),
  invocationCount: z.number().int().nonnegative(),
  inputTokens: z.number().int().nonnegative(),
  outputTokens: z.number().int().nonnegative(),
  cacheReadTokens: z.number().int().nonnegative(),
  cacheWriteTokens: z.number().int().nonnegative(),
  firstSeenAt: z.iso.datetime(),
  lastSeenAt: z.iso.datetime(),
});

export type LeaseSandboxSpacesUsage = z.infer<
  typeof LeaseSandboxSpacesUsageSchema
>;

/**
 * Per-user Sandbox Spaces usage on one lease
 * (`LEASE#{leaseId}` / `SANDBOX_SPACES_USAGE#USER#{userId}`). Attribution
 * only: the lease budget is the only enforced ceiling.
 */
export const LeaseUserSandboxSpacesUsageSchema =
  LeaseSandboxSpacesUsageSchema.extend({
    userId: SandboxSpacesUserIdSchema,
    /** Latest known email, for people reading the row; absent on older rows. */
    userEmail: z.email().optional(),
  });

export type LeaseUserSandboxSpacesUsage = z.infer<
  typeof LeaseUserSandboxSpacesUsageSchema
>;

export interface RecordTurnUsageProps {
  leaseId: string;
  userId: string;
  /** Written on the two user-keyed rows; overwritten each turn so it tracks email changes. */
  userEmail: string;
  /** Sort key of the monthly rollup, in MONTH#{YYYY-MM} format. */
  month: string;
  tokens: SandboxSpacesTokenUsage;
  /** Estimated token cost in USD for this turn. Rounded to {@link SPEND_DECIMAL_PLACES}. */
  sandboxSpacesEstimatedTokenCostAccrued: number;
  /** Recorded on the monthly rollup for cross-system lookups. */
  sessionId?: string;
}

export interface SandboxSpacesUsageStore {
  /**
   * Stamps `ttl` on every per-user usage item for a lease so the attribution
   * records expire with the lease. Call at lease termination.
   */
  stampLeaseTtl(leaseId: string, ttlEpochSeconds: number): Promise<void>;

  /**
   * Banks one turn's cost in a single TransactWriteItems: two atomic ADDs to
   * SANDBOX_SPACES_USAGE#USER#{userId} and USER#/MONTH#.
   */
  recordTurnUsage(props: RecordTurnUsageProps): Promise<void>;

  /**
   * Returns one user's usage on a lease (`SANDBOX_SPACES_USAGE#USER#{userId}`),
   * strongly consistent. Null if the user has no recorded turns. Throws
   * {@link MalformedSandboxSpacesUsageRecordError} on an unparseable row.
   */
  getLeaseUserUsage(
    leaseId: string,
    userId: string,
  ): Promise<LeaseUserSandboxSpacesUsage | null>;

  /**
   * Returns per-user attribution usage. Corrupt rows are excluded and reported
   * via `error` rather than failing the whole read (attribution-only, not enforcement).
   */
  listLeaseUserUsage(
    leaseId: string,
  ): Promise<{ usage: LeaseUserSandboxSpacesUsage[]; error?: string }>;
}

// ─── Key construction ────────────────────────────────────────────────────────
//
// `userId` and the `USER#` token are used throughout, matching the shipped
// monthly item. An earlier design draft used `actorId`/`ACTOR#`; the
// persistence layer never adopted that spelling and should not now.

/** Partition key for every lease-scoped Sandbox Spaces usage item. */
export function leaseUsagePk(leaseId: string): string {
  return `LEASE#${leaseId}`;
}

/** Partition key for the per-user monthly rollup. */
export function userUsagePk(userId: string): string {
  return `USER#${userId}`;
}

/** Sort-key prefix of the per-user attribution Query matches on. */
export const LEASE_USER_USAGE_SK_PREFIX = "SANDBOX_SPACES_USAGE#USER#";

export function leaseUserUsageSk(userId: string): string {
  return `${LEASE_USER_USAGE_SK_PREFIX}${userId}`;
}

/** Returns the current UTC month formatted as the DynamoDB sort key used by SandboxSpacesUsageStore (e.g. "MONTH#2024-01"). */
export function currentMonthKey(): string {
  return `MONTH#${DateTime.utc().toFormat("yyyy-MM")}`;
}

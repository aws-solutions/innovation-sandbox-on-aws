// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { DateTime, DateTimeMaybeValid } from "luxon";
import { z } from "zod";

import {
  BEDROCK_TOKEN_SK_PREFIX,
  BREACH_SK_PREFIX,
  COST_SK_PREFIX,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  calculateTtlInEpochSeconds,
  now,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  BreachActionSchema,
  BreachEvaluatedBySchema,
  BreachTriggeredBySchema,
  InsightKindSchema,
  RateBasisSchema,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-shared/types/lease.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseCostHistorySchemaVersion = 1;

// Exported so the store can classify a drop from the stored version alone, rather
// than inferring it from which issues a failed parse happened to produce.
export const LeaseCostHistorySupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseCostHistorySchemaVersion,
);

// Applied to each record schema below with `.extend(...shape)`, not `.merge(...)`.
// The sibling stores use `.merge`, but zod 4 deprecates it and SonarQube's S1874
// counts a deprecated API against new code only -- so the existing call sites are
// unaffected while these three would have been flagged. The two are equivalent for
// plain objects, and `.strict()` is applied after either, so the strip/strict mode
// is unchanged.
const LeaseCostHistoryItemWithMetadataSchema = createItemWithMetadataSchema(
  LeaseCostHistorySupportedVersionsSchema,
);

/**
 * Partition key: the lease's own identifier, the value carried in the
 * `ISB:LeaseId` tag. Not the base64url composite key used in API paths, and not
 * the AWS account ID.
 *
 * Pairing a domain-named partition key with a generic `sk` has precedent:
 * ConfigTable uses `partitionKey: { name: "section" }, sortKey: { name: "sk" }`
 * (infrastructure/lib/isb-data-resources.ts).
 */
const LeaseUuidSchema = LeaseKeySchema.shape.uuid;

// Sort keys are `<PREFIX><iso8601>` from `nowAsIsoDatetimeString()`, pinned to
// the fixed millisecond form so lexicographic order matches chronological
// order. See lease-cost-history-keys.ts for why.
// `String.raw` keeps the pattern readable when interpolated into `RegExp`.
const ISO_MILLIS_PATTERN = String.raw`\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z`;
// Exported for the store: a pagination cursor is validated against them before it
// reaches ExclusiveStartKey, so a cursor naming no row of these types cannot be
// passed through.
export const CostSkSchema = z
  .string()
  .regex(new RegExp(`^${COST_SK_PREFIX}${ISO_MILLIS_PATTERN}$`));
export const BreachSkSchema = z
  .string()
  .regex(new RegExp(`^${BREACH_SK_PREFIX}${ISO_MILLIS_PATTERN}$`));
export const BedrockTokenSkSchema = z
  .string()
  .regex(new RegExp(`^${BEDROCK_TOKEN_SK_PREFIX}${ISO_MILLIS_PATTERN}$`));

// Same fixed width, for values compared across regions: `z.iso.datetime()` also
// admits seconds-only and microsecond forms. Exported because the store's window
// queries bound the sort key with it, and a bound of another width compares
// wrong against the fixed-width keys rather than failing.
export const IsoMillisSchema = z
  .string()
  .regex(new RegExp(`^${ISO_MILLIS_PATTERN}$`));

/**
 * Epoch SECONDS. The floor rejects a millisecond epoch, which lands in year
 * ~55000. The ceiling is relative to the parse rather than a fixed far-future
 * date, because a fixed one admits the failure the bound exists to catch: a row
 * stamped decades out is one DynamoDB never acts on, and a lease and its cost
 * history must not outlive each other.
 */
const TTL_EPOCH_SECONDS_MIN = 1735689600; // 2025-01-01T00:00:00Z
// The longest lease the config permits plus the longest retention window it
// permits: the furthest ahead `calculateCostHistoryTtl` can stamp. Derived so
// raising either bound moves it, instead of rejecting a long lease's writes.
const TTL_MAX_DAYS_AHEAD =
  CONFIG_BOUNDS.MAX_DURATION_HOURS / 24 + CONFIG_BOUNDS.MAX_TTL_DAYS;
const TtlSchema = z
  .number()
  .int()
  .min(TTL_EPOCH_SECONDS_MIN)
  .refine(
    (ttl) =>
      ttl <=
      Math.floor(
        // The project's clock, not DateTime.now(): the store's write-time guard
        // uses it too, so one write path has one mockable clock and this bound's
        // accept/reject boundary can be pinned by a test.
        now().plus({ days: TTL_MAX_DAYS_AHEAD }).valueOf() / 1000,
      ),
    { message: `must be at most ${TTL_MAX_DAYS_AHEAD} days ahead` },
  );

/**
 * The `ttl` a producer stamps on a row: the lease's own end plus the operator's
 * `leases.ttl` retention window, so a lease and its cost history cannot outlive
 * each other. A lease with no end at all -- `requireMaxDuration` off, no
 * `expirationDate` and no duration -- has no expiry to anchor to, so the row's own
 * insert is the anchor. The anchor is the lease's end rather than `leases.ttl`
 * because an Active or Frozen lease carries no `ttl` at all: `MonitoredLeaseSchema`
 * omits it, and only the denied and expired shapes stamp one.
 *
 * Known limitation: rows written before a lease extension carry the pre-extension
 * expiry, and an append-only table cannot re-stamp them, so an extended lease
 * loses its earliest history.
 */
export function calculateCostHistoryTtl(props: {
  retentionDays: number;
  expirationDate?: string;
  startDate?: string;
  leaseDurationInHours?: number;
}): number {
  const { retentionDays, expirationDate, startDate, leaseDurationInHours } =
    props;
  // `leases.ttl` is capped on write but deliberately uncapped on read, so a
  // stored value can exceed the cap TTL_MAX_DAYS_AHEAD is derived from. Losing
  // retention past MAX_TTL_DAYS beats failing every write against TtlSchema.
  const boundedRetentionDays = Math.min(
    retentionDays,
    CONFIG_BOUNDS.MAX_TTL_DAYS,
  );
  const leaseEnd = resolveLeaseEnd({
    expirationDate,
    startDate,
    leaseDurationInHours,
  });
  if (leaseEnd === undefined) {
    return calculateTtlInEpochSeconds(boundedRetentionDays);
  }
  return Math.floor(
    leaseEnd.plus({ days: boundedRetentionDays }).valueOf() / 1000,
  );
}

function resolveLeaseEnd(props: {
  expirationDate?: string;
  startDate?: string;
  leaseDurationInHours?: number;
}): DateTime<true> | undefined {
  const { expirationDate, startDate, leaseDurationInHours } = props;
  // An unreadable end throws rather than falling through: the fallbacks handle a
  // lease with no end, and the insert-anchored one stamps a SHORTER ttl, so a
  // corrupt value would discard cost history while the lease is still running.
  if (expirationDate !== undefined) {
    return requireValid(parseDatetime(expirationDate), "expirationDate");
  }
  if (startDate === undefined || leaseDurationInHours === undefined) {
    return undefined;
  }
  const start = requireValid(parseDatetime(startDate), "startDate");
  return requireValid(
    start.plus({ hours: leaseDurationInHours }),
    "leaseDurationInHours",
  );
}

function requireValid(
  candidate: DateTimeMaybeValid,
  field: string,
): DateTime<true> {
  if (candidate.isValid) {
    return candidate;
  }
  throw new Error(
    `Cannot derive a lease-cost-history ttl: ${field} is unusable.`,
  );
}

/** The four non-overlapping CloudWatch token metrics. */
// Strict, like every other object schema here. Strictness does not reach nested
// objects, and this one sits two `boundedRecord` levels down -- so without it a
// fifth token type is silently stripped on read from a row whose `monitoredBedrockTokenCost` was
// computed at write time from the full set, leaving the two disagreeing with no
// drop, count or warning.
const TokenQuadSchema = z
  .object({
    input: z.number().nonnegative(),
    output: z.number().nonnegative(),
    cacheRead: z.number().nonnegative(),
    cacheWrite: z.number().nonnegative(),
  })
  .strict();

// Service names, region codes and model IDs come from an AWS response, so the
// maps keyed on them are bounded rather than trusted. A row is ~1.4 KB for 27
// services; nothing else holds it to that.
const MAX_MAP_KEYS = 200;
const MAX_MAP_KEY_LENGTH = 256;

/**
 * Serialized ceiling for one row, under DynamoDB's 400 KB item limit with room
 * for the attribute-name overhead the JSON form does not carry. Bounds the
 * aggregate the per-level key caps do not.
 */
const MAX_ITEM_BYTES = 300_000;

/** Below a hundredth of a cent is zero for the empty-row rule. */
const ZERO_COST_TOLERANCE = 1e-9;
const serializedSize = (row: unknown) =>
  Buffer.byteLength(JSON.stringify(row) ?? "");
const boundedRecord = <T extends z.ZodType>(value: T) =>
  z
    .record(z.string().min(1).max(MAX_MAP_KEY_LENGTH), value)
    .refine((map) => Object.keys(map).length <= MAX_MAP_KEYS, {
      message: `must hold at most ${MAX_MAP_KEYS} keys`,
    });

/** A reported cost observation (`COST#<iso8601>`). */
export const CostObservationSchema = z
  .object({
    leaseUuid: LeaseUuidSchema,
    sk: CostSkSchema,
    // Unbounded in magnitude and signed: Cost Explorer restatements are
    // permitted, so a negative delta is correct. The plausibility bound on the
    // magnitude is owned by the producer.
    /** Cumulative for the lease, summed from Cost Explorer's daily buckets. */
    billedCostAccrued: z.number(),
    /** Increase since the previous observation. */
    billedCostDelta: z.number(),
    /** The projection this reading re-based; null while no rate existed. */
    predictedCostAtRefresh: z.number().nullable(),
    /**
     * `TimePeriod.Start` of the newest (still-filling) bucket. Pinned to Cost
     * Explorer's day form: it is differenced to size the resume window, so a
     * malformed value mis-counts silently.
     */
    latestPeriodStart: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      // The pattern alone admits "9999-99-99", which differences to nonsense.
      .refine((value) => DateTime.fromISO(value).isValid, {
        message: "must be a calendar date",
      }),
    /** The anchor day's own bucket total, for the anchoring arithmetic. */
    latestPeriodAmount: z.number(),
    /** Per-service cumulative cost; absent when no breakdown is collected. */
    serviceBreakdown: boundedRecord(z.number()).optional(),
    /** The anchor day's per-service totals, companion to serviceBreakdown. */
    latestPeriodServiceAmounts: boundedRecord(z.number()).optional(),
    /**
     * First day `serviceBreakdown` covers, present only when that is less than
     * the whole history: the breakdown was turned on for a lease whose earlier
     * rows carry none, so pages before this day have no breakdown to show.
     */
    breakdownCoversFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    /**
     * Token-priced Bedrock usage only. `0.00` with no Bedrock spend, `null`
     * where the slice is unknown, as for a reading taken while monitoring was
     * off -- so null must stay distinguishable from absent.
     */
    billedBedrockTokenCost: z.number().nullable(),
    /**
     * The anchor day's own token-priced amount, companion to `billedBedrockTokenCost`
     * for the same anchoring arithmetic `latestPeriodAmount` serves, and signed
     * like it. Absent when monitoring is off.
     */
    latestPeriodBedrockTokenAmount: z.number().optional(),
    ttl: TtlSchema,
  })
  .extend(LeaseCostHistoryItemWithMetadataSchema.shape)
  .strict()
  // The anchoring arithmetic differences the anchor day out of both totals, so
  // one side without the other silently mis-states it.
  .superRefine((row, ctx) => {
    if (
      (row.serviceBreakdown === undefined) !==
      (row.latestPeriodServiceAmounts === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["latestPeriodServiceAmounts"],
        message:
          "serviceBreakdown and latestPeriodServiceAmounts are present together or not at all",
      });
    }
    if (
      row.breakdownCoversFrom !== undefined &&
      row.serviceBreakdown === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["breakdownCoversFrom"],
        message: "breakdownCoversFrom requires a serviceBreakdown to cover",
      });
    }
  });

export type CostObservation = z.infer<typeof CostObservationSchema>;

/** Cumulative Bedrock token counts and monitored token cost (`BEDROCK_TOKEN#<iso8601>`). */
export const BedrockTokenRowSchema = z
  .object({
    leaseUuid: LeaseUuidSchema,
    sk: BedrockTokenSkSchema,
    /** Cumulative counts, region -> model -> per-token-type. */
    tokens: boundedRecord(boundedRecord(TokenQuadSchema)),
    /** The cost of the counts added since the previous row; null on older rows saved unpriced. */
    monitoredBedrockTokenCostDelta: z.number().nullable(),
    /**
     * Cumulative cost derived from those counts, each priced once at the rates
     * in force when it was counted. A count with no rate adds nothing. Null on
     * older rows, saved unpriced where one counted slice had no rate.
     */
    monitoredBedrockTokenCost: z.number().nonnegative().nullable(),
    /** Per region, the newest CloudWatch timestamp included; the resume anchor. */
    coveredThrough: boundedRecord(IsoMillisSchema),
    ttl: TtlSchema,
  })
  .extend(LeaseCostHistoryItemWithMetadataSchema.shape)
  .strict()
  // A cost attributable to no region, model or measured window is the shape a
  // zip defect or a truncated identifier produces, not a row the poll writes: a
  // region only enters `tokens` on a read that succeeded, and `coveredThrough`
  // is keyed by region so a failed read holds back only that region.
  .superRefine((row, ctx) => {
    const regions = Object.keys(row.tokens);
    if (regions.length === 0) {
      // Tolerance, not exact equality: an empty `tokens` should yield a literal 0
      // today, but a sum over a rate table can land at 1e-17.
      if (
        row.monitoredBedrockTokenCost !== null &&
        row.monitoredBedrockTokenCost > ZERO_COST_TOLERANCE
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["monitoredBedrockTokenCost"],
          message: "must be 0 when tokens is empty",
        });
      }
      if (
        row.monitoredBedrockTokenCostDelta !== null &&
        Math.abs(row.monitoredBedrockTokenCostDelta) > ZERO_COST_TOLERANCE
      ) {
        ctx.addIssue({
          code: "custom",
          path: ["monitoredBedrockTokenCostDelta"],
          message: "must be 0 when tokens is empty",
        });
      }
    }
    // Own keys only, via a Set, rather than indexing `coveredThrough` and
    // comparing against undefined: it is a plain object, so a region named
    // `constructor`, `toString` or `valueOf` resolves through the prototype and
    // satisfies the requirement with no anchor present. Region codes come from
    // an AWS response.
    //
    // `Object.keys` rather than `Object.hasOwn` or `hasOwnProperty.call`: the
    // frontend type-checks this module at `lib: ES2020` and `Object.hasOwn` is
    // ES2022, while SonarQube's S6653 rejects `hasOwnProperty.call` because the
    // root tsconfig targets ES2022. `Object.keys` predates both and returns own
    // enumerable properties only, so it satisfies the guard and both tools.
    const anchoredRegions = new Set(Object.keys(row.coveredThrough));
    for (const region of regions) {
      if (!anchoredRegions.has(region)) {
        ctx.addIssue({
          code: "custom",
          path: ["coveredThrough", region],
          message: "required for every region present in tokens",
        });
      }
    }
    // The key caps bound each level independently, so nested they still admit
    // 200 regions x 200 models x 4 numbers -- an item DynamoDB rejects at write
    // time, three orders of magnitude over the ~1.4 KB a row should be.
    // `appendBedrockTokenRow` does not catch, so that write throws, the region's
    // `coveredThrough` anchor never advances, and the poll re-reads a window that
    // ages out of CloudWatch at 15 days -- a permanent understatement of Bedrock
    // spend, disabling the per-region anchor that mitigates it.
    if (serializedSize(row) > MAX_ITEM_BYTES) {
      ctx.addIssue({
        code: "custom",
        path: ["tokens"],
        message: `row must serialize to under ${MAX_ITEM_BYTES} bytes`,
      });
    }
  });

export type BedrockTokenRow = z.infer<typeof BedrockTokenRowSchema>;

/** The insight sent in the notification, stored verbatim so the two cannot diverge. */
export const BreachInsightSchema = z
  .object({
    kind: InsightKindSchema,
    /**
     * The one non-numeric, non-enum value on the alert detail, and the
     * notification copy interpolates it into `htmlBody`.
     *
     * **This does NOT make the templating layer safe.** That layer escapes
     * nothing: every `htmlBody` in `email-templates.ts` is a raw template
     * literal, and `AccountDrift` interpolates its own fields one function away.
     * The escaping helper arrives with the copy that first renders this value.
     *
     * What this bound does is narrower and worth having on its own. It excludes
     * two classes:
     *
     * - the characters that make markup (`< > " ' & =`), for the `htmlBody`; and
     * - every Unicode control character (`\p{C}`), which the markup set does not
     *   cover and which the OTHER sink needs. `email-templates.ts` renders a
     *   `textBody` beside the `htmlBody`, where an `escapeHtml` helper neutralises
     *   nothing: a name carrying `\n\n` followed by a sentence renders as extra
     *   sentences in a legitimately SES-signed notification, with no metacharacter
     *   involved. `\r`/`\n` also matter for any header sink, and `subject` is a
     *   constant only until the copy names the service in it.
     *
     * Everything a real charge name uses is still admitted -- the `:` in a Bedrock
     * model ID, the `,` in a Marketplace product, `+`, and non-ASCII letters via
     * the `u` flag. That matters: rejecting a legitimate name is worse than
     * accepting it, because the whole detail then fails to parse and the
     * notification is lost.
     *
     * Note the trust boundary this widens. Cost Explorer service names are
     * usually treated as AWS-controlled; a Marketplace product name is
     * seller-authored, so that premise no longer covers every value this field
     * can hold.
     */
    service: z
      .string()
      .min(1)
      .max(MAX_MAP_KEY_LENGTH)
      .regex(/^[^<>"'&=\p{C}]+$/u),
    amount: z.number(),
    shareOfComparedSpend: z.number().optional(),
    changePercent: z.number().optional(),
  })
  .strict()
  // Each kind's notification copy names its own figure, so the figure that kind
  // is about cannot be absent.
  .superRefine((insight, ctx) => {
    if (
      insight.kind === "COMPOSITION" &&
      insight.shareOfComparedSpend === undefined
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["shareOfComparedSpend"],
        message: "required when kind is COMPOSITION",
      });
    }
    if (insight.kind === "CHANGE" && insight.changePercent === undefined) {
      ctx.addIssue({
        code: "custom",
        path: ["changePercent"],
        message: "required when kind is CHANGE",
      });
    }
  });

/**
 * A threshold, `maxSpend` or expiry breach, retained for display and audit
 * (`BREACH#<iso8601>`). `triggeredBy` decides which fields carry meaning; the
 * unused pair is null.
 */
export const BreachRecordSchema = z
  .object({
    leaseUuid: LeaseUuidSchema,
    sk: BreachSkSchema,
    triggeredBy: BreachTriggeredBySchema,
    /** REPORTED, PREDICTED, RATE, and DURATION may alert or freeze; only MAX_SPEND and EXPIRY terminate. */
    action: BreachActionSchema,
    // A cap, a rate and a cost at fire are all nonnegative by construction; a
    // negative one is a corrupt audit row, not a restatement.
    thresholdDollars: z.number().nonnegative().nullable(),
    /**
     * The cap exceeded, and its basis, on a RATE breach. Strictly positive,
     * like the configured limit it records: a zero cap is never written.
     */
    thresholdRate: z.number().positive().nullable(),
    thresholdRateBasis: RateBasisSchema.nullable(),
    /**
     * The hours before the lease's end, on a DURATION breach. Absent where it
     * was not recorded.
     */
    thresholdHoursRemaining: z.number().positive().nullable().optional(),
    billedCostAtFire: z.number().nonnegative(),
    predictedCostAtFire: z.number().nonnegative().nullable(),
    /** Which schedule evaluated it: LEASE_MONITORING or TOKEN_POLL. */
    evaluatedBy: BreachEvaluatedBySchema,
    /**
     * The figure the breach was evaluated on, where it is more than just the
     * bill: the token poll's monitored Bedrock substitution, never below
     * the billed total.
     */
    evaluatedSpendAtFire: z.number().nonnegative().nullable(),
    monitoredBedrockTokenCostAtFire: z.number().nonnegative().nullable(),
    /** Both null where no rate was in force. */
    rateAtFire: z.number().nonnegative().nullable(),
    rateSourceAtFire: RateBasisSchema.nullable(),
    insight: BreachInsightSchema.nullable(),
    ttl: TtlSchema,
  })
  .extend(LeaseCostHistoryItemWithMetadataSchema.shape)
  .strict()
  // Enforce the field-pairing rules row by row, so the audit trail cannot
  // record a state the system does not produce.
  //
  // Split into one function per group of the table rather than one refinement,
  // because as a single block it measured 34 against SonarQube's cognitive
  // complexity limit of 15 (typescript:S3776, a Critical smell, which fails the
  // Maintainability-on-New-Code gate). The rules, paths and messages are
  // unchanged; only the nesting is.
  .superRefine((row, ctx) => {
    const fail: BreachFail = (path, message) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    checkThresholdFields(row, fail);
    checkProjectionFields(row, fail);
    checkRateAtFirePair(row, fail);
    checkEvaluatedSpendFigures(row, fail);
    checkTerminateAction(row, fail);
    checkMaxSpendFields(row, fail);
    checkLeaseEndFields(row, fail);
  });

type BreachFail = (path: string, message: string) => void;
// Structurally the parsed row, but taken pre-refinement so these helpers can be
// declared beside the schema they serve rather than after it.
type BreachPairingFields = Pick<
  z.infer<typeof BreachRecordSchema>,
  | "triggeredBy"
  | "action"
  | "thresholdDollars"
  | "thresholdRate"
  | "thresholdRateBasis"
  | "thresholdHoursRemaining"
  | "predictedCostAtFire"
  | "rateAtFire"
  | "rateSourceAtFire"
  | "evaluatedBy"
  | "evaluatedSpendAtFire"
  | "monitoredBedrockTokenCostAtFire"
  | "insight"
>;

/** Which threshold a breach may name: a rate cap, or a dollar figure, never both. */
function checkThresholdFields(
  row: BreachPairingFields,
  fail: BreachFail,
): void {
  // DURATION and EXPIRY are checked in `checkLeaseEndFields`.
  if (isLeaseEndBreach(row)) {
    return;
  }
  if (row.triggeredBy !== "RATE") {
    if (row.thresholdDollars === null)
      fail("thresholdDollars", `required on a ${row.triggeredBy} breach`);
    if (row.thresholdRate !== null)
      fail("thresholdRate", `must be null on a ${row.triggeredBy} breach`);
    if (row.thresholdRateBasis !== null)
      fail("thresholdRateBasis", `must be null on a ${row.triggeredBy} breach`);
    return;
  }
  if (row.thresholdDollars !== null)
    fail("thresholdDollars", "must be null on a RATE breach");
  if (row.thresholdRate === null)
    fail("thresholdRate", "required on a RATE breach");
  if (row.thresholdRateBasis === null)
    fail("thresholdRateBasis", "required on a RATE breach");
  // The rate-at-fire pair is the breach itself here, not context: a cap cannot
  // be exceeded by an unmeasured rate.
  if (row.rateAtFire === null) fail("rateAtFire", "required on a RATE breach");
}

/**
 * A projected crossing is only meaningful with the projection and the rate it was
 * carried forward at.
 */
function checkProjectionFields(
  row: BreachPairingFields,
  fail: BreachFail,
): void {
  if (row.triggeredBy !== "PREDICTED") return;
  if (row.predictedCostAtFire === null)
    fail("predictedCostAtFire", "required on a PREDICTED breach");
  if (row.rateAtFire === null)
    fail("rateAtFire", "required on a PREDICTED breach");
}

/** The measured rate and its basis are recorded together or not at all. */
function checkRateAtFirePair(row: BreachPairingFields, fail: BreachFail): void {
  if ((row.rateAtFire === null) !== (row.rateSourceAtFire === null))
    fail(
      "rateSourceAtFire",
      "rateAtFire and rateSourceAtFire are both null or both populated",
    );
}

/**
 * The token poll always records the figure it compared; Lease Monitoring
 * compares the bill as is. Only the poll has a monitored Bedrock term,
 * null where no token cost was priced or no billed Bedrock charge exists to
 * replace.
 */
function checkEvaluatedSpendFigures(
  row: BreachPairingFields,
  fail: BreachFail,
): void {
  if (row.evaluatedBy === "LEASE_MONITORING") {
    if (row.evaluatedSpendAtFire !== null) {
      fail("evaluatedSpendAtFire", "must be null on a LEASE_MONITORING breach");
    }
    if (row.monitoredBedrockTokenCostAtFire !== null)
      fail(
        "monitoredBedrockTokenCostAtFire",
        "must be null on a LEASE_MONITORING breach",
      );
    return;
  }
  if (row.evaluatedSpendAtFire === null)
    fail("evaluatedSpendAtFire", "required on a TOKEN_POLL breach");
}

/** Only reaching `maxSpend` or the lease's end terminates, and both always do. */
function checkTerminateAction(
  row: BreachPairingFields,
  fail: BreachFail,
): void {
  if (row.triggeredBy === "MAX_SPEND" || row.triggeredBy === "EXPIRY") {
    if (row.action !== "TERMINATE") {
      fail("action", `${breachName(row)} always terminates`);
    }
    return;
  }
  if (row.action === "TERMINATE") {
    fail("action", `${breachName(row)} never terminates`);
  }
}

/** "a REPORTED breach", "an EXPIRY breach": how the messages name a row's kind. */
function breachName(row: BreachPairingFields): string {
  return `${row.triggeredBy === "EXPIRY" ? "an" : "a"} ${row.triggeredBy} breach`;
}

/**
 * A MAX_SPEND breach compares spend so far with the cap, so it records no
 * projection or rate.
 */
function checkMaxSpendFields(row: BreachPairingFields, fail: BreachFail): void {
  if (row.triggeredBy !== "MAX_SPEND") {
    return;
  }
  if (row.predictedCostAtFire !== null) {
    fail("predictedCostAtFire", "must be null on a MAX_SPEND breach");
  }
  if (row.rateAtFire !== null) {
    fail("rateAtFire", "must be null on a MAX_SPEND breach");
  }
  if (row.rateSourceAtFire !== null) {
    fail("rateSourceAtFire", "must be null on a MAX_SPEND breach");
  }
}

/** A duration threshold counts hours to the lease's end, and an expiry is the end. */
function isLeaseEndBreach(row: BreachPairingFields): boolean {
  return row.triggeredBy === "DURATION" || row.triggeredBy === "EXPIRY";
}

/** Measured in time, so a duration or expiry breach records none of these. */
const LEASE_END_UNUSED_FIELDS = [
  "thresholdDollars",
  "thresholdRate",
  "thresholdRateBasis",
  "predictedCostAtFire",
  "rateAtFire",
  "evaluatedSpendAtFire",
  "insight",
] as const;

/**
 * A duration threshold names the hours before the lease's end, and an expiry
 * is the end itself. Both are checked against time, not spend, and only by
 * Lease Monitoring, so neither names a dollar or rate threshold or records a
 * projection, a rate or an evaluated spend figure; the billed total is context.
 */
function checkLeaseEndFields(row: BreachPairingFields, fail: BreachFail): void {
  if (!isLeaseEndBreach(row)) {
    if (row.thresholdHoursRemaining != null) {
      fail("thresholdHoursRemaining", `must be null on ${breachName(row)}`);
    }
    return;
  }
  checkLeaseEndThreshold(row, fail);
  if (row.evaluatedBy !== "LEASE_MONITORING") {
    fail(
      "evaluatedBy",
      `${row.triggeredBy} is only checked by LEASE_MONITORING`,
    );
  }
  for (const field of LEASE_END_UNUSED_FIELDS) {
    if (row[field] != null) {
      fail(field, `must be null on ${breachName(row)}`);
    }
  }
}

/** A duration threshold names its hours; an expiry names none. */
function checkLeaseEndThreshold(
  row: BreachPairingFields,
  fail: BreachFail,
): void {
  if (row.triggeredBy === "DURATION") {
    if (row.thresholdHoursRemaining == null) {
      fail("thresholdHoursRemaining", "required on a DURATION breach");
    }
    return;
  }
  if (row.thresholdHoursRemaining != null) {
    fail("thresholdHoursRemaining", "must be null on an EXPIRY breach");
  }
}

export type BreachRecord = z.infer<typeof BreachRecordSchema>;

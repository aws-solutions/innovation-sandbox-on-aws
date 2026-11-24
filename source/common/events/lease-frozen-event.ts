// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

// Import these schemas from their shared owner rather than through a budget
// alert alias, which would also load lease-template persistence dependencies.
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
  FreeTextSchema,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  DollarThresholdTriggeredBySchema,
  RateBasisSchema as RateSourceSchema,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger();

export const LeaseFrozenReasonTypeSchema = z.enum(
  ["Expired", "BudgetExceeded", "SpendRateExceeded", "ManuallyFrozen"],
  {
    error: enumErrorMap,
  },
);

export const LeaseFrozenByDurationSchema = z.object({
  type: z.literal(LeaseFrozenReasonTypeSchema.enum.Expired),
  triggeredDurationThreshold: z.number().gt(0),
  leaseDurationInHours: z.number().gt(0),
});

export const LeaseFrozenByBudgetSchema = z.object({
  type: z.literal(LeaseFrozenReasonTypeSchema.enum.BudgetExceeded),
  triggeredBudgetThreshold: z.number().gt(0),
  budget: z.number().optional(),
  totalSpend: z.number(),
  // Optional so v1.3-shaped freeze details still parse. A crossed spend-rate
  // limit freezes with the SpendRateExceeded reason instead. Both edits also
  // reach LeaseFreezingThresholdBreachedAlert, which aliases this schema.
  triggeredBy: DollarThresholdTriggeredBySchema.optional(),
  rateSource: RateSourceSchema.optional(),
});

/** A spend-rate limit whose action is FREEZE_ACCOUNT was crossed. */
export const LeaseFrozenBySpendRateSchema = z.object({
  type: z.literal(LeaseFrozenReasonTypeSchema.enum.SpendRateExceeded),
  /** The basis of both rates below: USD per hour or per day. */
  rateBasis: RateSourceSchema,
  thresholdRate: z.number().gt(0),
  measuredRate: z.number().nonnegative(),
  budget: z.number().optional(),
  totalSpend: z.number(),
});

export const LeaseFrozenManualSchema = z.object({
  type: z.literal(LeaseFrozenReasonTypeSchema.enum.ManuallyFrozen),
  comment: FreeTextSchema,
});

/**
 * The reason without the pairing rule, so a constructor has something that strips
 * on its own: zod drops unknown keys only on a SUCCESSFUL parse, and a refinement
 * failure yields no data at all. That is the path where stripping matters, since a
 * producer spreading a `BREACH#` row would otherwise put its storage attributes on
 * the bus. `.strict()` is not the alternative -- it rejects those keys instead, and
 * neither constructor here throws, so they would be emitted unstripped.
 */
const LeaseFrozenReasonShapeSchema = z.discriminatedUnion("type", [
  LeaseFrozenByDurationSchema,
  LeaseFrozenByBudgetSchema,
  LeaseFrozenBySpendRateSchema,
  LeaseFrozenManualSchema,
]);

export const LeaseFrozenReasonSchema = LeaseFrozenReasonShapeSchema
  // The rate source qualifies a projection and nothing else: a source on a
  // billed freeze qualifies nothing, and a projected freeze with no source
  // cannot be audited.
  .superRefine((reason, ctx) => {
    if (reason.type !== "BudgetExceeded") {
      return;
    }
    if (reason.triggeredBy === "PREDICTED" && reason.rateSource == null) {
      ctx.addIssue({
        code: "custom",
        path: ["rateSource"],
        message: "required when triggeredBy is PREDICTED",
      });
    }
    if (reason.triggeredBy !== "PREDICTED" && reason.rateSource != null) {
      ctx.addIssue({
        code: "custom",
        path: ["rateSource"],
        message: "only a PREDICTED freeze carries a rateSource",
      });
    }
  });

export type LeaseFrozenReason = z.infer<typeof LeaseFrozenReasonSchema>;

type FrozenReasonInput = z.input<typeof LeaseFrozenReasonSchema>;
type FrozenByBudgetInput = Extract<
  FrozenReasonInput,
  { type: "BudgetExceeded" }
>;

/**
 * The pairing rule as a TS union, because `superRefine` runs only on the
 * consumer's `parse` -- where a violation loses the freeze notification while
 * the account is frozen anyway. Required here, it is a compile error instead.
 */
export type LeaseFrozenReasonInput =
  | Exclude<FrozenReasonInput, { type: "BudgetExceeded" }>
  | (FrozenByBudgetInput & { triggeredBy?: "REPORTED"; rateSource?: never })
  | (FrozenByBudgetInput & {
      triggeredBy: "PREDICTED";
      rateSource: z.infer<typeof RateSourceSchema>;
    });

export const LeaseFrozenEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  reason: LeaseFrozenReasonSchema,
});

/** {@link LeaseFrozenEventSchema} without the reason's pairing rule, to strip with. */
const LeaseFrozenEventShapeSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  reason: LeaseFrozenReasonShapeSchema,
});

export type LeaseFrozenEventInput = Omit<
  z.input<typeof LeaseFrozenEventSchema>,
  "reason"
> & { reason: LeaseFrozenReasonInput };

const REASON_SHAPES = {
  Expired: LeaseFrozenByDurationSchema,
  BudgetExceeded: LeaseFrozenByBudgetSchema,
  SpendRateExceeded: LeaseFrozenBySpendRateSchema,
  ManuallyFrozen: LeaseFrozenManualSchema,
} as const;

function pickKeys(
  source: Record<string, unknown>,
  keys: Set<string>,
): Record<string, unknown> {
  const picked: Record<string, unknown> = {};
  // Iterating the source's own entries rather than testing each modelled key for
  // membership: `Object.entries` yields own enumerable properties only, so a key
  // shadowing an `Object.prototype` member cannot be copied and no explicit
  // own-property check is needed.
  for (const [key, value] of Object.entries(source)) {
    if (keys.has(key)) {
      picked[key] = value;
    }
  }
  return picked;
}

/**
 * The modelled keys only, for when even the shape parse fails and there is no
 * stripped output. Both key lists come off the schemas, so a new field cannot be
 * forgotten here; values pass through unrepaired, since the point is to disclose
 * nothing extra rather than to fix the detail. A reason whose `type` names no known
 * variant keeps no keys at all, having no shape to be judged against.
 */
export function projectModelledFrozenKeys(
  candidate: Record<string, unknown>,
): LeaseFrozenEventInput {
  const projected = pickKeys(
    candidate,
    new Set(Object.keys(LeaseFrozenEventShapeSchema.shape)),
  );
  const reason = candidate.reason;
  if (typeof reason === "object" && reason !== null) {
    const named = (reason as Record<string, unknown>).type;
    const variant = Object.entries(REASON_SHAPES).find(
      ([type]) => type === named,
    )?.[1];
    projected.reason = pickKeys(
      reason as Record<string, unknown>,
      new Set(variant === undefined ? [] : Object.keys(variant.shape)),
    );
  }
  return projected as unknown as LeaseFrozenEventInput;
}

/**
 * The detail to emit: stripped to the modelled keys whether or not the pairing rule
 * then holds. A producer spreading a stored row would otherwise put `leaseUuid`,
 * `sk`, `ttl` and `meta` onto the bus and into every rule target and archive, and
 * the fields a rejecting consumer will not read are worth nothing there.
 */
export function strippedFrozenDetail<T extends LeaseFrozenEventInput>(
  eventData: T,
): T {
  const shape = LeaseFrozenEventShapeSchema.safeParse(eventData);
  return (
    shape.success ? shape.data : projectModelledFrozenKeys(eventData)
  ) as T;
}

export class LeaseFrozenEvent<
  T extends z.infer<typeof LeaseFrozenReasonTypeSchema> = z.infer<
    typeof LeaseFrozenReasonTypeSchema
  >,
> implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseFrozen;
  readonly Detail: LeaseFrozenEventInput & { reason: { type: T } };

  // Deliberately does not throw: the freeze has already committed by the time
  // this is built (`InnovationSandbox.freezeLease`), so a throw would leave the
  // account frozen with the user never told why. Rejection belongs on the
  // consumer path, in `parse`; what is left here is to make a malformed emit
  // observable.
  constructor(eventData: LeaseFrozenEventInput & { reason: { type: T } }) {
    this.Detail = strippedFrozenDetail(eventData);

    const validated = LeaseFrozenEventSchema.safeParse(eventData);
    if (!validated.success) {
      logger.warn(
        // Paths only, never the zod message: this record's logDetailType is a
        // SubscribableLogSchema member, and that message carries the UUID regex
        // source and every failing attribute name.
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseFrozen} detail`,
        {
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseFrozen,
          invalidPaths: validated.error.issues.map((issue) =>
            issue.path.join("."),
          ),
        } satisfies SubscribableLog,
      );
    }
  }

  public isType<R extends T>(t: R): this is LeaseFrozenEvent<R> {
    return this.Detail.reason.type === t;
  }

  public static parse(eventDetail: unknown) {
    // The schema has already enforced the pairing rule the input union states,
    // which TypeScript cannot read back off the independently optional output.
    return new LeaseFrozenEvent(
      LeaseFrozenEventSchema.parse(eventDetail) as LeaseFrozenEventInput, // NOSONAR typescript:S4325 -- required by tsc; Zod output loses the reason pairing
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { BreachInsightSchema } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  DollarThresholdTriggeredBySchema,
  RateBasisSchema,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { ThresholdActionSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger();

// An alias, not a restatement: the persisted schema owns the value set, so the
// alert and the stored row cannot drift onto different ones.
export const RateSourceSchema = RateBasisSchema;

// The insight, computed by the emitting side: the Notification Lambda has no
// cost-history grant. Aliased to the persisted schema rather than restated, so
// the stored row and the alert cannot drift into different shapes.
export const BudgetAlertInsightSchema = BreachInsightSchema;

/**
 * The shape without the branch rules, so the constructor has something that strips
 * on its own: zod strips unknown keys only on a SUCCESSFUL parse, and a refinement
 * failure yields no data at all. That is the path where stripping matters, since a
 * producer spreading a `BREACH#` row would otherwise put its storage attributes on
 * the bus. `.strict()` is not the alternative -- it rejects those keys instead, and
 * a non-throwing constructor would then emit them unstripped.
 */
const LeaseBudgetThresholdTriggeredEventShapeSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  budget: z.number().optional(),
  totalSpend: z.number(),
  budgetThresholdTriggered: z.number(),
  actionRequested: ThresholdActionSchema,

  // Nullish, not optional, wherever the BreachRecord counterpart is
  // .nullable(): this alert is emitted from the `BREACH#` row just persisted, so
  // a null that record mandates (an unavailable rate) must project without the
  // producer stripping it. Nothing is required, so a v1.3-shaped detail still
  // parses. A spend-rate limit alerts through LeaseSpendRateThresholdBreachedAlert.
  triggeredBy: DollarThresholdTriggeredBySchema.default("REPORTED"),
  // `rate` and `rateSource` are the projection rate and its basis behind
  // `predictedCost` for this dollar-threshold alert, not configured spend-rate
  // limit fields (those travel on LeaseSpendRateThresholdBreachedAlert).
  rateSource: RateSourceSchema.nullish(),
  predictedCost: z.number().nullish(),
  rate: z.number().nullish(),
  hoursToBudgetExhaustion: z.number().nullish(),
  lastReportedAt: z.iso.datetime().optional(),
  insight: BudgetAlertInsightSchema.nullish(),
  // The rate the countdown burns at, where it is not `rate`: the token poll's
  // remainder plus monitored Bedrock rate. `rate` stays the one the breach records.
  countdownRate: z.number().nullish(),
  countdownRateSource: RateSourceSchema.nullish(),
  // The monitored Bedrock token cost the bill has not caught up with.
  unbilledBedrockTokenCost: z.number().nullish(),
});

// Not .strict() on either: no sibling event schema is, and strict would reject
// the spread above rather than strip it.
// The predicted branch must carry the figures its notification copy names, so
// an absent field cannot render "undefined". Not a discriminated union: a v1.3
// detail carries no `triggeredBy` to discriminate on and must still parse.
export const LeaseBudgetThresholdTriggeredEventSchema =
  LeaseBudgetThresholdTriggeredEventShapeSchema.superRefine((detail, ctx) => {
    const fail = (path: string, message: string) =>
      ctx.addIssue({ code: "custom", path: [path], message });
    if (detail.triggeredBy === "PREDICTED") {
      // The predicted copy names the projection and the rate behind it, and
      // states that rate per hour or per day -- so the basis is part of the
      // required figure, not context. BreachRecordSchema requires the same pair.
      if (detail.predictedCost == null)
        fail("predictedCost", "required when triggeredBy is PREDICTED");
      if (detail.rate == null)
        fail("rate", "required when triggeredBy is PREDICTED");
      if (detail.rateSource == null)
        fail("rateSource", "required when triggeredBy is PREDICTED");
    }
  });

type AlertInput = z.input<typeof LeaseBudgetThresholdTriggeredEventSchema>;

/**
 * The branch rule as a TS union, because `superRefine` runs only on the consumer's
 * `parse` -- where a violation loses the notification while the freeze still
 * happens. Required here, it is a compile error instead.
 */
export type LeaseBudgetThresholdAlertInput =
  | (AlertInput & { triggeredBy?: "REPORTED" })
  | (AlertInput & {
      triggeredBy: "PREDICTED";
      predictedCost: number;
      rate: number;
      rateSource: "HOURLY" | "DAILY";
    });

/**
 * The modelled keys only, for when even the shape parse fails and there is no
 * stripped output. Derived from the schema's key list so a new field cannot be
 * forgotten; values pass through unrepaired, since the point is to disclose nothing
 * extra rather than to fix the detail.
 */
function projectModelledKeys(
  candidate: Record<string, unknown>,
): z.infer<typeof LeaseBudgetThresholdTriggeredEventSchema> {
  // Iterating the candidate's own entries rather than testing each modelled key
  // for membership: `Object.entries` yields own enumerable properties only, so a
  // candidate key that shadows an `Object.prototype` member cannot be copied and
  // no explicit own-property check is needed. (`in` would have walked the
  // prototype chain; `Object.hasOwn` is ES2022 and `hasOwnProperty.call` trips
  // SonarQube S6653 -- see the same note in BedrockTokenRowSchema.)
  const modelledKeys = new Set(
    Object.keys(LeaseBudgetThresholdTriggeredEventShapeSchema.shape),
  );
  const projected: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(candidate)) {
    if (modelledKeys.has(key)) projected[key] = value;
  }
  return projected as z.infer<typeof LeaseBudgetThresholdTriggeredEventSchema>;
}

export class LeaseBudgetThresholdBreachedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseBudgetThresholdBreachedAlert;
  readonly Detail: z.infer<typeof LeaseBudgetThresholdTriggeredEventSchema>;

  // Deliberately does not throw: the producer is `determineLeaseEvents`, called
  // in an unguarded loop ahead of the fleet's cost writes
  // (lease-monitoring-handler.ts:87-112), so a throw here would suppress the
  // whole scan. Rejection belongs on the consumer path, in `parse`; what is left
  // to do here is make the malformed emit observable.
  constructor(eventData: LeaseBudgetThresholdAlertInput) {
    const candidate = {
      ...eventData,
      triggeredBy: eventData.triggeredBy ?? "REPORTED",
    };

    // Shape first, so the assigned detail is stripped whether or not the branch
    // rules then hold. A refinement failure yields no data, and `candidate` is
    // every own property of whatever the producer passed -- for a spread `BREACH#`
    // row that is `leaseUuid`, `sk`, `ttl`, `meta`, `evaluatedBy` and the
    // evaluated-spend figures, onto the bus and into every rule target and archive. The
    // fields a rejecting consumer will not read are worth nothing there.
    const shape =
      LeaseBudgetThresholdTriggeredEventShapeSchema.safeParse(candidate);
    this.Detail = shape.success ? shape.data : projectModelledKeys(candidate);

    const validated =
      LeaseBudgetThresholdTriggeredEventSchema.safeParse(candidate);
    if (!validated.success) {
      logger.warn(
        // Paths only, never the zod message: this record's logDetailType is a
        // SubscribableLogSchema member, and that message carries the UUID regex
        // source and every failing attribute name.
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseBudgetThresholdBreachedAlert} detail`,
        {
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
          // Joined raw, which is safe only because no field on this detail is a
          // `z.record`: an issue inside one puts the KEY on the path, so a
          // service, region or model ID would reach a SUBSCRIBABLE record. The
          // store redacts for that reason, but its helper sits beside the AWS SDK
          // import and pulling it in here would drag the SDK into `events`. If a
          // map-valued field is ever added to this detail, redact before joining.
          invalidPaths: validated.error.issues.map((issue) =>
            issue.path.join("."),
          ),
        } satisfies SubscribableLog,
      );
    }
  }

  public static parse(eventDetail: unknown) {
    const detail = LeaseBudgetThresholdTriggeredEventSchema.parse(eventDetail);
    const { triggeredBy } = detail;
    switch (triggeredBy) {
      case "REPORTED":
        return new LeaseBudgetThresholdBreachedAlert({
          ...detail,
          triggeredBy,
        });
      case "PREDICTED": {
        // The schema's refinement has already rejected a PREDICTED detail
        // without these, but its output type cannot say so; restate the rule
        // for the union.
        const { predictedCost, rate, rateSource } = detail;
        if (predictedCost == null || rate == null || rateSource == null) {
          throw new Error(
            "PREDICTED detail requires predictedCost, rate and rateSource.",
          );
        }
        return new LeaseBudgetThresholdBreachedAlert({
          ...detail,
          triggeredBy,
          predictedCost,
          rate,
          rateSource,
        });
      }
      default:
        return assertNever(triggeredBy);
    }
  }
}

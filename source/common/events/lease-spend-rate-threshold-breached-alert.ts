// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { BreachInsightSchema } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { RateBasisSchema } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger();

/**
 * A configured spend-rate limit whose action is ALERT was crossed. A limit
 * whose action is FREEZE_ACCOUNT requests its freeze through
 * LeaseFreezingThresholdBreachedAlert with a SpendRateExceeded reason instead;
 * dollar thresholds alert through LeaseBudgetThresholdBreachedAlert.
 *
 * Not `.strict()`, like its siblings: an unknown key is stripped, not rejected.
 */
export const LeaseSpendRateThresholdTriggeredEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  /** The basis of both rates below: USD per hour or per day. */
  rateBasis: RateBasisSchema,
  thresholdRate: z.number().gt(0),
  measuredRate: z.number().nonnegative(),
  // Context for the notification, as on the budget alert. The scheduled
  // monitors that evaluate spend-rate limits exclude Sandbox Spaces agent
  // spend, so these figures do too.
  budget: z.number().optional(),
  totalSpend: z.number(),
  predictedCost: z.number().nullish(),
  hoursToBudgetExhaustion: z.number().nullish(),
  lastReportedAt: z.iso.datetime().optional(),
  insight: BreachInsightSchema.nullish(),
  // The rate the countdown burns at, in its own unit: the token poll's
  // remainder plus monitored Bedrock rate. Not `measuredRate`, which is the rate
  // the configured limit was compared against.
  countdownRate: z.number().nullish(),
  countdownRateSource: RateBasisSchema.nullish(),
  // The monitored Bedrock token cost the bill has not caught up with.
  unbilledBedrockTokenCost: z.number().nullish(),
});

export type LeaseSpendRateThresholdAlertInput = z.input<
  typeof LeaseSpendRateThresholdTriggeredEventSchema
>;

type LeaseSpendRateThresholdAlertDetail = z.infer<
  typeof LeaseSpendRateThresholdTriggeredEventSchema
>;

/**
 * The modelled keys only, for a detail that fails its parse and so has no
 * stripped output. Zod transforms (including key stripping) run only after a
 * successful validation, so this fallback is needed only when validation fails
 * and returns no transformed data.
 */
function projectModelledKeys(
  candidate: LeaseSpendRateThresholdAlertInput,
): LeaseSpendRateThresholdAlertDetail {
  const modelledKeys = new Set(
    Object.keys(LeaseSpendRateThresholdTriggeredEventSchema.shape),
  );
  return Object.fromEntries(
    Object.entries(candidate).filter(([key]) => modelledKeys.has(key)),
  ) as LeaseSpendRateThresholdAlertDetail;
}

export class LeaseSpendRateThresholdBreachedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseSpendRateThresholdBreachedAlert;
  readonly Detail: LeaseSpendRateThresholdAlertDetail;

  // Does not throw, for the reason LeaseBudgetThresholdBreachedAlert gives: the
  // producer runs inside the monitoring scan. Rejection belongs to `parse`.
  constructor(eventData: LeaseSpendRateThresholdAlertInput) {
    const validated =
      LeaseSpendRateThresholdTriggeredEventSchema.safeParse(eventData);
    this.Detail = validated.success
      ? validated.data
      : projectModelledKeys(eventData);
    if (!validated.success) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseSpendRateThresholdBreachedAlert} detail`,
        {
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType:
            EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
          invalidPaths: validated.error.issues.map((issue) =>
            issue.path.join("."),
          ),
        } satisfies SubscribableLog,
      );
    }
  }

  public static parse(eventDetail: unknown) {
    return new LeaseSpendRateThresholdBreachedAlert(
      LeaseSpendRateThresholdTriggeredEventSchema.parse(eventDetail),
    );
  }
}

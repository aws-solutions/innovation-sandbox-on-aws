// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { ThresholdActionSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseBudgetThresholdTriggeredEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  budget: z.number().optional(),
  totalSpend: z.number(),
  budgetThresholdTriggered: z.number(),
  actionRequested: ThresholdActionSchema,
});

export class LeaseBudgetThresholdBreachedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseBudgetThresholdBreachedAlert;
  readonly Detail: z.infer<typeof LeaseBudgetThresholdTriggeredEventSchema>;

  constructor(
    eventData: z.infer<typeof LeaseBudgetThresholdTriggeredEventSchema>,
  ) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseBudgetThresholdBreachedAlert(
      LeaseBudgetThresholdTriggeredEventSchema.parse(eventDetail),
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/data/common-schemas.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const LeaseUnfrozenEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  maxBudget: z.number().optional(),
  leaseDurationInHours: z.number().optional(),
  reason: z.string(),
});

export class LeaseUnfrozenEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseUnfrozen;
  readonly Detail: z.infer<typeof LeaseUnfrozenEventSchema>;

  constructor(eventData: z.infer<typeof LeaseUnfrozenEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseUnfrozenEvent(LeaseUnfrozenEventSchema.parse(eventDetail));
  }
}

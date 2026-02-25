// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseExpiredEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  leaseExpirationDate: z.string().datetime(),
});

export class LeaseExpiredAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseExpiredAlert;
  readonly Detail: z.infer<typeof LeaseExpiredEventSchema>;

  constructor(eventData: z.infer<typeof LeaseExpiredEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseExpiredAlert(LeaseExpiredEventSchema.parse(eventDetail));
  }
}

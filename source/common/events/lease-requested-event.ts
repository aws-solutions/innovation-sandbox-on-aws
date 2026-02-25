// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { FreeTextSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseRequestedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  comments: FreeTextSchema.optional(),
  userEmail: z.string().email(),
  requiresManualApproval: z.boolean(),
});

export class LeaseRequestedEvent extends IsbEvent {
  override readonly DetailType = EventDetailTypes.LeaseRequested;
  override readonly Detail: z.infer<typeof LeaseRequestedEventSchema>;

  constructor(eventData: z.infer<typeof LeaseRequestedEventSchema>) {
    super();
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseRequestedEvent(
      LeaseRequestedEventSchema.parse(eventDetail),
    );
  }
}

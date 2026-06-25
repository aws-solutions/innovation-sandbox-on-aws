// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { FreeTextSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseExtensionRequestedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  userEmail: z.string().email(),
  requestedExpirationDate: z.string().datetime(),
  comments: FreeTextSchema.optional(),
});

export class LeaseExtensionRequestedEvent extends IsbEvent {
  override readonly DetailType = EventDetailTypes.LeaseExtensionRequested;
  override readonly Detail: z.infer<
    typeof LeaseExtensionRequestedEventSchema
  >;

  constructor(
    eventData: z.infer<typeof LeaseExtensionRequestedEventSchema>,
  ) {
    super();
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseExtensionRequestedEvent(
      LeaseExtensionRequestedEventSchema.parse(eventDetail),
    );
  }
}

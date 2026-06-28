// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const LeaseExtensionApprovedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  userEmail: z.string().email(),
  approvedBy: z.string().email(),
  newExpirationDate: z.string().datetime(),
});

export class LeaseExtensionApprovedEvent extends IsbEvent {
  override readonly DetailType = EventDetailTypes.LeaseExtensionApproved;
  override readonly Detail: z.infer<typeof LeaseExtensionApprovedEventSchema>;

  constructor(
    eventData: z.infer<typeof LeaseExtensionApprovedEventSchema>,
  ) {
    super();
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseExtensionApprovedEvent(
      LeaseExtensionApprovedEventSchema.parse(eventDetail),
    );
  }
}

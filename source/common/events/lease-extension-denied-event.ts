// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";

export const LeaseExtensionDeniedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  userEmail: z.string().email(),
  deniedBy: z.string().email(),
  comments: z.string().optional(),
});

export class LeaseExtensionDeniedEvent extends IsbEvent {
  override readonly DetailType = EventDetailTypes.LeaseExtensionDenied;
  override readonly Detail: z.infer<typeof LeaseExtensionDeniedEventSchema>;

  constructor(
    eventData: z.infer<typeof LeaseExtensionDeniedEventSchema>,
  ) {
    super();
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseExtensionDeniedEvent(
      LeaseExtensionDeniedEventSchema.parse(eventDetail),
    );
  }
}

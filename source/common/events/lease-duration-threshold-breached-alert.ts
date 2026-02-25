// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { ThresholdActionSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseExpirationAlertEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  triggeredDurationThreshold: z.number().gt(0),
  leaseDurationInHours: z.number().gt(0),
  actionRequested: ThresholdActionSchema,
});

export class LeaseDurationThresholdBreachedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseDurationThresholdBreachedAlert;
  readonly Detail: z.infer<typeof LeaseExpirationAlertEventSchema>;

  constructor(eventData: z.infer<typeof LeaseExpirationAlertEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseDurationThresholdBreachedAlert(
      LeaseExpirationAlertEventSchema.parse(eventDetail),
    );
  }
}

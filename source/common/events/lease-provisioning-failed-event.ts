// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseProvisioningFailedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  blueprintName: z.string(),
});

export type LeaseProvisioningFailedEventDetail = z.infer<
  typeof LeaseProvisioningFailedEventSchema
>;

export class LeaseProvisioningFailedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseProvisioningFailed;
  readonly Detail: LeaseProvisioningFailedEventDetail;

  constructor(eventData: LeaseProvisioningFailedEventDetail) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseProvisioningFailedEvent(
      LeaseProvisioningFailedEventSchema.parse(eventDetail),
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { LeaseKeySchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const BlueprintDeploymentFailedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  blueprintId: z.string().uuid(),
  accountId: AwsAccountIdSchema,
  operationId: z.string().optional(),
  errorType: z.string(),
  errorMessage: z.string(),
});

export class BlueprintDeploymentFailedEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.BlueprintDeploymentFailed;
  readonly Detail: z.infer<typeof BlueprintDeploymentFailedEventSchema>;

  constructor(eventData: z.infer<typeof BlueprintDeploymentFailedEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new BlueprintDeploymentFailedEvent(
      BlueprintDeploymentFailedEventSchema.parse(eventDetail),
    );
  }
}

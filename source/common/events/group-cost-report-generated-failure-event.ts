// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { z } from "zod";

export const GroupCostReportGenerationFailureEventSchema = z.object({
  reportMonth: z.string(), // e.g., "2024-01"
  timestamp: z.string(),
  logName: z.string(),
});

export class GroupCostReportGeneratedFailureEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.GroupCostReportGeneratedFailure;
  readonly Detail: z.infer<typeof GroupCostReportGenerationFailureEventSchema>;

  constructor(
    eventData: z.infer<typeof GroupCostReportGenerationFailureEventSchema>,
  ) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new GroupCostReportGeneratedFailureEvent(
      GroupCostReportGenerationFailureEventSchema.parse(eventDetail),
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import {
  LeaseFrozenEventInput,
  LeaseFrozenEventSchema,
  strippedFrozenDetail,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { Logger } from "@aws-lambda-powertools/logger";

const logger = new Logger();

export const LeaseFreezingEventSchema = LeaseFrozenEventSchema;

export class LeaseFreezingThresholdBreachedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseFreezingThresholdBreachedAlert;
  readonly Detail: LeaseFrozenEventInput;

  constructor(eventData: LeaseFrozenEventInput) {
    this.Detail = strippedFrozenDetail(eventData);

    const validated = LeaseFreezingEventSchema.safeParse(eventData);
    if (!validated.success) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: emitting an invalid ${EventDetailTypes.LeaseFreezingThresholdBreachedAlert} detail`,
        {
          logDetailType: "InvalidEventDetailEmitted",
          eventDetailType: EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
          invalidPaths: validated.error.issues.map((issue) =>
            issue.path.join("."),
          ),
        } satisfies SubscribableLog,
      );
    }
  }

  public static parse(eventDetail: unknown) {
    // The schema has already enforced the pairing rule the input union states,
    // which TypeScript cannot read back off the independently optional output.
    return new LeaseFreezingThresholdBreachedAlert(
      LeaseFreezingEventSchema.parse(eventDetail) as LeaseFrozenEventInput,
    );
  }
}

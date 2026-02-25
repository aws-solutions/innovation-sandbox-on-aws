// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { CleanupReasonSchema } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const AccountCleanupSuccessfulEventSchema = z.object({
  accountId: AwsAccountIdSchema,
  cleanupExecutionContext: z.object({
    stateMachineExecutionArn: z.string(),
    stateMachineExecutionStartTime: z.string(),
  }),
  reason: CleanupReasonSchema,
});

export class AccountCleanupSuccessfulEvent implements IsbEvent {
  readonly DetailType = EventDetailTypes.AccountCleanupSuccessful;
  readonly Detail: z.infer<typeof AccountCleanupSuccessfulEventSchema>;

  constructor(eventData: z.infer<typeof AccountCleanupSuccessfulEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new AccountCleanupSuccessfulEvent(
      AccountCleanupSuccessfulEventSchema.parse(eventDetail),
    );
  }
}

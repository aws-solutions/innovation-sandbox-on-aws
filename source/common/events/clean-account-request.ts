// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const CleanupReasonSchema = z.enum(
  [
    "ACCOUNT_REGISTRATION",
    "LEASE_TERMINATION",
    "RETRY_FAILED_CLEANUP",
    "LEASE_RESET",
  ],
  {
    errorMap: enumErrorMap,
  },
);

export type CleanupReason = z.infer<typeof CleanupReasonSchema>;

export const CleanAccountRequestSchema = z.object({
  accountId: AwsAccountIdSchema,
  reason: CleanupReasonSchema,
});

export class CleanAccountRequest implements IsbEvent {
  readonly DetailType = EventDetailTypes.CleanAccountRequest;
  readonly Detail: z.infer<typeof CleanAccountRequestSchema>;

  constructor(eventData: z.infer<typeof CleanAccountRequestSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new CleanAccountRequest(
      CleanAccountRequestSchema.parse(eventDetail),
    );
  }
}

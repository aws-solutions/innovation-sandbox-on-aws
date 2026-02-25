// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { IsbOuSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const AccountDriftEventSchema = z.object({
  accountId: AwsAccountIdSchema,
  actualOu: IsbOuSchema.optional(),
  expectedOu: IsbOuSchema.optional(),
});

export class AccountDriftDetectedAlert implements IsbEvent {
  readonly DetailType = EventDetailTypes.AccountDriftDetected;
  readonly Detail: z.infer<typeof AccountDriftEventSchema>;

  constructor(eventData: z.infer<typeof AccountDriftEventSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new AccountDriftDetectedAlert(
      AccountDriftEventSchema.parse(eventDetail),
    );
  }
}

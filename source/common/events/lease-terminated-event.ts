// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import {
  ExpiredLeaseStatus,
  LeaseKeySchema,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
  FreeTextSchema,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const LeaseTerminatedReasonTypeSchema = z.enum(
  [
    "Expired",
    "BudgetExceeded",
    "ManuallyTerminated",
    "AccountQuarantined",
    "Ejected",
    "ProvisioningFailed",
  ],
  {
    errorMap: enumErrorMap,
  },
);

export const LeaseTerminatedByDurationSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.Expired),
  leaseDurationInHours: z.number().gt(0),
});

export const LeaseTerminatedByBudgetSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.BudgetExceeded),
  budget: z.number().optional(),
  totalSpend: z.number(),
});

export const LeaseTerminatedManualSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.ManuallyTerminated),
  comment: FreeTextSchema,
});

export const LeaseTerminatedQuarantinedSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.AccountQuarantined),
  comment: FreeTextSchema,
});

export const LeaseTerminatedEjectedSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.Ejected),
  comment: FreeTextSchema,
});

export const LeaseTerminatedProvisioningFailedSchema = z.object({
  type: z.literal(LeaseTerminatedReasonTypeSchema.enum.ProvisioningFailed),
  comment: FreeTextSchema,
});

export const LeaseTerminatedReasonSchema = z.discriminatedUnion("type", [
  LeaseTerminatedByDurationSchema,
  LeaseTerminatedByBudgetSchema,
  LeaseTerminatedManualSchema,
  LeaseTerminatedQuarantinedSchema,
  LeaseTerminatedEjectedSchema,
  LeaseTerminatedProvisioningFailedSchema,
]);

export type LeaseTerminatedReason = z.infer<typeof LeaseTerminatedReasonSchema>;

export const LeaseTerminatedEventSchema = z.object({
  leaseId: LeaseKeySchema,
  accountId: AwsAccountIdSchema,
  reason: LeaseTerminatedReasonSchema,
});

export type LeaseTerminatedEventType<
  T extends z.infer<typeof LeaseTerminatedReasonTypeSchema> = z.infer<
    typeof LeaseTerminatedReasonTypeSchema
  >,
> = {
  DetailType: "LeaseTerminated";
  Detail: z.infer<typeof LeaseTerminatedEventSchema> & {
    reason: { type: T };
  };
};

export class LeaseTerminatedEvent<
  T extends z.infer<typeof LeaseTerminatedReasonTypeSchema> = z.infer<
    typeof LeaseTerminatedReasonTypeSchema
  >,
> implements IsbEvent {
  readonly DetailType = EventDetailTypes.LeaseTerminated;
  readonly Detail: z.infer<typeof LeaseTerminatedEventSchema> & {
    reason: { type: T };
  };

  constructor(
    eventData: z.infer<typeof LeaseTerminatedEventSchema> & {
      reason: { type: T };
    },
  ) {
    this.Detail = eventData;
  }

  public isType<R extends T>(t: R): this is LeaseTerminatedEvent<R> {
    return this.Detail.reason.type === t;
  }

  public static parse(eventDetail: unknown) {
    return new LeaseTerminatedEvent(
      LeaseTerminatedEventSchema.parse(eventDetail),
    );
  }
}

export function getLeaseTerminatedReason(
  expiredStatus: ExpiredLeaseStatus,
  lease: MonitoredLease,
): LeaseTerminatedReason {
  switch (expiredStatus) {
    case "Expired":
      if (lease.leaseDurationInHours === undefined) {
        throw new Error(
          "Lease duration is expected to be defined for this flow.",
        );
      }
      return {
        type: "Expired",
        leaseDurationInHours: lease.leaseDurationInHours,
      };
    case "BudgetExceeded":
      return {
        type: "BudgetExceeded",
        budget: lease.maxSpend,
        totalSpend: lease.totalCostAccrued,
      };
    case "ManuallyTerminated":
      return {
        type: "ManuallyTerminated",
        comment: "Terminated by admin",
      };
    case "AccountQuarantined":
      return {
        type: "AccountQuarantined",
        comment: "Account quarantined by admin",
      };
    case "Ejected":
      return {
        type: "Ejected",
        comment: "Account ejected by admin",
      };
    case "ProvisioningFailed":
      return {
        type: "ProvisioningFailed",
        comment: "Blueprint deployment failed",
      };
    default:
      throw new Error(`Unsupported expiration status.`);
  }
}

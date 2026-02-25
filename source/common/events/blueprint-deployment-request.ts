// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import z from "zod";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const BlueprintDeploymentRequestSchema = z.object({
  blueprintId: z.string().uuid(),
  leaseId: z.string().uuid(),
  userEmail: z.string().email(),
  accountId: z.string(),
  blueprintName: z.string(),
  stackSetId: z.string(),
  regions: z.array(z.string()),
  regionConcurrencyType: z.enum(["SEQUENTIAL", "PARALLEL"], {
    errorMap: enumErrorMap,
  }),
  deploymentTimeoutMinutes: z.number(),
  maxConcurrentPercentage: z.number().optional(),
  failureTolerancePercentage: z.number().optional(),
  concurrencyMode: z
    .enum(["STRICT_FAILURE_TOLERANCE", "SOFT_FAILURE_TOLERANCE"], {
      errorMap: enumErrorMap,
    })
    .optional(),
});

export class BlueprintDeploymentRequest implements IsbEvent {
  readonly DetailType = EventDetailTypes.BlueprintDeploymentRequest;
  readonly Detail: z.infer<typeof BlueprintDeploymentRequestSchema>;

  constructor(eventData: z.infer<typeof BlueprintDeploymentRequestSchema>) {
    this.Detail = eventData;
  }

  public static parse(eventDetail: unknown) {
    return new BlueprintDeploymentRequest(
      BlueprintDeploymentRequestSchema.parse(eventDetail),
    );
  }
}

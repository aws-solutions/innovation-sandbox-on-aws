// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import { BlueprintDeploymentFailedEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-failed-event.js";
import { BlueprintDeploymentSucceededEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-succeeded-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

export const PublishResultActionInputSchema = z.object({
  action: z.literal("PUBLISH_RESULT"),
  // Note: Step Function uses flat leaseId structure for simplicity.
  // This action transforms it to composite LeaseKey structure for events.
  leaseId: z.string().uuid(),
  userEmail: z.string().email(),
  blueprintId: z.string().uuid(),
  blueprintName: z.string().min(1),
  accountId: AwsAccountIdSchema,
  operationId: z.string().min(1),
  status: z.enum(["SUCCEEDED", "FAILED"], {
    errorMap: enumErrorMap,
  }),
  errorMessage: z.string().optional(),
});

export type PublishResultActionInput = z.infer<
  typeof PublishResultActionInputSchema
>;

export type PublishResultActionOutput = {
  published: true;
  status: "SUCCEEDED" | "FAILED";
};

export async function handlePublishResult(
  event: PublishResultActionInput,
  env: {
    USER_AGENT_EXTRA: string;
    ISB_EVENT_BUS: string;
    ISB_NAMESPACE: string;
  },
  logger: Logger,
  tracer: Tracer,
): Promise<PublishResultActionOutput> {
  logger.info("Publishing deployment result", {
    leaseId: event.leaseId,
    blueprintId: event.blueprintId,
    blueprintName: event.blueprintName,
    accountId: event.accountId,
    operationId: event.operationId,
    deploymentResult: event.status,
  });

  const eventBridgeClient = IsbServices.isbEventBridge(env);

  if (event.status === "SUCCEEDED") {
    await eventBridgeClient.sendIsbEvent(
      tracer,
      new BlueprintDeploymentSucceededEvent({
        leaseId: { userEmail: event.userEmail, uuid: event.leaseId },
        blueprintId: event.blueprintId,
        accountId: event.accountId,
        operationId: event.operationId,
        duration: 0,
      }),
    );

    logger.info("Blueprint deployment succeeded event published", {
      leaseId: event.leaseId,
      blueprintId: event.blueprintId,
      blueprintName: event.blueprintName,
      accountId: event.accountId,
      operationId: event.operationId,
      deploymentResult: "SUCCEEDED",
    });
  } else {
    await eventBridgeClient.sendIsbEvent(
      tracer,
      new BlueprintDeploymentFailedEvent({
        leaseId: { userEmail: event.userEmail, uuid: event.leaseId },
        blueprintId: event.blueprintId,
        accountId: event.accountId,
        operationId: event.operationId,
        errorType: "DeploymentFailed",
        errorMessage: event.errorMessage ?? "Unknown deployment error",
      }),
    );

    logger.info("Blueprint deployment failed event published", {
      leaseId: event.leaseId,
      blueprintId: event.blueprintId,
      blueprintName: event.blueprintName,
      accountId: event.accountId,
      operationId: event.operationId,
      deploymentResult: "FAILED",
      errorType: "DeploymentFailed",
      errorMessage: event.errorMessage,
    });
  }

  return {
    published: true,
    status: event.status,
  };
}

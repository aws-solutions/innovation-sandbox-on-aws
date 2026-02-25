// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudFormationClient,
  DescribeStackSetOperationCommand,
  ListStackInstancesCommand,
  StackInstanceSummary,
  StackSetOperationStatus,
} from "@aws-sdk/client-cloudformation";
import { z } from "zod";

import { generateDeploymentSK } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import {
  calculateDurationInMinutes,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";

import { withCloudFormationBackoff } from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/utils/cloudformation-backoff.js";

export const CheckStatusActionInputSchema = z.object({
  action: z.literal("CHECK_STATUS"),
  stackSetId: z.string().min(1),
  operationId: z.string().min(1),
  blueprintId: z.string().uuid(),
  leaseId: z.string().uuid(),
  accountId: AwsAccountIdSchema,
  deploymentTimeoutMinutes: z.number(),
  executionStartTime: z.string().datetime(),
});

export type CheckStatusActionInput = z.infer<
  typeof CheckStatusActionInputSchema
>;

export type CheckStatusActionOutput = {
  operationId: string;
  status: "SUCCEEDED" | "FAILED" | "IN_PROGRESS";
  errorMessage: string;
};

/**
 * Get detailed per-region error messages from failed stack instances
 * Returns error message in format: "region1: error1; region2: error2"
 *
 * IMPORTANT: If you change the format here, update the parsing logic in:
 * DeploymentHistoryTable in Blueprints page
 */
async function getDetailedErrorMessage(
  cfnClient: CloudFormationClient,
  event: CheckStatusActionInput,
  statusReason: string | undefined,
  logger: Logger,
): Promise<string> {
  try {
    const instancesResponse = await cfnClient.send(
      new ListStackInstancesCommand({
        StackSetName: event.stackSetId,
        Filters: [
          {
            Name: "LAST_OPERATION_ID",
            Values: event.operationId,
          },
          {
            Name: "DETAILED_STATUS",
            Values: "FAILED",
          },
        ],
        StackInstanceAccount: event.accountId,
      }),
    );

    const failedInstances = instancesResponse.Summaries || [];

    if (failedInstances.length > 0) {
      // Format: "region1: error1; region2: error2"
      return failedInstances
        .map(
          (instance: StackInstanceSummary) =>
            `${instance.Region}: ${instance.StatusReason || "Unknown error"}`,
        )
        .join("; ");
    }

    return statusReason || "Stack instance deployment failed";
  } catch (error) {
    logger.warn("Failed to get detailed stack instance errors", {
      error: error instanceof Error ? error.message : String(error),
      operationId: event.operationId,
    });
    return statusReason || "Stack instance deployment failed";
  }
}

/**
 * Check if deployment has exceeded timeout
 */
function checkTimeout(
  elapsedMinutes: number,
  event: CheckStatusActionInput,
  logger: Logger,
): CheckStatusActionOutput | null {
  if (elapsedMinutes >= event.deploymentTimeoutMinutes) {
    logger.warn("Deployment exceeded timeout", {
      elapsedMinutes,
      timeoutMinutes: event.deploymentTimeoutMinutes,
      operationId: event.operationId,
    });

    return {
      operationId: event.operationId,
      status: "FAILED",
      errorMessage: `Deployment exceeded ${event.deploymentTimeoutMinutes} minute timeout`,
    };
  }

  return null;
}

/**
 * Determine error type based on timeout and status
 */
function determineErrorType(
  finalStatus: "SUCCEEDED" | "FAILED",
  elapsedMinutes: number,
  timeoutMinutes: number,
): string | undefined {
  if (finalStatus !== "FAILED") {
    return undefined;
  }

  return elapsedMinutes >= timeoutMinutes
    ? "DeploymentTimeout"
    : "DeploymentFailed";
}

export async function handleCheckStatus(
  event: CheckStatusActionInput,
  env: {
    USER_AGENT_EXTRA: string;
    BLUEPRINT_TABLE_NAME: string;
  },
  logger: Logger,
): Promise<CheckStatusActionOutput> {
  logger.debug("Checking deployment status", {
    stackSetId: event.stackSetId,
    operationId: event.operationId,
  });

  const elapsedMinutes = calculateDurationInMinutes(event.executionStartTime);

  // Check timeout first
  const timeoutResult = checkTimeout(elapsedMinutes, event, logger);
  if (timeoutResult) {
    // Update DDB deployment record from RUNNING → FAILED before returning
    const blueprintStore = IsbServices.blueprintStore(env);
    const deploymentSK = generateDeploymentSK(
      event.executionStartTime,
      event.operationId,
    );

    await blueprintStore.updateDeploymentStatusAndMetrics({
      blueprintId: event.blueprintId,
      stackSetId: event.stackSetId,
      deploymentSK,
      status: "FAILED",
      duration: elapsedMinutes,
      deploymentTimestamp: nowAsIsoDatetimeString(),
      errorType: "DeploymentTimeout",
      errorMessage: timeoutResult.errorMessage,
    });

    return timeoutResult;
  }

  const cfnClient = IsbClients.cloudFormation(env);

  const response = await withCloudFormationBackoff(
    async () => {
      const command = new DescribeStackSetOperationCommand({
        StackSetName: event.stackSetId,
        OperationId: event.operationId,
      });

      return await cfnClient.send(command);
    },
    logger,
    {
      operationId: event.operationId,
      stackSetId: event.stackSetId,
    },
  );

  const status = response.StackSetOperation?.Status;
  const statusReason = response.StackSetOperation?.StatusReason;

  if (!status) {
    throw new Error("CloudFormation did not return operation status");
  }

  const isComplete =
    status === StackSetOperationStatus.SUCCEEDED ||
    status === StackSetOperationStatus.FAILED ||
    status === StackSetOperationStatus.STOPPED;

  logger.info("Deployment status checked", {
    status,
    statusReason,
    isComplete,
  });

  if (!isComplete) {
    return {
      operationId: event.operationId,
      status: "IN_PROGRESS",
      errorMessage: "",
    };
  }

  const blueprintStore = IsbServices.blueprintStore(env);
  const finalStatus =
    status === StackSetOperationStatus.SUCCEEDED ? "SUCCEEDED" : "FAILED";

  const durationMinutes = calculateDurationInMinutes(event.executionStartTime);
  const deploymentTimestamp = nowAsIsoDatetimeString();

  const deploymentSK = generateDeploymentSK(
    event.executionStartTime,
    event.operationId,
  );

  const errorType = determineErrorType(
    finalStatus,
    elapsedMinutes,
    event.deploymentTimeoutMinutes,
  );

  // Get detailed error message for failures
  const errorMessage =
    finalStatus === "FAILED"
      ? await getDetailedErrorMessage(cfnClient, event, statusReason, logger)
      : "";

  await blueprintStore.updateDeploymentStatusAndMetrics({
    blueprintId: event.blueprintId,
    stackSetId: event.stackSetId,
    deploymentSK,
    status: finalStatus,
    duration: durationMinutes,
    deploymentTimestamp,
    errorType,
    errorMessage,
  });

  return {
    operationId: event.operationId,
    status: finalStatus,
    errorMessage,
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { randomUUID } from "crypto";

import { Logger } from "@aws-lambda-powertools/logger";
import {
  ConcurrencyMode,
  CreateStackInstancesCommand,
  OperationInProgressException,
  RegionConcurrencyType,
} from "@aws-sdk/client-cloudformation";
import { z } from "zod";

import { generateDeploymentSK } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  AwsAccountIdSchema,
  enumErrorMap,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

import { withCloudFormationBackoff } from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/utils/cloudformation-backoff.js";

export const CreateActionInputSchema = z
  .object({
    action: z.literal("CREATE"),
    leaseId: z.string().uuid(),
    blueprintId: z.string().uuid(),
    accountId: AwsAccountIdSchema,
    stackSetId: z.string().min(1),
    regions: z.array(z.string()).min(1),
    regionConcurrencyType: z.enum(
      [RegionConcurrencyType.SEQUENTIAL, RegionConcurrencyType.PARALLEL],
      {
        errorMap: enumErrorMap,
      },
    ),
    maxConcurrentPercentage: z.number().int().min(1).max(100).optional(),
    failureTolerancePercentage: z.number().int().min(0).max(100).optional(),
    concurrencyMode: z
      .enum(
        [
          ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
          ConcurrencyMode.SOFT_FAILURE_TOLERANCE,
        ],
        {
          errorMap: enumErrorMap,
        },
      )
      .optional(),
    executionStartTime: z.string().optional(),
  })
  .strict();

export type CreateActionInput = z.infer<typeof CreateActionInputSchema>;

export type CreateActionOutput = {
  success: boolean;
  operationId: string;
  status: "SUCCEEDED" | "FAILED" | "IN_PROGRESS";
  errorMessage: string;
};

/**
 * Record a failed deployment attempt due to OperationInProgressException in DDB
 * and return a structured failure response for the Step Functions workflow.
 */
async function handleOperationInProgress(
  event: CreateActionInput,
  env: { USER_AGENT_EXTRA: string; BLUEPRINT_TABLE_NAME: string },
  logger: Logger,
): Promise<CreateActionOutput> {
  const errorMessage = `Another operation is in progress on this StackSet. Enable managed execution on your StackSet to allow concurrent deployments.`;
  const operationId = `not-started-${randomUUID()}`;
  const deploymentStartedAt = event.executionStartTime!;

  logger.error("CreateStackInstances failed: OperationInProgressException", {
    stackSetId: event.stackSetId,
    blueprintId: event.blueprintId,
    leaseId: event.leaseId,
  });

  const blueprintStore = IsbServices.blueprintStore(env);

  await blueprintStore.recordDeploymentStart({
    blueprintId: event.blueprintId,
    stackSetId: event.stackSetId,
    leaseId: event.leaseId,
    accountId: event.accountId,
    operationId,
    deploymentStartedAt,
  });

  await blueprintStore.updateDeploymentStatusAndMetrics({
    blueprintId: event.blueprintId,
    stackSetId: event.stackSetId,
    deploymentSK: generateDeploymentSK(deploymentStartedAt, operationId),
    status: "FAILED",
    duration: 0,
    deploymentTimestamp: nowAsIsoDatetimeString(),
    errorType: "OperationInProgressException",
    errorMessage,
  });

  return {
    success: false,
    operationId,
    status: "FAILED",
    errorMessage,
  };
}

export async function handleCreateStackInstances(
  event: CreateActionInput,
  env: {
    USER_AGENT_EXTRA: string;
    INTERMEDIATE_ROLE_ARN: string;
    SANDBOX_ACCOUNT_ROLE_NAME: string;
    BLUEPRINT_TABLE_NAME: string;
    ORG_MGT_ACCOUNT_ID: string;
    HUB_ACCOUNT_ID: string;
  },
  logger: Logger,
): Promise<CreateActionOutput> {
  logger.info("Creating stack instances", {
    blueprintId: event.blueprintId,
    leaseId: event.leaseId,
    accountId: event.accountId,
    stackSetId: event.stackSetId,
    regionCount: event.regions.length,
    regionConcurrencyType: event.regionConcurrencyType,
    maxConcurrentPercentage: event.maxConcurrentPercentage ?? 1,
    failureTolerancePercentage: event.failureTolerancePercentage ?? 0,
    concurrencyMode:
      event.concurrencyMode ?? ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
  });

  const cfnClient = IsbClients.cloudFormation(env);
  const blueprintDeploymentService =
    IsbServices.blueprintDeploymentService(env);

  try {
    // Validate StackSet exists and is SELF_MANAGED
    await blueprintDeploymentService.validateStackSetForDeployment(
      event.stackSetId,
    );
  } catch (error) {
    logger.error("StackSet validation failed", {
      error,
      stackSetId: event.stackSetId,
      blueprintId: event.blueprintId,
      leaseId: event.leaseId,
    });
    return {
      success: false,
      operationId: "N/A",
      status: "FAILED",
      errorMessage: `Failed to validate StackSet ID '${event.stackSetId}': ${error instanceof Error ? error.message : String(error)}`,
    };
  }

  try {
    const response = await withCloudFormationBackoff(
      async () => {
        const command = new CreateStackInstancesCommand({
          StackSetName: event.stackSetId, // Use ID (AWS API accepts either name or ID)
          Accounts: [event.accountId],
          Regions: event.regions,
          OperationPreferences: {
            RegionConcurrencyType: event.regionConcurrencyType,
            MaxConcurrentPercentage: event.maxConcurrentPercentage ?? 100,
            FailureTolerancePercentage: event.failureTolerancePercentage ?? 0,
            ConcurrencyMode:
              event.concurrencyMode ?? ConcurrencyMode.STRICT_FAILURE_TOLERANCE,
            // RegionOrder only applies to SEQUENTIAL deployments
            RegionOrder:
              event.regionConcurrencyType === RegionConcurrencyType.SEQUENTIAL
                ? event.regions
                : undefined,
          },
        });

        return await cfnClient.send(command);
      },
      logger,
      { stackSetId: event.stackSetId, accountId: event.accountId },
    );

    if (!response.OperationId) {
      throw new Error("CloudFormation did not return an OperationId");
    }

    logger.info("Stack instances creation started", {
      operationId: response.OperationId,
    });

    const blueprintStore = IsbServices.blueprintStore(env);

    await blueprintStore.recordDeploymentStart({
      blueprintId: event.blueprintId,
      stackSetId: event.stackSetId,
      leaseId: event.leaseId,
      accountId: event.accountId,
      operationId: response.OperationId,
      deploymentStartedAt: event.executionStartTime!,
    });

    return {
      success: true,
      operationId: response.OperationId,
      status: "IN_PROGRESS",
      errorMessage: "",
    };
  } catch (error) {
    if (error instanceof OperationInProgressException) {
      return handleOperationInProgress(event, env, logger);
    }
    throw error;
  }
}

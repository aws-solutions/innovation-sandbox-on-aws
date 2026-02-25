// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { handleCheckStatus } from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/check-deployment-status.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudFormationClient,
  DescribeStackSetOperationCommand,
  ListStackInstancesCommand,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfnMock = mockClient(CloudFormationClient);
const mockLogger = new Logger();
const mockEnv = {
  USER_AGENT_EXTRA: "test",
  BLUEPRINT_TABLE_NAME: "test-blueprints",
};

beforeEach(() => {
  cfnMock.reset();
  vi.spyOn(
    DynamoBlueprintStore.prototype,
    "updateDeploymentStatusAndMetrics",
  ).mockResolvedValue();
});

afterEach(() => {
  cfnMock.reset();
  vi.restoreAllMocks();
});

describe("check-deployment-status action", () => {
  const baseEvent = {
    action: "CHECK_STATUS" as const,
    stackSetId: "a1b2c3d4-5678-90ab-cdef-123456789abc",
    operationId: "12345678-1234-1234-1234-123456789abc",
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    blueprintId: "650e8400-e29b-41d4-a716-446655440000",
    accountId: "123456789012",
    deploymentTimeoutMinutes: 30,
    executionStartTime: new Date(Date.now() - 60000).toISOString(),
  };

  describe("SUCCEEDED status", () => {
    it("should return PUBLISH_RESULT action with success", async () => {
      cfnMock.on(DescribeStackSetOperationCommand).resolves({
        StackSetOperation: {
          Status: "SUCCEEDED",
          OperationId: "12345678-1234-1234-1234-123456789abc",
        },
      });

      const updateSpy = vi.spyOn(
        DynamoBlueprintStore.prototype,
        "updateDeploymentStatusAndMetrics",
      );

      const result = await handleCheckStatus(baseEvent, mockEnv, mockLogger);

      expect(result).toEqual({
        operationId: "12345678-1234-1234-1234-123456789abc",
        status: "SUCCEEDED",
        errorMessage: "",
      });

      // Verify DDB was updated with SUCCEEDED status
      expect(updateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId: baseEvent.blueprintId,
          stackSetId: baseEvent.stackSetId,
          status: "SUCCEEDED",
        }),
      );
    });
  });

  describe("RUNNING status", () => {
    it("should return CHECK_STATUS action to continue polling", async () => {
      cfnMock.on(DescribeStackSetOperationCommand).resolves({
        StackSetOperation: {
          Status: "RUNNING",
          OperationId: "12345678-1234-1234-1234-123456789abc",
        },
      });

      const result = await handleCheckStatus(baseEvent, mockEnv, mockLogger);

      expect(result).toEqual({
        operationId: "12345678-1234-1234-1234-123456789abc",
        status: "IN_PROGRESS",
        errorMessage: "",
      });
    });
  });

  describe("FAILED status", () => {
    it("should return detailed per-region error messages from stack instances", async () => {
      cfnMock.on(DescribeStackSetOperationCommand).resolves({
        StackSetOperation: {
          Status: "FAILED",
          StatusReason: "One or more stack instances failed",
          OperationId: "12345678-1234-1234-1234-123456789abc",
        },
      });

      cfnMock.on(ListStackInstancesCommand).resolves({
        Summaries: [
          {
            Region: "us-east-1",
            Account: "123456789012",
            StatusReason: "IAM role not found in target account",
          },
          {
            Region: "us-west-2",
            Account: "123456789012",
            StatusReason: "Insufficient permissions to create resources",
          },
        ],
      });

      const result = await handleCheckStatus(baseEvent, mockEnv, mockLogger);

      expect(result).toEqual({
        operationId: "12345678-1234-1234-1234-123456789abc",
        status: "FAILED",
        errorMessage:
          "us-east-1: IAM role not found in target account; us-west-2: Insufficient permissions to create resources",
      });

      // Verify filters were used correctly
      const commandCalls = cfnMock.commandCalls(ListStackInstancesCommand);
      expect(commandCalls[0]?.args[0]?.input).toMatchObject({
        Filters: [
          {
            Name: "LAST_OPERATION_ID",
            Values: "12345678-1234-1234-1234-123456789abc",
          },
          { Name: "DETAILED_STATUS", Values: "FAILED" },
        ],
        StackInstanceAccount: "123456789012",
      });
    });

    it("should fallback to StatusReason when list-stack-instances fails", async () => {
      cfnMock.on(DescribeStackSetOperationCommand).resolves({
        StackSetOperation: {
          Status: "FAILED",
          StatusReason: "StackSet not found",
          OperationId: "12345678-1234-1234-1234-123456789abc",
        },
      });

      cfnMock.on(ListStackInstancesCommand).rejects(new Error("Access denied"));

      const result = await handleCheckStatus(baseEvent, mockEnv, mockLogger);

      expect(result).toEqual({
        operationId: "12345678-1234-1234-1234-123456789abc",
        status: "FAILED",
        errorMessage: "StackSet not found",
      });
    });
  });

  describe("timeout handling", () => {
    it.each([
      { label: "exceeds timeout", elapsedMs: 6 * 60 * 1000 },
      {
        label: "exact boundary (elapsed === timeout)",
        elapsedMs: 5 * 60 * 1000,
      },
    ])(
      "should update DDB deployment record when $label",
      async ({ elapsedMs }) => {
        const timedOutEvent = {
          ...baseEvent,
          deploymentTimeoutMinutes: 5,
          executionStartTime: new Date(Date.now() - elapsedMs).toISOString(),
        };

        const updateSpy = vi.spyOn(
          DynamoBlueprintStore.prototype,
          "updateDeploymentStatusAndMetrics",
        );

        const result = await handleCheckStatus(
          timedOutEvent,
          mockEnv,
          mockLogger,
        );

        expect(result).toEqual({
          operationId: timedOutEvent.operationId,
          status: "FAILED",
          errorMessage: "Deployment exceeded 5 minute timeout",
        });

        expect(updateSpy).toHaveBeenCalledWith(
          expect.objectContaining({
            blueprintId: timedOutEvent.blueprintId,
            stackSetId: timedOutEvent.stackSetId,
            status: "FAILED",
            errorType: "DeploymentTimeout",
            errorMessage: "Deployment exceeded 5 minute timeout",
            duration: expect.closeTo(elapsedMs / 60000, 1),
            deploymentTimestamp: expect.any(String),
            deploymentSK: expect.any(String),
          }),
        );

        // Verify CloudFormation was NOT called (timeout short-circuits)
        expect(
          cfnMock.commandCalls(DescribeStackSetOperationCommand),
        ).toHaveLength(0);
      },
    );

    it("should propagate DDB update errors on timeout", async () => {
      const timedOutEvent = {
        ...baseEvent,
        deploymentTimeoutMinutes: 5,
        executionStartTime: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      };

      vi.spyOn(
        DynamoBlueprintStore.prototype,
        "updateDeploymentStatusAndMetrics",
      ).mockRejectedValueOnce(new Error("DDB write failed"));

      await expect(
        handleCheckStatus(timedOutEvent, mockEnv, mockLogger),
      ).rejects.toThrow("DDB write failed");
    });
  });

  describe("STOPPED status", () => {
    it("should return PUBLISH_RESULT action with failure for stopped operation", async () => {
      cfnMock.on(DescribeStackSetOperationCommand).resolves({
        StackSetOperation: {
          Status: "STOPPED",
          StatusReason: "Operation cancelled",
          OperationId: "12345678-1234-1234-1234-123456789abc",
        },
      });

      const result = await handleCheckStatus(baseEvent, mockEnv, mockLogger);

      expect(result).toEqual({
        operationId: "12345678-1234-1234-1234-123456789abc",
        status: "FAILED",
        errorMessage: "Operation cancelled",
      });
    });
  });
});

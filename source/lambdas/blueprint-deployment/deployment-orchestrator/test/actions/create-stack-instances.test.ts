// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CreateActionInputSchema,
  handleCreateStackInstances,
} from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/create-stack-instances.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudFormationClient,
  CloudFormationServiceException,
  CreateStackInstancesCommand,
  DescribeStackSetCommand,
  OperationInProgressException,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const cfnMock = mockClient(CloudFormationClient);
const mockLogger = new Logger();
const mockEnv = {
  USER_AGENT_EXTRA: "test",
  INTERMEDIATE_ROLE_ARN: "arn:aws:iam::123456789012:role/IntermediateRole",
  SANDBOX_ACCOUNT_ROLE_NAME: "SandboxAccountRole",
  BLUEPRINT_TABLE_NAME: "test-blueprints",
  ORG_MGT_ACCOUNT_ID: "123456789012",
  HUB_ACCOUNT_ID: "123456789012",
};

beforeEach(() => {
  cfnMock.reset();
  vi.spyOn(
    DynamoBlueprintStore.prototype,
    "recordDeploymentStart",
  ).mockResolvedValue({} as any);
  vi.spyOn(
    DynamoBlueprintStore.prototype,
    "updateDeploymentStatusAndMetrics",
  ).mockResolvedValue();
});

afterEach(() => {
  cfnMock.reset();
  vi.restoreAllMocks();
});

describe("create-stack-instances action", () => {
  const baseEvent = {
    action: "CREATE" as const,
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    blueprintId: "650e8400-e29b-41d4-a716-446655440000",
    accountId: "123456789012",
    stackSetId: "test-stackset:abc123-def456",
    regions: ["us-east-1", "us-west-2"],
    regionConcurrencyType: "SEQUENTIAL" as const,
  };

  describe("Input validation", () => {
    it("should reject invalid maxConcurrentPercentage (< 1)", () => {
      const invalidEvent = {
        ...baseEvent,
        maxConcurrentPercentage: 0,
      };

      expect(() => CreateActionInputSchema.parse(invalidEvent)).toThrow();
    });

    it("should reject invalid maxConcurrentPercentage (> 100)", () => {
      const invalidEvent = {
        ...baseEvent,
        maxConcurrentPercentage: 150,
      };

      expect(() => CreateActionInputSchema.parse(invalidEvent)).toThrow();
    });

    it("should reject invalid failureTolerancePercentage (< 0)", () => {
      const invalidEvent = {
        ...baseEvent,
        failureTolerancePercentage: -1,
      };

      expect(() => CreateActionInputSchema.parse(invalidEvent)).toThrow();
    });

    it("should reject invalid failureTolerancePercentage (> 100)", () => {
      const invalidEvent = {
        ...baseEvent,
        failureTolerancePercentage: 150,
      };

      expect(() => CreateActionInputSchema.parse(invalidEvent)).toThrow();
    });

    it("should accept valid percentage values", () => {
      const validEvent = {
        ...baseEvent,
        maxConcurrentPercentage: 50,
        failureTolerancePercentage: 10,
      };

      expect(() => CreateActionInputSchema.parse(validEvent)).not.toThrow();
    });
  });

  describe("Success path", () => {
    it("should create stack instances and return CHECK_STATUS action", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });
      cfnMock.on(CreateStackInstancesCommand).resolves({
        OperationId: "12345678-1234-1234-1234-123456789def",
      });

      const result = await handleCreateStackInstances(
        baseEvent,
        mockEnv,
        mockLogger,
      );

      expect(result).toEqual({
        success: true,
        operationId: "12345678-1234-1234-1234-123456789def",
        status: "IN_PROGRESS",
        errorMessage: "",
      });
    });

    it("should call CreateStackInstances with correct parameters", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });
      cfnMock.on(CreateStackInstancesCommand).resolves({
        OperationId: "12345678-1234-1234-1234-123456789def",
      });

      await handleCreateStackInstances(baseEvent, mockEnv, mockLogger);

      const calls = cfnMock.commandCalls(CreateStackInstancesCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0]?.input).toEqual({
        StackSetName: "test-stackset:abc123-def456", // Uses stackSetId (AWS API accepts either name or ID)
        Accounts: ["123456789012"],
        Regions: ["us-east-1", "us-west-2"],
        OperationPreferences: {
          RegionConcurrencyType: "SEQUENTIAL",
          MaxConcurrentPercentage: 100, // Default: Conservative strategy
          FailureTolerancePercentage: 0, // Default: Conservative strategy
          ConcurrencyMode: "STRICT_FAILURE_TOLERANCE",
          RegionOrder: ["us-east-1", "us-west-2"], // Set for SEQUENTIAL deployments
        },
      });
    });

    it("should use custom deployment configuration when provided", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });
      cfnMock.on(CreateStackInstancesCommand).resolves({
        OperationId: "12345678-1234-1234-1234-123456789def",
      });

      const eventWithCustomConfig = {
        ...baseEvent,
        regionConcurrencyType: "PARALLEL" as const,
        maxConcurrentPercentage: 50,
        failureTolerancePercentage: 20,
        concurrencyMode: "SOFT_FAILURE_TOLERANCE" as const,
      };

      await handleCreateStackInstances(
        eventWithCustomConfig,
        mockEnv,
        mockLogger,
      );

      const calls = cfnMock.commandCalls(CreateStackInstancesCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]?.args[0]?.input).toEqual({
        StackSetName: "test-stackset:abc123-def456",
        Accounts: ["123456789012"],
        Regions: ["us-east-1", "us-west-2"],
        OperationPreferences: {
          RegionConcurrencyType: "PARALLEL",
          MaxConcurrentPercentage: 50,
          FailureTolerancePercentage: 20,
          ConcurrencyMode: "SOFT_FAILURE_TOLERANCE",
        },
      });
    });
  });

  describe("Retry logic", () => {
    it("should retry on throttling error and succeed", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });

      // Create proper CloudFormationServiceException with retryable throttling
      const throttlingError = Object.assign(new Error("Throttling"), {
        name: "Throttling",
        $fault: "client",
        $metadata: { httpStatusCode: 429 },
        $retryable: { throttling: true },
      });
      Object.setPrototypeOf(
        throttlingError,
        CloudFormationServiceException.prototype,
      );

      cfnMock
        .on(CreateStackInstancesCommand)
        .rejectsOnce(throttlingError)
        .rejectsOnce(throttlingError)
        .resolves({ OperationId: "12345678-1234-1234-1234-retry123456" });

      const result = await handleCreateStackInstances(
        baseEvent,
        mockEnv,
        mockLogger,
      );

      expect(result.operationId).toBe("12345678-1234-1234-1234-retry123456");
      expect(cfnMock.commandCalls(CreateStackInstancesCommand)).toHaveLength(3);
    });

    it(
      "should throw error after max retry attempts",
      { timeout: 15000 },
      async () => {
        cfnMock.on(DescribeStackSetCommand).resolves({
          StackSet: {
            StackSetName: "test-stackset",
            StackSetId: "test-stackset:abc123-def456",
            PermissionModel: "SELF_MANAGED",
            Status: "ACTIVE",
          },
        });

        const throttlingError = Object.assign(new Error("Throttling"), {
          name: "Throttling",
          $fault: "client",
          $metadata: { httpStatusCode: 429 },
          $retryable: { throttling: true },
        });
        Object.setPrototypeOf(
          throttlingError,
          CloudFormationServiceException.prototype,
        );

        cfnMock.on(CreateStackInstancesCommand).rejects(throttlingError);

        await expect(
          handleCreateStackInstances(baseEvent, mockEnv, mockLogger),
        ).rejects.toThrow("Throttling");

        expect(cfnMock.commandCalls(CreateStackInstancesCommand)).toHaveLength(
          5,
        );
      },
    );

    it("should return FAILED on OperationInProgressException and record in deployment history", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });

      const operationInProgressError = new OperationInProgressException({
        message: "Another Operation on StackSet is in progress",
        $metadata: {},
      });

      cfnMock.on(CreateStackInstancesCommand).rejects(operationInProgressError);

      const result = await handleCreateStackInstances(
        baseEvent,
        mockEnv,
        mockLogger,
      );

      expect(result.success).toBe(false);
      expect(result.status).toBe("FAILED");
      expect(result.operationId).not.toBe("N/A");
      expect(result.errorMessage).toContain("managed execution");
      expect(result.errorMessage).not.toContain("https://");

      expect(
        DynamoBlueprintStore.prototype.recordDeploymentStart,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId: baseEvent.blueprintId,
          leaseId: baseEvent.leaseId,
          accountId: baseEvent.accountId,
          stackSetId: baseEvent.stackSetId,
        }),
      );
      expect(
        DynamoBlueprintStore.prototype.updateDeploymentStatusAndMetrics,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          blueprintId: baseEvent.blueprintId,
          stackSetId: baseEvent.stackSetId,
          status: "FAILED",
          errorType: "OperationInProgressException",
          duration: 0,
        }),
      );
    });
  });

  describe("Error handling", () => {
    it("should return FAILED status when StackSet not found", async () => {
      // AWS API throws StackSetNotFoundException when StackSet doesn't exist
      const awsError = new Error("StackSet not found");
      awsError.name = "StackSetNotFoundException";
      cfnMock.on(DescribeStackSetCommand).rejects(awsError);

      const result = await handleCreateStackInstances(
        baseEvent,
        mockEnv,
        mockLogger,
      );

      expect(result).toEqual({
        success: false,
        operationId: "N/A",
        status: "FAILED",
        errorMessage: expect.stringContaining("not found"),
      });
    });

    it("should throw error if OperationId is missing", async () => {
      cfnMock.on(DescribeStackSetCommand).resolves({
        StackSet: {
          StackSetName: "test-stackset",
          StackSetId: "test-stackset:abc123-def456",
          PermissionModel: "SELF_MANAGED",
          Status: "ACTIVE",
        },
      });
      cfnMock.on(CreateStackInstancesCommand).resolves({
        OperationId: undefined,
      });

      await expect(
        handleCreateStackInstances(baseEvent, mockEnv, mockLogger),
      ).rejects.toThrow("CloudFormation did not return an OperationId");
    });
  });
});

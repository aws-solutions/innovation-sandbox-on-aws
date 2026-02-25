// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  CloudFormationClient,
  DeleteStackInstancesCommand,
  DescribeStackSetCommand,
  StackSet,
  StackSetNotFoundException,
} from "@aws-sdk/client-cloudformation";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import {
  BlueprintDeploymentService,
  StackSetNotFoundError,
  UnsupportedPermissionModelError,
} from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";

// Mock CloudFormation Client
const mockCloudFormationClient = mockClient(CloudFormationClient);

describe("BlueprintDeploymentService", () => {
  let service: BlueprintDeploymentService;
  const env = {
    INTERMEDIATE_ROLE_ARN:
      "arn:aws:iam::123456789012:role/ISB-IntermediateRole",
    SANDBOX_ACCOUNT_ROLE_NAME: "ISB-SandboxAccountRole",
    ORG_MGT_ACCOUNT_ID: "111111111111",
    HUB_ACCOUNT_ID: "222222222222",
  };

  beforeEach(() => {
    mockCloudFormationClient.reset();
    vi.clearAllMocks();
    service = new BlueprintDeploymentService(
      mockCloudFormationClient as any,
      env,
    );
  });

  afterEach(() => {
    vi.resetAllMocks();
  });

  describe("validateStackSet()", () => {
    test("should validate StackSet with recommended ISB roles", async () => {
      // Arrange
      const stackSetId = "test-stackset:a1b2c3d4-5678-90ab-cdef-123456789abc";
      const stackSet: StackSet = {
        StackSetName: "test-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act
      const result = await service.validateStackSet(stackSetId);

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.stackSet).toEqual(stackSet);
      expect(
        mockCloudFormationClient.commandCalls(DescribeStackSetCommand),
      ).toHaveLength(1);
    });

    test("should warn when StackSet uses both non-recommended roles", async () => {
      // Arrange
      const stackSetId = "fully-custom-stackset:abc123-def456";
      const customAdminRole = "arn:aws:iam::123456789012:role/CustomAdminRole";
      const customExecRole = "CustomExecutionRole";
      const stackSet: StackSet = {
        StackSetName: "fully-custom-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: customAdminRole,
        ExecutionRoleName: customExecRole,
        PermissionModel: "SELF_MANAGED",
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act
      const result = await service.validateStackSet(stackSetId);

      // Assert
      expect(result.isValid).toBe(true);
      expect(result.stackSet).toEqual(stackSet);
    });

    test("should return error when StackSet does not exist", async () => {
      // Arrange
      const stackSetId = "nonexistent-stackset:abc123-def456";

      // AWS API throws StackSetNotFoundException when StackSet doesn't exist
      mockCloudFormationClient.on(DescribeStackSetCommand).rejects(
        new StackSetNotFoundException({
          message: "StackSet not found",
          $metadata: {},
        }),
      );

      // Act
      const result = await service.validateStackSet(stackSetId);

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.errorType).toBe("NOT_FOUND");
      expect(result.errorMessage).toContain(
        "StackSet not found or has been deleted",
      );
    });

    test("should return NOT_FOUND error when StackSet has DELETED status", async () => {
      // Arrange
      const stackSetId = "deleted-stackset:abc123-def456";
      const stackSet: StackSet = {
        StackSetName: "deleted-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "DELETED",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act
      const result = await service.validateStackSet(stackSetId);

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.errorType).toBe("NOT_FOUND");
      expect(result.errorMessage).toContain("StackSet has been deleted");
    });

    test("should return error when StackSet uses SERVICE_MANAGED", async () => {
      // Arrange
      const stackSetId = "service-managed-stackset:abc123-def456";
      const stackSet: StackSet = {
        StackSetName: "service-managed-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SERVICE_MANAGED",
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act
      const result = await service.validateStackSet(stackSetId);

      // Assert
      expect(result.isValid).toBe(false);
      expect(result.errorType).toBe("UNSUPPORTED_PERMISSION_MODEL");
      expect(result.errorMessage).toBe(
        "Only SELF_MANAGED StackSets are supported for blueprint registration.",
      );
    });

    test("should reject StackSet with null PermissionModel and Control Tower role", async () => {
      const stackSetId = "ct-stackset:abc123-def456";
      const stackSet: StackSet = {
        StackSetName: "AWSControlTowerBP-BASELINE",
        StackSetId: stackSetId,
        AdministrationRoleARN:
          "arn:aws:iam::123456789012:role/service-role/AWSControlTowerStackSetRole",
        ExecutionRoleName: "AWSControlTowerExecution",
        PermissionModel: undefined,
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      const result = await service.validateStackSet(stackSetId);

      expect(result.isValid).toBe(false);
      expect(result.errorType).toBe("UNSUPPORTED_PERMISSION_MODEL");
      expect(result.errorMessage).toContain("appears to be SERVICE_MANAGED");
    });

    test("should reject StackSet with null PermissionModel and service-role pattern", async () => {
      const stackSetId = "svc-stackset:abc123-def456";
      const stackSet: StackSet = {
        StackSetName: "some-service-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN:
          "arn:aws:iam::123456789012:role/service-role/SomeServiceRole",
        ExecutionRoleName: "SomeExecRole",
        PermissionModel: undefined,
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      const result = await service.validateStackSet(stackSetId);

      expect(result.isValid).toBe(false);
      expect(result.errorType).toBe("UNSUPPORTED_PERMISSION_MODEL");
      expect(result.errorMessage).toContain("appears to be SERVICE_MANAGED");
    });

    test("should accept StackSet with null PermissionModel and custom role", async () => {
      const stackSetId = "custom-stackset:abc123-def456";
      const stackSet: StackSet = {
        StackSetName: "my-custom-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: undefined,
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      const result = await service.validateStackSet(stackSetId);

      expect(result.isValid).toBe(true);
      expect(result.stackSet).toEqual(stackSet);
    });
  });

  describe("validateStackSetForDeployment()", () => {
    test("should validate StackSet with matching StackSet ID", async () => {
      // Arrange
      const storedStackSetId =
        "test-stackset:12345678-1234-1234-1234-123456789012";
      const stackSet: StackSet = {
        StackSetName: "test-stackset",
        StackSetId: storedStackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act
      const result =
        await service.validateStackSetForDeployment(storedStackSetId);

      // Assert
      expect(result).toEqual(stackSet);
      expect(
        mockCloudFormationClient.commandCalls(DescribeStackSetCommand),
      ).toHaveLength(1);
    });

    test("should throw StackSetNotFoundError when StackSet does not exist", async () => {
      // Arrange
      const storedStackSetId =
        "nonexistent-stackset:12345678-1234-1234-1234-123456789012";

      // AWS API throws StackSetNotFoundException when StackSet doesn't exist
      mockCloudFormationClient.on(DescribeStackSetCommand).rejects(
        new StackSetNotFoundException({
          message: "StackSet not found",
          $metadata: {},
        }),
      );

      // Act & Assert
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow(StackSetNotFoundError);
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow("StackSet not found or has been deleted");
    });

    test("should throw StackSetNotFoundError when StackSet has DELETED status", async () => {
      // Arrange
      const storedStackSetId =
        "deleted-stackset:12345678-1234-1234-1234-123456789012";
      const stackSet: StackSet = {
        StackSetName: "deleted-stackset",
        StackSetId: storedStackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "DELETED",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act & Assert
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow(StackSetNotFoundError);
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow("StackSet has been deleted");
    });

    test("should throw UnsupportedPermissionModelError when StackSet uses SERVICE_MANAGED", async () => {
      // Arrange
      const storedStackSetId =
        "service-managed-stackset:12345678-1234-1234-1234-123456789012";
      const stackSet: StackSet = {
        StackSetName: "service-managed-stackset",
        StackSetId: storedStackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SERVICE_MANAGED",
        Status: "ACTIVE",
      };

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: stackSet,
        $metadata: {},
      });

      // Act & Assert
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow(UnsupportedPermissionModelError);
      await expect(
        service.validateStackSetForDeployment(storedStackSetId),
      ).rejects.toThrow(
        "Only SELF_MANAGED StackSets are supported for blueprint registration.",
      );
    });
  });

  // Note: startDeployment() removed - deployment now triggered via EventBridge
  // BlueprintDeploymentRequest event → EventBridge rule → Step Functions
  // This follows ISB event-driven pattern (same as CleanAccountRequest)

  describe("validateBlueprintForDeployment()", () => {
    let mockBlueprintStore: BlueprintStore;

    beforeEach(() => {
      mockBlueprintStore = {
        get: vi.fn(),
      } as any;
    });

    test("should validate blueprint with valid StackSet", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";
      const stackSetId = "test-stackset:12345678-1234-1234-1234-123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "TestBlueprint",
          stackSetId,
        },
        stackSets: [
          {
            stackSetId,
            regions: ["us-east-1"],
          },
        ],
      };

      const awsStackSetResponse: StackSet = {
        StackSetName: "test-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "ACTIVE",
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: awsStackSetResponse,
        $metadata: {},
      });

      // Act
      const result = await service.validateBlueprintForDeployment(
        blueprintId,
        mockBlueprintStore,
      );

      // Assert
      expect(result).toEqual(mockBlueprintWithStackSets);
      expect(mockBlueprintStore.get).toHaveBeenCalledWith(blueprintId);
      expect(
        mockCloudFormationClient.commandCalls(DescribeStackSetCommand),
      ).toHaveLength(1);
    });

    test("should throw error when blueprint not found", async () => {
      // Arrange
      const blueprintId = "nonexistent-bp";

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: undefined,
      } as any);

      // Act & Assert
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow("Blueprint not found. Cannot approve lease.");
    });

    test("should throw error when blueprint has no StackSets", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "Blueprint Without StackSets",
        },
        stackSets: [],
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      // Act & Assert
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow("Blueprint has no StackSets configured.");
    });

    test("should throw StackSetNotFoundError when StackSet has been deleted", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440002";
      const stackSetId =
        "deleted-stackset:12345678-1234-1234-1234-123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "Blueprint With Deleted StackSet",
          stackSetId,
        },
        stackSets: [
          {
            stackSetId,
            regions: ["us-east-1"],
          },
        ],
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      // AWS API throws StackSetNotFoundException when StackSet doesn't exist
      mockCloudFormationClient.on(DescribeStackSetCommand).rejects(
        new StackSetNotFoundException({
          message: "StackSet not found",
          $metadata: {},
        }),
      );

      // Act & Assert
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow(StackSetNotFoundError);
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow("StackSet not found or has been deleted");
    });

    test("should throw StackSetNotFoundError when StackSet has DELETED status", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440003";
      const stackSetId =
        "deleted-stackset:12345678-1234-1234-1234-123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "Blueprint With Deleted StackSet",
          stackSetId,
        },
        stackSets: [
          {
            stackSetId,
            regions: ["us-east-1"],
          },
        ],
      };

      const deletedStackSet: StackSet = {
        StackSetName: "deleted-stackset",
        StackSetId: stackSetId,
        AdministrationRoleARN: env.INTERMEDIATE_ROLE_ARN,
        ExecutionRoleName: env.SANDBOX_ACCOUNT_ROLE_NAME,
        PermissionModel: "SELF_MANAGED",
        Status: "DELETED",
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      mockCloudFormationClient.on(DescribeStackSetCommand).resolves({
        StackSet: deletedStackSet,
        $metadata: {},
      });

      // Act & Assert
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow(StackSetNotFoundError);
      await expect(
        service.validateBlueprintForDeployment(blueprintId, mockBlueprintStore),
      ).rejects.toThrow("StackSet has been deleted");
    });
  });

  describe("deleteStackInstancesMetadata()", () => {
    let mockBlueprintStore: BlueprintStore;

    beforeEach(() => {
      mockBlueprintStore = {
        get: vi.fn(),
      } as any;
    });

    test("should delete stack instance metadata successfully", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";
      const accountId = "123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "TestBlueprint",
        },
        stackSets: [
          {
            stackSetId: "test-stackset:test-id",
            regions: ["us-east-1", "us-west-2"],
          },
        ],
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      mockCloudFormationClient.on(DeleteStackInstancesCommand).resolves({
        OperationId: "12345678-1234-1234-1234-123456789mno",
        $metadata: {},
      });

      // Act
      await service.deleteStackInstancesMetadata(
        blueprintId,
        accountId,
        mockBlueprintStore,
      );

      // Assert
      expect(mockBlueprintStore.get).toHaveBeenCalledWith(blueprintId);
      const deleteCall = mockCloudFormationClient.commandCalls(
        DeleteStackInstancesCommand,
      )[0];
      expect(deleteCall).toBeDefined();
      expect(deleteCall!.args[0].input).toMatchObject({
        StackSetName: "test-stackset:test-id", // Uses stackSetId (AWS API accepts either name or ID)
        Accounts: [accountId],
        Regions: ["us-east-1", "us-west-2"],
        RetainStacks: true,
        OperationPreferences: {
          MaxConcurrentCount: 1,
          FailureToleranceCount: 0,
        },
      });
    });

    test("should skip deletion when blueprint not found", async () => {
      // Arrange
      const blueprintId = "nonexistent-bp";
      const accountId = "123456789012";

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: undefined,
      } as any);

      // Act
      await service.deleteStackInstancesMetadata(
        blueprintId,
        accountId,
        mockBlueprintStore,
      );

      // Assert
      expect(mockBlueprintStore.get).toHaveBeenCalledWith(blueprintId);
      expect(
        mockCloudFormationClient.commandCalls(DeleteStackInstancesCommand),
      ).toHaveLength(0);
    });

    test("should skip deletion when blueprint has no StackSets", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";
      const accountId = "123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "Blueprint Without StackSets",
        },
        stackSets: [],
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      // Act
      await service.deleteStackInstancesMetadata(
        blueprintId,
        accountId,
        mockBlueprintStore,
      );

      // Assert
      expect(mockBlueprintStore.get).toHaveBeenCalledWith(blueprintId);
      expect(
        mockCloudFormationClient.commandCalls(DeleteStackInstancesCommand),
      ).toHaveLength(0);
    });

    test("should not throw when deletion fails", async () => {
      // Arrange
      const blueprintId = "650e8400-e29b-41d4-a716-446655440001";
      const accountId = "123456789012";

      const mockBlueprintWithStackSets = {
        blueprint: {
          blueprintId,
          name: "TestBlueprint",
        },
        stackSets: [
          {
            stackSetId: "test-stackset:test-id",
            regions: ["us-east-1"],
          },
        ],
      };

      vi.mocked(mockBlueprintStore.get).mockResolvedValue({
        result: mockBlueprintWithStackSets,
      } as any);

      mockCloudFormationClient
        .on(DeleteStackInstancesCommand)
        .rejects(new Error("CloudFormation error"));

      // Act - should not throw
      await expect(
        service.deleteStackInstancesMetadata(
          blueprintId,
          accountId,
          mockBlueprintStore,
        ),
      ).resolves.toBeUndefined();

      // Assert
      expect(mockBlueprintStore.get).toHaveBeenCalledWith(blueprintId);
      expect(
        mockCloudFormationClient.commandCalls(DeleteStackInstancesCommand),
      ).toHaveLength(1);
    });
  });
});

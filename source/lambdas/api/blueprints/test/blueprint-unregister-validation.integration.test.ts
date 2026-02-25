// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Integration test for blueprint unregistration validation
 *
 * Tests that blueprints cannot be unregistered when attached to lease templates.
 * This validates the GSI query findByBlueprintId() is working correctly.
 */

import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  QueryCommand,
} from "@aws-sdk/lib-dynamodb";
import { randomUUID } from "crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  BLUEPRINT_SK,
  generateBlueprintPK,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import type { BlueprintItem } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  BlueprintDeploymentService,
  BlueprintInUseError,
} from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";

describe("Blueprint Unregistration Validation - Integration Test", () => {
  const blueprintTableName = "test-blueprint-table";
  const leaseTemplateTableName = "test-lease-template-table";

  let blueprintStore: DynamoBlueprintStore;
  let leaseTemplateStore: DynamoLeaseTemplateStore;
  let blueprintService: BlueprintDeploymentService;
  let mockDdbClient: any;

  beforeEach(() => {
    // Create mock DynamoDB client
    mockDdbClient = {
      send: vi.fn(),
    };

    blueprintStore = new DynamoBlueprintStore({
      client: mockDdbClient as unknown as DynamoDBDocumentClient,
      blueprintTableName: blueprintTableName,
    });

    leaseTemplateStore = new DynamoLeaseTemplateStore({
      client: mockDdbClient as unknown as DynamoDBDocumentClient,
      leaseTemplateTableName: leaseTemplateTableName,
    });

    blueprintService = new BlueprintDeploymentService(
      {} as CloudFormationClient, // Mock client - not used in this test
      {
        INTERMEDIATE_ROLE_ARN: "arn:aws:iam::123456789012:role/test",
        SANDBOX_ACCOUNT_ROLE_NAME: "test-role",
        ORG_MGT_ACCOUNT_ID: "123456789012",
        HUB_ACCOUNT_ID: "123456789012",
      },
    );
  });

  describe("Scenario: Blueprint attached to lease template", () => {
    it("should prevent unregistration when blueprint is in use", async () => {
      // Arrange: Create test data
      const blueprintId = randomUUID();
      const templateUuid = randomUUID();

      const testBlueprint: BlueprintItem = {
        PK: generateBlueprintPK(blueprintId),
        SK: BLUEPRINT_SK,
        itemType: "BLUEPRINT",
        blueprintId,
        name: "Test-Blueprint",
        tags: {},
        createdBy: "test@example.com",
        deploymentTimeoutMinutes: 60,
        regionConcurrencyType: "SEQUENTIAL",
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
        meta: {
          createdTime: new Date().toISOString(),
          lastEditTime: new Date().toISOString(),
          schemaVersion: 1,
        },
      };

      // Mock: GSI query returns the template (only key fields due to KEYS_ONLY projection)
      mockDdbClient.send.mockImplementation((command: any) => {
        if (command instanceof QueryCommand) {
          if (command.input.IndexName === "blueprintId-index") {
            // Return only key fields (uuid, blueprintId) - matches KEYS_ONLY GSI projection
            return Promise.resolve({
              Items: [{ uuid: templateUuid, blueprintId }],
              Count: 1,
            });
          }
        }
        if (command instanceof DeleteCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      // Act & Assert: Try to unregister blueprint
      await expect(
        blueprintService.unregisterBlueprint(
          { blueprint: testBlueprint },
          blueprintStore,
          leaseTemplateStore,
        ),
      ).rejects.toThrow(BlueprintInUseError);

      await expect(
        blueprintService.unregisterBlueprint(
          { blueprint: testBlueprint },
          blueprintStore,
          leaseTemplateStore,
        ),
      ).rejects.toThrow(
        "Blueprint is currently in use by one or more lease templates and cannot be deleted.",
      );
    });

    it("should allow unregistration when blueprint is not in use", async () => {
      // Arrange
      const blueprintId = randomUUID();

      const testBlueprint: BlueprintItem = {
        PK: generateBlueprintPK(blueprintId),
        SK: BLUEPRINT_SK,
        itemType: "BLUEPRINT",
        blueprintId,
        name: "Unused Blueprint",
        tags: {},
        createdBy: "test@example.com",
        deploymentTimeoutMinutes: 60,
        regionConcurrencyType: "SEQUENTIAL",
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
        meta: {
          createdTime: new Date().toISOString(),
          lastEditTime: new Date().toISOString(),
          schemaVersion: 1,
        },
      };

      // Mock: GSI query returns empty
      mockDdbClient.send.mockImplementation((command: any) => {
        if (command instanceof QueryCommand) {
          if (command.input.IndexName === "blueprintId-index") {
            return Promise.resolve({ Items: [], Count: 0 });
          }
        }
        if (command instanceof DeleteCommand) {
          return Promise.resolve({});
        }
        return Promise.resolve({});
      });

      // Act: Unregister blueprint (should succeed)
      await expect(
        blueprintService.unregisterBlueprint(
          { blueprint: testBlueprint },
          blueprintStore,
          leaseTemplateStore,
        ),
      ).resolves.not.toThrow();
    });
  });

  describe("Scenario: GSI query behavior", () => {
    it("should call findByBlueprintId when validating", async () => {
      // Arrange
      const blueprintId = randomUUID();
      const testBlueprint: BlueprintItem = {
        PK: generateBlueprintPK(blueprintId),
        SK: BLUEPRINT_SK,
        itemType: "BLUEPRINT",
        blueprintId,
        name: "Test-Blueprint",
        tags: {},
        createdBy: "test@example.com",
        deploymentTimeoutMinutes: 60,
        regionConcurrencyType: "SEQUENTIAL",
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0,
        },
        meta: {
          createdTime: new Date().toISOString(),
          lastEditTime: new Date().toISOString(),
          schemaVersion: 1,
        },
      };

      // Spy on findByBlueprintId
      const findByBlueprintIdSpy = vi.spyOn(
        leaseTemplateStore,
        "findByBlueprintId",
      );

      mockDdbClient.send.mockResolvedValue({ Items: [], Count: 0 });

      // Act
      await blueprintService.unregisterBlueprint(
        { blueprint: testBlueprint },
        blueprintStore,
        leaseTemplateStore,
      );

      // Assert: Verify findByBlueprintId was called
      expect(findByBlueprintIdSpy).toHaveBeenCalledWith(blueprintId);
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import {
  ItemAlreadyExists,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  createTestBlueprintItem,
  createTestDeploymentHistory,
  createTestDeploymentHistoryItem,
  createTestStackSetItem,
  createTestStackSets,
} from "@amzn/innovation-sandbox-commons/test/fixtures/blueprint-fixtures.js";

// Mock DynamoDB Document Client
const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoBlueprintStore", () => {
  let store: DynamoBlueprintStore;
  const tableName = "test-blueprint-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoBlueprintStore({
      blueprintTableName: tableName,
      client: mockDynamoClient as any,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("createBlueprintWithStackSet()", () => {
    test("should create blueprint and stackset items atomically", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const blueprint = createTestBlueprintItem({
        blueprintId,
        name: "TestBlueprint",
        deploymentTimeoutMinutes: 45,
        createdBy: "admin@example.com",
      });

      const stackSetId = "test-stackset:12345678-1234-1234-1234-123456789012";
      const stackSet = createTestStackSetItem({
        blueprintId,
        PK: `bp#${blueprintId}`,
        SK: `stackset#${stackSetId}`,
        stackSetId,
        administrationRoleArn: "arn:aws:iam::123456789012:role/AdminRole",
        executionRoleName: "ExecutionRole",
        regions: ["us-east-1", "us-west-2"],
      });

      mockDynamoClient.on(TransactWriteCommand).resolves({});

      const result = await store.createBlueprintWithStackSet(
        blueprint,
        stackSet,
      );

      expect(result.blueprint).toMatchObject({
        blueprintId,
        name: "TestBlueprint",
        tags: {},
      });
      expect(result.stackSets).toHaveLength(1);
      expect(result.stackSets[0]).toMatchObject({
        stackSetId,
        regions: ["us-east-1", "us-west-2"],
      });

      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        1,
      );

      const transactInput =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0]?.args[0]?.input;
      expect(transactInput?.TransactItems).toHaveLength(2);
      expect(transactInput?.TransactItems?.[0]?.Put?.Item).toMatchObject({
        blueprintId,
        PK: `bp#${blueprintId}`,
        SK: "blueprint",
      });
      expect(transactInput?.TransactItems?.[1]?.Put?.Item).toMatchObject({
        blueprintId,
        PK: `bp#${blueprintId}`,
        SK: `stackset#${stackSetId}`,
      });
    });

    test("should throw ItemAlreadyExists when blueprint already exists", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440001";
      const blueprint = createTestBlueprintItem({
        blueprintId,
        name: "DuplicateBlueprint",
      });

      const stackSet = createTestStackSetItem({
        blueprintId,
        PK: `bp#${blueprintId}`,
        SK: "stackset#12345678-1234-1234-1234-123456789012",
        stackSetId: "12345678-1234-1234-1234-123456789012",
      });

      mockDynamoClient.on(TransactWriteCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(
        store.createBlueprintWithStackSet(blueprint, stackSet),
      ).rejects.toThrow(ItemAlreadyExists);
    });
  });

  describe("update()", () => {
    test("should update blueprint metadata fields", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440003";
      const oldBlueprint = createTestBlueprintItem({
        blueprintId,
        name: "OldName",
        tags: { environment: "test" },
        deploymentTimeoutMinutes: 30,
      });

      const updatedBlueprint = {
        ...oldBlueprint,
        name: "UpdatedBlueprintName",
        tags: { environment: "production", version: "2.0" },
        deploymentTimeoutMinutes: 60,
      };

      mockDynamoClient.on(PutCommand).resolves({
        Attributes: oldBlueprint,
      });

      const result = await store.update(updatedBlueprint);

      expect(result.oldItem).toEqual(oldBlueprint);
      // The @withMetadata decorator updates lastEditTime to current time
      expect(result.newItem).toMatchObject({
        ...updatedBlueprint,
        meta: {
          ...updatedBlueprint.meta,
          lastEditTime: "2024-01-01T00:00:00.000Z",
        },
      });
      expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(1);
    });

    test("should throw UnknownItem when blueprint not found", async () => {
      const blueprintId = "550e8400-e29b-41d4-a716-446655440004";
      const blueprint = createTestBlueprintItem({
        blueprintId,
        name: "UpdatedName",
      });

      mockDynamoClient.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(store.update(blueprint)).rejects.toThrow(UnknownItem);
    });
  });

  describe("delete()", () => {
    test("should delete blueprint and stacksets only (deployment history cleaned by TTL)", async () => {
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const pk = `bp#${blueprintId}`;

      const blueprintItem = createTestBlueprintItem({
        PK: pk,
        SK: "blueprint",
        blueprintId,
      });

      const stackSetItem = createTestStackSetItem({
        PK: pk,
        SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
        blueprintId,
      });

      // Mock two separate queries: blueprint and stacksets
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [blueprintItem],
        })
        .resolvesOnce({
          Items: [stackSetItem],
        });
      mockDynamoClient.on(TransactWriteCommand).resolves({});

      const result = await store.delete({ blueprintId });

      expect(result).toEqual(blueprintItem);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(2);

      // Verify first query gets blueprint item
      const blueprintQueryCall = mockDynamoClient.commandCalls(QueryCommand)[0];
      expect(blueprintQueryCall?.args[0]?.input).toMatchObject({
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":sk": "blueprint",
        },
      });

      // Verify second query gets stackset items
      const stackSetQueryCall = mockDynamoClient.commandCalls(QueryCommand)[1];
      expect(stackSetQueryCall?.args[0]?.input).toMatchObject({
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": "stackset#",
        },
      });

      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        1,
      );

      // Verify only 2 items deleted (blueprint + stackset, not deployment history)
      const transactCall =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0];
      expect(transactCall?.args[0]?.input?.TransactItems).toHaveLength(2);
    });

    test("should return undefined when blueprint not found", async () => {
      const blueprintId = "nonexistent-blueprint";

      // Both queries return empty
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] });

      const result = await store.delete({ blueprintId });

      expect(result).toBeUndefined();
      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        0,
      );
    });

    test("should delete multiple stacksets atomically", async () => {
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const pk = `bp#${blueprintId}`;

      const blueprintItem = createTestBlueprintItem({
        PK: pk,
        SK: "blueprint",
        blueprintId,
      });

      // Multiple stacksets
      const stackSetItems = createTestStackSets(blueprintId, 5).map(
        (item, i) => ({
          ...item,
          PK: pk,
          SK: `stackset#stackset-${i}`,
        }),
      );

      // Mock two separate queries: blueprint and stacksets
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [blueprintItem],
        })
        .resolvesOnce({
          Items: stackSetItems,
        });
      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await store.delete({ blueprintId });

      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(2);
      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        1,
      );

      // Verify only 6 items deleted (1 blueprint + 5 stacksets)
      const transactCall =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0];
      expect(transactCall?.args[0]?.input?.TransactItems).toHaveLength(6);
    });
  });

  describe("listBlueprints()", () => {
    test("should list all blueprints using GSI", async () => {
      // Arrange
      const blueprintId1 = "550e8400-e29b-41d4-a716-446655440001";
      const blueprintId2 = "550e8400-e29b-41d4-a716-446655440002";

      const blueprint1 = createTestBlueprintItem({
        PK: `bp#${blueprintId1}`,
        blueprintId: blueprintId1,
        name: "BlueprintOne",
        createdBy: "admin@example.com",
      });
      const blueprint2 = createTestBlueprintItem({
        PK: `bp#${blueprintId2}`,
        blueprintId: blueprintId2,
        name: "BlueprintTwo",
        createdBy: "admin@example.com",
      });

      mockDynamoClient.on(QueryCommand).resolves({
        Items: [blueprint1, blueprint2],
        LastEvaluatedKey: undefined,
      });

      // Act
      const result = await store.listBlueprints();

      // Assert - order-independent
      expect(result.result).toHaveLength(2);
      expect(result.result).toContainEqual(
        expect.objectContaining({
          blueprint: expect.objectContaining({ blueprintId: blueprintId1 }),
          stackSets: [],
          recentDeployments: [],
        }),
      );
      expect(result.result).toContainEqual(
        expect.objectContaining({
          blueprint: expect.objectContaining({ blueprintId: blueprintId2 }),
          stackSets: [],
          recentDeployments: [],
        }),
      );
      expect(result.nextPageIdentifier).toBeNull();

      const queryCall = mockDynamoClient.commandCalls(QueryCommand)[0];
      expect(queryCall).toBeDefined();
      expect(queryCall!.args[0].input).toMatchObject({
        TableName: tableName,
        IndexName: "itemType-blueprintId-index",
        KeyConditionExpression: "itemType = :itemType",
        ExpressionAttributeValues: {
          ":itemType": "BLUEPRINT",
        },
      });
    });

    test("should handle pagination with pageIdentifier and pageSize", async () => {
      // Arrange
      const blueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const blueprint = createTestBlueprintItem({
        blueprintId,
        PK: `bp#${blueprintId}`,
      });
      const lastEvaluatedKey = {
        itemType: "BLUEPRINT",
        blueprintId: "550e8400-e29b-41d4-a716-446655440003",
      };

      // Create a valid base64-encoded pageIdentifier
      const pageKey = {
        itemType: "BLUEPRINT",
        blueprintId: "550e8400-e29b-41d4-a716-446655440000",
      };
      const validPageIdentifier = Buffer.from(
        JSON.stringify(pageKey),
        "utf8",
      ).toString("base64");

      // Mock both queries: blueprint list AND deployment history for each blueprint
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [blueprint],
          LastEvaluatedKey: lastEvaluatedKey,
        })
        .resolvesOnce({
          Items: [], // Empty deployment history
        });

      // Act
      const result = await store.listBlueprints({
        pageSize: 10,
        pageIdentifier: validPageIdentifier,
      });

      // Assert
      expect(result.result).toHaveLength(1);
      expect(result.nextPageIdentifier).toBeDefined();

      const queryCall = mockDynamoClient.commandCalls(QueryCommand)[0];
      expect(queryCall).toBeDefined();
      expect(queryCall!.args[0].input.Limit).toBe(10);
    });

    test("should return empty result when no blueprints exist", async () => {
      // Arrange
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [],
      });

      // Act
      const result = await store.listBlueprints();

      // Assert
      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();
    });
  });

  describe("get()", () => {
    test("should get complete blueprint with stacksets and recent deployments", async () => {
      // Arrange
      const validBlueprintId = "550e8400-e29b-41d4-a716-446655440000";
      const validPk = `bp#${validBlueprintId}`;

      const blueprintItem = createTestBlueprintItem({
        PK: validPk,
        blueprintId: validBlueprintId,
        name: "TestBlueprint",
      });

      const stackSetItem = createTestStackSetItem({
        PK: validPk,
        SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
        blueprintId: validBlueprintId,
        stackSetId: "test-stackset",
      });

      // Generate deployments in reverse chronological order (most recent first)
      const deploymentItems = createTestDeploymentHistory(validBlueprintId, 15);

      // Mock three separate queries: blueprint, stacksets, deployments
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({
          Items: [blueprintItem],
        })
        .resolvesOnce({
          Items: [stackSetItem],
        })
        .resolvesOnce({
          Items: deploymentItems.slice(0, 10), // Only return 10 most recent
        });

      // Act
      const result = await store.get(validBlueprintId);

      // Assert
      expect(result.result).toBeDefined();
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(3);
      expect(result.result!.blueprint).toMatchObject({
        PK: validPk,
        SK: "blueprint",
        blueprintId: validBlueprintId,
        name: "TestBlueprint",
        itemType: "BLUEPRINT",
      });
      expect(result.result!.stackSets).toHaveLength(1);
      expect(result.result!.stackSets[0]).toMatchObject({
        PK: validPk,
        SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
        blueprintId: validBlueprintId,
        itemType: "STACKSET",
      });
      expect(result.result!.recentDeployments).toHaveLength(10); // Limited to last 10

      // Verify deployments are sorted in reverse chronological order
      const deployments = result.result!.recentDeployments!;
      expect(deployments).toHaveLength(10);
      for (let i = 0; i < deployments.length - 1; i++) {
        expect(deployments[i]!.SK >= deployments[i + 1]!.SK).toBe(true);
      }
    });

    test("should return undefined when blueprint not found", async () => {
      // Arrange
      const blueprintId = "nonexistent-blueprint";

      // Mock all three queries returning empty
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [] });

      // Act
      const result = await store.get(blueprintId);

      // Assert
      expect(result.result).toBeUndefined();
    });

    test("should return undefined when blueprint item missing but other items exist", async () => {
      // Arrange
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const pk = `bp#${blueprintId}`;

      // Only stackset item, no blueprint item
      const stackSetItem = createTestStackSetItem({
        PK: pk,
        SK: "stackset#a1b2c3d4-5678-90ab-cdef-123456789abc",
        blueprintId,
      });

      // Mock: blueprint query returns empty, stackset query returns item
      mockDynamoClient
        .on(QueryCommand)
        .resolvesOnce({ Items: [] })
        .resolvesOnce({ Items: [stackSetItem] })
        .resolvesOnce({ Items: [] });

      // Act
      const result = await store.get(blueprintId);

      // Assert
      expect(result.result).toBeUndefined();
    });
  });

  describe("recordDeploymentStart()", () => {
    test("should record deployment start with provided timestamp and generated PK/SK/TTL", async () => {
      // Arrange
      const deploymentStartedAt = "2024-01-01T00:00:00.000Z";
      const deploymentProps = {
        blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
        stackSetId: "test-stackset:a1b2c3d4-5678-90ab-cdef-123456789abc",
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        accountId: "123456789012",
        operationId: "12345678-1234-1234-1234-123456789jkl",
        deploymentStartedAt,
      };

      mockDynamoClient.on(PutCommand).resolves({});

      // Act
      const result = await store.recordDeploymentStart(deploymentProps);

      // Assert
      expect(result.PK).toBe("bp#b1c2d3e4-5678-90ab-cdef-blueprintabc");
      expect(result.SK).toBe(
        `deployment#${deploymentStartedAt}#12345678-1234-1234-1234-123456789jkl`,
      );
      expect(result.stackSetId).toBe(
        "test-stackset:a1b2c3d4-5678-90ab-cdef-123456789abc",
      );
      expect(result.status).toBe("RUNNING");
      expect(result.deploymentStartedAt).toBe(deploymentStartedAt);

      // Verify TTL is set to exactly 90 days from fake timer (2024-01-01T00:00:00Z)
      // Expected: 1704067200 (2024-01-01) + 7776000 (90 days) = 1711843200
      expect(result.ttl).toBe(1711843200);
      expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(1);
    });

    test("should create deployment history item with meta (createdTime, lastEditTime, schemaVersion)", async () => {
      // Arrange
      const deploymentStartedAt = "2024-01-01T00:00:00.000Z";
      const deploymentProps = {
        blueprintId: "b1c2d3e4-5678-90ab-cdef-blueprintabc",
        stackSetName: "test-stackset",
        stackSetId: "a1b2c3d4-5678-90ab-cdef-123456789abc",
        leaseId: "550e8400-e29b-41d4-a716-446655440001",
        accountId: "123456789012",
        operationId: "12345678-1234-1234-1234-123456789jkl",
        deploymentStartedAt,
      };

      mockDynamoClient.on(PutCommand).resolves({});

      // Act
      const result = await store.recordDeploymentStart(deploymentProps);

      // Assert - verify meta is populated by withUpdatedMetadata
      expect(result.meta).toBeDefined();
      expect(result.meta?.schemaVersion).toBe(1);
      expect(result.meta?.createdTime).toBe("2024-01-01T00:00:00.000Z");
      expect(result.meta?.lastEditTime).toBe("2024-01-01T00:00:00.000Z");
    });
  });

  describe("getDeploymentHistory()", () => {
    test("should get deployment history in reverse chronological order", async () => {
      // Arrange
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const pk = `bp#${blueprintId}`;

      const deployments = [
        createTestDeploymentHistoryItem({
          PK: pk,
          SK: "deployment#2024-01-03T00:00:00Z#00000003-1234-1234-1234-deploy000003",
          status: "SUCCEEDED",
        }),
        createTestDeploymentHistoryItem({
          PK: pk,
          SK: "deployment#2024-01-02T00:00:00Z#00000002-1234-1234-1234-deploy000002",
          status: "FAILED",
        }),
        createTestDeploymentHistoryItem({
          PK: pk,
          SK: "deployment#2024-01-01T00:00:00Z#00000001-1234-1234-1234-deploy000001",
          status: "SUCCEEDED",
        }),
      ];

      mockDynamoClient.on(QueryCommand).resolves({
        Items: deployments,
        LastEvaluatedKey: undefined,
      });

      // Act
      const result = await store.getDeploymentHistory(blueprintId);

      // Assert
      expect(result.result).toHaveLength(3);
      expect(result.result).toEqual(deployments);
      expect(result.nextPageIdentifier).toBeNull();

      const queryCall = mockDynamoClient.commandCalls(QueryCommand)[0];
      expect(queryCall).toBeDefined();
      expect(queryCall!.args[0].input).toMatchObject({
        TableName: tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": "deployment#",
        },
        ScanIndexForward: false, // Reverse chronological
      });
    });

    test("should handle pagination for deployment history", async () => {
      // Arrange
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const deployment = createTestDeploymentHistoryItem();
      const lastEvaluatedKey = { PK: "bp#test", SK: "deployment#last" };

      // Create a valid base64-encoded pageIdentifier
      const pageKey = { PK: "bp#test", SK: "deployment#start" };
      const validPageIdentifier = Buffer.from(
        JSON.stringify(pageKey),
        "utf8",
      ).toString("base64");

      mockDynamoClient.on(QueryCommand).resolves({
        Items: [deployment],
        LastEvaluatedKey: lastEvaluatedKey,
      });

      // Act
      const result = await store.getDeploymentHistory(blueprintId, {
        pageSize: 5,
        pageIdentifier: validPageIdentifier,
      });

      // Assert
      expect(result.result).toHaveLength(1);
      expect(result.nextPageIdentifier).toBeDefined();

      const queryCall = mockDynamoClient.commandCalls(QueryCommand)[0];
      expect(queryCall).toBeDefined();
      expect(queryCall!.args[0].input.Limit).toBe(5);
    });

    test("should return empty result when no deployment history exists", async () => {
      // Arrange
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";

      mockDynamoClient.on(QueryCommand).resolves({
        Items: [],
      });

      // Act
      const result = await store.getDeploymentHistory(blueprintId);

      // Assert
      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();
    });
  });

  describe("updateDeploymentStatusAndMetrics()", () => {
    test("should update deployment status and health metrics atomically for successful deployment", async () => {
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const stackSetId = "test-stackset:12345678-1234-1234-1234-123456789012";
      const deploymentSK =
        "deployment#2024-01-01T00:00:00.000Z#12345678-1234-1234-1234-deploy00123";
      const duration = 45;
      const deploymentTimestamp = "2024-01-01T00:45:00.000Z";
      const pk = `bp#${blueprintId}`;

      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await store.updateDeploymentStatusAndMetrics({
        blueprintId,
        stackSetId,
        deploymentSK,
        status: "SUCCEEDED",
        duration,
        deploymentTimestamp,
      });

      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        1,
      );

      const transactCall =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0];
      expect(transactCall).toBeDefined();
      const transactItems = transactCall!.args[0].input.TransactItems;

      expect(transactItems).toHaveLength(3);

      expect(transactItems![0]!.Update).toMatchObject({
        TableName: tableName,
        Key: { PK: pk, SK: deploymentSK },
        UpdateExpression: expect.stringContaining("#status = :status"),
        ExpressionAttributeValues: expect.objectContaining({
          ":status": "SUCCEEDED",
          ":completedAt": "2024-01-01T00:00:00.000Z",
          ":duration": duration,
        }),
      });

      expect(transactItems![1]!.Update).toMatchObject({
        TableName: tableName,
        Key: { PK: pk, SK: "blueprint" },
        UpdateExpression: expect.stringContaining(
          "ADD totalHealthMetrics.totalDeploymentCount :one, totalHealthMetrics.totalSuccessfulCount :one",
        ),
        ExpressionAttributeValues: expect.objectContaining({
          ":one": 1,
          ":timestamp": deploymentTimestamp,
        }),
      });

      expect(transactItems![2]!.Update).toMatchObject({
        TableName: tableName,
        Key: { PK: pk, SK: `stackset#${stackSetId}` },
        UpdateExpression: expect.stringContaining(
          "ADD healthMetrics.deploymentCount :one, healthMetrics.successfulDeploymentCount :one",
        ),
        ExpressionAttributeValues: expect.objectContaining({
          ":one": 1,
          ":zero": 0,
          ":timestamp": deploymentTimestamp,
        }),
      });
    });

    test("should update deployment status and health metrics atomically for failed deployment", async () => {
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const stackSetId = "test-stackset:12345678-1234-1234-1234-123456789012";
      const deploymentSK =
        "deployment#2024-01-01T00:00:00.000Z#12345678-1234-1234-1234-deploy00456";
      const duration = 30;
      const deploymentTimestamp = "2024-01-01T00:30:00.000Z";
      const errorType = "DeploymentFailed";
      const errorMessage = "StackSet deployment failed";

      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await store.updateDeploymentStatusAndMetrics({
        blueprintId,
        stackSetId,
        deploymentSK,
        status: "FAILED",
        duration,
        deploymentTimestamp,
        errorType,
        errorMessage,
      });

      const transactCall =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0];
      expect(transactCall).toBeDefined();
      const transactItems = transactCall!.args[0].input.TransactItems;

      expect(
        transactItems![0]!.Update!.ExpressionAttributeValues,
      ).toMatchObject({
        ":status": "FAILED",
        ":completedAt": "2024-01-01T00:00:00.000Z",
        ":duration": duration,
        ":errorType": errorType,
        ":errorMessage": errorMessage,
      });

      expect(transactItems![1]!.Update!.UpdateExpression).toContain(
        "ADD totalHealthMetrics.totalDeploymentCount :one",
      );
      expect(transactItems![1]!.Update!.UpdateExpression).not.toContain(
        "totalSuccessfulCount",
      );

      expect(transactItems![2]!.Update!.UpdateExpression).toContain(
        "ADD healthMetrics.deploymentCount :one, healthMetrics.consecutiveFailures :one",
      );
      expect(transactItems![2]!.Update!.UpdateExpression).toContain(
        "SET healthMetrics.lastFailureAt = :timestamp",
      );
    });

    test("should update deployment status and health metrics for timeout failure", async () => {
      const blueprintId = "b1c2d3e4-5678-90ab-cdef-blueprintabc";
      const stackSetId = "test-stackset:12345678-1234-1234-1234-123456789012";
      const deploymentSK =
        "deployment#2024-01-01T00:00:00.000Z#12345678-1234-1234-1234-deploy00789";
      const duration = 60;
      const deploymentTimestamp = "2024-01-01T01:00:00.000Z";
      const errorType = "DeploymentTimeout";
      const errorMessage = "Deployment exceeded 60 minute timeout";

      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await store.updateDeploymentStatusAndMetrics({
        blueprintId,
        stackSetId,
        deploymentSK,
        status: "FAILED",
        duration,
        deploymentTimestamp,
        errorType,
        errorMessage,
      });

      const transactCall =
        mockDynamoClient.commandCalls(TransactWriteCommand)[0];
      const transactItems = transactCall!.args[0].input.TransactItems;

      expect(
        transactItems![0]!.Update!.ExpressionAttributeValues,
      ).toMatchObject({
        ":status": "FAILED",
        ":errorType": "DeploymentTimeout",
        ":errorMessage": errorMessage,
      });
    });
  });
});

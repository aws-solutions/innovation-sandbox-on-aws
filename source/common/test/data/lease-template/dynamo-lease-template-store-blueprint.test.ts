// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for LeaseTemplate blueprintId null transformation.
 * Tests that null values are properly transformed to undefined before DynamoDB writes.
 */

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ConcurrentDataModificationException } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import { PersistedLeaseTemplateSchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoLeaseTemplateStore - blueprintId transformation", () => {
  let store: DynamoLeaseTemplateStore;
  const tableName = "test-lease-template-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseTemplateStore({
      leaseTemplateTableName: tableName,
      client: mockDynamoClient as any,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-01-01T00:00:00Z"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("create() - blueprintId transformation", () => {
    test("should remove blueprintId field when value is null", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template Without Blueprint",
        blueprintId: null, // Explicitly null
      });

      mockDynamoClient.on(PutCommand).resolves({});

      await store.create(template);

      // Verify PutCommand was called
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      // Verify blueprintId field was removed from Item
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toBeDefined();
      expect(putCommandInput.Item).not.toHaveProperty("blueprintId");
    });

    test("should preserve blueprintId field when value is a UUID", async () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template With Blueprint",
        blueprintId, // UUID value
      });

      mockDynamoClient.on(PutCommand).resolves({});

      await store.create(template);

      // Verify PutCommand was called
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      // Verify blueprintId field was preserved
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toBeDefined();
      expect(putCommandInput.Item).toHaveProperty("blueprintId", blueprintId);
    });
  });

  describe("update() - blueprintId transformation", () => {
    test("should remove blueprintId field when updating to null", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId: null, // Changed to null
      });

      mockDynamoClient.on(GetCommand).resolves({ Item: template });
      mockDynamoClient.on(PutCommand).resolves({ Attributes: {} });

      await store.update(template);

      // Verify PutCommand was called
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      // Verify blueprintId field was removed
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toBeDefined();
      expect(putCommandInput.Item).not.toHaveProperty("blueprintId");
    });

    test("should preserve blueprintId when updating to a UUID", async () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId, // Changed to UUID
      });

      mockDynamoClient.on(GetCommand).resolves({ Item: template });
      mockDynamoClient.on(PutCommand).resolves({ Attributes: {} });

      await store.update(template);

      // Verify PutCommand was called
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);

      // Verify blueprintId field was preserved
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toBeDefined();
      expect(putCommandInput.Item).toHaveProperty("blueprintId", blueprintId);
    });

    test("should handle update with expected value and null blueprintId", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId: null,
      });

      const expected = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: template.uuid,
        name: "Old Name",
        blueprintId: "old-blueprint-id",
      });

      mockDynamoClient.on(GetCommand).resolves({ Item: template });
      mockDynamoClient.on(PutCommand).resolves({ Attributes: expected });

      await store.update(template, expected);

      // Verify blueprintId was removed in the update
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]!.args[0].input.Item).not.toHaveProperty("blueprintId");
    });

    test("conditions the write on the expected lastEditTime and reports a stale one as a concurrent modification", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      });
      const expected = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: template.uuid,
        meta: {
          schemaVersion: 1,
          lastEditTime: "2023-12-31T00:00:00.000Z",
        },
      });

      mockDynamoClient.on(GetCommand).resolves({ Item: template });
      mockDynamoClient.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          $metadata: {},
          message: "The conditional request failed",
        }),
      );

      await expect(store.update(template, expected)).rejects.toBeInstanceOf(
        ConcurrentDataModificationException,
      );
      const input = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.ConditionExpression).toBe(
        "attribute_exists(#uid) and meta.lastEditTime = :expectedTime",
      );
      expect(input.ExpressionAttributeValues).toEqual({
        ":expectedTime": "2023-12-31T00:00:00.000Z",
      });
    });

    test("conditions the write on lastEditTime being absent when the expected legacy template has no metadata", async () => {
      const template = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
      });
      const expected = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid: template.uuid,
      });
      delete expected.meta; // legacy row written before metadata existed

      mockDynamoClient.on(GetCommand).resolves({ Item: template });
      mockDynamoClient.on(PutCommand).resolves({ Attributes: expected });

      await store.update(template, expected);

      const input = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input;
      expect(input.ConditionExpression).toBe(
        "attribute_exists(#uid) and attribute_not_exists(meta.lastEditTime)",
      );
      expect(input).not.toHaveProperty("ExpressionAttributeValues");
    });
  });

  describe("update() - createdBy/createdTime preservation", () => {
    test("ignores caller-supplied createdBy and meta.createdTime, keeping the persisted values", async () => {
      const uuid = "550e8400-e29b-41d4-a716-446655440000";
      const originalCreatedBy = "original.author@example.com";
      const originalCreatedTime = "2020-01-01T00:00:00.000Z";

      const persisted = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid,
        createdBy: originalCreatedBy,
        meta: {
          schemaVersion: 1,
          createdTime: originalCreatedTime,
          lastEditTime: originalCreatedTime,
        },
      });

      const forgedUpdate = generateSchemaData(PersistedLeaseTemplateSchema, {
        uuid,
        createdBy: "attacker@example.com",
        meta: {
          schemaVersion: 1,
          createdTime: "1999-12-31T00:00:00.000Z",
          lastEditTime: "1999-12-31T00:00:00.000Z",
        },
      });

      mockDynamoClient.on(GetCommand).resolves({ Item: persisted });
      mockDynamoClient.on(PutCommand).resolves({ Attributes: persisted });

      await store.update(forgedUpdate);

      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      const item = putCalls[0]!.args[0].input.Item as any;
      // createdBy and createdTime must come from the persisted record, not the caller.
      expect(item.createdBy).toBe(originalCreatedBy);
      expect(item.meta.createdTime).toBe(originalCreatedTime);
    });
  });
});

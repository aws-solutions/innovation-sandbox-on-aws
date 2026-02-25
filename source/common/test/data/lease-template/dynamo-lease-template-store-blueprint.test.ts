// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for LeaseTemplate blueprintId null transformation.
 * Tests that null values are properly transformed to undefined before DynamoDB writes.
 */

import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DynamoLeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/dynamo-lease-template-store.js";
import {
  LeaseTemplate,
  LeaseTemplateSchema,
  Visibility,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
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
      const template = generateSchemaData(LeaseTemplateSchema, {
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
      const template = generateSchemaData(LeaseTemplateSchema, {
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
      const template = generateSchemaData(LeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId: null, // Changed to null
      });

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
      const template = generateSchemaData(LeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId, // Changed to UUID
      });

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
      const template = generateSchemaData(LeaseTemplateSchema, {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Template",
        blueprintId: null,
      });

      const expected = generateSchemaData(LeaseTemplateSchema, {
        uuid: template.uuid,
        name: "Old Name",
        blueprintId: "old-blueprint-id",
      });

      mockDynamoClient.on(PutCommand).resolves({ Attributes: expected });

      await store.update(template, expected);

      // Verify blueprintId was removed in the update
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls).toHaveLength(1);
      expect(putCalls[0]!.args[0].input.Item).not.toHaveProperty("blueprintId");
    });
  });

  describe("Zod validation with transformation", () => {
    test("should validate template with blueprintId=null before transformation", () => {
      const template = {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Template",
        requiresApproval: false,
        createdBy: "test@example.com",
        visibility: "PUBLIC" as Visibility,
        maxSpend: 100,
        leaseDurationInHours: 24,
        budgetThresholds: [],
        durationThresholds: [],
        blueprintId: null, // null should be valid
        meta: {
          schemaVersion: 3,
          createdTime: "2024-01-01T00:00:00Z",
          lastEditTime: "2024-01-01T00:00:00Z",
        },
      };

      // Should not throw
      expect(() => LeaseTemplateSchema.parse(template)).not.toThrow();
      expect(template.blueprintId).toBeNull();
    });

    test("should validate template with blueprintId=undefined after transformation", () => {
      const template: LeaseTemplate = {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Template",
        requiresApproval: false,
        createdBy: "test@example.com",
        visibility: "PUBLIC" as Visibility,
        maxSpend: 100,
        leaseDurationInHours: 24,
        budgetThresholds: [],
        durationThresholds: [],
        // blueprintId is undefined (field missing)
        meta: {
          schemaVersion: 3,
          createdTime: "2024-01-01T00:00:00Z",
          lastEditTime: "2024-01-01T00:00:00Z",
        },
      };

      // Should not throw - .optional() allows undefined
      expect(() => LeaseTemplateSchema.parse(template)).not.toThrow();
      expect(template.blueprintId).toBeUndefined();
    });

    test("should validate template with blueprintId=UUID", () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const template = {
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        name: "Test Template",
        requiresApproval: false,
        createdBy: "test@example.com",
        visibility: "PUBLIC" as Visibility,
        maxSpend: 100,
        leaseDurationInHours: 24,
        budgetThresholds: [],
        durationThresholds: [],
        blueprintId, // UUID value
        meta: {
          schemaVersion: 3,
          createdTime: "2024-01-01T00:00:00Z",
          lastEditTime: "2024-01-01T00:00:00Z",
        },
      };

      // Should not throw
      expect(() => LeaseTemplateSchema.parse(template)).not.toThrow();
      expect(template.blueprintId).toBe(blueprintId);
    });
  });
});

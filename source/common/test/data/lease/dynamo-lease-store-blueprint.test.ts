// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Unit tests for Lease blueprintId/blueprintName null transformation.
 * Tests that null values are properly transformed to undefined before DynamoDB writes.
 */

import { DynamoDBDocumentClient, PutCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { PendingLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoLeaseStore - blueprintId transformation", () => {
  let store: DynamoLeaseStore;
  const tableName = "test-lease-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseStore({
      leaseTableName: tableName,
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
    test("should remove blueprintId and blueprintName when values are null", async () => {
      const lease = generateSchemaData(PendingLeaseSchema, {
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        status: "PendingApproval",
        blueprintId: null, // Explicitly null
        blueprintName: null, // Explicitly null
      });

      mockDynamoClient.on(PutCommand).resolves({});

      await store.create(lease);

      // Verify PutCommand was called
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThan(0);

      // Verify both fields were removed from Item
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toBeDefined();
      expect(putCommandInput.Item).not.toHaveProperty("blueprintId");
      expect(putCommandInput.Item).not.toHaveProperty("blueprintName");
    });

    test("should preserve blueprintId and blueprintName when values exist", async () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const blueprintName = "TestBlueprint";
      const lease = generateSchemaData(PendingLeaseSchema, {
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        status: "PendingApproval",
        blueprintId,
        blueprintName,
      });

      mockDynamoClient.on(PutCommand).resolves({});

      await store.create(lease);

      // Verify fields were preserved
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThan(0);
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toHaveProperty("blueprintId", blueprintId);
      expect(putCommandInput.Item).toHaveProperty(
        "blueprintName",
        blueprintName,
      );
    });
  });

  describe("update() - blueprintId transformation", () => {
    test("should remove blueprintId when updating to null", async () => {
      const lease = generateSchemaData(PendingLeaseSchema, {
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        status: "PendingApproval",
        blueprintId: null, // Changed to null
        blueprintName: null,
      });

      mockDynamoClient.on(PutCommand).resolves({ Attributes: {} });

      await store.update(lease);

      // Verify fields were removed
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThan(0);
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).not.toHaveProperty("blueprintId");
      expect(putCommandInput.Item).not.toHaveProperty("blueprintName");
    });

    test("should preserve blueprintId when updating to UUID", async () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const lease = generateSchemaData(PendingLeaseSchema, {
        userEmail: "user@example.com",
        uuid: "550e8400-e29b-41d4-a716-446655440000",
        status: "PendingApproval",
        blueprintId,
        blueprintName: "TestBlueprint",
      });

      mockDynamoClient.on(PutCommand).resolves({ Attributes: {} });

      await store.update(lease);

      // Verify fields were preserved
      const putCalls = mockDynamoClient.commandCalls(PutCommand);
      expect(putCalls.length).toBeGreaterThan(0);
      const putCommandInput = putCalls[0]!.args[0].input;
      expect(putCommandInput.Item).toHaveProperty("blueprintId", blueprintId);
      expect(putCommandInput.Item).toHaveProperty(
        "blueprintName",
        "TestBlueprint",
      );
    });
  });

  describe("Zod validation", () => {
    test("should accept blueprintId=null", () => {
      const lease = generateSchemaData(PendingLeaseSchema, {
        blueprintId: null,
        blueprintName: null,
      });

      expect(() => PendingLeaseSchema.parse(lease)).not.toThrow();
      expect(lease.blueprintId).toBeNull();
    });

    test("should accept blueprintId=undefined (from DynamoDB read)", () => {
      const lease = generateSchemaData(PendingLeaseSchema, {
        blueprintId: undefined, // Simulates field missing from DynamoDB
        blueprintName: undefined,
      });

      expect(() => PendingLeaseSchema.parse(lease)).not.toThrow();
      expect(lease.blueprintId).toBeUndefined();
    });

    test("should accept blueprintId=UUID", () => {
      const blueprintId = "660e8400-e29b-41d4-a716-446655440001";
      const lease = generateSchemaData(PendingLeaseSchema, {
        blueprintId,
        blueprintName: "TestBlueprint",
      });

      expect(() => PendingLeaseSchema.parse(lease)).not.toThrow();
      expect(lease.blueprintId).toBe(blueprintId);
    });
  });
});

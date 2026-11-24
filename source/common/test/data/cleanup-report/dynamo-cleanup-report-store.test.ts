// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  CleanupReportKey,
  CleanupReportSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import { DynamoCleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/dynamo-cleanup-report-store.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoCleanupReportStore", () => {
  let store: DynamoCleanupReportStore;
  const tableName = "test-cleanup-report-table";

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoCleanupReportStore({
      client: mockDynamoClient as any,
      cleanupReportTableName: tableName,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("create()", () => {
    test("persists report with correct item shape and prevents overwrite", async () => {
      mockDynamoClient.on(PutCommand).resolves({});

      const input = buildCreateInput();
      const result = await store.create(input);

      const calls = mockDynamoClient.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const putInput = calls[0]!.args[0].input;
      expect(putInput.TableName).toBe(tableName);
      expect(putInput.ConditionExpression).toBe(
        "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      );
      expect(putInput.Item).toMatchObject({
        pk: "123456789012",
        sk: "CleanupReport#2024-06-01T12:00:00.000Z",
        accountId: "123456789012",
        status: "IN_PROGRESS",
        cleanupStatus: "INITIALIZING",
        steps: [],
        ttl: 1717329600,
      });
      expect(putInput.Item!.meta).toEqual({
        schemaVersion: CleanupReportSchemaVersion,
        createdTime: "2024-06-01T12:00:00.000Z",
        lastEditTime: "2024-06-01T12:00:00.000Z",
      });

      expect(result.pk).toBe("123456789012");
      expect(result.status).toBe("IN_PROGRESS");
    });
  });

  describe("updateReport()", () => {
    test("updates specified fields and returns parsed result", async () => {
      const mockReport = buildMockReport({ status: "COMPLETED" });
      mockDynamoClient.on(UpdateCommand).resolves({ Attributes: mockReport });

      const key = new CleanupReportKey(
        "123456789012",
        "2024-06-01T12:00:00.000Z",
      );
      const result = await store.updateReport({
        key,
        status: "COMPLETED",
      });

      const calls = mockDynamoClient.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.Key).toEqual({
        pk: "123456789012",
        sk: "CleanupReport#2024-06-01T12:00:00.000Z",
      });
      expect(input.UpdateExpression).toContain("#status = :status");
      expect(input.ReturnValues).toBe("ALL_NEW");
      expect(result.status).toBe("COMPLETED");
    });
  });

  describe("addStep()", () => {
    test("appends step using list_append with if_not_exists guard and returns index", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: {
          steps: [
            {
              name: "initialize-cleanup",
              startedAt: "2024-06-01T12:00:00.000Z",
            },
            { name: "nuke-phase-1", startedAt: "2024-06-01T12:05:00.000Z" },
          ],
        },
      });

      const key = new CleanupReportKey(
        "123456789012",
        "2024-06-01T12:00:00.000Z",
      );
      const index = await store.addStep({
        key,
        step: {
          name: "nuke-phase-1",
          startedAt: "2024-06-01T12:05:00.000Z",
        },
      });

      expect(index).toBe(1);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toContain(
        "list_append(if_not_exists(#steps, :emptyList), :newStep)",
      );
      expect(input.ReturnValues).toBe("ALL_NEW");
      expect(input.ExpressionAttributeValues![":newStep"]).toEqual([
        {
          name: "nuke-phase-1",
          startedAt: "2024-06-01T12:05:00.000Z",
        },
      ]);
      expect(input.ExpressionAttributeValues![":emptyList"]).toEqual([]);
    });

    test("includes meta when provided", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: {
          steps: [
            {
              name: "nuke-phase-1",
              startedAt: "2024-06-01T12:05:00.000Z",
              meta: {
                codeBuildExecutionArn:
                  "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
              },
            },
          ],
        },
      });

      const key = new CleanupReportKey(
        "123456789012",
        "2024-06-01T12:00:00.000Z",
      );
      const index = await store.addStep({
        key,
        step: {
          name: "nuke-phase-1",
          startedAt: "2024-06-01T12:05:00.000Z",
          meta: {
            codeBuildExecutionArn:
              "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
          },
        },
      });

      expect(index).toBe(0);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues![":newStep"]).toEqual([
        {
          name: "nuke-phase-1",
          startedAt: "2024-06-01T12:05:00.000Z",
          meta: {
            codeBuildExecutionArn:
              "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
          },
        },
      ]);
    });
  });

  describe("updateStepAtIndex()", () => {
    test("updates completedAt and meta at the specified index", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      const key = new CleanupReportKey(
        "123456789012",
        "2024-06-01T12:00:00.000Z",
      );
      await store.updateStepAtIndex({
        key,
        index: 2,
        completedAt: "2024-06-01T12:30:00.000Z",
        meta: {
          codeBuildExecutionArn:
            "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
          outcome: "SUCCEEDED",
        },
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toContain("#steps[2].#completedAt");
      expect(input.UpdateExpression).toContain("#steps[2].#stepMeta");
      expect(input.ConditionExpression).toContain(
        "attribute_exists(#steps[2].#name)",
      );
      expect(input.ExpressionAttributeValues![":completedAt"]).toBe(
        "2024-06-01T12:30:00.000Z",
      );
      expect(input.ExpressionAttributeValues![":stepMeta"]).toEqual({
        codeBuildExecutionArn:
          "arn:aws:codebuild:us-east-1:123456789012:build/cleanup:abc-123",
        outcome: "SUCCEEDED",
      });
    });

    test("updates only completedAt when meta is not provided", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      const key = new CleanupReportKey(
        "123456789012",
        "2024-06-01T12:00:00.000Z",
      );
      await store.updateStepAtIndex({
        key,
        index: 0,
        completedAt: "2024-06-01T12:10:00.000Z",
      });

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.UpdateExpression).toContain("#steps[0].#completedAt");
      expect(input.UpdateExpression).not.toContain("#stepMeta");
      expect(input.ConditionExpression).toContain(
        "attribute_exists(#steps[0].#name)",
      );
      expect(input.ExpressionAttributeValues![":completedAt"]).toBe(
        "2024-06-01T12:10:00.000Z",
      );
    });
  });

  describe("getLatestReport()", () => {
    test("queries with reverse sort and limit 1", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await store.getLatestReport("123456789012");

      const input =
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.ScanIndexForward).toBe(false);
      expect(input.Limit).toBe(1);
    });

    test("returns parsed result when item exists", async () => {
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: [buildMockReport()] });

      const result = await store.getLatestReport("123456789012");

      expect(result.result).toBeDefined();
      expect(result.result!.accountId).toBe("123456789012");
    });

    test("returns undefined when no items exist", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      const result = await store.getLatestReport("123456789012");

      expect(result.result).toBeUndefined();
    });
  });

  describe("listRecentReports()", () => {
    test("defaults limit to 5", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await store.listRecentReports({ accountId: "123456789012" });

      const input =
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.Limit).toBe(5);
    });

    test("uses custom limit when provided", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await store.listRecentReports({ accountId: "123456789012", limit: 10 });

      const input =
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.Limit).toBe(10);
    });

    test("supports pagination with pageIdentifier", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      const lastKey = {
        pk: "123456789012",
        sk: "CleanupReport#2024-05-01T12:00:00.000Z",
      };
      const pageIdentifier = Buffer.from(
        JSON.stringify(lastKey),
        "utf8",
      ).toString("base64");

      await store.listRecentReports({
        accountId: "123456789012",
        pageIdentifier,
      });

      const input =
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.ExclusiveStartKey).toEqual(lastKey);
    });

    test.each([
      [
        "invalid account ID",
        {
          pk: "not-an-account-id",
          sk: "CleanupReport#2024-05-01T12:00:00.000Z",
        },
      ],
      [
        "invalid sort key",
        { pk: "123456789012", sk: "OtherReport#2024-05-01T12:00:00.000Z" },
      ],
      [
        "another account",
        {
          pk: "210987654321",
          sk: "CleanupReport#2024-05-01T12:00:00.000Z",
        },
      ],
    ])("rejects a cursor for %s", async (_description, lastKey) => {
      const pageIdentifier = Buffer.from(
        JSON.stringify(lastKey),
        "utf8",
      ).toString("base64url");

      await expect(
        store.listRecentReports({
          accountId: "123456789012",
          pageIdentifier,
        }),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    });

    test("returns nextPageIdentifier when more pages exist", async () => {
      const lastKey = {
        pk: "123456789012",
        sk: "CleanupReport#2024-05-15T12:00:00.000Z",
      };
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [buildMockReport()],
        LastEvaluatedKey: lastKey,
      });

      const result = await store.listRecentReports({
        accountId: "123456789012",
      });

      expect(result.nextPageIdentifier).not.toBeNull();
    });

    test("returns null nextPageIdentifier when no more pages", async () => {
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [buildMockReport()],
        LastEvaluatedKey: undefined,
      });

      const result = await store.listRecentReports({
        accountId: "123456789012",
      });

      expect(result.nextPageIdentifier).toBeNull();
    });
  });
});

function buildMockReport(
  overrides: Record<string, any> = {},
): Record<string, any> {
  return {
    pk: "123456789012",
    sk: "CleanupReport#2024-06-01T12:00:00.000Z",
    accountId: "123456789012",
    durableExecutionArn:
      "arn:aws:states:us-east-1:123456789012:execution:cleanup:exec-1",
    status: "IN_PROGRESS",
    cleanupStatus: "INITIALIZING",
    startedAt: "2024-06-01T12:00:00.000Z",
    reasonForCleanup: "LEASE_TERMINATION",
    steps: [],
    ttl: 1717329600,
    meta: {
      schemaVersion: CleanupReportSchemaVersion,
      createdTime: "2024-06-01T12:00:00.000Z",
      lastEditTime: "2024-06-01T12:00:00.000Z",
    },
    ...overrides,
  };
}

function buildCreateInput() {
  return {
    key: new CleanupReportKey("123456789012", "2024-06-01T12:00:00.000Z"),
    durableExecutionArn:
      "arn:aws:states:us-east-1:123456789012:execution:cleanup:exec-1",
    reasonForCleanup: "LEASE_TERMINATION" as const,
    ttl: 1717329600,
  };
}

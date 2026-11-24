// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import { DynamoDBDocumentClient, UpdateCommand } from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import {
  PersistedSandboxAccountKeySchema,
  PersistedSandboxAccountSchema,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

describe("DynamoSandboxAccountStore - Lock Methods", () => {
  let store: DynamoSandboxAccountStore;
  const tableName = "test-account-table";

  /**
   * Returns a valid PersistedSandboxAccount Attributes object for mocking
   * the ALL_NEW response from acquireLock's UpdateCommand.
   */
  function mockAcquireLockResponse(
    accountId: string,
    ownerId: string,
    meta?: Record<string, string>,
  ) {
    return {
      Attributes: {
        awsAccountId: accountId,
        status: "CleanUp",
        resourceLock: {
          ownerId,
          acquiredAt: "2024-06-01T12:00:00.000Z",
          expiresAt: "2024-06-01T12:05:00.000Z",
          ...(meta ? { meta } : {}),
        },
        meta: {
          schemaVersion: 2,
          createdTime: "2024-01-01T00:00:00.000Z",
          lastEditTime: "2024-06-01T12:00:00.000Z",
        },
      },
    };
  }

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoSandboxAccountStore({
      accountTableName: tableName,
      client: mockDynamoClient as any,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2024-06-01T12:00:00.000Z"));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("acquireLock()", () => {
    test("sends UpdateCommand with correct key, lock value, and condition expression", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "owner-1"));

      await store.acquireLock("123456789012", "owner-1", 300);

      const calls = mockDynamoClient.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe(tableName);
      expect(input.Key).toEqual({ awsAccountId: "123456789012" });
      expect(input.UpdateExpression).toBe("SET resourceLock = :lock");
      const lockValue = input.ExpressionAttributeValues![":lock"];
      expect(lockValue.ownerId).toBe("owner-1");
      expect(lockValue.acquiredAt).toBe("2024-06-01T12:00:00.000Z");
      expect(lockValue.meta).toBeUndefined();
      expect(input.ConditionExpression).toContain(
        "attribute_exists(awsAccountId)",
      );
      expect(input.ConditionExpression).toContain(
        "attribute_not_exists(resourceLock)",
      );
      expect(input.ConditionExpression).toContain(
        "resourceLock.ownerId = :ownerId",
      );
      expect(input.ConditionExpression).toContain(
        "resourceLock.expiresAt < :now",
      );
    });

    test("includes ownerId in condition expression for re-entrant lock support", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "owner-1"));

      await store.acquireLock("123456789012", "owner-1", 300);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues![":ownerId"]).toBe("owner-1");
    });

    test("propagates ConditionalCheckFailedException on lock conflict", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(
        store.acquireLock("123456789012", "owner-2", 300),
      ).rejects.toThrow(ConditionalCheckFailedException);
    });

    test("includes current timestamp as :now for expiry comparison", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "new-owner"));

      await store.acquireLock("123456789012", "new-owner", 600);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ExpressionAttributeValues![":now"]).toBe(
        "2024-06-01T12:00:00.000Z",
      );
    });

    test("stores meta field in lock value when provided", async () => {
      const meta = { reason: "cleanup", executionId: "exec-123" };
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "owner-1", meta));

      await store.acquireLock("123456789012", "owner-1", 300, meta);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      const lockValue = input.ExpressionAttributeValues![":lock"];
      expect(lockValue.meta).toEqual(meta);
    });

    test("omits meta field from lock value when not provided", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "owner-1"));

      await store.acquireLock("123456789012", "owner-1", 300);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      const lockValue = input.ExpressionAttributeValues![":lock"];
      expect(lockValue.meta).toBeUndefined();
    });

    test("computes expiresAt as acquiredAt + timeoutSeconds", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("123456789012", "owner-1"));

      await store.acquireLock("123456789012", "owner-1", 600);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      const lockValue = input.ExpressionAttributeValues![":lock"];
      // 2024-06-01T12:00:00.000Z + 600s = 2024-06-01T12:10:00.000Z
      expect(lockValue.acquiredAt).toBe("2024-06-01T12:00:00.000Z");
      expect(lockValue.expiresAt).toBe("2024-06-01T12:10:00.000Z");
    });

    test("condition expression prevents upsert on non-existent account", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .resolves(mockAcquireLockResponse("999999999999", "owner-1"));

      await store.acquireLock("999999999999", "owner-1", 300);

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ConditionExpression).toContain(
        "attribute_exists(awsAccountId)",
      );
    });
  });

  describe("releaseLock()", () => {
    test("sends REMOVE UpdateCommand with owner condition and returns true", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({});

      const released = await store.releaseLock("123456789012", "owner-1");

      expect(released).toBe(true);
      const calls = mockDynamoClient.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.TableName).toBe(tableName);
      expect(input.Key).toEqual({ awsAccountId: "123456789012" });
      expect(input.UpdateExpression).toBe("REMOVE resourceLock");
      expect(input.ConditionExpression).toBe("resourceLock.ownerId = :ownerId");
      expect(input.ExpressionAttributeValues![":ownerId"]).toBe("owner-1");
    });

    test("is idempotent and returns false when ConditionalCheckFailedException occurs (no lock, wrong owner, or already released)", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      // Returning false lets callers distinguish "I lost the lock" from a
      // genuine release, so a preempted execution can avoid spurious actions.
      await expect(
        store.releaseLock("123456789012", "any-owner"),
      ).resolves.toBe(false);
    });

    test("propagates non-conditional errors", async () => {
      mockDynamoClient
        .on(UpdateCommand)
        .rejects(new Error("InternalServerError"));

      await expect(
        store.releaseLock("123456789012", "owner-1"),
      ).rejects.toThrow("InternalServerError");
    });
  });
});

describe("PersistedSandboxAccountSchema - resourceLock field", () => {
  test("parses correctly with resourceLock present", () => {
    const account = {
      awsAccountId: "123456789012",
      status: "Available",
      resourceLock: {
        ownerId: "owner-1",
        acquiredAt: "2024-06-01T12:00:00.000Z",
        expiresAt: "2024-06-01T12:05:00.000Z",
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2024-06-01T12:00:00.000Z",
        lastEditTime: "2024-06-01T12:00:00.000Z",
      },
    };

    const result = PersistedSandboxAccountSchema.safeParse(account);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toEqual({
        ownerId: "owner-1",
        acquiredAt: "2024-06-01T12:00:00.000Z",
        expiresAt: "2024-06-01T12:05:00.000Z",
      });
    }
  });

  test("parses correctly without resourceLock (backward compat)", () => {
    const account = {
      awsAccountId: "123456789012",
      status: "Available",
      meta: {
        schemaVersion: 2,
        createdTime: "2024-06-01T12:00:00.000Z",
        lastEditTime: "2024-06-01T12:00:00.000Z",
      },
    };

    const result = PersistedSandboxAccountSchema.safeParse(account);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock).toBeUndefined();
    }
  });

  test("parses resourceLock with meta field", () => {
    const account = {
      awsAccountId: "123456789012",
      status: "CleanUp",
      resourceLock: {
        ownerId: "durable-exec-123",
        acquiredAt: "2024-06-01T12:00:00.000Z",
        expiresAt: "2024-06-01T12:05:00.000Z",
        meta: { reason: "cleanup", phase: "nuke" },
      },
      meta: {
        schemaVersion: 2,
        createdTime: "2024-06-01T12:00:00.000Z",
        lastEditTime: "2024-06-01T12:00:00.000Z",
      },
    };

    const result = PersistedSandboxAccountSchema.safeParse(account);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.resourceLock!.meta).toEqual({
        reason: "cleanup",
        phase: "nuke",
      });
    }
  });
});

describe("PersistedSandboxAccountKeySchema", () => {
  test("accepts a valid AWS account ID", () => {
    expect(
      PersistedSandboxAccountKeySchema.safeParse({
        awsAccountId: "123456789012",
      }).success,
    ).toBe(true);
  });

  test.each([
    { awsAccountId: "not-an-account-id" },
    { awsAccountId: "123456789012", unexpected: true },
  ])("rejects an invalid table key", (key) => {
    expect(PersistedSandboxAccountKeySchema.safeParse(key).success).toBe(false);
  });
});

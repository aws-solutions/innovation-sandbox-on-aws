// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { DynamoSandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/dynamo-sandbox-spaces-usage-store.js";
import {
  MalformedSandboxSpacesUsageRecordError,
  RecordTurnUsageProps,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { calculateTtlInEpochSeconds } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDdb = mockClient(ddbDocClient);

const TABLE = "test-sandbox-spaces-usage-table";
const USER_ID = "alice-at-example-d-com";
const USER_EMAIL = "alice@example.com";
const MONTH = "MONTH#2024-01";

function makeStore() {
  return new DynamoSandboxSpacesUsageStore({
    client: ddbDocClient,
    tableName: TABLE,
  });
}

function makeStoreWithTtl(ttlDays: number) {
  return new DynamoSandboxSpacesUsageStore({
    client: ddbDocClient,
    tableName: TABLE,
    ttlDays,
  });
}

beforeEach(() => {
  mockDdb.reset();
});

// ─── Lease-level Sandbox Spaces usage ─────────────────────────────────────────

const LEASE_ID = "0f5b7f7a-6d1e-4c4e-8a37-2d6c9b1f4a21";

const TOKENS = {
  inputTokens: 1_200,
  outputTokens: 300,
  cacheReadTokens: 800,
  cacheWriteTokens: 100,
};

function recordProps(
  overrides: Partial<RecordTurnUsageProps> = {},
): RecordTurnUsageProps {
  return {
    leaseId: LEASE_ID,
    userId: USER_ID,
    userEmail: USER_EMAIL,
    month: MONTH,
    tokens: TOKENS,
    sandboxSpacesEstimatedTokenCostAccrued: 0.0123,
    ...overrides,
  };
}

function transactItems() {
  const calls = mockDdb.commandCalls(TransactWriteCommand);
  return (calls[0]!.args[0] as TransactWriteCommand).input.TransactItems!;
}

function storedLeaseUsageItem(overrides: Record<string, unknown> = {}) {
  return {
    pk: `LEASE#${LEASE_ID}`,
    sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
    leaseId: LEASE_ID,
    userId: USER_ID,
    sandboxSpacesEstimatedTokenCostAccrued: 0.0123,
    invocationCount: 1,
    ...TOKENS,
    firstSeenAt: "2024-01-01T00:00:00.000Z",
    lastSeenAt: "2024-01-01T00:05:00.000Z",
    ...overrides,
  };
}

describe("recordTurnUsage", () => {
  it("issues one transaction with two Updates (USER, MONTH) and no lease total", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    expect(mockDdb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(mockDdb.commandCalls(UpdateCommand)).toHaveLength(0);

    const items = transactItems();
    expect(items).toHaveLength(2);
    expect(items.map((item) => item.Update?.Key)).toEqual([
      { pk: `LEASE#${LEASE_ID}`, sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}` },
      { pk: `USER#${USER_ID}`, sk: MONTH },
    ]);
  });

  it("writes the user's email on both user-keyed rows", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    for (const item of transactItems()) {
      expect(item.Update?.UpdateExpression).toContain(
        "#userEmail = :userEmail",
      );
      expect(item.Update?.ExpressionAttributeValues).toMatchObject({
        ":userEmail": USER_EMAIL,
      });
    }
  });

  it("overwrites the stored email with the latest one each turn", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(
      recordProps({ userEmail: "alice.new@example.com" }),
    );

    expect(transactItems()[1]!.Update?.ExpressionAttributeValues).toMatchObject(
      {
        ":userEmail": "alice.new@example.com",
      },
    );
  });

  it("writes userId, leaseId, and both timestamps as top-level attributes", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    const update = transactItems()[0]!.Update!;

    // `leaseId` and `userId` are set unconditionally on every recording, so the
    // deferred per-user dashboard index needs no backfill.
    expect(update.UpdateExpression).toContain("#leaseId = :leaseId");
    expect(update.UpdateExpression).toContain("#userId = :userId");
    expect(update.UpdateExpression).toContain("#lastSeenAt = :now");
    expect(update.UpdateExpression).toContain(
      "#firstSeenAt = if_not_exists(#firstSeenAt, :now)",
    );
    expect(update.UpdateExpression).not.toContain("byModel");
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":leaseId": LEASE_ID,
      ":userId": USER_ID,
    });
  });

  it("ADDs all four token types and the USD they priced to at the top level", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    const update = transactItems()[0]!.Update!;
    expect(update.UpdateExpression).toContain(
      "ADD #sandboxSpacesEstimatedTokenCostAccrued :sandboxSpacesEstimatedTokenCostAccrued, #invocationCount :one, " +
        "#inputTokens :inputTokens, #outputTokens :outputTokens, " +
        "#cacheReadTokens :cacheReadTokens, #cacheWriteTokens :cacheWriteTokens",
    );
    expect(update.ExpressionAttributeValues).toMatchObject({
      ":inputTokens": 1_200,
      ":outputTokens": 300,
      ":cacheReadTokens": 800,
      ":cacheWriteTokens": 100,
      ":sandboxSpacesEstimatedTokenCostAccrued": 0.0123,
    });
    // No condition: the update also creates the item on a lease's first turn.
    expect(update.ConditionExpression).toBeUndefined();
  });

  it("counts all four token types toward the monthly totalTokens", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    const monthly = transactItems()[1]!.Update!;
    expect(monthly.ExpressionAttributeValues?.[":totalTokens"]).toBe(2_400);
    expect(monthly.UpdateExpression).not.toContain("estimatedCostCents");
  });

  it("rounds banked spend to six decimal places", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(
      recordProps({ sandboxSpacesEstimatedTokenCostAccrued: 0.01234567891 }),
    );

    const items = transactItems();
    expect(
      items[0]!.Update?.ExpressionAttributeValues?.[
        ":sandboxSpacesEstimatedTokenCostAccrued"
      ],
    ).toBe(0.012346);
  });

  it("records the session id on the monthly rollup when provided", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps({ sessionId: "lease-abc" }));

    const monthly = transactItems()[1]!.Update!;
    expect(monthly.UpdateExpression).toContain("SET #lastSessionId");
    expect(monthly.ExpressionAttributeValues?.[":lastSessionId"]).toBe(
      "lease-abc",
    );
  });

  it("omits the session id clause when not provided", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    const monthly = transactItems()[1]!.Update!;
    expect(monthly.UpdateExpression).not.toContain("lastSessionId");
    expect(
      monthly.ExpressionAttributeNames?.["#lastSessionId"],
    ).toBeUndefined();
  });

  it("leaves no partial state when the transaction fails outright", async () => {
    mockDdb.on(TransactWriteCommand).rejects(new Error("DynamoDB unavailable"));

    await expect(makeStore().recordTurnUsage(recordProps())).rejects.toThrow(
      "DynamoDB unavailable",
    );

    expect(mockDdb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(mockDdb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("does not retry or initialize when the transaction is cancelled", async () => {
    const cancelled = Object.assign(new Error("Transaction cancelled"), {
      name: "TransactionCanceledException",
      CancellationReasons: [{ Code: "None" }, { Code: "TransactionConflict" }],
    });
    mockDdb.on(TransactWriteCommand).rejects(cancelled);

    await expect(makeStore().recordTurnUsage(recordProps())).rejects.toThrow(
      "Transaction cancelled",
    );
    expect(mockDdb.commandCalls(TransactWriteCommand)).toHaveLength(1);
    expect(mockDdb.commandCalls(UpdateCommand)).toHaveLength(0);
  });
});

describe("getLeaseUserUsage", () => {
  const userItem = (overrides: Record<string, unknown> = {}) =>
    storedLeaseUsageItem({
      sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
      userId: USER_ID,
      ...overrides,
    });

  it("reads the user's row with a strongly consistent GetItem", async () => {
    mockDdb.on(GetCommand).resolves({ Item: userItem() });

    const result = await makeStore().getLeaseUserUsage(LEASE_ID, USER_ID);

    expect(result).toMatchObject({
      userId: USER_ID,
      leaseId: LEASE_ID,
      sandboxSpacesEstimatedTokenCostAccrued: 0.0123,
    });
    const input = (mockDdb.calls()[0]!.args[0] as GetCommand).input;
    expect(input.Key).toEqual({
      pk: `LEASE#${LEASE_ID}`,
      sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
    });
    expect(input.ConsistentRead).toBe(true);
  });

  it("returns null for a user with no recorded turns on the lease", async () => {
    mockDdb.on(GetCommand).resolves({ Item: undefined });

    await expect(
      makeStore().getLeaseUserUsage(LEASE_ID, USER_ID),
    ).resolves.toBeNull();
  });

  it("throws on a malformed row rather than reporting zero spend", async () => {
    mockDdb.on(GetCommand).resolves({
      Item: userItem({
        sandboxSpacesEstimatedTokenCostAccrued: "not-a-number",
      }),
    });

    await expect(
      makeStore().getLeaseUserUsage(LEASE_ID, USER_ID),
    ).rejects.toBeInstanceOf(MalformedSandboxSpacesUsageRecordError);
  });

  it("throws on a row missing a token counter", async () => {
    const item: Record<string, unknown> = userItem();
    delete item.cacheWriteTokens;
    mockDdb.on(GetCommand).resolves({ Item: item });

    await expect(
      makeStore().getLeaseUserUsage(LEASE_ID, USER_ID),
    ).rejects.toBeInstanceOf(MalformedSandboxSpacesUsageRecordError);
  });
});

// ─── listLeaseUserUsage ───────────────────────────────────────────────────────

describe("listLeaseUserUsage", () => {
  it("queries only the per-user attribution items", async () => {
    mockDdb.on(QueryCommand).resolves({
      Items: [
        storedLeaseUsageItem({
          sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
          userId: USER_ID,
        }),
      ],
    });

    const { usage } = await makeStore().listLeaseUserUsage(LEASE_ID);

    expect(usage).toHaveLength(1);
    expect(usage[0]).toMatchObject({ userId: USER_ID, leaseId: LEASE_ID });

    const input = (mockDdb.calls()[0]!.args[0] as QueryCommand).input;
    expect(input.KeyConditionExpression).toBe(
      "#pk = :pk AND begins_with(#sk, :prefix)",
    );
    // Returns only per-user attribution rows.
    expect(input.ExpressionAttributeValues?.[":prefix"]).toBe(
      "SANDBOX_SPACES_USAGE#USER#",
    );
  });

  it("returns the stored email, and still parses rows written without one", async () => {
    mockDdb.on(QueryCommand).resolves({
      Items: [
        storedLeaseUsageItem({
          sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
          userId: USER_ID,
          userEmail: USER_EMAIL,
        }),
        storedLeaseUsageItem({
          sk: "SANDBOX_SPACES_USAGE#USER#bob-at-example-d-com",
          userId: "bob-at-example-d-com",
        }),
      ],
    });

    const { usage, error } = await makeStore().listLeaseUserUsage(LEASE_ID);

    expect(error).toBeUndefined();
    expect(usage).toHaveLength(2);
    expect(usage[0]).toMatchObject({ userEmail: USER_EMAIL });
    expect(usage[1]!.userEmail).toBeUndefined();
  });

  it("returns an empty list when the lease has no Sandbox Spaces usage", async () => {
    mockDdb.on(QueryCommand).resolves({ Items: [] });

    const { usage, error } = await makeStore().listLeaseUserUsage(LEASE_ID);
    expect(usage).toEqual([]);
    expect(error).toBeUndefined();
  });

  it("follows pagination until every user is returned", async () => {
    const other = "bob-at-example-d-com";
    mockDdb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          storedLeaseUsageItem({
            sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
            userId: USER_ID,
          }),
        ],
        LastEvaluatedKey: {
          pk: `LEASE#${LEASE_ID}`,
          sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
        },
      })
      .resolves({
        Items: [
          storedLeaseUsageItem({
            sk: `SANDBOX_SPACES_USAGE#USER#${other}`,
            userId: other,
          }),
        ],
      });

    const { usage } = await makeStore().listLeaseUserUsage(LEASE_ID);

    expect(usage.map((entry) => entry.userId)).toEqual([USER_ID, other]);
    expect(mockDdb.commandCalls(QueryCommand)).toHaveLength(2);
  });

  it("excludes corrupt rows and reports an error rather than failing closed", async () => {
    mockDdb.on(QueryCommand).resolves({
      Items: [
        storedLeaseUsageItem({ userId: undefined }), // userId missing
      ],
    });

    const { usage, error } = await makeStore().listLeaseUserUsage(LEASE_ID);

    // The corrupt row is excluded — the rest of the attribution list is unblocked.
    expect(usage).toHaveLength(0);
    // The error surface lets the caller log or display a degraded-data warning.
    expect(error).toEqual(expect.any(String));
  });
});

// ─── stampLeaseTtl ────────────────────────────────────────────────────────────

describe("stampLeaseTtl", () => {
  const TTL_EPOCH = 1_800_000_000;

  it("queries by lease PK and updates every returned item", async () => {
    mockDdb.on(QueryCommand).resolves({
      Items: [
        { pk: `LEASE#${LEASE_ID}`, sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}` },
        {
          pk: `LEASE#${LEASE_ID}`,
          sk: "SANDBOX_SPACES_USAGE#USER#another-user",
        },
      ],
    });
    mockDdb.on(UpdateCommand).resolves({});

    await makeStore().stampLeaseTtl(LEASE_ID, TTL_EPOCH);

    const query = (
      mockDdb.commandCalls(QueryCommand)[0]!.args[0] as QueryCommand
    ).input;
    expect(query.KeyConditionExpression).toBe("#pk = :pk");
    expect(query.ExpressionAttributeValues?.[":pk"]).toBe(`LEASE#${LEASE_ID}`);
    // ProjectionExpression must only request pk + sk, not the whole item.
    expect(query.ProjectionExpression).toMatch(/pk/);
    expect(query.ProjectionExpression).toMatch(/sk/);

    const updates = mockDdb
      .commandCalls(UpdateCommand)
      .map((c) => (c.args[0] as UpdateCommand).input);
    expect(updates).toHaveLength(2);
    for (const u of updates) {
      expect(u.UpdateExpression).toBe("SET #ttl = :ttl");
      expect(u.ExpressionAttributeValues?.[":ttl"]).toBe(TTL_EPOCH);
    }
  });

  it("does nothing when there are no LEASE# items", async () => {
    mockDdb.on(QueryCommand).resolves({ Items: [] });

    await makeStore().stampLeaseTtl(LEASE_ID, TTL_EPOCH);

    expect(mockDdb.commandCalls(UpdateCommand)).toHaveLength(0);
  });

  it("follows pagination and stamps every page", async () => {
    mockDdb
      .on(QueryCommand)
      .resolvesOnce({
        Items: [
          {
            pk: `LEASE#${LEASE_ID}`,
            sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
          },
        ],
        LastEvaluatedKey: {
          pk: `LEASE#${LEASE_ID}`,
          sk: `SANDBOX_SPACES_USAGE#USER#${USER_ID}`,
        },
      })
      .resolves({
        Items: [
          {
            pk: `LEASE#${LEASE_ID}`,
            sk: "SANDBOX_SPACES_USAGE#USER#another-user",
          },
        ],
      });
    mockDdb.on(UpdateCommand).resolves({});

    await makeStore().stampLeaseTtl(LEASE_ID, TTL_EPOCH);

    expect(mockDdb.commandCalls(QueryCommand)).toHaveLength(2);
    expect(mockDdb.commandCalls(UpdateCommand)).toHaveLength(2);
  });
});

// ─── ttlDays on recordTurnUsage monthly rollup ────────────────────────────────

describe("recordTurnUsage monthly rollup ttl", () => {
  it("stamps the monthly rollup ttl when ttlDays is set", async () => {
    const TTL_DAYS = 30;
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStoreWithTtl(TTL_DAYS).recordTurnUsage(recordProps());

    const monthly = transactItems()[1]!.Update!;
    expect(monthly.UpdateExpression).toContain("#ttl = :ttl");
    expect(monthly.ExpressionAttributeValues?.[":ttl"]).toBe(
      calculateTtlInEpochSeconds(TTL_DAYS),
    );
  });

  it("omits the monthly rollup ttl when ttlDays is not set", async () => {
    mockDdb.on(TransactWriteCommand).resolves({});

    await makeStore().recordTurnUsage(recordProps());

    const monthly = transactItems()[1]!.Update!;
    expect(monthly.UpdateExpression).not.toContain("#ttl");
    expect(monthly.ExpressionAttributeValues?.[":ttl"]).toBeUndefined();
  });
});

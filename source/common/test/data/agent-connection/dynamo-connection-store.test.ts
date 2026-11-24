// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import type { ConnectionRecord } from "@amzn/innovation-sandbox-commons/data/agent-connection/connection-store.js";
import { DynamoConnectionStore } from "@amzn/innovation-sandbox-commons/data/agent-connection/dynamo-connection-store.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

const ddbDocClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDdb = mockClient(ddbDocClient);

const TABLE = "test-connection-table";

function makeStore() {
  return new DynamoConnectionStore({ client: ddbDocClient, tableName: TABLE });
}

const validRecord: ConnectionRecord = {
  connectionId: "abc123",
  actorId: "alice-at-example-d-com",
  role: "User",
  email: "alice@example.com",
  userId: "11111111-1111-4111-8111-111111111111",
  protocolVersion: 1,
  ttl: 9999999999,
};

beforeEach(() => {
  mockDdb.reset();
});

describe("save", () => {
  it("sends a PutCommand with the correct table and item", async () => {
    mockDdb.on(PutCommand).resolves({});

    await makeStore().save(validRecord);

    const calls = mockDdb.calls();
    expect(calls).toHaveLength(1);
    const input = (calls[0]!.args[0] as PutCommand).input;
    expect(input.TableName).toBe(TABLE);
    expect(input.Item).toEqual(validRecord);
  });
});

// ─── delete ───────────────────────────────────────────────────────────────────

describe("delete", () => {
  it("sends a DeleteCommand with the correct key", async () => {
    mockDdb.on(DeleteCommand).resolves({});

    await makeStore().delete("abc123");

    const calls = mockDdb.calls();
    expect(calls).toHaveLength(1);
    const input = (calls[0]!.args[0] as DeleteCommand).input;
    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({ connectionId: "abc123" });
  });
});

// ─── get ──────────────────────────────────────────────────────────────────────

describe("get", () => {
  it("returns null when the item does not exist", async () => {
    mockDdb.on(GetCommand).resolves({ Item: undefined });

    const result = await makeStore().get("abc123");

    expect(result).toBeNull();
  });

  it("returns the parsed ConnectionRecord when the item exists and is valid", async () => {
    mockDdb.on(GetCommand).resolves({ Item: validRecord });

    const result = await makeStore().get("abc123");

    expect(result).toEqual(validRecord);
  });

  it("returns null (fail-closed) when the stored item fails schema validation", async () => {
    mockDdb.on(GetCommand).resolves({
      Item: {
        connectionId: "abc123",
        // actorId missing → schema invalid
        role: "User",
        email: "alice@example.com",
        userId: "11111111-1111-4111-8111-111111111111",
        protocolVersion: 1,
        ttl: 9999999999,
      },
    });

    const result = await makeStore().get("abc123");

    expect(result).toBeNull();
  });

  it("returns null (fail-closed) for a record stored without userId", async () => {
    const { userId: _userId, ...legacyRecord } = validRecord;
    mockDdb.on(GetCommand).resolves({ Item: legacyRecord });

    const result = await makeStore().get("abc123");

    expect(result).toBeNull();
  });

  it("sends a GetCommand with the correct key", async () => {
    mockDdb.on(GetCommand).resolves({ Item: validRecord });

    await makeStore().get("abc123");

    const calls = mockDdb.calls();
    expect(calls).toHaveLength(1);
    const input = (calls[0]!.args[0] as GetCommand).input;
    expect(input.TableName).toBe(TABLE);
    expect(input.Key).toEqual({ connectionId: "abc123" });
  });
});

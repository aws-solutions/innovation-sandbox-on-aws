// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import { BatchUnprocessedItemsError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  batchWriteWithRetry,
  buildExpectedFieldsCondition,
  matchesExpectedFields,
} from "@amzn/innovation-sandbox-commons/data/utils.js";

const TABLE_NAME = "test-table";
const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDynamoClient = mockClient(ddbClient);
const writeRequest = {
  PutRequest: { Item: { pk: "pk", sk: "sk" } },
};
const secondWriteRequest = {
  DeleteRequest: { Key: { pk: "other-pk", sk: "other-sk" } },
};

describe("buildExpectedFieldsCondition", () => {
  it("compares stored values exactly and requires absence for undefined fields", () => {
    expect(
      buildExpectedFieldsCondition({
        status: "Active",
        enabled: false,
        assignments: [],
        optional: undefined,
        nullable: null,
      }),
    ).toEqual({
      conditionExpression:
        "#expected_status = :expected_status AND #expected_enabled = :expected_enabled AND #expected_assignments = :expected_assignments AND attribute_not_exists(#expected_optional) AND #expected_nullable = :expected_nullable",
      expressionAttributeNames: {
        "#expected_status": "status",
        "#expected_enabled": "enabled",
        "#expected_assignments": "assignments",
        "#expected_optional": "optional",
        "#expected_nullable": "nullable",
      },
      expressionAttributeValues: {
        ":expected_status": "Active",
        ":expected_enabled": false,
        ":expected_assignments": [],
        ":expected_nullable": null,
      },
    });
  });

  it("treats null as absence only for explicitly selected fields", () => {
    const condition = buildExpectedFieldsCondition(
      { lock: null, nullable: null },
      { nullMatchesMissing: ["lock"] },
    );

    expect(condition.conditionExpression).toBe(
      "(attribute_not_exists(#expected_lock) OR #expected_lock = :expected_lock) AND #expected_nullable = :expected_nullable",
    );
    expect(condition.expressionAttributeValues).toEqual({
      ":expected_lock": null,
      ":expected_nullable": null,
    });
  });
});

describe("matchesExpectedFields", () => {
  it("compares selected fields while ignoring unrelated stored fields", () => {
    const expected = {
      assignments: [{ principalId: "user-1" }],
      enabled: false,
      optional: undefined,
      nullable: null,
    };
    const stored = marshall(
      { ...expected, monitoringCost: 42 },
      { removeUndefinedValues: true },
    );

    expect(matchesExpectedFields(stored, expected)).toBe(true);
    expect(
      matchesExpectedFields(stored, { ...expected, assignments: [] }),
    ).toBe(false);
  });

  it("requires absence for undefined fields, including stored NULL", () => {
    expect(
      matchesExpectedFields(marshall({ optional: null }), {
        optional: undefined,
      }),
    ).toBe(false);
  });

  it("requires the complete stored item in exact mode and an available image", () => {
    const expected = { status: "Active", optional: undefined };
    const stored = marshall(expected, { removeUndefinedValues: true });

    expect(matchesExpectedFields(stored, expected, { exact: true })).toBe(true);
    expect(
      matchesExpectedFields(
        { ...stored, ...marshall({ additionalField: 42 }) },
        expected,
        { exact: true },
      ),
    ).toBe(false);
    expect(matchesExpectedFields(undefined, expected)).toBe(false);
  });
});

describe("batchWriteWithRetry", () => {
  beforeEach(() => {
    mockDynamoClient.reset();
  });

  it("sends each batch independently", async () => {
    mockDynamoClient.on(BatchWriteCommand).resolves({});

    await batchWriteWithRetry({
      client: ddbClient,
      tableName: TABLE_NAME,
      batches: [[writeRequest], [secondWriteRequest]],
    });

    const requestBatches = mockDynamoClient
      .commandCalls(BatchWriteCommand)
      .map((call) => call.args[0].input.RequestItems![TABLE_NAME]);
    expect(requestBatches).toHaveLength(2);
    expect(requestBatches).toEqual(
      expect.arrayContaining([[writeRequest], [secondWriteRequest]]),
    );
  });

  it("retries only the unprocessed requests", async () => {
    mockDynamoClient
      .on(BatchWriteCommand)
      .resolvesOnce({
        UnprocessedItems: { [TABLE_NAME]: [writeRequest] },
      })
      .resolvesOnce({});

    await batchWriteWithRetry({
      client: ddbClient,
      tableName: TABLE_NAME,
      batches: [[writeRequest]],
      startingDelay: 1,
    });

    const calls = mockDynamoClient.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(2);
    expect(calls[1]!.args[0].input.RequestItems![TABLE_NAME]).toEqual([
      writeRequest,
    ]);
  });

  it("throws after the configured number of attempts", async () => {
    mockDynamoClient.on(BatchWriteCommand).resolves({
      UnprocessedItems: { [TABLE_NAME]: [writeRequest] },
    });

    await expect(
      batchWriteWithRetry({
        client: ddbClient,
        tableName: TABLE_NAME,
        batches: [[writeRequest]],
        numOfAttempts: 2,
        startingDelay: 1,
      }),
    ).rejects.toThrow(BatchUnprocessedItemsError);

    expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(2);
  });

  it("does not retry non-retryable errors", async () => {
    const serviceError = new Error("service unavailable");
    mockDynamoClient.on(BatchWriteCommand).rejects(serviceError);

    await expect(
      batchWriteWithRetry({
        client: ddbClient,
        tableName: TABLE_NAME,
        batches: [[writeRequest]],
        startingDelay: 1,
      }),
    ).rejects.toBe(serviceError);

    expect(mockDynamoClient.commandCalls(BatchWriteCommand)).toHaveLength(1);
  });
});

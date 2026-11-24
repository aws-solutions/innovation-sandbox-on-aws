// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  QueryCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BREACH_SK_ATTEMPTS,
  DynamoLeaseCostHistoryStore,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/dynamo-lease-cost-history-store.js";
import { LeaseCostHistorySchemaVersion } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);
// A real instance, which paginateQuery requires; the mock above intercepts its sends.
const ddbClient = DynamoDBDocumentClient.from(
  new DynamoDBClient({ region: "us-east-1" }),
);

const LEASE_UUID = "750e8400-e29b-41d4-a716-446655440002";
const tableName = "test-lease-cost-history-table";
const meta = { schemaVersion: LeaseCostHistorySchemaVersion };

type CostHistoryWindow = { from: string; to: string };

const pageCursor = (
  sk: string,
  window: CostHistoryWindow | null = null,
  leaseUuid = LEASE_UUID,
) =>
  base64EncodeCompositeKey({
    version: 1,
    key: { leaseUuid, sk },
    window,
  })!;

function costRow(sk: string, billedCostAccrued = 60.0) {
  return {
    leaseUuid: LEASE_UUID,
    sk,
    billedCostAccrued,
    billedCostDelta: 28.0,
    predictedCostAtRefresh: null,
    latestPeriodStart: "2026-08-11",
    latestPeriodAmount: 12.0,
    billedBedrockTokenCost: null,
    ttl: futureTtl(),
    meta,
  };
}

function tokenRow(sk: string) {
  return {
    leaseUuid: LEASE_UUID,
    sk,
    tokens: {
      "us-east-1": {
        "amazon.nova-pro-v1:0": {
          input: 184320,
          output: 41200,
          cacheRead: 1104000,
          cacheWrite: 92400,
        },
      },
    },
    monitoredBedrockTokenCostDelta: 1.87,
    monitoredBedrockTokenCost: 12.44,
    coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000Z" },
    ttl: futureTtl(),
    meta,
  };
}

function breachRow() {
  return {
    leaseUuid: LEASE_UUID,
    triggeredBy: "REPORTED" as const,
    action: "ALERT" as const,
    thresholdDollars: 70.0,
    thresholdRate: null,
    thresholdRateBasis: null,
    billedCostAtFire: 60.0,
    predictedCostAtFire: null,
    evaluatedBy: "LEASE_MONITORING" as const,
    evaluatedSpendAtFire: null,
    monitoredBedrockTokenCostAtFire: null,
    rateAtFire: null,
    rateSourceAtFire: null,
    insight: null,
    ttl: futureTtl(),
  };
}

describe("DynamoLeaseCostHistoryStore", () => {
  let store: DynamoLeaseCostHistoryStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseCostHistoryStore({
      client: ddbClient,
      leaseCostHistoryTableName: tableName,
    });
  });

  test("getNewestCostObservation issues one query with ScanIndexForward:false, Limit:1 over the COST prefix", async () => {
    mockDynamoClient
      .on(QueryCommand)
      .resolves({ Items: [costRow("COST#2026-08-11T08:00:00.000Z")] });

    const result = await store.getNewestCostObservation(LEASE_UUID);

    const calls = mockDynamoClient.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input!;
    expect(input.TableName).toBe(tableName);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(input.KeyConditionExpression).toContain("begins_with");
    expect(input.ExpressionAttributeValues?.[":skPrefix"]).toBe("COST#");
    expect(result.complete && result.result?.billedCostAccrued).toBe(60.0);
  });

  test("getNewestCostObservation reports a corrupt newest row rather than an absent one", async () => {
    // Conflating the two would restart the cumulative from zero and re-arm
    // every fired threshold.
    mockDynamoClient
      .on(QueryCommand)
      .resolves({ Items: [costRow("COST#2026-08-11T09:00:00Z")] });

    const result = await store.getNewestCostObservation(LEASE_UUID);

    expect(result.complete).toBe(false);
    expect(result).not.toHaveProperty("result");
    expect(result.complete === false && result.droppedRecordCount).toBe(1);
  });

  test("appendCostObservation uses a plain PutCommand, generates a COST# sk, and preserves null fields", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    const written = await store.appendCostObservation({
      leaseUuid: LEASE_UUID,
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      billedBedrockTokenCost: null,
      ttl: futureTtl(),
    } as any);

    const calls = mockDynamoClient.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input!;
    expect(input.TableName).toBe(tableName);
    // Plain put -- no conditional write.
    expect(input.ConditionExpression).toBeUndefined();
    expect(written.sk).toMatch(
      /^COST#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    // Null must survive to the item, not be stripped.
    expect((input.Item as any).billedBedrockTokenCost).toBeNull();
    expect((input.Item as any).predictedCostAtRefresh).toBeNull();
  });

  // I1: the anchoring arithmetic needs the anchor day's totals in the item, not
  // merely in the object that passed `parse`.
  test("appendCostObservation writes both anchor-day totals to the item", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await store.appendCostObservation({
      leaseUuid: LEASE_UUID,
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      serviceBreakdown: { "Amazon Bedrock": 52.1 },
      latestPeriodServiceAmounts: { "Amazon Bedrock": 10.5 },
      billedBedrockTokenCost: null,
      ttl: futureTtl(),
    } as any);

    const item = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input!
      .Item as Record<string, unknown>;
    expect(item.latestPeriodAmount).toBe(12.0);
    expect(item.latestPeriodServiceAmounts).toEqual({ "Amazon Bedrock": 10.5 });
  });

  test("appendCostObservation rejects a breakdown with no anchor-day companion", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await expect(
      store.appendCostObservation({
        leaseUuid: LEASE_UUID,
        billedCostAccrued: 60.0,
        billedCostDelta: 28.0,
        predictedCostAtRefresh: null,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 12.0,
        serviceBreakdown: { "Amazon Bedrock": 52.1 },
        billedBedrockTokenCost: null,
        ttl: futureTtl(),
      } as any),
    ).rejects.toThrow();
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("listCostObservations narrows to a window without losing the prefix", async () => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await store.listCostObservations(LEASE_UUID, {
      pageSize: 100,
      window: {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-11T00:00:00.000Z",
      },
    });

    const query =
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!;
    // A `BETWEEN` replaces the `begins_with`, since DynamoDB allows one sort-key
    // condition; the prefix stays on the bounds so the BREACH and BEDROCK_TOKEN
    // rows sorting below `COST#` are still excluded.
    expect(query.KeyConditionExpression).toContain("BETWEEN");
    expect(query.KeyConditionExpression).not.toContain("begins_with");
    expect(query.ExpressionAttributeValues).toMatchObject({
      ":from": "COST#2026-08-10T00:00:00.000Z",
      ":to": "COST#2026-08-11T00:00:00.000Z",
    });
  });

  test.each([
    [
      "an inverted window",
      {
        from: "2026-08-11T00:00:00.000Z",
        to: "2026-08-10T00:00:00.000Z",
      },
    ],
    [
      "a bound with no milliseconds",
      { from: "2026-08-10T00:00:00Z", to: "2026-08-11T00:00:00.000Z" },
    ],
  ])(
    "listCostObservations rejects %s before querying",
    async (_name, window) => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await expect(
        store.listCostObservations(LEASE_UUID, { pageSize: 100, window }),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  test("a row that fails its schema is excluded and counted, not thrown", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        costRow("COST#2026-08-11T08:00:00.000Z"),
        // Malformed sort key (no milliseconds) -- must be dropped, not thrown.
        costRow("COST#2026-08-11T09:00:00Z", 61.0),
      ],
    });

    const page = await store.listCostObservations(LEASE_UUID, {
      pageSize: 100,
    });

    expect(page.result).toHaveLength(1);
    expect(page.result[0]!.billedCostAccrued).toBe(60.0);
    expect(page.droppedRecordCount).toBe(1);
  });

  // The store is the chokepoint. parseResults' message names stored attributes
  // and the sort-key regex patterns, so no read may return it.
  test.each([
    [
      "listCostObservations",
      () => store.listCostObservations(LEASE_UUID, { pageSize: 100 }),
    ],
    [
      "listBreachRecords",
      () =>
        store.listBreachRecords(LEASE_UUID, {
          from: "2026-08-11T00:00:00.000Z",
          to: "2026-08-11T23:59:59.999Z",
        }),
    ],
    [
      "listBreachRecordPage",
      () => store.listBreachRecordPage(LEASE_UUID, { pageSize: 100 }),
    ],
    [
      "listBedrockTokenRows",
      () => store.listBedrockTokenRows(LEASE_UUID, { pageSize: 100 }),
    ],
    [
      "getNewestCostObservation",
      () => store.getNewestCostObservation(LEASE_UUID),
    ],
    [
      "getRecentCostObservations",
      () => store.getRecentCostObservations(LEASE_UUID, { limit: 25 }),
    ],
  ])("%s discloses no schema detail when a row is dropped", async (_, read) => {
    mockDynamoClient.on(QueryCommand).resolves({
      // Malformed for every one of the three schemas.
      Items: [costRow("COST#2026-08-11T09:00:00Z", 61.0)],
    });

    const serialized = JSON.stringify(await read());

    expect(serialized).not.toContain("sk");
    expect(serialized).not.toContain("COST#");
    expect(serialized).not.toContain("pattern");
    expect(serialized).not.toContain("invalid record");
    // The reason class instead: a bare count does not say why rows are missing,
    // and this value carries no attribute name, type, bound or pattern.
    expect(serialized).toContain("SCHEMA_VALIDATION");
  });

  test("the warn logged for a dropped row carries no schema detail either", async () => {
    // The response was the only sink checked above; the store logged the same
    // parseResults message it refuses to return, into a log group scoped by a
    // broader grant than the table's own.
    const warn = vi.spyOn(Logger.prototype, "warn");
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [costRow("COST#2026-08-11T09:00:00Z", 61.0)],
    });

    await store.getNewestCostObservation(LEASE_UUID);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).not.toContain("pattern");
    expect(logged).not.toContain("must match");
    expect(logged).not.toContain("expected");
    expect(logged).not.toContain("COST#");
    // The failing field and the issue class, which is what makes it diagnosable.
    expect(logged).toContain("sk");
    expect(logged).toContain("invalid_format");
  });

  test("logs the issue paths of a dropped row, map keys included, and neither the zod message nor an unrecognized key's name", async () => {
    const warn = vi.spyOn(Logger.prototype, "warn");
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        {
          ...costRow("COST#2026-08-11T09:00:00.000Z"),
          serviceBreakdown: { AmazonBedrock: "not-a-number" },
          someV2Attribute: "from a newer writer",
        },
      ],
    });

    await store.getNewestCostObservation(LEASE_UUID);

    const logged = JSON.stringify(warn.mock.calls);
    expect(logged).toContain("serviceBreakdown.AmazonBedrock");
    // an unrecognized-keys issue is reported at the root, its key names withheld
    expect(logged).toContain("(root)");
    expect(logged).not.toContain("someV2Attribute");
    // zod's message would add the expected and received types
    expect(logged).not.toContain("Invalid input");
    expect(logged).not.toContain("expected number");
  });

  test("listBreachRecords bounds the query with BETWEEN wrapped in the BREACH prefix", async () => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await store.listBreachRecords(LEASE_UUID, {
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z",
    });

    const input =
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!;
    expect(input.KeyConditionExpression).toContain("BETWEEN");
    expect(input.ExpressionAttributeValues?.[":from"]).toBe(
      "BREACH#2026-08-11T00:00:00.000Z",
    );
    expect(input.ExpressionAttributeValues?.[":to"]).toBe(
      "BREACH#2026-08-11T23:59:59.999Z",
    );
  });

  // One paged read per row type, each over its own prefix only.
  const pagedReads = [
    [
      "listCostObservations",
      "COST#",
      (options: Parameters<typeof store.listCostObservations>[1]) =>
        store.listCostObservations(LEASE_UUID, options),
    ],
    [
      "listBedrockTokenRows",
      "BEDROCK_TOKEN#",
      (options: Parameters<typeof store.listBedrockTokenRows>[1]) =>
        store.listBedrockTokenRows(LEASE_UUID, options),
    ],
    [
      "listBreachRecordPage",
      "BREACH#",
      (options: Parameters<typeof store.listBreachRecordPage>[1]) =>
        store.listBreachRecordPage(LEASE_UUID, options),
    ],
  ] as const;

  test.each(pagedReads)(
    "%s pages newest-first over its own prefix",
    async (_name, prefix, read) => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await read({ pageSize: 25 });
      await read({
        pageSize: 25,
        window: {
          from: "2026-08-11T00:00:00.000Z",
          to: "2026-08-11T23:59:59.999Z",
        },
      });

      const [unbounded, bounded] = mockDynamoClient
        .commandCalls(QueryCommand)
        .map((call) => call.args[0].input!);
      for (const input of [unbounded!, bounded!]) {
        expect(input.ScanIndexForward).toBe(false);
        expect(input.Limit).toBe(25);
      }
      expect(unbounded!.KeyConditionExpression).toContain("begins_with");
      expect(unbounded!.ExpressionAttributeValues?.[":skPrefix"]).toBe(prefix);
      expect(bounded!.KeyConditionExpression).toContain("BETWEEN");
      // Every row type's keys are fixed-width milliseconds, so each window bound
      // is the prefixed timestamp exactly, with no widening.
      expect(bounded!.ExpressionAttributeValues).toMatchObject({
        ":from": `${prefix}2026-08-11T00:00:00.000Z`,
        ":to": `${prefix}2026-08-11T23:59:59.999Z`,
      });
    },
  );

  test("listBreachRecordPage accepts a cursor on either edge millisecond of its window", async () => {
    const window = {
      from: "2026-08-11T09:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    };
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    for (const sk of [
      "BREACH#2026-08-11T09:00:00.000Z",
      "BREACH#2026-08-11T10:00:00.000Z",
    ]) {
      mockDynamoClient.resetHistory();
      await store.listBreachRecordPage(LEASE_UUID, {
        pageSize: 100,
        pageIdentifier: pageCursor(sk, window),
        window,
      });
      expect(
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!
          .ExclusiveStartKey,
      ).toEqual({ leaseUuid: LEASE_UUID, sk });
    }
  });

  test("listBreachRecordPage rejects a cursor one millisecond outside its window or with sub-millisecond precision", async () => {
    const window = {
      from: "2026-08-11T09:00:00.000Z",
      to: "2026-08-11T10:00:00.000Z",
    };
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    for (const sk of [
      "BREACH#2026-08-11T08:59:59.999Z",
      "BREACH#2026-08-11T10:00:00.001Z",
      "BREACH#2026-08-11T09:30:00.000123456789Z",
    ]) {
      await expect(
        store.listBreachRecordPage(LEASE_UUID, {
          pageSize: 100,
          pageIdentifier: pageCursor(sk, window),
          window,
        }),
      ).rejects.toThrow(/not a valid pagination cursor/);
    }
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test.each(pagedReads)(
    "%s round-trips its cursor",
    async (_name, prefix, read) => {
      const lastEvaluatedKey = {
        leaseUuid: LEASE_UUID,
        sk: `${prefix}2026-08-11T00:00:00.000Z`,
      };
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: [], LastEvaluatedKey: lastEvaluatedKey });

      const page = await read({ pageSize: 100 });

      expect(page.nextPageIdentifier).toBe(pageCursor(lastEvaluatedKey.sk));
      mockDynamoClient.reset();
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });
      const next = await read({
        pageSize: 100,
        pageIdentifier: page.nextPageIdentifier!,
      });
      expect(
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!
          .ExclusiveStartKey,
      ).toEqual(lastEvaluatedKey);
      expect(next.nextPageIdentifier).toBeNull();
    },
  );

  // A one-reading page before a range is how a reader finds the reading a range's
  // first change is measured from, so an unreadable reading and no reading must
  // stay apart: both pages are empty, and only the first hands on a cursor.
  describe("a one-reading token page before a range", () => {
    const window = {
      from: "1970-01-01T00:00:00.000Z",
      to: "2026-08-10T23:59:59.999Z",
    };
    const sk = "BEDROCK_TOKEN#2026-08-10T23:50:00.000Z";

    test("hands on the cursor where it dropped its only reading", async () => {
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [{ ...tokenRow(sk), monitoredBedrockTokenCost: -1 }],
        LastEvaluatedKey: { leaseUuid: LEASE_UUID, sk },
      });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 1,
        window,
      });

      expect(page.result).toEqual([]);
      expect(page.droppedRecordCount).toBe(1);
      expect(page.nextPageIdentifier).toBe(pageCursor(sk, window));
    });

    test("has no cursor where no reading precedes the range", async () => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 1,
        window,
      });

      expect(page.result).toEqual([]);
      expect(page.nextPageIdentifier).toBeNull();
    });
  });

  // The type is the prefix of the cursor's sort key, so a cursor from one type's
  // read is rejected by another's rather than resuming it at a foreign key.
  test.each(
    pagedReads.flatMap(([name, prefix, read]) =>
      ["COST#", "BEDROCK_TOKEN#", "BREACH#"]
        .filter((other) => other !== prefix)
        .map((other) => [name, other, read] as const),
    ),
  )("%s rejects a %s cursor", async (_name, otherPrefix, read) => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await expect(
      read({
        pageSize: 100,
        pageIdentifier: pageCursor(`${otherPrefix}2026-08-11T09:00:00.000Z`),
      }),
    ).rejects.toThrow(/not a valid pagination cursor/);
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test.each(pagedReads)(
    "%s binds its cursor to the lease and the window",
    async (_name, prefix, read) => {
      const window = {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      };
      const sk = `${prefix}2026-08-11T09:00:00.000Z`;
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      for (const [pageIdentifier, readWindow] of [
        [
          pageCursor(sk, window, "850e8400-e29b-41d4-a716-446655440009"),
          window,
        ],
        [pageCursor(sk), window],
        [pageCursor(sk, window), undefined],
        [pageCursor(`${prefix}2026-08-13T00:00:00.000Z`, window), window],
      ] as const) {
        await expect(
          read({
            pageSize: 100,
            pageIdentifier,
            ...(readWindow === undefined ? {} : { window: readWindow }),
          }),
        ).rejects.toThrow(/not a valid pagination cursor/);
      }
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);

      await read({
        pageSize: 100,
        pageIdentifier: pageCursor(sk, window),
        window,
      });
      expect(
        mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!
          .ExclusiveStartKey,
      ).toEqual({ leaseUuid: LEASE_UUID, sk });
    },
  );

  test("listBreachRecordPage returns DURATION and EXPIRY rows", async () => {
    // Measured in time, so neither kind names a dollar threshold.
    const leaseEnd = { ...breachRow(), thresholdDollars: null, meta };
    const duration = {
      ...leaseEnd,
      sk: "BREACH#2026-08-11T18:00:00.000Z",
      triggeredBy: "DURATION",
      action: "FREEZE_ACCOUNT",
      thresholdHoursRemaining: 24,
    };
    const expiry = {
      ...leaseEnd,
      sk: "BREACH#2026-08-11T12:00:00.000Z",
      triggeredBy: "EXPIRY",
      action: "TERMINATE",
    };
    mockDynamoClient.on(QueryCommand).resolves({ Items: [duration, expiry] });

    const page = await store.listBreachRecordPage(LEASE_UUID, {
      pageSize: 100,
    });

    expect(page.result).toEqual([
      expect.objectContaining({
        sk: duration.sk,
        triggeredBy: "DURATION",
        action: "FREEZE_ACCOUNT",
        thresholdHoursRemaining: 24,
      }),
      expect.objectContaining({
        sk: expiry.sk,
        triggeredBy: "EXPIRY",
        action: "TERMINATE",
      }),
    ]);
  });

  test("an unpaginated window query that never exhausts throws instead of returning a partial window", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [{ ...breachRow(), sk: "BREACH#2026-08-11T18:00:00.000Z", meta }],
      LastEvaluatedKey: {
        leaseUuid: LEASE_UUID,
        sk: "BREACH#2026-08-11T12:00:00.000Z",
      },
    });

    await expect(
      store.listBreachRecords(LEASE_UUID, {
        from: "2026-08-11T00:00:00.000Z",
        to: "2026-08-11T23:59:59.999Z",
      }),
    ).rejects.toThrow(/exceeded 20 pages/);
  });

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
    ["over the cap", 1001],
  ])(
    "listCostObservations rejects a %s pageSize before querying",
    async (_label, pageSize) => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await expect(
        store.listCostObservations(LEASE_UUID, { pageSize }),
      ).rejects.toThrow(/pageSize must be an integer/);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  test.each([
    ["zero", 0],
    ["negative", -1],
    ["fractional", 10.5],
    ["over the cap", 1001],
  ])(
    "getRecentCostObservations rejects a %s limit before querying",
    async (_label, limit) => {
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await expect(
        store.getRecentCostObservations(LEASE_UUID, { limit }),
      ).rejects.toThrow(/limit must be an integer/);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  test.each([
    ["null", "null"],
    ["a number", "123"],
    ["a bare string", '"x"'],
    ["an array", "[]"],
    ["an empty object", "{}"],
    ["an unrelated object", '{"foo":1}'],
    [
      "a cursor for another lease",
      '{"leaseUuid":"other","sk":"COST#2026-08-11T09:00:00.000Z"}',
    ],
    [
      "a cursor for another record type",
      `{"leaseUuid":"${LEASE_UUID}","sk":"BREACH#2026-08-11T09:00:00.000Z"}`,
    ],
    [
      "extra attributes",
      `{"leaseUuid":"${LEASE_UUID}","sk":"COST#2026-08-11T09:00:00.000Z","x":1}`,
    ],
  ])(
    "listCostObservations rejects %s as a cursor before querying",
    async (_label, json) => {
      // Buffer.from(...,"base64url") never throws -- it drops invalid characters --
      // so every one of these decodes and JSON.parses cleanly. Catching the decode
      // throw alone would let them all reach ExclusiveStartKey.
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await expect(
        store.listCostObservations(LEASE_UUID, {
          pageSize: 100,
          pageIdentifier: Buffer.from(json, "utf8").toString("base64url"),
        }),
      ).rejects.toThrow(/not a valid pagination cursor/);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  test("listCostObservations accepts an unbounded cursor it minted itself", async () => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });
    const cursor = pageCursor("COST#2026-08-11T09:00:00.000Z");

    await store.listCostObservations(LEASE_UUID, {
      pageSize: 100,
      pageIdentifier: cursor,
    });

    const input =
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!;
    expect(input.ExclusiveStartKey).toEqual({
      leaseUuid: LEASE_UUID,
      sk: "COST#2026-08-11T09:00:00.000Z",
    });
  });

  test("listCostObservations binds a cursor to its original range", async () => {
    const originalWindow = {
      from: "2026-08-10T00:00:00.000Z",
      to: "2026-08-12T00:00:00.000Z",
    };
    const cursor = pageCursor("COST#2026-08-11T09:00:00.000Z", originalWindow);
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await store.listCostObservations(LEASE_UUID, {
      pageSize: 100,
      pageIdentifier: cursor,
      window: originalWindow,
    });
    expect(
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!
        .ExclusiveStartKey,
    ).toEqual({
      leaseUuid: LEASE_UUID,
      sk: "COST#2026-08-11T09:00:00.000Z",
    });

    mockDynamoClient.reset();
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });
    await expect(
      store.listCostObservations(LEASE_UUID, {
        pageSize: 100,
        pageIdentifier: cursor,
        window: {
          from: originalWindow.from,
          to: "2026-08-11T12:00:00.000Z",
        },
      }),
    ).rejects.toThrow(/not a valid pagination cursor/);
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test.each([
    [
      "an unbounded cursor on a bounded query",
      pageCursor("COST#2026-08-11T09:00:00.000Z"),
      {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      },
    ],
    [
      "a bounded cursor on an unbounded query",
      pageCursor("COST#2026-08-11T09:00:00.000Z", {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      }),
      undefined,
    ],
    [
      "a cursor above the bounded query",
      pageCursor("COST#2026-08-13T00:00:00.000Z", {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      }),
      {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      },
    ],
    [
      "a cursor below the bounded query",
      pageCursor("COST#2026-08-09T23:59:59.999Z", {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      }),
      {
        from: "2026-08-10T00:00:00.000Z",
        to: "2026-08-12T00:00:00.000Z",
      },
    ],
  ])("listCostObservations rejects %s", async (_label, cursor, window) => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await expect(
      store.listCostObservations(LEASE_UUID, {
        pageSize: 100,
        pageIdentifier: cursor,
        ...(window === undefined ? {} : { window }),
      }),
    ).rejects.toThrow(/not a valid pagination cursor/);
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test("listCostObservations rejects a malformed cursor without echoing it back", async () => {
    // base64DecodeCompositeKey is a bare JSON.parse, so this arrives as an
    // unhandled SyntaxError otherwise.
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    const rejection = store.listCostObservations(LEASE_UUID, {
      pageSize: 100,
      pageIdentifier: Buffer.from("}not json{", "utf8").toString("base64url"),
    });

    await expect(rejection).rejects.toThrow(/not a valid pagination cursor/);
    await expect(rejection).rejects.not.toThrow(/not json/);
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test("an inverted window throws rather than reporting an empty audit trail", async () => {
    // The bound a caller derives from another query's page: every read here is
    // newest-first, so page[0] is the NEWEST row. Passing it as `from` makes
    // BETWEEN match nothing, and the empty result is indistinguishable from a
    // lease that never breached -- the audit trail the breach history relies on.
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

    await expect(
      store.listBreachRecords(LEASE_UUID, {
        from: "2026-08-11T23:59:59.999Z",
        to: "2026-08-11T00:00:00.000Z",
      }),
    ).rejects.toThrow(/inverted window/);
    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
  });

  test.each([
    ["a date with no time", "2026-08-11"],
    ["seconds only", "2026-08-11T00:00:00Z"],
    ["an offset instead of Z", "2026-08-11T00:00:00.000+00:00"],
    ["microseconds", "2026-08-11T00:00:00.000000Z"],
  ])(
    "a window bound given as %s throws rather than sorting wrong",
    async (_label, bound) => {
      // BREACH#2026-08-11 sorts BELOW BREACH#2026-08-11T00:00:00.000Z, so a
      // short bound drops the whole boundary day silently. Same reason every
      // stored sort key is regex-pinned.
      mockDynamoClient.on(QueryCommand).resolves({ Items: [] });

      await expect(
        store.listBreachRecords(LEASE_UUID, {
          from: bound,
          to: "2026-08-12T00:00:00.000Z",
        }),
      ).rejects.toThrow(/fixed-width ISO millisecond/);
      expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(0);
    },
  );

  test("a window query throws on accumulated size before the page cap is reached", async () => {
    // The page cap alone admits 20 full 1 MB pages plus their parsed copies.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [{ leaseUuid: LEASE_UUID, filler: "x".repeat(1_000_000) }],
      LastEvaluatedKey: {
        leaseUuid: LEASE_UUID,
        sk: "BREACH#2026-08-11T12:00:00.000Z",
      },
    });

    await expect(
      store.listBreachRecords(LEASE_UUID, {
        from: "2026-08-11T00:00:00.000Z",
        to: "2026-08-11T23:59:59.999Z",
      }),
    ).rejects.toThrow(/exceeded 4000000 bytes/);
    // Fired on size, well short of the 20 pages the other cap would have run.
    expect(
      mockDynamoClient.commandCalls(QueryCommand).length,
    ).toBeLessThanOrEqual(5);
  });

  test("a window query drains LastEvaluatedKey so a truncated page does not silently lose the oldest rows", async () => {
    const pageBoundary = {
      leaseUuid: LEASE_UUID,
      sk: "BREACH#2026-08-11T12:00:00.000Z",
    };
    const pages = [
      {
        Items: [
          { ...breachRow(), sk: "BREACH#2026-08-11T18:00:00.000Z", meta },
        ],
        LastEvaluatedKey: pageBoundary,
      },
      {
        Items: [
          { ...breachRow(), sk: "BREACH#2026-08-11T06:00:00.000Z", meta },
        ],
      },
    ];
    // Copied as sent: the paginator reuses one input object across pages, so a
    // recorded call's input shows only the last page's cursor afterward.
    const sent: QueryCommandInput[] = [];
    mockDynamoClient.on(QueryCommand).callsFake((input: QueryCommandInput) => {
      sent.push(structuredClone(input));
      return pages[sent.length - 1];
    });

    const windowed = await store.listBreachRecords(LEASE_UUID, {
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z",
    });

    expect(mockDynamoClient.commandCalls(QueryCommand)).toHaveLength(2);
    // Newest-first is the reason draining matters: a cap or an abandoned cursor
    // would drop the window's oldest rows, not its newest.
    expect(sent[0]!.ScanIndexForward).toBe(false);
    expect(sent[1]!.ScanIndexForward).toBe(false);
    expect(sent[0]!.ExclusiveStartKey).toBeUndefined();
    expect(sent[1]!.ExclusiveStartKey).toEqual(pageBoundary);
    expect(windowed.result).toHaveLength(2);
    expect(windowed.droppedRecordCount).toBe(0);
    expect(windowed.droppedRecordReason).toBeNull();
  });

  describe("a token page too large for one response", () => {
    // About 240 KB each, under the schema's item ceiling: four fit the 1 MB a token
    // page takes, and a fifth passes it.
    const regions = Array.from({ length: 19 }, (_, index) => `region-${index}`);
    const largeTokenRow = (sk: string) => ({
      ...tokenRow(sk),
      tokens: Object.fromEntries(
        regions.map((region) => [
          region,
          Object.fromEntries(
            Array.from({ length: 200 }, (_, model) => [
              `model-${model}`,
              { input: 1, output: 2, cacheRead: 3, cacheWrite: 4 },
            ]),
          ),
        ]),
      ),
      coveredThrough: Object.fromEntries(
        regions.map((region) => [region, "2026-08-11T10:54:00.000Z"]),
      ),
    });
    const window = {
      from: "2026-08-11T00:00:00.000Z",
      to: "2026-08-11T23:59:59.999Z",
    };
    const hours = (count: number) =>
      Array.from(
        { length: count },
        (_, index) =>
          `BEDROCK_TOKEN#2026-08-11T${String(20 - index).padStart(2, "0")}:00:00.000Z`,
      );

    test("stops after the last row that fits and resumes below it", async () => {
      mockDynamoClient
        .on(QueryCommand)
        .resolves({ Items: hours(6).map(largeTokenRow) });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 100,
        window,
      });

      expect(page.result.map((row) => row.sk)).toEqual(hours(4));
      // A real row, never an instant between two.
      expect(page.nextPageIdentifier).toBe(pageCursor(hours(4)[3]!, window));
    });

    test("stops at the byte budget even where DynamoDB hands on a cursor further down", async () => {
      mockDynamoClient.on(QueryCommand).resolves({
        Items: hours(6).map(largeTokenRow),
        LastEvaluatedKey: { leaseUuid: LEASE_UUID, sk: hours(6)[5]! },
      });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 6,
        window,
      });

      expect(page.result.map((row) => row.sk)).toEqual(hours(4));
      // Resuming from DynamoDB's cursor would skip the two rows left unread.
      expect(page.nextPageIdentifier).toBe(pageCursor(hours(4)[3]!, window));
    });

    test("hands on DynamoDB's own cursor where the page fits", async () => {
      const lastEvaluatedKey = { leaseUuid: LEASE_UUID, sk: hours(4)[3]! };
      mockDynamoClient.on(QueryCommand).resolves({
        Items: hours(4).map(largeTokenRow),
        LastEvaluatedKey: lastEvaluatedKey,
      });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 4,
      });

      expect(page.result).toHaveLength(4);
      expect(page.nextPageIdentifier).toBe(pageCursor(lastEvaluatedKey.sk));
    });

    test("keeps a row a cursor cannot name, and stops after the next one it can", async () => {
      const rows = hours(6).map(largeTokenRow);
      rows[3] = { ...rows[3]!, sk: "BEDROCK_TOKEN#2026-08-11T17:00:00Z" };
      mockDynamoClient.on(QueryCommand).resolves({ Items: rows });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 100,
      });

      // The malformed row is read and dropped, so the page runs one row further.
      expect(page.droppedRecordCount).toBe(1);
      expect(page.result.map((row) => row.sk)).toEqual([
        ...hours(3),
        hours(5)[4],
      ]);
      expect(page.nextPageIdentifier).toBe(pageCursor(hours(5)[4]!));
    });

    test("leaves the rows past where it stops to the next page, unparsed and uncounted", async () => {
      const rows = hours(6).map(largeTokenRow);
      rows[5] = { ...rows[5]!, monitoredBedrockTokenCost: -1 };
      mockDynamoClient.on(QueryCommand).resolves({ Items: rows });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 100,
      });

      expect(page.result.map((row) => row.sk)).toEqual(hours(4));
      expect(page.droppedRecordCount).toBeUndefined();
    });

    test("never stops before the first row, so every page moves the read on", async () => {
      const oversized = {
        ...tokenRow(hours(1)[0]!),
        filler: "x".repeat(1_100_000),
      };
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [oversized, tokenRow(hours(2)[1]!)],
      });

      const page = await store.listBedrockTokenRows(LEASE_UUID, {
        pageSize: 100,
      });

      // Read and dropped as unparseable, but the cursor still moves past it.
      expect(page.result).toEqual([]);
      expect(page.droppedRecordCount).toBe(1);
      expect(page.nextPageIdentifier).toBe(pageCursor(hours(1)[0]!));
    });
  });

  // The audit read the breach history rests on: a v2 row a newer Lambda wrote during a rolling
  // deploy is dropped by createVersionRangeSchema(1, 1), so the count is required
  // rather than optional and a clean window states 0 instead of omitting it.
  test.each([
    [
      "listBreachRecords",
      () =>
        store.listBreachRecords(LEASE_UUID, {
          from: "2026-08-11T00:00:00.000Z",
          to: "2026-08-11T23:59:59.999Z",
        }),
    ],
  ])("%s always states its drop count", async (_, read) => {
    mockDynamoClient.on(QueryCommand).resolves({ Items: [] });
    const clean = await read();
    expect(clean.droppedRecordCount).toBe(0);
    expect(clean.droppedRecordReason).toBeNull();

    mockDynamoClient.reset();
    mockDynamoClient
      .on(QueryCommand)
      .resolves({ Items: [{ ...breachRow(), sk: "BREACH#nope", meta }] });
    const dropped = await read();
    expect(dropped.droppedRecordCount).toBe(1);
    expect(dropped.droppedRecordReason).toBe("SCHEMA_VALIDATION");
  });

  test("a caller cannot destructure an audit read without its drop count", () => {
    // @ts-expect-error droppedRecordCount and droppedRecordReason are required
    const ignoringTheDrop: Awaited<ReturnType<typeof store.listBreachRecords>> =
      { result: [] };
    expect(ignoringTheDrop.result).toEqual([]);
  });

  test("getRecentCostObservations queries newest-first with the requested limit", async () => {
    mockDynamoClient
      .on(QueryCommand)
      .resolves({ Items: [costRow("COST#2026-08-11T08:00:00.000Z")] });

    const recent = await store.getRecentCostObservations(LEASE_UUID, {
      limit: 25,
    });

    const input =
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(25);
    expect(recent.complete).toBe(true);
    expect(recent.complete && recent.result).toHaveLength(1);
  });

  test("getRecentCostObservations withholds the series entirely when a row is dropped", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        // The newest row is malformed. Handing back the remainder would
        // difference the rate across a wider interval than the real one, so the
        // result carries no series at all.
        costRow("COST#2026-08-11T09:00:00Z", 61.0),
        costRow("COST#2026-08-11T08:00:00.000Z"),
      ],
    });

    const recent = await store.getRecentCostObservations(LEASE_UUID, {
      limit: 25,
    });

    expect(recent.complete).toBe(false);
    expect(recent).not.toHaveProperty("result");
    expect(recent.complete === false && recent.droppedRecordCount).toBe(1);
  });

  test("appendCostObservation drops keys passed as explicit undefined", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await store.appendCostObservation({
      leaseUuid: LEASE_UUID,
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      billedBedrockTokenCost: null,
      serviceBreakdown: undefined,
      ttl: futureTtl(),
    } as any);

    const item = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input!
      .Item as Record<string, unknown>;
    expect(item).not.toHaveProperty("serviceBreakdown");
    // Null is a distinct value here and must survive.
    expect(item.billedBedrockTokenCost).toBeNull();
  });

  test("appendBedrockTokenRow uses a plain PutCommand and generates a BEDROCK_TOKEN# sk", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    const written = await store.appendBedrockTokenRow({
      leaseUuid: LEASE_UUID,
      tokens: {
        "us-east-1": {
          "amazon.nova-pro-v1:0": {
            input: 184320,
            output: 41200,
            cacheRead: 1104000,
            cacheWrite: 92400,
          },
        },
      },
      monitoredBedrockTokenCostDelta: 1.87,
      monitoredBedrockTokenCost: 12.44,
      coveredThrough: { "us-east-1": "2026-08-11T10:54:00.000Z" },
      ttl: futureTtl(),
    });

    const calls = mockDynamoClient.commandCalls(PutCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input!;
    expect(input.TableName).toBe(tableName);
    // A plain put: a run appends at most one token row per lease.
    expect(input.ConditionExpression).toBeUndefined();
    expect(written.sk).toMatch(
      /^BEDROCK_TOKEN#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
    );
    expect((input.Item as any).coveredThrough).toEqual({
      "us-east-1": "2026-08-11T10:54:00.000Z",
    });
  });

  test("appendBedrockTokenRow writes an empty row only when both costs are zero", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await expect(
      store.appendBedrockTokenRow({
        leaseUuid: LEASE_UUID,
        tokens: {},
        monitoredBedrockTokenCostDelta: 1.87,
        monitoredBedrockTokenCost: 12.44,
        coveredThrough: {},
        ttl: futureTtl(),
      }),
    ).rejects.toThrow();
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(0);

    await store.appendBedrockTokenRow({
      leaseUuid: LEASE_UUID,
      tokens: {},
      monitoredBedrockTokenCostDelta: 0,
      monitoredBedrockTokenCost: 0,
      coveredThrough: {},
      ttl: futureTtl(),
    });
    const item = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input!
      .Item as Record<string, unknown>;
    expect(item.tokens).toEqual({});
    expect(item.coveredThrough).toEqual({});
  });

  test("getNewestBedrockTokenRow queries newest-first over the BEDROCK_TOKEN prefix", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [tokenRow("BEDROCK_TOKEN#2026-08-11T10:55:00.000Z")],
    });

    const result = await store.getNewestBedrockTokenRow(LEASE_UUID);

    const calls = mockDynamoClient.commandCalls(QueryCommand);
    expect(calls).toHaveLength(1);
    const input = calls[0]!.args[0].input!;
    expect(input.TableName).toBe(tableName);
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(input.KeyConditionExpression).toContain("begins_with");
    expect(input.ExpressionAttributeValues?.[":skPrefix"]).toBe(
      "BEDROCK_TOKEN#",
    );
    expect(result.complete && result.result?.monitoredBedrockTokenCost).toBe(
      12.44,
    );
  });

  test("getNewestBedrockTokenRowAtOrBefore bounds the sort key at the instant, newest first", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [tokenRow("BEDROCK_TOKEN#2026-08-11T09:55:00.000Z")],
    });

    const result = await store.getNewestBedrockTokenRowAtOrBefore(
      LEASE_UUID,
      "2026-08-11T10:00:00.000Z",
    );

    const input =
      mockDynamoClient.commandCalls(QueryCommand)[0]!.args[0].input!;
    expect(input.ScanIndexForward).toBe(false);
    expect(input.Limit).toBe(1);
    expect(input.KeyConditionExpression).toContain(
      "#sk BETWEEN :skPrefix AND :upTo",
    );
    expect(input.ExpressionAttributeValues).toMatchObject({
      ":skPrefix": "BEDROCK_TOKEN#",
      ":upTo": "BEDROCK_TOKEN#2026-08-11T10:00:00.000Z",
    });
    expect(result.complete && result.result?.monitoredBedrockTokenCost).toBe(
      12.44,
    );
  });

  test("getNewestBedrockTokenRow reports a corrupt resume anchor rather than an absent one", async () => {
    // Conflating the two would re-read from lease start, double-counting every
    // bucket the stored cumulative already includes.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [tokenRow("BEDROCK_TOKEN#2026-08-11T10:55:00Z")],
    });

    const result = await store.getNewestBedrockTokenRow(LEASE_UUID);

    expect(result.complete).toBe(false);
    expect(result).not.toHaveProperty("result");
    expect(result.complete === false && result.droppedRecordCount).toBe(1);
  });

  test("appendBreachRecord writes conditionally and retries on a later millisecond after a collision", async () => {
    mockDynamoClient
      .on(PutCommand)
      .rejectsOnce(
        new ConditionalCheckFailedException({ $metadata: {}, message: "" }),
      )
      .resolvesOnce({});

    const written = await store.appendBreachRecord(breachRow());

    const calls = mockDynamoClient.commandCalls(PutCommand);
    expect(calls).toHaveLength(2);
    expect(calls[0]!.args[0].input!.ConditionExpression).toBe(
      "attribute_not_exists(sk)",
    );
    const firstSk = (calls[0]!.args[0].input!.Item as any).sk;
    expect(written.sk > firstSk).toBe(true);
    for (const sk of [firstSk, written.sk]) {
      expect(sk).toMatch(
        /^BREACH#\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/,
      );
    }
  });

  test("appendBreachRecord propagates a non-conditional failure", async () => {
    mockDynamoClient.on(PutCommand).rejects(new Error("throttled"));

    await expect(store.appendBreachRecord(breachRow())).rejects.toThrow(
      "throttled",
    );
  });

  test("appendBreachRecord throws once every attempt has collided", async () => {
    mockDynamoClient
      .on(PutCommand)
      .rejects(
        new ConditionalCheckFailedException({ $metadata: {}, message: "" }),
      );

    await expect(store.appendBreachRecord(breachRow())).rejects.toThrow(
      /millisecond sort keys were already taken/,
    );
    const attempted = mockDynamoClient
      .commandCalls(PutCommand)
      .map((call) => (call.args[0].input!.Item as any).sk as string);
    expect(attempted).toHaveLength(BREACH_SK_ATTEMPTS);
    // Bounded and never spinning on one key: every attempt is a distinct,
    // later, fixed-width millisecond.
    expect(new Set(attempted).size).toBe(BREACH_SK_ATTEMPTS);
    expect([...attempted].sort()).toEqual(attempted);
  });

  // Zod 4 retains an explicitly-undefined optional key, and BreachInsightSchema
  // carries two of them a level down, so a top-level filter alone lets the
  // PutCommand reject the write and lose the breach record.
  test("appendBreachRecord drops a nested key passed as explicit undefined", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await store.appendBreachRecord({
      ...breachRow(),
      insight: {
        kind: "NEW_ENTRANT",
        service: "Amazon Bedrock",
        amount: 52.1,
        shareOfComparedSpend: undefined,
        changePercent: undefined,
      },
    } as any);

    const item = mockDynamoClient.commandCalls(PutCommand)[0]!.args[0].input!
      .Item as Record<string, any>;
    expect(item.insight).not.toHaveProperty("shareOfComparedSpend");
    expect(item.insight).not.toHaveProperty("changePercent");
    expect(item.insight.service).toBe("Amazon Bedrock");
    // Null one level down is a distinct value and must survive.
    expect(item.thresholdRate).toBeNull();
  });
});

describe("a row whose ttl has already elapsed is never written", () => {
  let store: DynamoLeaseCostHistoryStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseCostHistoryStore({
      client: ddbClient,
      leaseCostHistoryTableName: tableName,
    });
  });

  // TtlSchema's floor is a fixed calendar date, so a past ttl parses; the write
  // then succeeds and DynamoDB reclaims the row, with the append having reported
  // success to a caller that treats it as durable.
  const elapsed = Math.floor(
    DateTime.now().minus({ days: 1 }).valueOf() / 1000,
  );
  const future = Math.floor(DateTime.now().plus({ days: 30 }).valueOf() / 1000);

  test("appendCostObservation refuses it", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    await expect(
      store.appendCostObservation({
        leaseUuid: LEASE_UUID,
        billedCostAccrued: 60.0,
        billedCostDelta: 28.0,
        predictedCostAtRefresh: null,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 12.0,
        billedBedrockTokenCost: null,
        ttl: elapsed,
      }),
    ).rejects.toThrow(/ttl has already elapsed/);
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(0);
  });

  test("a future ttl writes normally, so the guard is not blanket", async () => {
    mockDynamoClient.on(PutCommand).resolves({});

    const written = await store.appendCostObservation({
      leaseUuid: LEASE_UUID,
      billedCostAccrued: 60.0,
      billedCostDelta: 28.0,
      predictedCostAtRefresh: null,
      latestPeriodStart: "2026-08-11",
      latestPeriodAmount: 12.0,
      billedBedrockTokenCost: null,
      ttl: future,
    });

    expect(written.ttl).toBe(future);
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(1);
  });

  test("a read still returns an expired row, because the sweep lags by up to 48h", async () => {
    // The check is write-time only for this reason: as a TtlSchema refinement it
    // would drop the resume anchor on read and freeze billedCostAccrued -- the very
    // failure it exists to prevent.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [{ ...costRow("COST#2026-08-11T08:00:00.000Z"), ttl: elapsed }],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete).toBe(true);
  });
});

describe("a newer writer's row is not reported as corruption", () => {
  let store: DynamoLeaseCostHistoryStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoLeaseCostHistoryStore({
      client: ddbClient,
      leaseCostHistoryTableName: tableName,
    });
  });

  test("a row only the version gate rejects reports SCHEMA_VERSION_UNSUPPORTED", async () => {
    // createVersionRangeSchema(1, 1) is an exact range, so during any rolling
    // deploy a v2 writer's rows are unreadable here. Collapsed into one reason
    // class, a caller alarming on corruption is paged for every deploy.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        {
          ...costRow("COST#2026-08-11T09:00:00.000Z"),
          meta: { schemaVersion: LeaseCostHistorySchemaVersion + 1 },
        },
      ],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete).toBe(false);
    expect(newest.complete === false && newest.droppedRecordReason).toBe(
      "SCHEMA_VERSION_UNSUPPORTED",
    );
  });

  test("a genuinely malformed row still reports SCHEMA_VALIDATION", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [costRow("COST#2026-08-11T09:00:00Z")],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete).toBe(false);
    expect(newest.complete === false && newest.droppedRecordReason).toBe(
      "SCHEMA_VALIDATION",
    );
  });

  // The rate-feeding read, and the one that gates PREDICTED and
  // RATE enforcement -- so reporting a deploy as corruption here is the false
  // page the two reasons exist to separate. Asserted per read path because the
  // reason was hardcoded on this one while every other path forwarded it.
  test.each([
    [
      "getRecentCostObservations",
      (store: DynamoLeaseCostHistoryStore) =>
        store.getRecentCostObservations(LEASE_UUID, { limit: 25 }),
    ],
    [
      "getNewestCostObservation",
      (store: DynamoLeaseCostHistoryStore) =>
        store.getNewestCostObservation(LEASE_UUID),
    ],
  ])(
    "%s reports the version gate as a deploy, not corruption",
    async (_label, read) => {
      mockDynamoClient.on(QueryCommand).resolves({
        Items: [
          {
            ...costRow("COST#2026-08-11T09:00:00.000Z"),
            meta: { schemaVersion: LeaseCostHistorySchemaVersion + 1 },
          },
        ],
      });

      const result = await read(store);

      expect(result.complete).toBe(false);
      expect(result.complete === false && result.droppedRecordReason).toBe(
        "SCHEMA_VERSION_UNSUPPORTED",
      );
    },
  );

  test("a bumped version PLUS a new attribute is a deploy, not corruption", async () => {
    // The realistic shape, and the one the version-only cases above miss: adding
    // an attribute is the only reason to bump the version, and `.strict()` then
    // reports `unrecognized_keys` at the root alongside `meta.schemaVersion`. A
    // classification inferred from the issue set reads that as corruption.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        {
          ...costRow("COST#2026-08-11T09:00:00.000Z"),
          meta: { schemaVersion: LeaseCostHistorySchemaVersion + 1 },
          someV2Attribute: 1,
        },
      ],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete).toBe(false);
    expect(newest.complete === false && newest.droppedRecordReason).toBe(
      "SCHEMA_VERSION_UNSUPPORTED",
    );
  });

  test("getRecentCostObservations still reports a malformed row as corruption", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [costRow("COST#2026-08-11T09:00:00Z")],
    });

    const recent = await store.getRecentCostObservations(LEASE_UUID, {
      limit: 25,
    });

    expect(recent.complete === false && recent.droppedRecordReason).toBe(
      "SCHEMA_VALIDATION",
    );
  });

  test("an unsupported version wins over shape failures on the same row", async () => {
    // Deliberate, and a correction of an earlier expectation: once the version is
    // past what this reader supports, the reader has no standing to judge the rest
    // of the row -- a later version may legitimately have changed the sort-key form
    // or any other field. Calling that corruption would page an operator for a
    // deploy, which is what the two reasons exist to avoid.
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [
        {
          ...costRow("COST#2026-08-11T09:00:00Z"),
          meta: { schemaVersion: LeaseCostHistorySchemaVersion + 1 },
        },
      ],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete === false && newest.droppedRecordReason).toBe(
      "SCHEMA_VERSION_UNSUPPORTED",
    );
  });

  test("a supported-version row that fails its shape is still corruption", async () => {
    mockDynamoClient.on(QueryCommand).resolves({
      Items: [costRow("COST#2026-08-11T09:00:00Z")],
    });

    const newest = await store.getNewestCostObservation(LEASE_UUID);

    expect(newest.complete === false && newest.droppedRecordReason).toBe(
      "SCHEMA_VALIDATION",
    );
  });
});

describe("breach collisions retry on fresh millisecond keys", () => {
  let store: DynamoLeaseCostHistoryStore;
  let taken: Set<string>;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime("2026-08-11T11:00:00.123Z");
    mockDynamoClient.reset();
    store = new DynamoLeaseCostHistoryStore({
      client: ddbClient,
      leaseCostHistoryTableName: tableName,
    });
    taken = new Set<string>();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  /** What DynamoDB returns for attribute_not_exists(sk) on a live key. */
  function rejectTakenKeys(onCollision?: () => void): void {
    mockDynamoClient.on(PutCommand).callsFake((input) => {
      const sk = input.Item.sk as string;
      if (taken.has(sk)) {
        onCollision?.();
        throw new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        });
      }
      taken.add(sk);
      return {};
    });
  }

  test("a stalled clock advances past the collided millisecond", async () => {
    // Another writer (Lease Monitoring or Token Poll) already owns this
    // millisecond for the lease, and the clock has not moved since.
    taken.add("BREACH#2026-08-11T11:00:00.123Z");
    rejectTakenKeys();

    const written = await store.appendBreachRecord(breachRow());

    expect(written.sk).toBe("BREACH#2026-08-11T11:00:00.124Z");
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(2);
  });

  test("a moving clock retries at the fresh reading, not one past the collision", async () => {
    taken.add("BREACH#2026-08-11T11:00:00.123Z");
    rejectTakenKeys(() => vi.setSystemTime("2026-08-11T11:00:00.457Z"));

    const written = await store.appendBreachRecord(breachRow());

    expect(written.sk).toBe("BREACH#2026-08-11T11:00:00.457Z");
  });

  test("sequential appends in one millisecond each keep a distinct fixed-width key", async () => {
    // Callers await each append, as the threshold service does.
    rejectTakenKeys();

    const first = await store.appendBreachRecord(breachRow());
    const second = await store.appendBreachRecord({
      ...breachRow(),
      thresholdDollars: 90,
    } as any);
    const third = await store.appendBreachRecord({
      ...breachRow(),
      triggeredBy: "DURATION",
      thresholdDollars: null,
      thresholdHoursRemaining: 24,
    } as any);

    expect([first.sk, second.sk, third.sk]).toEqual([
      "BREACH#2026-08-11T11:00:00.123Z",
      "BREACH#2026-08-11T11:00:00.124Z",
      "BREACH#2026-08-11T11:00:00.125Z",
    ]);
  });
});

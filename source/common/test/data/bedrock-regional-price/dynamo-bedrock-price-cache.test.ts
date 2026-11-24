// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { DynamoDBClient } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  BatchWriteCommand,
  DynamoDBDocumentClient,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BedrockRegionalPrice } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import { DynamoBedrockPriceCache } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/dynamo-bedrock-price-cache.js";
import { BatchGetUnprocessedKeysError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDdb = mockClient(ddbClient);

const TABLE_NAME = "test-regional-price-table";
const PROFILE = "apac.anthropic.claude-sonnet-4-20250514-v1:0";
const NOW = new Date("2026-09-28T12:00:00.000Z");
/** 30 days after NOW, in epoch seconds. */
const TTL = NOW.getTime() / 1000 + 30 * 24 * 60 * 60;

const prices = {
  inputPricePer1KTokens: 0.00108,
  outputPricePer1KTokens: 0.00432,
  cacheReadPricePer1KTokens: 0.00027,
  cacheWritePricePer1KTokens: 0.00108,
  pricingSource: "price-list",
  pricingRefreshedAt: "2026-09-28T12:00:00.000Z",
} as const;

const price: BedrockRegionalPrice = {
  modelId: PROFILE,
  region: "ap-southeast-1",
  ...prices,
};

/** The item as the store writes it. */
const item = { ...price, ttl: TTL };

function store() {
  return new DynamoBedrockPriceCache({
    client: ddbClient,
    tableName: TABLE_NAME,
  });
}

beforeEach(() => {
  mockDdb.reset();
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("DynamoBedrockPriceCache", () => {
  it("batch-writes prices keyed by model and region, expiring 30 days after the save", async () => {
    mockDdb.on(BatchWriteCommand).resolves({});

    await store().putPrices([price]);

    const calls = mockDdb.commandCalls(BatchWriteCommand);
    expect(calls).toHaveLength(1);
    expect(calls[0]!.args[0].input.RequestItems).toEqual({
      [TABLE_NAME]: [{ PutRequest: { Item: item } }],
    });
  });

  it("refuses to write a price its schema rejects", async () => {
    await expect(
      store().putPrices([{ ...price, inputPricePer1KTokens: -1 }]),
    ).rejects.toThrow();

    expect(mockDdb.commandCalls(BatchWriteCommand)).toHaveLength(0);
  });

  it("reads the given keys in one request, returning the prices found without their expiry", async () => {
    const novaItem = {
      ...item,
      modelId: "amazon.nova-pro-v1:0",
      region: "eu-west-1",
      inputPricePer1KTokens: 0.00092,
    };
    mockDdb
      .on(BatchGetCommand)
      .resolves({ Responses: { [TABLE_NAME]: [item, novaItem] } });

    const read = await store().getPrices([
      { modelId: PROFILE, region: "ap-southeast-1" },
      { modelId: "amazon.nova-pro-v1:0", region: "eu-west-1" },
      // no price stored, so left out
      { modelId: "amazon.nova-lite-v1:0", region: "eu-west-1" },
    ]);

    expect(read).toEqual([
      price,
      {
        ...price,
        modelId: "amazon.nova-pro-v1:0",
        region: "eu-west-1",
        inputPricePer1KTokens: 0.00092,
      },
    ]);
    const requests = mockDdb.commandCalls(BatchGetCommand);
    expect(requests).toHaveLength(1);
    expect(requests[0]!.args[0].input).toEqual({
      RequestItems: {
        [TABLE_NAME]: {
          Keys: [
            { modelId: PROFILE, region: "ap-southeast-1" },
            { modelId: "amazon.nova-pro-v1:0", region: "eu-west-1" },
            { modelId: "amazon.nova-lite-v1:0", region: "eu-west-1" },
          ],
        },
      },
    });
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("makes no request for no keys", async () => {
    await expect(store().getPrices([])).resolves.toEqual([]);

    expect(mockDdb.commandCalls(BatchGetCommand)).toHaveLength(0);
  });

  it("splits more than 100 keys across requests and returns the prices from every one", async () => {
    const keys = Array.from({ length: 150 }, (_, index) => ({
      modelId: `model-${index}`,
      region: "eu-west-1",
    }));
    const stored = (modelId: string) => ({ ...item, ...keys[0], modelId });
    mockDdb
      .on(BatchGetCommand)
      .resolvesOnce({ Responses: { [TABLE_NAME]: [stored("model-0")] } })
      .resolvesOnce({ Responses: { [TABLE_NAME]: [stored("model-149")] } });

    const read = await store().getPrices(keys);

    expect(read.map((price) => price.modelId)).toEqual([
      "model-0",
      "model-149",
    ]);
    const requests = mockDdb.commandCalls(BatchGetCommand);
    expect(
      requests.map(
        (request) =>
          request.args[0].input.RequestItems![TABLE_NAME]!.Keys!.length,
      ),
    ).toEqual([100, 50]);
  });

  it("requests the keys DynamoDB leaves unprocessed again", async () => {
    vi.useRealTimers();
    const unprocessed = {
      modelId: "amazon.nova-pro-v1:0",
      region: "eu-west-1",
    };
    const novaItem = { ...item, ...unprocessed };
    mockDdb
      .on(BatchGetCommand)
      .resolvesOnce({
        Responses: { [TABLE_NAME]: [item] },
        UnprocessedKeys: { [TABLE_NAME]: { Keys: [unprocessed] } },
      })
      .resolvesOnce({ Responses: { [TABLE_NAME]: [novaItem] } });

    const read = await store().getPrices([
      { modelId: PROFILE, region: "ap-southeast-1" },
      unprocessed,
    ]);

    expect(read).toEqual([price, { ...price, ...unprocessed }]);
    const requests = mockDdb.commandCalls(BatchGetCommand);
    expect(requests).toHaveLength(2);
    expect(requests[1]!.args[0].input.RequestItems![TABLE_NAME]!.Keys).toEqual([
      unprocessed,
    ]);
  });

  it("fails once keys are still unprocessed after the last attempt", async () => {
    vi.useRealTimers();
    const key = { modelId: PROFILE, region: "ap-southeast-1" };
    mockDdb.on(BatchGetCommand).resolves({
      Responses: { [TABLE_NAME]: [] },
      UnprocessedKeys: { [TABLE_NAME]: { Keys: [key] } },
    });

    await expect(store().getPrices([key])).rejects.toBeInstanceOf(
      BatchGetUnprocessedKeysError,
    );
    expect(mockDdb.commandCalls(BatchGetCommand)).toHaveLength(4);
  });

  it.each([
    ["a negative price", { ...item, outputPricePer1KTokens: -1 }],
    ["no refresh time", { ...item, pricingRefreshedAt: undefined }],
    ["an unknown pricing source", { ...item, pricingSource: "guessed" }],
    ["an attribute the schema does not hold", { ...item, enabled: true }],
    ["an empty model ID", { ...item, modelId: "" }],
  ])(
    "drops an item with %s and logs it as a validation warning, keeping the others",
    async (_case, invalid) => {
      mockDdb
        .on(BatchGetCommand)
        .resolves({ Responses: { [TABLE_NAME]: [invalid, item] } });

      const read = await store().getPrices([
        { modelId: PROFILE, region: "ap-southeast-1" },
      ]);

      expect(read).toEqual([price]);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
        expect.objectContaining({
          modelId: invalid.modelId,
          region: invalid.region,
          invalidPaths: expect.any(Array),
          issueCodes: expect.any(Array),
        }),
      );
    },
  );
});

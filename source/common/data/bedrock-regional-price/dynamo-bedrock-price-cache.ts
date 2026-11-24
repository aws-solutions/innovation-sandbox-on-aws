// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { BatchGetCommand, DynamoDBDocumentClient } from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";

import {
  BedrockPriceCache,
  BedrockRegionalPrice,
  BedrockRegionalPriceKey,
  BedrockRegionalPriceSchema,
} from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import { BatchGetUnprocessedKeysError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  batchWriteWithRetry,
  chunk,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { calculateTtlInEpochSeconds } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

const logger = new Logger();

/** The most keys one BatchGetItem request may carry. */
const MAX_KEYS_PER_BATCH_GET = 100;

const MAX_ITEMS_PER_BATCH_WRITE = 25;

/**
 * How long a price is kept after its last save. A refresh saves a price in use
 * again within a day, so a price expires once no lease has used it for this
 * long, or once its refreshes have failed for this long.
 */
const PRICE_TTL_DAYS = 30;

/**
 * {@link BedrockPriceCache} on its own table, keyed by model and then by
 * region, with one item per model and region.
 */
export class DynamoBedrockPriceCache implements BedrockPriceCache {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(props: { client: DynamoDBDocumentClient; tableName: string }) {
    this.client = props.client;
    this.tableName = props.tableName;
  }

  async getPrices(
    keys: BedrockRegionalPriceKey[],
  ): Promise<BedrockRegionalPrice[]> {
    const prices: BedrockRegionalPrice[] = [];
    for (const batch of chunk(keys, MAX_KEYS_PER_BATCH_GET)) {
      const items = await this.batchGet(batch);
      prices.push(...items.flatMap((item) => parsePrice(item) ?? []));
    }
    return prices;
  }

  async putPrices(prices: BedrockRegionalPrice[]): Promise<void> {
    const ttl = calculateTtlInEpochSeconds(PRICE_TTL_DAYS);
    const requests = prices.map((price) => ({
      PutRequest: {
        Item: { ...BedrockRegionalPriceSchema.parse(price), ttl },
      },
    }));
    await batchWriteWithRetry({
      client: this.client,
      tableName: this.tableName,
      batches: chunk(requests, MAX_ITEMS_PER_BATCH_WRITE),
    });
  }

  /** One BatchGetItem request, retrying the keys DynamoDB leaves unprocessed. */
  private async batchGet(
    keys: BedrockRegionalPriceKey[],
  ): Promise<Record<string, unknown>[]> {
    const found: Record<string, unknown>[] = [];
    let pending: Record<string, unknown>[] = keys.map(
      ({ modelId, region }) => ({ modelId, region }),
    );
    await backOff(
      async () => {
        const result = await this.client.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: pending } },
          }),
        );
        found.push(...(result.Responses?.[this.tableName] ?? []));
        const unprocessed = result.UnprocessedKeys?.[this.tableName]?.Keys;
        if (unprocessed !== undefined && unprocessed.length > 0) {
          pending = unprocessed;
          throw new BatchGetUnprocessedKeysError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) =>
          error instanceof BatchGetUnprocessedKeysError,
      },
    );
    return found;
  }
}

/** The item as a price, or undefined where it fails validation. */
function parsePrice(
  item: Record<string, unknown>,
): BedrockRegionalPrice | undefined {
  const { ttl: _ttl, ...price } = item;
  const parsed = BedrockRegionalPriceSchema.safeParse(price);
  if (parsed.success) {
    return parsed.data;
  }
  logger.warn(
    `${LogPatterns.DataValidationWarning.pattern}: dropping a Bedrock regional price that failed schema validation`,
    {
      modelId: item.modelId,
      region: item.region,
      invalidPaths: parsed.error.issues.map((issue) => issue.path.join(".")),
      issueCodes: parsed.error.issues.map((issue) => issue.code),
    },
  );
  return undefined;
}

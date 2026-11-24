// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import type {
  BedrockPriceCache,
  BedrockRegionalPrice,
  BedrockRegionalPriceKey,
} from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import { ModelNotPricedError } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import {
  getStoredModelPrices,
  requireStoredModelPrice,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/model-prices.service.js";

const REGION = "us-east-1";

function price(modelId: string): BedrockRegionalPrice {
  return {
    modelId,
    region: REGION,
    inputPricePer1KTokens: 0.003,
    outputPricePer1KTokens: 0.015,
    cacheReadPricePer1KTokens: 0.0003,
    cacheWritePricePer1KTokens: 0.00375,
    pricingSource: "price-list",
    pricingRefreshedAt: "2026-01-01T00:00:00.000Z",
  };
}

function priceCacheWith(stored: BedrockRegionalPrice[]): BedrockPriceCache {
  return {
    getPrices: vi.fn(async (keys: BedrockRegionalPriceKey[]) =>
      stored.filter((p) =>
        keys.some((k) => k.modelId === p.modelId && k.region === p.region),
      ),
    ),
    putPrices: vi.fn(),
  };
}

describe("getStoredModelPrices", () => {
  it("returns the stored prices by model ID and leaves out unpriced models", async () => {
    const priceCache = priceCacheWith([price("model-a")]);

    const prices = await getStoredModelPrices(
      { modelIds: ["model-a", "model-b"], region: REGION },
      { priceCache },
    );

    expect([...prices.keys()]).toEqual(["model-a"]);
    expect(priceCache.getPrices).toHaveBeenCalledWith([
      { modelId: "model-a", region: REGION },
      { modelId: "model-b", region: REGION },
    ]);
  });
});

describe("requireStoredModelPrice", () => {
  it("returns the stored price", async () => {
    const stored = price("model-a");

    await expect(
      requireStoredModelPrice(
        { modelId: "model-a", region: REGION },
        { priceCache: priceCacheWith([stored]) },
      ),
    ).resolves.toEqual(stored);
  });

  it("throws ModelNotPricedError when the model has no stored price", async () => {
    await expect(
      requireStoredModelPrice(
        { modelId: "model-a", region: REGION },
        { priceCache: priceCacheWith([]) },
      ),
    ).rejects.toBeInstanceOf(ModelNotPricedError);
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { BedrockRegionalPrice } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import {
  GetStoredModelPricesProps,
  ModelNotPricedError,
  RequireStoredModelPriceProps,
  StoredModelPricesServices,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";

/**
 * The stored price of each given model in the region, by model ID. A model
 * with no stored price is left out of the map.
 */
export async function getStoredModelPrices(
  props: GetStoredModelPricesProps,
  services: StoredModelPricesServices,
): Promise<Map<string, BedrockRegionalPrice>> {
  const { modelIds, region } = props;
  const prices = await services.priceCache.getPrices(
    modelIds.map((modelId) => ({ modelId, region })),
  );
  return new Map(prices.map((price) => [price.modelId, price]));
}

/**
 * Reads the model's stored price and requires that there is one: a model with
 * no stored price cannot be billed, so it cannot be enabled. Reads the price
 * table only; it does not fetch a missing price (the models list and the Worker
 * do, and save it).
 *
 * @returns the model's stored price, so the caller need not read it again.
 * @throws ModelNotPricedError when the model has no stored price in the region.
 */
export async function requireStoredModelPrice(
  props: RequireStoredModelPriceProps,
  services: StoredModelPricesServices,
): Promise<BedrockRegionalPrice> {
  const { modelId, region } = props;
  const prices = await getStoredModelPrices(
    { modelIds: [modelId], region },
    services,
  );
  const price = prices.get(modelId);
  if (price === undefined) {
    throw new ModelNotPricedError(
      "Pricing is not available for this model yet, so it cannot be enabled. Reload the model list and try again later.",
    );
  }
  return price;
}

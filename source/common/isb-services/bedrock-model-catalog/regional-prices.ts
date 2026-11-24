// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { BedrockClient } from "@aws-sdk/client-bedrock";
import { DateTime, Duration } from "luxon";

import type {
  BedrockPriceCache,
  BedrockRegionalPrice,
  BedrockRegionalPriceKey,
} from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import {
  BedrockPricingServices,
  DiscoveredModel,
  FetchPricingForModelsResult,
  LiveModelRates,
  PricingModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";
import {
  discoverFoundationModels,
  discoverInferenceProfiles,
  pickDiscoveredModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js";
import {
  fetchPublishedModelRates,
  resolveModelPricing,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js";
import {
  now,
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

/** A model's prices per 1,000 tokens. */
export type ModelPricing = Pick<
  BedrockRegionalPrice,
  | "inputPricePer1KTokens"
  | "outputPricePer1KTokens"
  | "cacheReadPricePer1KTokens"
  | "cacheWritePricePer1KTokens"
  | "pricingSource"
>;

/** A model as used in one region, which is what a price is looked up for. */
export type RegionModel = BedrockRegionalPriceKey;

/**
 * Every price held for each model in each region, keyed by region and then by
 * model. A model with no price is unpriced.
 */
export type ModelPricingLookup = (
  models: RegionModel[],
) => Promise<Map<string, Map<string, ModelPricing>>>;

/** How old a saved price may be before it is refreshed. */
const PRICE_MAX_AGE = Duration.fromObject({ hours: 24 });

/** A model's prices and the time they were fetched. */
export type PricesWithRefreshTime = ModelPricing & {
  pricingRefreshedAt: string;
};

/** One region's prices as a lookup works on them. */
interface RegionPrices {
  region: string;
  /** The models looked up in the region. */
  modelIds: string[];
  /** The looked-up models whose price is missing or stale. */
  toRefresh: string[];
  /** The looked-up models' prices, replaced as prices are fetched. */
  prices: Map<string, PricesWithRefreshTime>;
}

type Logger = BedrockPricingServices["logger"];

export interface RegionalPriceLookupServices {
  /** The DynamoDB cache of every region's prices, read on each run. */
  priceCache: BedrockPriceCache;
  /**
   * Used to fetch prices, only for a price missing from the cache or stale.
   * The Price List client fetches every region.
   */
  pricingServices: Pick<BedrockPricingServices, "pricingClient" | "logger">;
  /**
   * A Bedrock client in the region, to list its models and agreement offers,
   * which are both regional.
   */
  regionalBedrock: (region: string) => BedrockClient;
}

/**
 * Prices models in every region from the price cache. Only a price missing
 * from it or stale is fetched, with the model details that region's Bedrock
 * model list gives, and cached.
 */
export function createRegionalPriceLookup(
  services: RegionalPriceLookupServices,
): ModelPricingLookup {
  const { logger } = services.pricingServices;
  return async (models) => {
    const checkedAt = now();
    const regions = await readCachedPrices(
      models,
      checkedAt,
      services.priceCache,
    );
    for (const regionPrices of regions) {
      await fetchAndCachePrices(regionPrices, services);
    }
    return new Map(
      regions.map((regionPrices) => [
        regionPrices.region,
        pricedModels(regionPrices, checkedAt, logger),
      ]),
    );
  };
}

/** The looked-up models by region, with their cached prices, read in one call. */
async function readCachedPrices(
  models: RegionModel[],
  checkedAt: DateTime,
  priceCache: BedrockPriceCache,
): Promise<RegionPrices[]> {
  const byRegion = new Map<string, Set<string>>();
  for (const { region, modelId } of models) {
    byRegion.set(region, (byRegion.get(region) ?? new Set()).add(modelId));
  }
  const cached = await priceCache.getPrices(
    [...byRegion].flatMap(([region, ids]) =>
      [...ids].map((modelId) => ({ modelId, region })),
    ),
  );
  return [...byRegion].map(([region, ids]) => {
    const modelIds = [...ids];
    const prices = cachedRegionPrices(region, cached);
    const toRefresh = modelIds.filter((modelId) =>
      needsPriceRefresh(prices.get(modelId), checkedAt),
    );
    return { region, modelIds, toRefresh, prices };
  });
}

/** One region's prices, from the cached prices read for its models. */
function cachedRegionPrices(
  region: string,
  cached: BedrockRegionalPrice[],
): RegionPrices["prices"] {
  return new Map<string, PricesWithRefreshTime>(
    cached
      .filter((price) => price.region === region)
      .map((price) => [price.modelId, price]),
  );
}

/**
 * Fetches and caches one region's prices for the models that need a price
 * refresh, in one call. A model is fetched only where the region's Bedrock
 * model list returns it. A fetch that throws saves nothing, and the older
 * prices are used. One whose Price List read stops part way saves only the
 * agreement-offer prices, and the older prices are used for the rest.
 */
async function fetchAndCachePrices(
  regionPrices: RegionPrices,
  services: RegionalPriceLookupServices,
): Promise<void> {
  const { region, toRefresh } = regionPrices;
  if (toRefresh.length === 0) {
    return;
  }
  const regionServices: BedrockPricingServices = {
    ...services.pricingServices,
    bedrockClient: services.regionalBedrock(region),
    region,
  };
  const models = await discoverModelsToRefresh(toRefresh, regionServices);
  await refreshPrices(
    regionPrices,
    models,
    regionServices,
    services.priceCache,
  );
}

/**
 * Fetches the given models' prices and saves them to the price cache, then
 * puts them in place of the stored ones. The models are those of
 * `regionPrices` that need a price refresh, with the details Bedrock lists.
 */
async function refreshPrices(
  regionPrices: RegionPrices,
  models: PricingModel[],
  regionServices: BedrockPricingServices,
  priceCache: BedrockPriceCache,
): Promise<void> {
  if (models.length === 0) {
    return;
  }
  const fetched = await tryFetchPrices(models, regionServices);
  if (fetched === undefined) {
    return;
  }
  const replaced = replacePrices(
    regionPrices,
    fetched.models,
    fetched.rates,
    regionServices.logger,
  );
  await cachePrices(
    regionPrices.region,
    replaced,
    priceCache,
    regionServices.logger,
  );
}

/**
 * Prices models that are already discovered, in the services' own region,
 * from the price cache. A price under 24 hours old is used as it is; the
 * missing or stale ones are fetched and saved. Unlike
 * {@link createRegionalPriceLookup}, the models are not listed from Bedrock
 * again.
 *
 * Returns each priced model's price and the time it was fetched. A model with
 * no cached price whose fetch found none is left out, and the caller decides
 * what to show for it.
 */
export async function priceDiscoveredModels(
  models: DiscoveredModel[],
  services: {
    priceCache: BedrockPriceCache;
    pricingServices: BedrockPricingServices;
  },
): Promise<Map<string, PricesWithRefreshTime>> {
  const { priceCache, pricingServices } = services;
  const { region } = pricingServices;
  const [regionPrices] = await readCachedPrices(
    models.map(({ modelId }) => ({ modelId, region })),
    now(),
    priceCache,
  );
  if (regionPrices === undefined) {
    return new Map();
  }
  const toRefresh = new Set(regionPrices.toRefresh);
  await refreshPrices(
    regionPrices,
    models.filter(({ modelId }) => toRefresh.has(modelId)),
    pricingServices,
    priceCache,
  );
  return regionPrices.prices;
}

/**
 * Puts the fetched prices in place of the stored ones and returns those it
 * replaced, which are used this run whether or not they save. A model the
 * fetch has no input or output price for is left as it was, so with no stored
 * price it stays unpriced and the next run fetches it again.
 */
function replacePrices(
  regionPrices: RegionPrices,
  models: PricingModel[],
  fetched: Map<string, LiveModelRates>,
  logger: Logger,
): Map<string, PricesWithRefreshTime> {
  const pricingRefreshedAt = nowAsIsoDatetimeString();
  const replaced = new Map<string, PricesWithRefreshTime>();
  const unpriced: string[] = [];
  for (const { modelId } of models) {
    const resolved = resolveModelPricing(fetched.get(modelId));
    if (!resolved) {
      unpriced.push(modelId);
      continue;
    }
    const pricing: PricesWithRefreshTime = { ...resolved, pricingRefreshedAt };
    regionPrices.prices.set(modelId, pricing);
    replaced.set(modelId, pricing);
  }
  if (unpriced.length > 0) {
    logger.warn(
      "the fetch lacked an input or an output price for these models; saving nothing for them and fetching them again next run",
      { region: regionPrices.region, modelIds: unpriced },
    );
  }
  return replaced;
}

/** Saves a region's fetched prices together through the cache's batch-write API. */
async function cachePrices(
  region: string,
  replaced: Map<string, PricesWithRefreshTime>,
  priceCache: BedrockPriceCache,
  logger: Logger,
): Promise<void> {
  const prices = [...replaced].map(([modelId, prices]) => ({
    region,
    modelId,
    ...prices,
  }));
  try {
    await priceCache.putPrices(prices);
  } catch (error) {
    logger.warn(
      "could not save fetched model prices to the price cache; using them this run",
      { region, modelIds: prices.map(({ modelId }) => modelId), error },
    );
  }
}

/**
 * The region's Bedrock details for its models that need a price refresh. If
 * listing the region's Bedrock models fails, none is fetched there, and the
 * older prices are used.
 */
async function discoverModelsToRefresh(
  modelIds: string[],
  services: BedrockPricingServices,
): Promise<DiscoveredModel[]> {
  try {
    return await discoverModels(new Set(modelIds), services);
  } catch (error) {
    services.logger.warn(
      "could not list Bedrock's models in the region; fetching no prices there this run and using the older stored prices where there are any",
      { region: services.region, modelIds, error },
    );
    return [];
  }
}

/**
 * Finds the wanted models among the region's Bedrock foundation models, then
 * the rest among its inference profiles. A model in neither list is not
 * fetched.
 */
async function discoverModels(
  wanted: Set<string>,
  { bedrockClient, logger, region }: BedrockPricingServices,
): Promise<DiscoveredModel[]> {
  const foundationModels = await discoverFoundationModels(bedrockClient);
  const found = foundationModels.filter((model) => wanted.has(model.modelId));
  const notFoundationModels = missingFrom(found, wanted);
  if (notFoundationModels.length === 0) {
    return found.map(pickDiscoveredModel);
  }
  let profiles: DiscoveredModel[];
  try {
    profiles = (
      await discoverInferenceProfiles(bedrockClient, foundationModels, logger)
    ).filter((model) => wanted.has(model.modelId));
  } catch (error) {
    logger.warn(
      "could not list Bedrock's inference profiles; fetching only the models among the foundation models and using the older stored prices for the rest where there are any",
      { region, modelIds: notFoundationModels, error },
    );
    return found.map(pickDiscoveredModel);
  }
  const unlisted = missingFrom(profiles, notFoundationModels);
  if (unlisted.length > 0) {
    logger.info(
      "fetching no price for these models: Bedrock does not list them in the region",
      { region, modelIds: unlisted },
    );
  }
  return [...found, ...profiles].map(pickDiscoveredModel);
}

/** The given IDs that none of the models has. */
function missingFrom(
  models: DiscoveredModel[],
  modelIds: Iterable<string>,
): string[] {
  const found = new Set(models.map((model) => model.modelId));
  return [...modelIds].filter((modelId) => !found.has(modelId));
}

/**
 * The models to price from the fetch and their fetched rates, or undefined
 * where the fetch threw. Where the Price List read stopped part way, its rates
 * can be lower than the real ones, so only the agreement-offer rates, which
 * come from a separate call, are kept, and the other models are left as on a
 * failed fetch.
 */
async function tryFetchPrices(
  models: PricingModel[],
  services: BedrockPricingServices,
): Promise<
  { models: PricingModel[]; rates: Map<string, LiveModelRates> } | undefined
> {
  const failure = {
    region: services.region,
    modelIds: models.map((model) => model.modelId),
  };
  let fetched: FetchPricingForModelsResult;
  try {
    fetched = await fetchPublishedModelRates({ models }, services);
  } catch (error) {
    services.logger.warn(
      "model price fetch failed; using the older stored prices where there are any",
      { ...failure, error },
    );
    return undefined;
  }
  if (!fetched.priceListComplete) {
    services.logger.warn(
      "the Price List read stopped part way, so its prices may be low; keeping only the agreement-offer prices and using the older stored prices for the rest where there are any",
      failure,
    );
    const rates = new Map(
      [...fetched.rates].filter(
        ([, rate]) => rate.pricingSource === "agreement-offers",
      ),
    );
    return {
      models: models.filter((model) => rates.has(model.modelId)),
      rates,
    };
  }
  return { models, rates: fetched.rates };
}

/** A model with no stored price, or one more than a day old, is fetched. */
function needsPriceRefresh(
  stored: PricesWithRefreshTime | undefined,
  checkedAt: DateTime,
): boolean {
  return stored === undefined || isOutdated(stored, checkedAt);
}

/** True where the price is more than a day old. */
function isOutdated(
  prices: PricesWithRefreshTime,
  checkedAt: DateTime,
): boolean {
  const refreshedAt = parseDatetime(prices.pricingRefreshedAt);
  return !refreshedAt.isValid || refreshedAt < checkedAt.minus(PRICE_MAX_AGE);
}

/**
 * The region's looked-up models that have a price, each with its price. A
 * price that is old or may have been filled in from the input price is logged.
 */
function pricedModels(
  regionPrices: RegionPrices,
  checkedAt: DateTime,
  logger: Logger,
): Map<string, ModelPricing> {
  const { modelIds, prices } = regionPrices;
  const priced = modelIds.filter((modelId) => prices.has(modelId));
  logOutdatedPrices(regionPrices, priced, checkedAt, logger);
  logPricesEqualToInputPrice(regionPrices, priced, logger);
  return new Map(
    priced.map((modelId) => [modelId, pickModelPricing(prices.get(modelId)!)]),
  );
}

function logOutdatedPrices(
  { region, prices }: RegionPrices,
  modelIds: string[],
  checkedAt: DateTime,
  logger: Logger,
): void {
  const outdated = modelIds.filter((modelId) => {
    const found = prices.get(modelId)!;
    return isOutdated(found, checkedAt);
  });
  if (outdated.length > 0) {
    logger.info(
      "no complete newer price was fetched; pricing these models from stored prices more than a day old",
      {
        region,
        models: outdated.map((modelId) => ({
          modelId,
          pricingRefreshedAt: prices.get(modelId)!.pricingRefreshedAt,
        })),
      },
    );
  }
}

/**
 * Logs prices equal to the input price, which may have been filled in from it
 * and so be wrong. Some models do charge the same, so the price is still used.
 */
function logPricesEqualToInputPrice(
  { region, prices }: RegionPrices,
  modelIds: string[],
  logger: Logger,
): void {
  const equalToInput = modelIds.flatMap((modelId) => {
    const found = prices.get(modelId)!;
    const tokenTypes = (
      [
        ["output", found.outputPricePer1KTokens],
        ["cacheRead", found.cacheReadPricePer1KTokens],
        ["cacheWrite", found.cacheWritePricePer1KTokens],
      ] as const
    )
      .filter(([, price]) => price === found.inputPricePer1KTokens)
      .map(([tokenType]) => tokenType);
    return tokenTypes.length === 0 ? [] : [{ modelId, tokenTypes }];
  });
  if (equalToInput.length > 0) {
    logger.info(
      "these models' prices equal their input price and may have been filled in from it",
      { region, models: equalToInput },
    );
  }
}

/**
 * A price's rates and source, without its refresh time. The one place that
 * lists the rate fields, so a new rate is added here.
 */
export function pickModelPricing(
  price: Pick<BedrockRegionalPrice, keyof ModelPricing>,
): ModelPricing {
  return {
    inputPricePer1KTokens: price.inputPricePer1KTokens,
    outputPricePer1KTokens: price.outputPricePer1KTokens,
    cacheReadPricePer1KTokens: price.cacheReadPricePer1KTokens,
    cacheWritePricePer1KTokens: price.cacheWritePricePer1KTokens,
    pricingSource: price.pricingSource,
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { BedrockClient } from "@aws-sdk/client-bedrock";
import { PricingClient } from "@aws-sdk/client-pricing";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BedrockPriceCache,
  BedrockRegionalPrice,
  BedrockRegionalPriceSchema,
} from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import type {
  BedrockPricingServices,
  DiscoveredFoundationModel,
  DiscoveredInferenceProfile,
  DiscoveredModel,
  LiveModelRates,
  PricingModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";
import {
  discoverFoundationModels,
  discoverInferenceProfiles,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js";
import { fetchPublishedModelRates } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js";
import {
  createRegionalPriceLookup,
  ModelPricing,
  priceDiscoveredModels,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/regional-prices.js";

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js")
    >()),
    discoverFoundationModels: vi.fn(),
    discoverInferenceProfiles: vi.fn(),
  }),
);
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js")
    >()),
    fetchPublishedModelRates: vi.fn(),
  }),
);
/**
 * The rates the next fetch returns, by model. The price-fetching mock reports a
 * complete Price List read with these rates, unless a test says otherwise.
 */
const mockFetchRates =
  vi.fn<
    (
      props: { models: PricingModel[] },
      services: BedrockPricingServices,
    ) => Promise<Map<string, LiveModelRates>>
  >();

const PROFILE = "us.anthropic.claude-haiku-4-5-20251001-v1:0";
const HAIKU = "anthropic.claude-haiku-4-5-20251001-v1:0";
const NOVA = "amazon.nova-pro-v1:0";
const NOW = new Date("2026-09-28T12:00:00.000Z");
const hoursAgo = (hours: number) =>
  new Date(NOW.getTime() - hours * 60 * 60 * 1000).toISOString();

const prices: ModelPricing = {
  inputPricePer1KTokens: 0.001,
  outputPricePer1KTokens: 0.005,
  cacheReadPricePer1KTokens: 0.0001,
  cacheWritePricePer1KTokens: 0.00125,
  pricingSource: "agreement-offers",
};

/** What the fetch returns for a model it prices. */
const live: LiveModelRates = {
  input: 0.002,
  output: 0.01,
  cacheRead: 0.0002,
  cacheWrite: 0.0025,
  pricingSource: "price-list",
};

/** `live` as the lookup returns it. */
const fetchedPrices: ModelPricing = {
  inputPricePer1KTokens: 0.002,
  outputPricePer1KTokens: 0.01,
  cacheReadPricePer1KTokens: 0.0002,
  cacheWritePricePer1KTokens: 0.0025,
  pricingSource: "price-list",
};

/** `live` as a rate from the agreement-offer call. */
const offerRates: LiveModelRates = {
  ...live,
  pricingSource: "agreement-offers",
};

/** `offerRates` as the lookup returns it. */
const offerPrices: ModelPricing = {
  ...fetchedPrices,
  pricingSource: "agreement-offers",
};

/** `fetchedPrices` at another input price. */
const pricedAt = (input: number): ModelPricing => ({
  ...fetchedPrices,
  inputPricePer1KTokens: input,
});

const novaModel: DiscoveredModel = {
  modelId: NOVA,
  displayName: "Nova Pro",
  provider: "Amazon",
  availability: "global",
  modelType: "foundation-model",
  foundationModelId: NOVA,
  foundationModelName: "Nova Pro",
};

const profileModel: DiscoveredModel = {
  modelId: PROFILE,
  displayName: "US Anthropic Claude Haiku 4.5",
  provider: "Anthropic",
  availability: "us",
  description: "Routes requests to Claude Haiku 4.5 in US regions.",
  modelType: "inference-profile",
  foundationModelId: HAIKU,
  foundationModelName: "Claude Haiku 4.5",
};

/** A foundation model Bedrock lists, named for its ID. */
const foundationModel = (modelId: string): DiscoveredModel => ({
  ...novaModel,
  modelId,
  displayName: modelId,
  foundationModelId: modelId,
  foundationModelName: modelId,
});

/** This Lambda's own region, the hub region. */
const HUB = "us-east-1";
const APSE1 = "ap-southeast-1";
const EUW1 = "eu-west-1";

/** What the lookup is built with besides each region's Bedrock client. */
const lookupServices = {
  pricingClient: new PricingClient({}),
  logger: new Logger(),
};

/** One Bedrock client per region, the same one each time it is asked for. */
const bedrockClients = new Map<string, BedrockClient>();
const bedrockClientIn = (region: string): BedrockClient => {
  const client = bedrockClients.get(region) ?? new BedrockClient({ region });
  bedrockClients.set(region, client);
  return client;
};

/** What the fetch is given for a region: that region's own Bedrock client. */
/** What Bedrock's model list returns for a model the agent could use. */
const asFoundation = (model: DiscoveredModel): DiscoveredFoundationModel => ({
  ...model,
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  inferenceTypesSupported: ["ON_DEMAND"],
});

const asProfile = (model: DiscoveredModel): DiscoveredInferenceProfile => ({
  ...model,
  status: "ACTIVE",
  profileType: "SYSTEM_DEFINED",
  routedModelIds: [model.foundationModelId],
});

const pricingServicesIn = (region: string): BedrockPricingServices => ({
  ...lookupServices,
  bedrockClient: bedrockClientIn(region),
  region,
});

/** What the fetch is given for the hub region. */
const pricingServices = pricingServicesIn(HUB);

/**
 * A cache price store that, as the real one does, returns only the prices
 * asked for and refuses a write its schema rejects.
 */
function priceCacheHolding(stored: BedrockRegionalPrice[]) {
  const putPrice = vi.fn(async (price: BedrockRegionalPrice) => {
    BedrockRegionalPriceSchema.parse(price);
  });
  return {
    getPrices: vi.fn<BedrockPriceCache["getPrices"]>(async (keys) =>
      stored.filter((price) =>
        keys.some(
          (key) => key.modelId === price.modelId && key.region === price.region,
        ),
      ),
    ),
    putPrices: vi.fn<BedrockPriceCache["putPrices"]>(async (prices) => {
      await Promise.all(prices.map((price) => putPrice(price)));
    }),
    putPrice,
  };
}

/** A price saved for the region an hour ago. */
const regionalPrice = (
  region: string,
  modelId: string,
  fields: Partial<BedrockRegionalPrice> = {},
): BedrockRegionalPrice => ({
  region,
  modelId,
  ...prices,
  pricingRefreshedAt: hoursAgo(1),
  ...fields,
});

/** A price as the lookup saves it to the cache prices. */
const savedIn = (
  region: string,
  modelId: string,
  pricing: ModelPricing = fetchedPrices,
) => ({ region, modelId, ...pricing, pricingRefreshedAt: NOW.toISOString() });

function priceModels(priceCache: BedrockPriceCache, models: RegionModel[]) {
  return createRegionalPriceLookup({
    priceCache: priceCache,
    pricingServices: lookupServices,
    regionalBedrock: bedrockClientIn,
  })(models);
}

/** Looks the models up as used in the hub region, returning that region's prices. */
function lookup(priceCache: BedrockPriceCache) {
  return async (modelIds: string[]) => {
    const priced = await priceModels(
      priceCache,
      modelIds.map((modelId) => ({ region: HUB, modelId })),
    );
    return priced.get(HUB) ?? new Map<string, ModelPricing>();
  };
}

/** A fetch that prices every model it is given at `live`. */
function fetchPricesEveryModel() {
  vi.mocked(mockFetchRates).mockImplementation(
    async ({ models }) => new Map(models.map((model) => [model.modelId, live])),
  );
}

function bedrockLists(
  foundationModels: DiscoveredModel[],
  profiles: DiscoveredModel[] = [],
) {
  vi.mocked(discoverFoundationModels).mockResolvedValue(
    foundationModels.map(asFoundation),
  );
  vi.mocked(discoverInferenceProfiles).mockResolvedValue(
    profiles.map(asProfile),
  );
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
  vi.mocked(mockFetchRates).mockReset().mockResolvedValue(new Map());
  // The lookup fetches through fetchPublishedModelRates. Unless a test
  // says otherwise, it reports a complete Price List read and returns what
  // mockFetchRates is set up to.
  vi.mocked(fetchPublishedModelRates)
    .mockReset()
    .mockImplementation(async (props, services) => ({
      rates: await mockFetchRates(props, services),
      priceListComplete: true,
    }));
  vi.mocked(discoverFoundationModels).mockReset();
  vi.mocked(discoverInferenceProfiles).mockReset();
  bedrockLists([]);
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("createRegionalPriceLookup", () => {
  it("prices from the price cache without listing, fetching or saving while every price is a day old or less", async () => {
    const cache = priceCacheHolding([
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(24) }),
      regionalPrice(HUB, NOVA),
    ]);

    const priced = await lookup(cache)([PROFILE, NOVA]);

    expect(priced).toEqual(
      new Map([
        [PROFILE, prices],
        [NOVA, prices],
      ]),
    );
    expect(discoverFoundationModels).not.toHaveBeenCalled();
    expect(mockFetchRates).not.toHaveBeenCalled();
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("fetches stale and missing prices with the details Bedrock lists, then saves and prices from them", async () => {
    fetchPricesEveryModel();
    bedrockLists([novaModel], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, "fresh"),
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(25) }),
      // stale, but not looked up, so neither fetched nor saved
      regionalPrice(HUB, "unrequested", { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)(["fresh", PROFILE, NOVA]);

    // Bedrock's model list supplies what the fetch matches Price List rows on
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [novaModel, profileModel] }, pricingServices],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([
      [savedIn(HUB, NOVA)],
      [savedIn(HUB, PROFILE)],
    ]);
    expect(priced.get("fresh")).toEqual(prices);
    expect(priced.get(PROFILE)).toEqual(fetchedPrices);
    expect(priced.get(NOVA)).toEqual(fetchedPrices);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
    expect(Logger.prototype.info).not.toHaveBeenCalled();
  });

  it("fetches and saves a price whose refresh time does not parse", async () => {
    fetchPricesEveryModel();
    bedrockLists([novaModel]);
    // The cache price store drops such a price on read; this checks the
    // lookup's own guard.
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: "not-a-date" }),
    ]);

    const priced = await lookup(cache)([NOVA]);

    expect(mockFetchRates).toHaveBeenCalledTimes(1);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
    expect(priced.get(NOVA)).toEqual(fetchedPrices);
  });

  it("fetches a model Bedrock lists as a foundation model without listing the inference profiles, and saves and prices from its fetched price", async () => {
    fetchPricesEveryModel();
    bedrockLists([foundationModel("amazon.nova-lite-v1:0"), novaModel]);
    const cache = priceCacheHolding([]);

    const priced = await lookup(cache)([NOVA]);

    expect(discoverFoundationModels).toHaveBeenCalledWith(
      pricingServices.bedrockClient,
    );
    expect(discoverInferenceProfiles).not.toHaveBeenCalled();
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [novaModel] }, pricingServices],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
    expect(priced.get(NOVA)).toEqual(fetchedPrices);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("finds a model among Bedrock's inference profiles where it is not a foundation model", async () => {
    fetchPricesEveryModel();
    vi.mocked(discoverFoundationModels).mockResolvedValue([
      asFoundation(novaModel),
    ]);
    vi.mocked(discoverInferenceProfiles).mockResolvedValue(
      [
        {
          ...profileModel,
          modelId: "eu.anthropic.claude-haiku-4-5-20251001-v1:0",
        },
        profileModel,
      ].map(asProfile),
    );
    const cache = priceCacheHolding([]);

    const priced = await lookup(cache)([PROFILE]);

    expect(discoverInferenceProfiles).toHaveBeenCalledWith(
      pricingServices.bedrockClient,
      [asFoundation(novaModel)],
      pricingServices.logger,
    );
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [profileModel] }, pricingServices],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, PROFILE)]]);
    expect(priced.get(PROFILE)).toEqual(fetchedPrices);
  });

  it("logs and does not fetch a model Bedrock does not list, pricing it from its older stored price where it has one", async () => {
    fetchPricesEveryModel();
    bedrockLists([novaModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
      regionalPrice(HUB, "unlisted-priced.model-v1:0", {
        pricingRefreshedAt: hoursAgo(48),
      }),
    ]);

    const priced = await lookup(cache)([
      NOVA,
      "unlisted-priced.model-v1:0",
      "unlisted.model-v1:0",
    ]);

    expect(discoverInferenceProfiles).toHaveBeenCalled();
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [novaModel] }, pricingServices],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
    expect(priced.get(NOVA)).toEqual(fetchedPrices);
    expect(priced.get("unlisted-priced.model-v1:0")).toEqual(prices);
    expect(priced.has("unlisted.model-v1:0")).toBe(false);
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("Bedrock does not list them"),
      {
        region: HUB,
        modelIds: ["unlisted-priced.model-v1:0", "unlisted.model-v1:0"],
      },
    );
  });

  it("does not fetch at all where Bedrock lists none of the models that need a price refresh", async () => {
    const cache = priceCacheHolding([regionalPrice(HUB, NOVA)]);

    const priced = await lookup(cache)([NOVA, "unlisted.model-v1:0"]);

    expect(mockFetchRates).not.toHaveBeenCalled();
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced).toEqual(new Map([[NOVA, prices]]));
  });

  it("fetches nothing where listing Bedrock's models fails, pricing from the older prices and leaving a model with none unpriced", async () => {
    fetchPricesEveryModel();
    vi.mocked(discoverFoundationModels).mockRejectedValue(
      new Error("ListFoundationModels throttled"),
    );
    const cache = priceCacheHolding([
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)([PROFILE, NOVA]);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not list Bedrock's models"),
      expect.objectContaining({ region: HUB, modelIds: [PROFILE, NOVA] }),
    );
    expect(mockFetchRates).not.toHaveBeenCalled();
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced).toEqual(new Map([[PROFILE, prices]]));
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("more than a day old"),
      {
        region: HUB,
        models: [{ modelId: PROFILE, pricingRefreshedAt: hoursAgo(48) }],
      },
    );
  });

  it("keeps a stale real price the fetch returns nothing or only a partial rate for, unsaved, and logs it", async () => {
    // an input rate but no output rate, which resolveModelPricing leaves unpriced
    vi.mocked(mockFetchRates).mockResolvedValue(
      new Map([[PROFILE, { ...live, output: 0 }]]),
    );
    bedrockLists([novaModel], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)([NOVA, PROFILE]);

    expect(mockFetchRates).toHaveBeenCalledTimes(1);
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced).toEqual(
      new Map([
        [NOVA, prices],
        [PROFILE, prices],
      ]),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("more than a day old"),
      {
        region: HUB,
        models: [
          { modelId: NOVA, pricingRefreshedAt: hoursAgo(48) },
          { modelId: PROFILE, pricingRefreshedAt: hoursAgo(48) },
        ],
      },
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetching them again next run"),
      { region: HUB, modelIds: [NOVA, PROFILE] },
    );
  });

  it("saves nothing for a model with no stored price that the fetch returns nothing for, leaving it unpriced and fetching it again on the next run", async () => {
    bedrockLists([novaModel]);
    const cache = priceCacheHolding([]);

    const priced = await lookup(cache)([NOVA]);

    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced.has(NOVA)).toBe(false);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetching them again next run"),
      { region: HUB, modelIds: [NOVA] },
    );

    await lookup(cache)([NOVA]);

    expect(mockFetchRates).toHaveBeenCalledTimes(2);
  });

  it("saves nothing where the fetch throws, pricing from the older prices and leaving a model with none unpriced", async () => {
    vi.mocked(mockFetchRates).mockRejectedValue(
      new Error("GetProducts failed"),
    );
    bedrockLists([novaModel], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)([PROFILE, NOVA]);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("fetch failed"),
      expect.objectContaining({ region: HUB, modelIds: [NOVA, PROFILE] }),
    );
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced).toEqual(new Map([[PROFILE, prices]]));
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("more than a day old"),
      {
        region: HUB,
        models: [{ modelId: PROFILE, pricingRefreshedAt: hoursAgo(48) }],
      },
    );
  });

  it("saves and prices from only the agreement-offer prices where the Price List read stopped part way, pricing the rest from the older prices and saving nothing for them", async () => {
    vi.mocked(fetchPublishedModelRates).mockResolvedValue({
      rates: new Map([
        ["offer-priced", offerRates],
        // read from part of the Price List
        [PROFILE, { ...live, input: 0.0001 }],
        [NOVA, live],
      ]),
      priceListComplete: false,
    });
    bedrockLists([foundationModel("offer-priced"), novaModel], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, "offer-priced", { pricingRefreshedAt: hoursAgo(48) }),
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)(["offer-priced", PROFILE, NOVA]);

    expect(cache.putPrice.mock.calls).toEqual([
      [savedIn(HUB, "offer-priced", offerPrices)],
    ]);
    expect(priced).toEqual(
      new Map([
        ["offer-priced", offerPrices],
        [PROFILE, prices],
      ]),
    );
    // the only warning
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringMatching(
        /^the Price List read stopped part way.*only the agreement-offer prices/,
      ),
      { region: HUB, modelIds: ["offer-priced", NOVA, PROFILE] },
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("more than a day old"),
      {
        region: HUB,
        models: [{ modelId: PROFILE, pricingRefreshedAt: hoursAgo(48) }],
      },
    );
  });

  it("still prices from a fetched price the price cache would not save, and logs the model", async () => {
    fetchPricesEveryModel();
    bedrockLists([novaModel]);
    const cache = priceCacheHolding([]);
    const error = new Error("ProvisionedThroughputExceeded");
    cache.putPrice.mockRejectedValue(error);

    const priced = await lookup(cache)([NOVA]);

    expect(priced.get(NOVA)).toEqual(fetchedPrices);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not save"),
      { region: HUB, modelIds: [NOVA], error },
    );
  });

  it("saves fetched prices in one batch", async () => {
    fetchPricesEveryModel();
    bedrockLists([novaModel], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    await lookup(cache)([PROFILE, NOVA]);

    expect(cache.putPrices.mock.calls).toEqual([
      [[savedIn(HUB, NOVA), savedIn(HUB, PROFILE)]],
    ]);
  });

  it("keeps a stale real price with a $0 input price that the fetch returns nothing for", async () => {
    bedrockLists([novaModel]);
    const free = { ...prices, inputPricePer1KTokens: 0 };
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { ...free, pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)([NOVA]);

    expect(mockFetchRates).toHaveBeenCalledTimes(1);
    expect(cache.putPrice).not.toHaveBeenCalled();
    expect(priced.get(NOVA)).toEqual(free);
  });

  it("prices a found foundation model even when listing the inference profiles fails, leaving the profile unpriced", async () => {
    fetchPricesEveryModel();
    vi.mocked(discoverFoundationModels).mockResolvedValue([
      asFoundation(novaModel),
    ]);
    vi.mocked(discoverInferenceProfiles).mockRejectedValue(
      new Error("ListInferenceProfiles throttled"),
    );
    const cache = priceCacheHolding([]);

    const priced = await lookup(cache)([NOVA, PROFILE]);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not list Bedrock's inference profiles"),
      expect.objectContaining({ modelIds: [PROFILE] }),
    );
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
    expect(priced.get(NOVA)).toEqual(fetchedPrices);
    expect(priced.has(PROFILE)).toBe(false);
    // the profiles were never listed, so the profile is not logged as unlisted
    expect(Logger.prototype.info).not.toHaveBeenCalledWith(
      expect.stringContaining("Bedrock does not list them"),
      expect.anything(),
    );
  });

  it("reads the price cache on every run, holding no price across runs", async () => {
    const cache = priceCacheHolding([regionalPrice(HUB, NOVA)]);
    const priceModelsInHub = lookup(cache);

    expect((await priceModelsInHub([NOVA])).get(NOVA)).toEqual(prices);

    const higherPrices = { ...prices, inputPricePer1KTokens: 0.009 };
    cache.getPrices.mockResolvedValue([regionalPrice(HUB, NOVA, higherPrices)]);

    expect((await priceModelsInHub([NOVA])).get(NOVA)).toEqual(higherPrices);
    expect(cache.getPrices).toHaveBeenCalledTimes(2);
  });

  it("matches a model on its exact ID, not on the model an inference profile routes to", async () => {
    const cache = priceCacheHolding([
      regionalPrice(HUB, HAIKU, { inputPricePer1KTokens: 0.009 }),
    ]);

    const priced = await lookup(cache)([PROFILE]);

    expect(priced.has(PROFILE)).toBe(false);
    expect(discoverFoundationModels).toHaveBeenCalled();
    expect(mockFetchRates).not.toHaveBeenCalled();
  });

  it("passes a real $0 price through as a price, not as missing", async () => {
    const free = { ...prices, cacheWritePricePer1KTokens: 0 };
    const cache = priceCacheHolding([regionalPrice(HUB, NOVA, free)]);

    const priced = await lookup(cache)([NOVA]);

    expect(priced.get(NOVA)).toEqual(free);
  });

  it("uses an output, cache-read or cache-write price equal to the input price, and logs the model and token types", async () => {
    // each model has one price equal to its input price, the rest distinct
    const equalToInput = {
      output: { ...prices, outputPricePer1KTokens: 0.001 },
      cacheRead: { ...prices, cacheReadPricePer1KTokens: 0.001 },
      cacheWrite: { ...prices, cacheWritePricePer1KTokens: 0.001 },
    };
    const cache = priceCacheHolding(
      Object.entries(equalToInput).map(([modelId, fields]) =>
        regionalPrice(HUB, modelId, fields),
      ),
    );

    const priced = await lookup(cache)(Object.keys(equalToInput));

    for (const [modelId, fields] of Object.entries(equalToInput)) {
      expect(priced.get(modelId)).toEqual(fields);
    }
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("equal their input price"),
      {
        region: HUB,
        models: [
          { modelId: "output", tokenTypes: ["output"] },
          { modelId: "cacheRead", tokenTypes: ["cacheRead"] },
          { modelId: "cacheWrite", tokenTypes: ["cacheWrite"] },
        ],
      },
    );
  });

  it("replaces a stale price with the fetched one even where the fetch has no cache price, filling that price in from the input price", async () => {
    vi.mocked(mockFetchRates).mockResolvedValue(
      new Map([[NOVA, { ...live, cacheRead: 0 }]]),
    );
    bedrockLists([novaModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await lookup(cache)([NOVA]);

    const filledIn = {
      ...fetchedPrices,
      cacheReadPricePer1KTokens: live.input,
    };
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA, filledIn)]]);
    expect(priced.get(NOVA)).toEqual(filledIn);
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("equal their input price"),
      { region: HUB, models: [{ modelId: NOVA, tokenTypes: ["cacheRead"] }] },
    );
  });

  it("does not log a model that did not need a price refresh as priced from an old price when it turns a day old while the fetch runs", async () => {
    vi.mocked(mockFetchRates).mockImplementation(async ({ models }) => {
      vi.setSystemTime(NOW.getTime() + 60_000);
      return new Map(models.map((model) => [model.modelId, live]));
    });
    bedrockLists([], [profileModel]);
    const cache = priceCacheHolding([
      regionalPrice(HUB, PROFILE, { pricingRefreshedAt: hoursAgo(48) }),
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(24) }),
    ]);

    const priced = await lookup(cache)([PROFILE, NOVA]);

    expect(mockFetchRates).toHaveBeenCalledTimes(1);
    expect(priced.get(NOVA)).toEqual(prices);
    expect(Logger.prototype.info).not.toHaveBeenCalled();
  });

  it("prices a model used in two regions at each region's own stored price", async () => {
    const cache = priceCacheHolding([
      regionalPrice(APSE1, NOVA, pricedAt(0.00108)),
      regionalPrice(EUW1, NOVA, pricedAt(0.00092)),
    ]);

    const priced = await priceModels(cache, [
      { region: APSE1, modelId: NOVA },
      { region: EUW1, modelId: NOVA },
    ]);

    expect(priced).toEqual(
      new Map([
        [APSE1, new Map([[NOVA, pricedAt(0.00108)]])],
        [EUW1, new Map([[NOVA, pricedAt(0.00092)]])],
      ]),
    );
    expect(mockFetchRates).not.toHaveBeenCalled();
  });

  it("reads the price cache once, then lists each region's Bedrock models with that region's client and fetches once per region at its own prices, saving every region's to the price cache", async () => {
    const inputByRegion: Record<string, number> = {
      [HUB]: 0.0008,
      [APSE1]: 0.00108,
      [EUW1]: 0.00092,
    };
    vi.mocked(mockFetchRates).mockImplementation(
      async ({ models }, { region }) =>
        new Map(
          models.map((model) => [
            model.modelId,
            { ...live, input: inputByRegion[region]! },
          ]),
        ),
    );
    bedrockLists([novaModel], [profileModel]);
    const cache = priceCacheHolding([]);

    const priced = await priceModels(cache, [
      { region: HUB, modelId: PROFILE },
      { region: APSE1, modelId: NOVA },
      { region: HUB, modelId: NOVA },
      { region: EUW1, modelId: NOVA },
      { region: APSE1, modelId: PROFILE },
      { region: APSE1, modelId: NOVA },
    ]);

    // one read for every model used in every region, each once
    expect(cache.getPrices.mock.calls).toEqual([
      [
        [
          { modelId: PROFILE, region: HUB },
          { modelId: NOVA, region: HUB },
          { modelId: NOVA, region: APSE1 },
          { modelId: PROFILE, region: APSE1 },
          { modelId: NOVA, region: EUW1 },
        ],
      ],
    ]);
    const listedWith = (mock: { mock: { calls: unknown[][] } }) =>
      mock.mock.calls.map(([client]) => client);
    expect(listedWith(vi.mocked(discoverFoundationModels))).toEqual([
      bedrockClientIn(HUB),
      bedrockClientIn(APSE1),
      bedrockClientIn(EUW1),
    ]);
    // eu-west-1 wants only a foundation model, so its profiles are not listed
    expect(listedWith(vi.mocked(discoverInferenceProfiles))).toEqual([
      bedrockClientIn(HUB),
      bedrockClientIn(APSE1),
    ]);
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [novaModel, profileModel] }, pricingServices],
      [{ models: [novaModel, profileModel] }, pricingServicesIn(APSE1)],
      [{ models: [novaModel] }, pricingServicesIn(EUW1)],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([
      [savedIn(HUB, NOVA, pricedAt(0.0008))],
      [savedIn(HUB, PROFILE, pricedAt(0.0008))],
      [savedIn(APSE1, NOVA, pricedAt(0.00108))],
      [savedIn(APSE1, PROFILE, pricedAt(0.00108))],
      [savedIn(EUW1, NOVA, pricedAt(0.00092))],
    ]);
    expect(priced).toEqual(
      new Map([
        [
          HUB,
          new Map([
            [PROFILE, pricedAt(0.0008)],
            [NOVA, pricedAt(0.0008)],
          ]),
        ],
        [
          APSE1,
          new Map([
            [NOVA, pricedAt(0.00108)],
            [PROFILE, pricedAt(0.00108)],
          ]),
        ],
        [EUW1, new Map([[NOVA, pricedAt(0.00092)]])],
      ]),
    );
  });

  it("fetches the other regions' prices where listing one region's Bedrock models fails, pricing that region from its older prices", async () => {
    fetchPricesEveryModel();
    vi.mocked(discoverFoundationModels).mockImplementation(async (client) => {
      if (client === bedrockClientIn(APSE1)) {
        throw new Error("ListFoundationModels throttled");
      }
      return [asFoundation(novaModel)];
    });
    const cache = priceCacheHolding([
      regionalPrice(APSE1, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await priceModels(cache, [
      { region: APSE1, modelId: NOVA },
      { region: EUW1, modelId: NOVA },
    ]);

    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("could not list Bedrock's models"),
      expect.objectContaining({ region: APSE1, modelIds: [NOVA] }),
    );
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [{ models: [novaModel] }, pricingServicesIn(EUW1)],
    ]);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(EUW1, NOVA)]]);
    expect(priced).toEqual(
      new Map([
        [APSE1, new Map([[NOVA, prices]])],
        [EUW1, new Map([[NOVA, fetchedPrices]])],
      ]),
    );
  });
});

describe("priceDiscoveredModels", () => {
  const priceNova = (cache: BedrockPriceCache) =>
    priceDiscoveredModels([novaModel], {
      priceCache: cache,
      pricingServices,
    });

  it("uses a stored price under a day old without fetching or saving", async () => {
    fetchPricesEveryModel();
    const cache = priceCacheHolding([regionalPrice(HUB, NOVA)]);

    const priced = await priceNova(cache);

    expect(priced.get(NOVA)).toMatchObject(prices);
    expect(mockFetchRates).not.toHaveBeenCalled();
    expect(cache.putPrice).not.toHaveBeenCalled();
  });

  it("fetches and saves a price that is not stored", async () => {
    fetchPricesEveryModel();
    const cache = priceCacheHolding([]);

    const priced = await priceNova(cache);

    expect(priced.get(NOVA)).toMatchObject(fetchedPrices);
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
  });

  it("fetches a stale price and uses the fetched price when the fetch finds one", async () => {
    fetchPricesEveryModel();
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await priceNova(cache);

    expect(priced.get(NOVA)).toMatchObject({
      ...fetchedPrices,
      pricingRefreshedAt: NOW.toISOString(),
    });
    expect(cache.putPrice.mock.calls).toEqual([[savedIn(HUB, NOVA)]]);
  });

  it("uses the stale stored price, saving nothing, when the fetch finds no price", async () => {
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await priceNova(cache);

    expect(mockFetchRates).toHaveBeenCalledOnce();
    expect(priced.get(NOVA)).toMatchObject({
      ...prices,
      pricingRefreshedAt: hoursAgo(48),
    });
    expect(cache.putPrice).not.toHaveBeenCalled();
  });

  it("uses the stale stored price when the fetch fails", async () => {
    vi.mocked(mockFetchRates).mockRejectedValue(new Error("pricing throttled"));
    const cache = priceCacheHolding([
      regionalPrice(HUB, NOVA, { pricingRefreshedAt: hoursAgo(48) }),
    ]);

    const priced = await priceNova(cache);

    expect(priced.get(NOVA)).toMatchObject({
      ...prices,
      pricingRefreshedAt: hoursAgo(48),
    });
    expect(cache.putPrice).not.toHaveBeenCalled();
  });

  it("has no price for a model that is not stored and cannot be fetched", async () => {
    const cache = priceCacheHolding([]);

    const priced = await priceNova(cache);

    expect(priced.has(NOVA)).toBe(false);
    expect(cache.putPrice).not.toHaveBeenCalled();
  });
});

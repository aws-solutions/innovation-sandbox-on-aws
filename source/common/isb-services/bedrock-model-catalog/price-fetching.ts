// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockClient,
  ListFoundationModelAgreementOffersCommand,
  ResourceNotFoundException,
  ThrottlingException,
  ValidationException,
} from "@aws-sdk/client-bedrock";
import { paginateGetProducts, PricingClient } from "@aws-sdk/client-pricing";
import { backOff } from "exponential-backoff";
import pThrottle from "p-throttle";

import {
  BedrockPricingServices,
  FetchPricingForModelsResult,
  LiveModelRates,
  ModelRates,
  PricingModel,
  ResolvedModelPricing,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";

/** Parses a rate card from `ListFoundationModelAgreementOffers` into per-1K USD rates. */
function parseRateCard(
  rateCard: { dimension?: string; price?: string }[],
  dimensionKeys: Array<Record<keyof ModelRates, string>>,
): ModelRates | null {
  const parsed: ModelRates = {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
  };
  let hasAnyRate = false;
  for (const entry of rateCard) {
    const price = Number.parseFloat(entry.price ?? "");
    if (Number.isNaN(price) || price <= 0) continue;
    // Flatten all key sets and find the matching rate dimension in one pass.
    const dim = dimensionKeys
      .flatMap((ks) => Object.entries(ks) as [keyof ModelRates, string][])
      .find(([, key]) => key === (entry.dimension ?? ""))?.[0];
    if (dim !== undefined) {
      // API returns $/Million tokens — convert to $/1K by dividing by 1000.
      parsed[dim] = price / 1000;
      hasAnyRate = true;
    }
  }
  return hasAnyRate ? parsed : null;
}

// ListFoundationModelAgreementOffers throttles at an unpublished rate; 10 TPS
// throttled on back-to-back runs, so cap at 5. Module scope, so the window
// persists across warm invocations.
const agreementOffersThrottle = pThrottle({ limit: 5, interval: 1000 });
const throttledAgreementOffers = agreementOffersThrottle(
  (client: BedrockClient, modelId: string) =>
    client.send(new ListFoundationModelAgreementOffersCommand({ modelId })),
);

/**
 * Fetches pricing via `ListFoundationModelAgreementOffers` for models the Price List did not price.
 * Returns a map of modelId → ModelRates (per-1K USD). Models with no published
 * rate are absent from the map (the model has no price).
 *
 * `region` is used to derive the dimension key prefix (e.g. "us-east-1" → "USE1")
 * so only rates for the deployment region are matched. When the region is not
 * in the expected "xx-name-N" format, no rates are extracted — the model gets no price
 * rather than risking a keyword match against a different region's rates.
 *
 * Inference profile IDs are passed as-is; the API accepts them directly.
 */
async function fetchPricingFromAgreementOffers(
  client: BedrockClient,
  modelIds: string[],
  region: string,
  logger: Logger,
): Promise<Map<string, ModelRates>> {
  const rates = new Map<string, ModelRates>();

  const prefix = agreementOfferDimensionPrefix(region);

  if (!prefix) {
    logger.warn(
      "Bedrock price fetch: unrecognised region for agreement-offer dimension prefix — skipping agreement-offer pricing",
      { region },
    );
    return rates;
  }

  // Issued concurrently so the throttle, not call latency, sets the pace.
  await Promise.all(
    modelIds.map(async (modelId) => {
      const isGlobal = modelId.startsWith("global.");
      const dimensionKeys = dimensionKeysForPrefix(prefix, isGlobal);
      try {
        // Retries go back through the throttle, so they never exceed the rate.
        const resp = await backOff(
          () => throttledAgreementOffers(client, modelId),
          {
            numOfAttempts: 4,
            jitter: "full",
            startingDelay: 500,
            retry: (error) => error instanceof ThrottlingException,
          },
        );
        const rateCard =
          resp.offers?.[0]?.termDetails?.usageBasedPricingTerm?.rateCard ?? [];
        const parsed = parseRateCard(rateCard, dimensionKeys);
        if (parsed) rates.set(modelId, parsed);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        if (
          err instanceof ValidationException ||
          err instanceof ResourceNotFoundException
        ) {
          // Model has no agreement offer; it gets no price.
          logger.debug("Bedrock price fetch: no agreement offer for model", {
            modelId,
            errorName: err.name,
          });
        } else if (err instanceof ThrottlingException) {
          logger.warn(
            "Bedrock price fetch: ListFoundationModelAgreementOffers still throttled after retries — model will have no price",
            { modelId, errorMessage: msg },
          );
        } else {
          logger.error(
            "Bedrock price fetch: ListFoundationModelAgreementOffers failed — model will have no price",
            { modelId, errorMessage: msg },
          );
        }
      }
    }),
  );

  return rates;
}

/** One parsed GetProducts row. */
interface PriceListRow {
  modelName: string;
  usageType: string;
  priceItem: Record<string, unknown>;
}

/** Parses one GetProducts price item; returns undefined for rows without a model name. */
function parsePriceListRow(
  priceItemStr: string,
  logger: Logger,
): PriceListRow | undefined {
  try {
    const priceItem = JSON.parse(priceItemStr) as Record<string, unknown>;
    const attrs = (priceItem["product"] as Record<string, unknown>)?.[
      "attributes"
    ] as Record<string, string> | undefined;
    if (!attrs) return undefined;

    const modelName: string = attrs["model"] ?? attrs["model_name"] ?? "";
    if (!modelName) return undefined;

    return { modelName, usageType: attrs["usagetype"] ?? "", priceItem };
  } catch (err) {
    logger.warn(
      "Bedrock price fetch: failed to parse GetProducts row — skipping",
      {
        errorMessage: err instanceof Error ? err.message : String(err),
      },
    );
    return undefined;
  }
}

/** Case/punctuation-insensitive name key; also drops a trailing ".0" version. */
function normalizePriceListName(name: string): string {
  return name
    .toLowerCase()
    .replace(/\.0(?!\d)/g, "")
    .replace(/[^a-z0-9]/g, "");
}

/**
 * Resolves the Price List `model` name for one model, in order: model-ID
 * override, exact display name, model ID, normalized display name. Never
 * substring-matches — related SKUs (e.g. "Nova Pro" vs "Nova Pro Latency
 * Optimized") must not share a price. Unresolved models get no price.
 */
function resolvePriceListName(
  model: PricingModel,
  rowNames: string[],
  logger: Logger,
): string | undefined {
  const base = {
    modelId: model.foundationModelId ?? model.modelId,
    modelName: model.foundationModelName ?? model.displayName,
  };

  const override = PRICE_LIST_NAME_BY_MODEL_ID[base.modelId];
  if (override !== undefined) {
    // An override is authoritative — never fall through to looser matching.
    if (rowNames.includes(override)) return override;
    logger.warn(
      "Bedrock price fetch: Price List override not found in GetProducts — model will have no price",
      { modelId: model.modelId, priceListName: override },
    );
    return undefined;
  }

  const exactName = [model.displayName, base.modelName].find((name) =>
    rowNames.includes(name),
  );
  if (exactName !== undefined) return exactName;

  const idMatch = rowNames.find(
    (name) => name === model.modelId || name === base.modelId,
  );
  if (idMatch !== undefined) return idMatch;

  const key = normalizePriceListName(base.modelName);
  const normalizedMatches = rowNames.filter(
    (name) => normalizePriceListName(name) === key,
  );
  if (normalizedMatches.length === 1) return normalizedMatches[0];
  if (normalizedMatches.length > 1) {
    logger.warn(
      "Bedrock price fetch: ambiguous Price List name match — model will have no price",
      { modelId: model.modelId, candidates: normalizedMatches },
    );
  }
  return undefined;
}

/**
 * Pages every on-demand AmazonBedrock Price List row for the region. On a
 * mid-pagination failure, returns the rows fetched so far.
 */
async function fetchPriceListRows(
  client: PricingClient,
  region: string,
  logger: Logger,
): Promise<{ rows: PriceListRow[]; allPagesFetched: boolean }> {
  const rows: PriceListRow[] = [];
  try {
    for await (const page of paginateGetProducts(
      { client },
      {
        ServiceCode: "AmazonBedrock",
        FormatVersion: "aws_v1",
        // No `feature` filter: newer rows omit it. Non-on-demand rows are
        // dropped by the anchored usagetype patterns instead. ~1,000 rows per
        // region, so ~11 pages of 100 (GetProducts bucket: 10, refill 5/s).
        Filters: [{ Type: "TERM_MATCH", Field: "regionCode", Value: region }],
      },
    )) {
      for (const priceItemStr of page.PriceList ?? []) {
        const row = parsePriceListRow(priceItemStr, logger);
        if (row) rows.push(row);
      }
    }
    return { rows, allPagesFetched: true };
  } catch (err) {
    logPriceListPaginationFailure(err, logger);
    return { rows, allPagesFetched: false };
  }
}

/** Logs a GetProducts pagination failure: throttling as WARN, anything else as ERROR. */
function logPriceListPaginationFailure(err: unknown, logger: Logger): void {
  const msg = err instanceof Error ? err.message : String(err);
  if (/ThrottlingException|TooManyRequests/i.test(msg)) {
    logger.warn(
      "Bedrock price fetch: pricing:GetProducts throttled mid-pagination — returning partial rates",
      { errorMessage: msg },
    );
    return;
  }
  logger.error(
    "Bedrock price fetch: pricing:GetProducts failed unexpectedly mid-pagination — returning partial rates",
    { errorMessage: msg },
  );
}

/** True when any of the four rates was published (non-zero). */
function hasPublishedRate(r: ModelRates): boolean {
  return r.input > 0 || r.output > 0 || r.cacheRead > 0 || r.cacheWrite > 0;
}

/**
 * Fetches pricing via `pricing:GetProducts` (service code
 * `AmazonBedrock`). Returns a map of modelId → ModelRates (per-1K USD), and
 * whether every page was read.
 *
 * Matches product rows by `attributes.model` (display name) against the
 * `displayName` field on each discovered model. The Pricing API has no
 * modelId field — display name is the only stable identifier available.
 */
async function fetchPricingFromPriceList(
  client: PricingClient,
  models: PricingModel[],
  region: string,
  logger: Logger,
): Promise<{ rates: Map<string, ModelRates>; allPagesFetched: boolean }> {
  const rates = new Map<string, ModelRates>();
  if (models.length === 0) {
    return { rates, allPagesFetched: true };
  }

  const accumulated = new Map<string, ModelRates>();
  for (const { modelId } of models) {
    accumulated.set(modelId, {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }

  const { rows, allPagesFetched } = await fetchPriceListRows(
    client,
    region,
    logger,
  );

  // Resolve each model to one Price List name, then apply only that name's rows.
  // Runs on partial results too, so rows fetched before a throttle still count.
  const rowNames = [...new Set(rows.map((row) => row.modelName))];
  for (const model of models) {
    const priceListName = resolvePriceListName(model, rowNames, logger);
    if (!priceListName) continue;
    const named = rows.filter((row) => row.modelName === priceListName);
    const scope = selectRateScope(model.modelId, named);
    for (const row of named) {
      applyPriceListRow(row, model.modelId, scope, accumulated);
    }
  }

  // Promote accumulated rates in both the success and partial-failure cases.
  for (const [id, r] of accumulated) {
    if (hasPublishedRate(r)) rates.set(id, r);
  }

  if (allPagesFetched) {
    logger.info("Bedrock price fetch: GetProducts pricing complete", {
      requestedModels: models.length,
      pricedModels: rates.size,
      unpricedIds: models
        .filter((m) => !rates.has(m.modelId))
        .map((m) => ({ modelId: m.modelId, displayName: m.displayName })),
    });
  }

  return { rates, allPagesFetched };
}

/** Whether a Price List rate applies in-region or to global cross-region routing. */
type RateScope = "regional" | "global";

/**
 * Standard on-demand usagetype endings → rate type and scope. Anchored, so
 * priority/flex/batch, latency-optimized, and custom-model rows never match.
 * Formats: https://docs.aws.amazon.com/bedrock/latest/userguide/cost-mgmt-understanding-cur-data.html
 * "-global-standard" (bedrock-mantle global rows) is not documented there;
 * it was observed in the AmazonBedrock Price List.
 */
const USAGE_TYPE_PATTERNS: Array<[RegExp, keyof ModelRates, RateScope]> = [
  [/-input-tokens(?:-standard)?$/, "input", "regional"],
  [/-output-tokens(?:-standard)?$/, "output", "regional"],
  [/-cache-read-input-token-count$/, "cacheRead", "regional"],
  [/-cache-write-input-token-count$/, "cacheWrite", "regional"],
  [/-cache-read-tokens-standard$/, "cacheRead", "regional"],
  [/-cache-write-tokens(?:-\d+[mh])?-standard$/, "cacheWrite", "regional"],
  [/-input-tokens-(?:global-standard|cross-region-global)$/, "input", "global"],
  [
    /-output-tokens-(?:global-standard|cross-region-global)$/,
    "output",
    "global",
  ],
  [/-cache-read-tokens-global-standard$/, "cacheRead", "global"],
  [/-cache-write-tokens(?:-\d+[mh])?-global-standard$/, "cacheWrite", "global"],
  [/-cache-read-input-token-count-cross-region-global$/, "cacheRead", "global"],
  [
    /-cache-write-input-token-count-cross-region-global$/,
    "cacheWrite",
    "global",
  ],
];

/** Classifies a standard on-demand row; undefined means the row is not used. */
function classifyUsageType(
  usageType: string,
): { rate: keyof ModelRates; scope: RateScope } | undefined {
  // Speech-to-speech rows (Nova Sonic) are not text chat tokens.
  if (usageType.includes("speech-")) return undefined;
  const match = USAGE_TYPE_PATTERNS.find(([pattern]) =>
    pattern.test(usageType),
  );
  return match ? { rate: match[1], scope: match[2] } : undefined;
}

/**
 * Global profiles use their model's global rows when any exist, else the
 * regional rows. Everything else uses regional rows only — global rates are
 * cheaper, so applying them in-region would undercharge.
 */
function selectRateScope(modelId: string, rows: PriceListRow[]): RateScope {
  if (!modelId.startsWith("global.")) return "regional";
  const hasGlobal = rows.some(
    (row) => classifyUsageType(row.usageType)?.scope === "global",
  );
  return hasGlobal ? "global" : "regional";
}

/**
 * Bedrock foundation model ID → Pricing API `model` name, for models whose
 * names genuinely differ. Keyed by foundation ID; inference profiles
 * (e.g. "us.amazon.nova-2-lite-v1:0") resolve through their backing model.
 */
const PRICE_LIST_NAME_BY_MODEL_ID: Record<string, string> = {
  "amazon.nova-2-lite-v1:0": "Nova 2.0 Lite",
  "deepseek.r1-v1:0": "R1",
  "google.gemma-3-4b-it": "Gemma 3 4B",
  "google.gemma-3-12b-it": "Gemma 3 12B",
  "google.gemma-3-27b-it": "Gemma 3 27B",
  "meta.llama3-8b-instruct-v1:0": "Llama 3 8B",
  "meta.llama3-70b-instruct-v1:0": "Llama 3 70B",
  "meta.llama3-1-8b-instruct-v1:0": "Llama 3.1 8B",
  "meta.llama3-1-70b-instruct-v1:0": "Llama 3.1 70B",
  "meta.llama3-3-70b-instruct-v1:0": "Llama 3.3 70B",
  "meta.llama4-maverick-17b-instruct-v1:0": "Llama 4 Maverick 17B",
  "meta.llama4-scout-17b-instruct-v1:0": "Llama 4 Scout 17B",
  // Price List "Devstral" is Devstral 2: its usagetype embeds this model ID.
  "mistral.devstral-2-123b": "Devstral",
  "mistral.magistral-small-2509": "Magistral Small 1.2",
  "mistral.ministral-3-3b-instruct": "Ministral 3B 3.0",
  "mistral.ministral-3-8b-instruct": "Ministral 8B 3.0",
  "mistral.mistral-7b-instruct-v0:2": "Mistral 7B",
  "mistral.mistral-large-2402-v1:0": "Mistral Large",
  "mistral.mistral-small-2402-v1:0": "Mistral Small",
  "mistral.mixtral-8x7b-instruct-v0:1": "Mixtral 8x7B",
  "mistral.pixtral-large-2502-v1:0": "Pixtral Large 25.02",
  "mistral.voxtral-mini-3b-2507": "Voxtral Mini 1.0",
  "mistral.voxtral-small-24b-2507": "Voxtral Small 1.0",
  "moonshotai.kimi-k3": "Kimi K3",
  "nvidia.nemotron-nano-9b-v2": "NVIDIA Nemotron Nano 2",
  "nvidia.nemotron-nano-12b-v2": "NVIDIA Nemotron Nano 2 VL",
  "qwen.qwen3-32b-v1:0": "Qwen3 32B",
  "qwen.qwen3-coder-30b-a3b-v1:0": "Qwen3 Coder 30B A3B",
  "xai.grok-4.7": "Grok 4.7",
};

/** Tokens per Price List billing unit; rows with any other unit are skipped. */
const PRICE_LIST_TOKENS_PER_UNIT: Record<string, number> = {
  "1k tokens": 1_000,
  "1m tokens": 1_000_000,
};

/** Extracts and accumulates one price dimension from a GetProducts row in the given scope. */
function applyPriceListRow(
  row: PriceListRow,
  modelId: string,
  scope: RateScope,
  accumulated: Map<string, ModelRates>,
): void {
  const terms = (row.priceItem["terms"] as Record<string, unknown>)?.[
    "OnDemand"
  ];
  if (!terms || typeof terms !== "object") return;

  const classified = classifyUsageType(row.usageType);
  if (classified?.scope !== scope) return;
  const tokenType = classified.rate;
  const entry = accumulated.get(modelId);
  if (!entry) return;

  for (const term of Object.values(terms)) {
    const dims = (term as Record<string, unknown>)["priceDimensions"];
    if (!dims || typeof dims !== "object") continue;
    for (const dim of Object.values(dims)) {
      const d = dim as Record<string, unknown>;
      const priceStr =
        (d["pricePerUnit"] as Record<string, string>)?.["USD"] ?? "";
      const price = Number.parseFloat(priceStr);
      if (Number.isNaN(price) || price <= 0) continue;
      const unit = String(d["unit"]).trim().toLowerCase();
      const tokensPerUnit = PRICE_LIST_TOKENS_PER_UNIT[unit];
      if (tokensPerUnit === undefined) continue;

      const pricePer1K = price / (tokensPerUnit / 1_000);
      entry[tokenType] = Math.max(entry[tokenType], pricePer1K);
    }
  }
}

/**
 * Derives the agreement-offer dimension key prefix from an AWS region code,
 * e.g. "us-east-1" → "USE1", "eu-central-1" → "EUC1".
 */
function agreementOfferDimensionPrefix(region: string): string | undefined {
  const match = /^([a-z]{2})-([a-z]+)-(\d+)$/.exec(region.toLowerCase());
  if (!match) return undefined;

  return `${match[1]!.toUpperCase()}${match[2]![0]!.toUpperCase()}${match[3]!}`;
}

function dimensionKeysForPrefix(
  prefix: string,
  isGlobal: boolean,
): Array<Record<keyof ModelRates, string>> {
  // Two dimension key formats exist across different model generations:
  // - Old format (PascalCase): USE1_InputTokenCount, USE1_InputTokenCount_Global
  // - New format (lowercase):  USE1_input_tokens_standard, USE1_input_tokens_global_standard
  // Return both sets; the caller checks each entry until one matches.
  if (isGlobal) {
    return [
      {
        // Old format — global
        input: `${prefix}_InputTokenCount_Global`,
        output: `${prefix}_OutputTokenCount_Global`,
        cacheRead: `${prefix}_CacheReadInputTokenCount_Global`,
        cacheWrite: `${prefix}_CacheWriteInputTokenCount_Global`,
      },
      {
        // New format — global standard
        input: `${prefix}_input_tokens_global_standard`,
        output: `${prefix}_output_tokens_global_standard`,
        cacheRead: `${prefix}_cache_read_tokens_global_standard`,
        cacheWrite: `${prefix}_cache_write_tokens_global_standard`,
      },
      {
        // No-prefix global format (e.g. OpenAI, xAI models)
        input: "input_tokens_global_standard",
        output: "output_tokens_global_standard",
        cacheRead: "cache_read_tokens_global_standard",
        cacheWrite: "cache_writes_tokens_global_standard",
      },
    ];
  }
  return [
    {
      // Old format — regional
      input: `${prefix}_InputTokenCount`,
      output: `${prefix}_OutputTokenCount`,
      cacheRead: `${prefix}_CacheReadInputTokenCount`,
      cacheWrite: `${prefix}_CacheWriteInputTokenCount`,
    },
    {
      // New format — regional standard
      input: `${prefix}_input_tokens_standard`,
      output: `${prefix}_output_tokens_standard`,
      cacheRead: `${prefix}_cache_read_tokens_standard`,
      cacheWrite: `${prefix}_cache_write_tokens_standard`,
    },
    {
      // No-prefix regional format (e.g. OpenAI, xAI models)
      input: "input_tokens_standard",
      output: "output_tokens_standard",
      cacheRead: "cache_read_tokens_standard",
      cacheWrite: "cache_writes_tokens_standard",
    },
    {
      // No-prefix global format fallback for bare FM IDs (e.g. newer bare OpenAI models)
      input: "input_tokens_global_standard",
      output: "output_tokens_global_standard",
      cacheRead: "cache_read_tokens_global_standard",
      cacheWrite: "cache_writes_tokens_global_standard",
    },
  ];
}
/**
 * Fills every rate for one model from its fetched rates: an unpublished cache
 * rate defaults to the input rate. A model without a published input
 * or output rate has no price, so it returns undefined.
 */
export function resolveModelPricing(
  rates: LiveModelRates | undefined,
): ResolvedModelPricing | undefined {
  if (!rates?.input || !rates.output) {
    return undefined;
  }
  return {
    pricingSource: rates.pricingSource,
    inputPricePer1KTokens: rates.input,
    outputPricePer1KTokens: rates.output,
    cacheReadPricePer1KTokens: rates.cacheRead || rates.input,
    cacheWritePricePer1KTokens: rates.cacheWrite || rates.input,
  };
}

/**
 * Fetches live published rates for the given models, without rediscovering them:
 * `pricing:GetProducts` first, then `ListFoundationModelAgreementOffers` for
 * models still unpriced. A profile's `foundationModelId`/`foundationModelName` match it to
 * its foundation model's Price List rows. Models with no published rate are absent from the
 * rates; callers fill the remaining rates with `resolveModelPricing`.
 *
 * Also says whether every Price List page was read. A read that stopped part
 * way still prices from the pages it got, so a model's rate can be lower than
 * its real one.
 */
export async function fetchPublishedModelRates(
  props: { models: PricingModel[] },
  services: BedrockPricingServices,
): Promise<FetchPricingForModelsResult> {
  const { bedrockClient, pricingClient, logger, region } = services;
  const { models } = props;

  const { rates: priceListRates, allPagesFetched } =
    await fetchPricingFromPriceList(pricingClient, models, region, logger);
  const unpricedIds = models
    .map((model) => model.modelId)
    .filter((modelId) => !priceListRates.has(modelId));

  const agreementRates =
    unpricedIds.length > 0
      ? await fetchPricingFromAgreementOffers(
          bedrockClient,
          unpricedIds,
          region,
          logger,
        )
      : new Map<string, ModelRates>();
  return {
    rates: tagRates(agreementRates, priceListRates),
    priceListComplete: allPagesFetched,
  };
}

/** Merges per-API rate maps, tagging each entry with its pricing source. */
function tagRates(
  agreementRates: Map<string, ModelRates>,
  priceListRates: Map<string, ModelRates>,
): Map<string, LiveModelRates> {
  const tagged = new Map<string, LiveModelRates>();
  for (const [modelId, rates] of agreementRates) {
    tagged.set(modelId, { ...rates, pricingSource: "agreement-offers" });
  }
  for (const [modelId, rates] of priceListRates) {
    tagged.set(modelId, { ...rates, pricingSource: "price-list" });
  }
  return tagged;
}

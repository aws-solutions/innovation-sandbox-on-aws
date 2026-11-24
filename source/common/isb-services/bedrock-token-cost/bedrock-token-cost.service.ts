// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  computeProjection,
  computeSpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/index.js";
import { CostObservationPoint } from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  TokenType,
  UNATTRIBUTED_MODEL_ID,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

import type {
  ModelPricing,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import {
  BedrockPricing,
  BedrockPricingServices,
  BedrockRate,
  BedrockRateSource,
  BedrockRateSourceServices,
  BilledObservationPoint,
  EvaluatedSpendInput,
  LeaseFigures,
  LeaseFiguresInput,
  PriceTokensInput,
  TokenCumulative,
  TokensByRegionAndModel,
} from "./bedrock-token-cost.types.js";
import {
  mergeCounts,
  RegionTokenUsage,
  TOKEN_TYPES,
} from "./token-usage-reader.js";

/**
 * `CE - BBTC + NRTBTC`: the billed total with its lagging token-priced Bedrock
 * slice replaced by the monitored one. Either Bedrock term null leaves the billed
 * total as it is, so with monitoring off, before the first token row, or while
 * the counts cannot be priced, the evaluated spend is the billed total.
 * Substituting zero for a null slice would count the billed Bedrock spend
 * twice. Never below the billed total: the monitored term falls short of
 * the billed slice where it missed tokens the bill holds, such as tokens past
 * CloudWatch's retention when monitoring was switched on.
 */
export function calculateEvaluatedSpend(input: EvaluatedSpendInput): number {
  const {
    billedCostAccrued,
    billedBedrockTokenCost,
    monitoredBedrockTokenCost,
  } = input;
  if (billedBedrockTokenCost === null || monitoredBedrockTokenCost === null) {
    return billedCostAccrued;
  }
  return Math.max(
    billedCostAccrued,
    billedCostAccrued - billedBedrockTokenCost + monitoredBedrockTokenCost,
  );
}

/**
 * What the poll writes to the lease record, recomputed from stored rows every
 * run rather than from its own previous output. One rule governs every
 * figure: the monitored Bedrock term is substituted only where both it
 * and the billed slice are known. Then evaluated spend is
 * `max(CE, CE - BBTC + NRTBTC)`, the projection carries it forward on the
 * remainder rate alone, and the caps get the remainder plus the
 * monitored Bedrock rate. Otherwise the lease is
 * measured as an unmonitored one is: billed total, billed rate, nothing added.
 * The monitored term is never scaled by the projection's uplift, being
 * measured to the present already.
 */
export function computeLeaseFigures(input: LeaseFiguresInput): LeaseFigures {
  const monitoredBedrockTokenCost =
    input.billedBedrockTokenCost === null
      ? null
      : input.monitoredBedrockTokenCost;
  const hasMonitoredBedrockTokenCost = monitoredBedrockTokenCost !== null;
  const evaluatedSpend = calculateEvaluatedSpend(input);
  const remainder = computeSpendRates(
    remainderSeries(input.observations, hasMonitoredBedrockTokenCost),
  );
  const projection = computeProjection({
    projectionAnchorCost: evaluatedSpend,
    lastReportedAt: input.reportedAt,
    evaluatedAt: input.evaluatedAt,
    rates: remainder,
    recentIntervalHours: remainder.hourlyRateWindowHours,
  });
  const bedrock =
    monitoredBedrockTokenCost === null
      ? null
      : {
          hourly: input.bedrockWindows.lastHour,
          daily: input.bedrockWindows.lastDay,
        };
  return {
    evaluatedSpend,
    monitoredBedrockTokenCost,
    predictedCost: projection.predictedCost,
    rateSource: projection.rateSource,
    remainder,
    rates: {
      remainderHourlyRate: remainder.hourlyRate,
      remainderDailyRate: remainder.dailyRate,
      bedrockHourlyRate: bedrock?.hourly ?? null,
      summedHourlyRate:
        bedrock === null
          ? remainder.hourlyRate
          : sumRates(remainder.hourlyRate, bedrock.hourly),
      summedDailyRate:
        bedrock === null
          ? remainder.dailyRate
          : sumRates(remainder.dailyRate, bedrock.daily),
    },
  };
}

/**
 * The series the remainder rates difference over. With a monitored term
 * to substitute, each observation is reduced by its billed Bedrock slice. A
 * row with no slice, such as one taken while monitoring was off, is left out
 * so both ends of a difference carry the same terms. Without one, the series
 * remains the billed total throughout, as an unmonitored lease is measured.
 */
export function remainderSeries(
  observations: BilledObservationPoint[],
  hasMonitoredBedrockTokenCost: boolean,
): CostObservationPoint[] {
  if (!hasMonitoredBedrockTokenCost) {
    return observations;
  }
  return observations.flatMap((point) =>
    point.billedBedrockTokenCost === null
      ? []
      : [
          {
            timestamp: point.timestamp,
            billedCostAccrued:
              point.billedCostAccrued - point.billedBedrockTokenCost,
          },
        ],
  );
}

function sumRates(a: number | null, b: number | null): number | null {
  return a === null || b === null ? null : a + b;
}

/** One region, model and token type with a non-zero count. */
interface TokenSlice {
  region: string;
  modelId: string;
  tokenType: TokenType;
  count: number;
}

/**
 * Sum over region, model and token type of (tokens / unitDivisor) x rate. A
 * slice with no rate adds nothing, which understates the total by its price,
 * and the unpriced slices are named in one warning per lease. Counts the
 * reader left unattributed have no model to price under, so they add nothing
 * either; the reader logged them when it recorded them.
 */
export function priceTokens(input: PriceTokensInput): number {
  const unpriced: TokenSlice[] = [];
  let total = 0;
  for (const slice of countedSlices(input.tokens)) {
    const rate = input.rates(slice.region, slice.modelId, slice.tokenType);
    if (rate === null) {
      unpriced.push(slice);
      continue;
    }
    total += (slice.count / rate.unitDivisor) * rate.ratePerUnit;
  }
  if (unpriced.length > 0) {
    input.logger.warn(
      `${LogPatterns.BedrockTokensUnpriced.pattern}: no rate for some of the lease's token counts, so they add nothing to its monitored Bedrock token cost`,
      { leaseId: input.leaseId, unpriced },
    );
  }
  return total;
}

function countedSlices(tokens: TokensByRegionAndModel): TokenSlice[] {
  const slices: TokenSlice[] = [];
  for (const [region, models] of Object.entries(tokens)) {
    for (const [modelId, counts] of Object.entries(models)) {
      if (modelId === UNATTRIBUTED_MODEL_ID) {
        continue;
      }
      for (const tokenType of TOKEN_TYPES) {
        if (counts[tokenType] > 0) {
          slices.push({ region, modelId, tokenType, count: counts[tokenType] });
        }
      }
    }
  }
  return slices;
}

/**
 * The stored cumulative plus each region's reading, with that region's anchor
 * moved to the reading's. A region with no reading for the lease keeps its
 * counts and anchor, so a failed or idle region holds back only itself. Null
 * when nothing moved, so there is nothing to write.
 */
export function accumulateTokenUsage(
  leaseId: string,
  previous: TokenCumulative | null,
  regions: RegionTokenUsage[],
): TokenCumulative | null {
  const readings = regions.flatMap(({ region, leases }) => {
    const reading = leases[leaseId];
    return reading ? [{ region, reading }] : [];
  });
  if (readings.length === 0) {
    return null;
  }
  const cumulative: TokenCumulative = structuredClone(previous) ?? {
    tokens: {},
    coveredThrough: {},
  };
  for (const { region, reading } of readings) {
    const models = cumulative.tokens[region] ?? {};
    mergeCounts(models, reading.tokens);
    cumulative.tokens[region] = models;
    cumulative.coveredThrough[region] = reading.coveredThrough;
  }
  return cumulative;
}

// ---------------------------------------------------------------------------
// Rate source
//
// Prices are read per region and model from the regional price table. Each
// model has one price, whose four rates map directly to its token types.
// Prices are read each run, as a container is rarely reused.
// ---------------------------------------------------------------------------

/** The two units Bedrock quotes prices in; any other means the unit was guessed. */
const VALID_UNIT_DIVISORS = new Set([1_000, 1_000_000]);

/** The lowest plausible dollars per token for a non-free rate; below it a rate silently understates spend. */
const MIN_DOLLARS_PER_TOKEN = 1e-9;

/** The highest plausible dollars per token; above it a rate overstates spend and raises false alerts. */
const MAX_DOLLARS_PER_TOKEN = 0.001;

/** The model pricing table field that prices each counted token type. */
const PRICE_FIELDS: Record<
  TokenType,
  Exclude<keyof ModelPricing, "pricingSource">
> = {
  input: "inputPricePer1KTokens",
  output: "outputPricePer1KTokens",
  cacheRead: "cacheReadPricePer1KTokens",
  cacheWrite: "cacheWritePricePer1KTokens",
};

/**
 * Real prices for the region and model pairs passed to loadPrices, looked up
 * in one call and kept until the next call, with validation applied. Always
 * build the pricing here, as nothing else validates a BedrockRateSource. If the
 * lookup throws, nothing is priced and loadPrices resolves false.
 */
export function createBedrockPricing(
  services: BedrockPricingServices,
): BedrockPricing {
  let loadedPrices = new Map<
    string,
    Map<string, Partial<Record<TokenType, number>>>
  >();

  const loadPrices = async (models: RegionModel[]) => {
    loadedPrices = new Map();
    if (models.length === 0) {
      return true;
    }
    try {
      const prices = await services.modelPricing(models);
      for (const { region, modelId } of models) {
        const rates = loadedPrices.get(region) ?? new Map();
        rates.set(modelId, tokenRates(prices.get(region)?.get(modelId)));
        loadedPrices.set(region, rates);
      }
      return true;
    } catch (error) {
      services.logger.error(
        "model pricing lookup failed; no Bedrock token counts can be priced this run",
        { models, error },
      );
      return false;
    }
  };

  const source: BedrockRateSource = (region, modelId, tokenType) => {
    const ratePerUnit = loadedPrices.get(region)?.get(modelId)?.[tokenType];
    return ratePerUnit === undefined
      ? null
      : { ratePerUnit, unitDivisor: 1_000 };
  };
  return { source: validatedRateSource(source, services), loadPrices };
}

/** Maps one model price to its rates by token type. */
function tokenRates(
  pricing: ModelPricing | undefined,
): Partial<Record<TokenType, number>> {
  const rates: Partial<Record<TokenType, number>> = {};
  if (pricing === undefined) {
    return rates;
  }
  for (const [tokenType, field] of Object.entries(PRICE_FIELDS) as [
    TokenType,
    (typeof PRICE_FIELDS)[TokenType],
  ][]) {
    rates[tokenType] = pricing[field];
  }
  return rates;
}

/**
 * Drops a malformed rate instead of pricing from it: the prices come from
 * another feature and neither side validates the hand-off, so one bad entry
 * would misprice every token-monitored lease in the same run.
 */
export function validatedRateSource(
  source: BedrockRateSource,
  services: BedrockRateSourceServices,
): BedrockRateSource {
  return (region, modelId, tokenType) => {
    const rate = source(region, modelId, tokenType);
    if (rate === null) {
      return null;
    }
    const rejection = rejectionReason(rate);
    if (rejection === null) {
      return rate;
    }
    services.logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: rejected a Bedrock rate, leaving the slice unpriced`,
      { ...rate, region, modelId, tokenType, rejection },
    );
    return null;
  };
}

/** Why a rate is unusable, or null when it is well-formed. */
function rejectionReason(rate: BedrockRate): string | null {
  if (!VALID_UNIT_DIVISORS.has(rate.unitDivisor)) {
    return "unitDivisor is not a Bedrock pricing unit";
  }
  if (!Number.isFinite(rate.ratePerUnit) || rate.ratePerUnit < 0) {
    return "ratePerUnit is negative or not a finite number";
  }
  // Zero is a free SKU and is accepted. A missing price must be reported as
  // null, never as 0, so its slice is logged as unpriced.
  if (rate.ratePerUnit === 0) {
    return null;
  }
  const dollarsPerToken = rate.ratePerUnit / rate.unitDivisor;
  if (
    dollarsPerToken < MIN_DOLLARS_PER_TOKEN ||
    dollarsPerToken > MAX_DOLLARS_PER_TOKEN
  ) {
    return "price per token is outside the plausible Bedrock range";
  }
  return null;
}

/**
 * The counts that moved between two cumulatives, per region, model and token
 * type; a slice that did not move is left out, so an empty result means
 * nothing moved. A count that fell (a region whose anchor was reset) reads as
 * zero rather than negative.
 */
export function subtractTokens(
  now: TokensByRegionAndModel,
  before: TokensByRegionAndModel,
): TokensByRegionAndModel {
  const moved: TokensByRegionAndModel = {};
  for (const [region, models] of Object.entries(now)) {
    for (const [modelId, counts] of Object.entries(models)) {
      const earlier = before[region]?.[modelId];
      const delta = { ...counts };
      let any = false;
      for (const tokenType of TOKEN_TYPES) {
        delta[tokenType] = Math.max(
          0,
          counts[tokenType] - (earlier?.[tokenType] ?? 0),
        );
        any ||= delta[tokenType] > 0;
      }
      if (any) {
        moved[region] ??= {};
        moved[region][modelId] = delta;
      }
    }
  }
  return moved;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import {
  CostObservationPoint,
  RateSource,
  SpendRates,
} from "@amzn/innovation-sandbox-commons/isb-services/spend-rate/spend-rate.types.js";
import type {
  TokenCounts,
  TokenType,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

import type {
  ModelPricingLookup,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";

/** region -> modelId -> counts. */
export type TokensByRegionAndModel = Record<
  string,
  Record<string, TokenCounts>
>;

/** A lease's running token cumulative and, per region, the anchor its counts run to. */
export interface TokenCumulative {
  tokens: TokensByRegionAndModel;
  /** Region -> ISO 8601 timestamp of the newest bucket the counts include. */
  coveredThrough: Record<string, string>;
}

/**
 * Inputs to `evaluatedSpend = max(CE, CE - BBTC + NRTBTC)`, where:
 * - CE = Cost Explorer's billed lease-to-date total (every service)
 * - BBTC = billed Bedrock token cost (the token-priced slice of CE)
 * - NRTBTC = monitored Bedrock token cost, derived from CloudWatch token counts
 *
 * i.e. the billed total with its lagging token-priced Bedrock slice swapped
 * for the monitored one. Null Bedrock terms mean token monitoring is off
 * (or no row exists yet), in which case evaluated spend is just CE.
 */
export interface EvaluatedSpendInput {
  /** CE: billed lease-to-date total across every service, from the newest cost observation. */
  billedCostAccrued: number;
  /** BBTC: billed token-priced Bedrock portion of that same observation. */
  billedBedrockTokenCost: number | null;
  /** NRTBTC: monitored lease-to-date Bedrock cost derived from CloudWatch token counts. */
  monitoredBedrockTokenCost: number | null;
}

/**
 * The five Bedrock-aware rate figures. Remainder rates difference CE - BBTC
 * (what the projection extrapolates — see EvaluatedSpendInput for the
 * definitions); summed rates add the monitored Bedrock rate on top (what
 * rate caps compare against). Where there is no monitored term to
 * substitute, the same rule that makes evaluated spend the billed total makes
 * the remainder the billed total, the Bedrock rate null and the summed rates
 * the remainder rates. Null otherwise follows the same unavailable-not-wrong
 * rule as SpendRates.
 */
export interface BedrockAwareRates {
  remainderHourlyRate: number | null;
  remainderDailyRate: number | null;
  bedrockHourlyRate: number | null;
  summedHourlyRate: number | null;
  summedDailyRate: number | null;
}

/**
 * Monitored Bedrock dollars accrued in the hour and the day before this
 * run: the current value less the value on the newest row at or before that
 * instant. Each row prices only the counts it adds, so a rate change never
 * reads as usage. Zero where nothing moved; null where the lease had not
 * started or has no monitored value.
 */
export interface BedrockWindowCost {
  lastHour: number | null;
  lastDay: number | null;
}

/** A cost observation with the billed Bedrock slice it carries, newest first. */
export interface BilledObservationPoint extends CostObservationPoint {
  /** Null where the slice is unknown, as for a reading taken while monitoring was off. */
  billedBedrockTokenCost: number | null;
}

/**
 * Everything the poll's lease-record figures are recomputed from on each run:
 * the newest cost observation's terms, when it was reported, and the readings
 * the rates difference over.
 */
export interface LeaseFiguresInput extends EvaluatedSpendInput {
  /** Timestamp of the newest cost observation, the point the projection carries forward from. */
  reportedAt: string; // ISO 8601
  /** The instant of this poll run. */
  evaluatedAt: string; // ISO 8601
  /** Cost observations with their billed Bedrock slice, newest first. */
  observations: BilledObservationPoint[];
  bedrockWindows: BedrockWindowCost;
}

/** What the poll writes to the lease record, and the rates it derived them from. */
export interface LeaseFigures {
  evaluatedSpend: number;
  /**
   * The monitored Bedrock term substituted into evaluated spend, before
   * the floor at the billed total; null where none was substituted because no
   * token row has been priced or the newest billed row carries no Bedrock
   * slice for it to replace.
   */
  monitoredBedrockTokenCost: number | null;
  /** Evaluated spend carried forward on the remainder rate; evaluated spend itself where no rate exists. */
  predictedCost: number;
  /** Which remainder rate carried the projection; null where none did. */
  rateSource: RateSource | null;
  /** The remainder rates with their windows, as the plain spend rates are shaped. */
  remainder: SpendRates;
  rates: BedrockAwareRates;
}

export interface PriceTokensInput {
  leaseId: string;
  /** Counts, keyed by region and CloudWatch ModelId. */
  tokens: TokensByRegionAndModel;
  rates: BedrockRateSource;
  logger: Logger;
}

/** One published price point, for a single region, model and token type. */
export interface BedrockRate {
  /**
   * Dollars per priced unit, where a unit is `unitDivisor` tokens. Named for the
   * unit rather than for 1,000 because a consumer that assumes per-1,000
   * regardless misprices a per-1,000,000 product by 1000x.
   */
  ratePerUnit: number;
  /** Tokens per priced unit (1_000 or 1_000_000) — read from data, never assumed. */
  unitDivisor: number;
}

/**
 * The published rate for one region, model and token type, or null when none is
 * available. Null means unpriced: the slice adds nothing to the lease's
 * monitored Bedrock token cost and is logged, where a rate of 0 is a free
 * SKU.
 */
export type BedrockRateSource = (
  region: string,
  modelId: string,
  tokenType: TokenType,
) => BedrockRate | null;

export interface BedrockRateSourceServices {
  logger: Logger;
}

export interface BedrockPricingServices extends BedrockRateSourceServices {
  modelPricing: ModelPricingLookup;
}

/**
 * The rate source and the step that fills it. The source is read
 * synchronously, so call loadPrices first. A region and model not loaded is
 * unpriced, and loadPrices resolves false where the lookup failed.
 */
export interface BedrockPricing {
  source: BedrockRateSource;
  /** Takes each region and CloudWatch ModelId, as a model's price differs by region. */
  loadPrices(models: RegionModel[]): Promise<boolean>;
}

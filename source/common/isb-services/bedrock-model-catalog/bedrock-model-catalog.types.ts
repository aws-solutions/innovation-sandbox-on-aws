// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockClient,
  type FoundationModelLifecycleStatus,
} from "@aws-sdk/client-bedrock";
import { PricingClient } from "@aws-sdk/client-pricing";

import type { PricingSource } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import { AgentModelType } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";

/** A model to price; the foundation model defaults to the model itself. */
export interface PricingModel {
  modelId: string;
  displayName: string;
  foundationModelId?: string;
  foundationModelName?: string;
}

/** What fetching a model's price needs: clients for the region and a logger. */
export interface BedrockPricingServices {
  bedrockClient: BedrockClient;
  pricingClient: PricingClient;
  region: string;
  logger: Logger;
}

/** A model as Bedrock lists it, before it is priced. */
export interface DiscoveredModel {
  modelId: string;
  displayName: string;
  provider: string;
  availability: string;
  description?: string;
  modelType: AgentModelType;
  foundationModelId: string;
  foundationModelName: string;
}

/** A foundation model as Bedrock lists it, with what a feature filters on. */
export interface DiscoveredFoundationModel extends DiscoveredModel {
  inputModalities: string[];
  outputModalities: string[];
  responseStreamingSupported: boolean;
  inferenceTypesSupported: string[];
  lifecycleStatus?: FoundationModelLifecycleStatus;
}

/** An inference profile as Bedrock lists it, with what a feature filters on. */
export interface DiscoveredInferenceProfile extends DiscoveredModel {
  status?: string;
  profileType?: string;
  /** The foundation models the profile routes to. */
  routedModelIds: string[];
}

/** Per-model rates in per-1K-token USD. Zero means "not published". */
export interface ModelRates {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
}

/** Published rates fetched live, tagged with the API that returned them. */
export interface LiveModelRates extends ModelRates {
  pricingSource: PricingSource;
}

/** Each priced model's live rates, and whether the Price List read completed. */
export interface FetchPricingForModelsResult {
  rates: Map<string, LiveModelRates>;
  /**
   * False where the Price List read stopped part way. The rates still come
   * from the pages read, so a model's rate can be lower than its real one.
   */
  priceListComplete: boolean;
}

/** Final per-model pricing with every rate filled in. */
export interface ResolvedModelPricing {
  pricingSource: PricingSource;
  inputPricePer1KTokens: number;
  outputPricePer1KTokens: number;
  cacheReadPricePer1KTokens: number;
  cacheWritePricePer1KTokens: number;
}

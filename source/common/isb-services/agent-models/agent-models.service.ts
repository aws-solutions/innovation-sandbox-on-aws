// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  FoundationModelLifecycleStatus,
  InferenceType,
  ModelModality,
} from "@aws-sdk/client-bedrock";

import {
  AgentModelDiscoveryError,
  AgentModelWithPricing,
  FetchAgentModelsWithPricingResult,
  FetchAgentModelsWithPricingServices,
  ResolveEligibleAgentModelProps,
  ResolveEligibleAgentModelServices,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import type {
  DiscoveredFoundationModel,
  DiscoveredInferenceProfile,
  DiscoveredModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";
import {
  discoverFoundationModels,
  discoverInferenceProfiles,
  getFoundationModel,
  getInferenceProfile,
  pickDiscoveredModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js";
import {
  PricesWithRefreshTime,
  pickModelPricing,
  priceDiscoveredModels,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/regional-prices.js";
import { parseDatetime } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

/** Bedrock returns it, but the SDK's ModelModality enum has no SPEECH member. */
const SPEECH_MODALITY = "SPEECH";

/**
 * Checks text input, streaming, and lifecycle for TEXT-output models. Models
 * that also output speech (Nova Sonic) are speech-to-speech: Bedrock serves
 * them only over bidirectional streaming, and Converse rejects them.
 */
function isTextCapableFoundationModel(
  model: DiscoveredFoundationModel,
): boolean {
  return (
    model.inputModalities.includes(ModelModality.TEXT) &&
    !model.outputModalities.includes(SPEECH_MODALITY) &&
    model.responseStreamingSupported &&
    model.lifecycleStatus === FoundationModelLifecycleStatus.ACTIVE
  );
}

/** Adds ON_DEMAND for direct models; profiles invoke backing models indirectly. */
function isEligibleFoundationModel(model: DiscoveredFoundationModel): boolean {
  return (
    isTextCapableFoundationModel(model) &&
    model.inferenceTypesSupported.includes(InferenceType.ON_DEMAND)
  );
}

/**
 * A system-defined, active inference profile is eligible when every foundation
 * model it routes to is text-capable.
 */
function isEligibleInferenceProfile(
  profile: DiscoveredInferenceProfile,
  textCapableModelIds: Set<string>,
): boolean {
  return (
    profile.status === "ACTIVE" &&
    profile.profileType === "SYSTEM_DEFINED" &&
    profile.routedModelIds.length > 0 &&
    profile.routedModelIds.every((id) => textCapableModelIds.has(id))
  );
}

/** The text-output check `ListFoundationModels` applies server-side, made locally. */
function hasTextOutput(model: DiscoveredFoundationModel): boolean {
  return model.outputModalities.includes(ModelModality.TEXT);
}

/**
 * Looks up one model in Bedrock as the given type and returns it when Sandbox
 * Spaces can use it, under the same rules as {@link discoverEligibleAgentModels}.
 * Returns `undefined` when Bedrock has no such model of that type, when it is
 * not eligible, or when Bedrock describes it under a different ID (the get
 * calls also accept ARNs, and the catalog is keyed by ID). Reads Bedrock only.
 */
export async function resolveEligibleAgentModel(
  props: ResolveEligibleAgentModelProps,
  services: ResolveEligibleAgentModelServices,
): Promise<DiscoveredModel | undefined> {
  const { modelId, modelType } = props;
  const { bedrockClient, logger } = services;

  if (modelType === "foundation-model") {
    const model = await getFoundationModel(bedrockClient, modelId);
    return model?.modelId === modelId &&
      hasTextOutput(model) &&
      isEligibleFoundationModel(model)
      ? model
      : undefined;
  }

  const result = await getInferenceProfile(bedrockClient, modelId, logger);
  if (result?.profile.modelId !== modelId) return undefined;
  const { profile, routedModels } = result;
  const textCapableModelIds = new Set(
    routedModels
      .filter((m) => hasTextOutput(m) && isTextCapableFoundationModel(m))
      .map((m) => m.modelId),
  );
  return isEligibleInferenceProfile(profile, textCapableModelIds)
    ? profile
    : undefined;
}

/**
 * Discovers the Bedrock models Sandbox Spaces can use: the eligible foundation
 * models from `ListFoundationModels` and the eligible inference profiles from
 * `ListInferenceProfiles`, without duplicates. Reads Bedrock only; prices are
 * not looked at.
 */
export async function discoverEligibleAgentModels(
  services: Pick<
    FetchAgentModelsWithPricingServices,
    "bedrockClient" | "logger"
  >,
): Promise<DiscoveredModel[]> {
  const { bedrockClient, logger } = services;

  // Foundation models must resolve first: textCapableModels gates inference profile
  // filtering. If this call fails, throw immediately — continuing with an empty
  // textCapableModels would silently exclude all profiles, returning {} models with
  // a 200 that is indistinguishable from a genuinely empty catalog.
  let foundationModels: DiscoveredFoundationModel[];
  try {
    foundationModels = await discoverFoundationModels(bedrockClient, {
      byOutputModality: ModelModality.TEXT,
    });
  } catch (err) {
    throw new AgentModelDiscoveryError(
      `ListAgentModels: ListFoundationModels failed — cannot verify profile eligibility: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const textCapableModelIds = new Set(
    foundationModels.filter(isTextCapableFoundationModel).map((m) => m.modelId),
  );

  let inferenceProfiles: DiscoveredModel[] = [];
  try {
    inferenceProfiles = (
      await discoverInferenceProfiles(bedrockClient, foundationModels, logger)
    ).filter((profile) =>
      isEligibleInferenceProfile(profile, textCapableModelIds),
    );
  } catch (err) {
    logger.warn(
      "ListAgentModels: ListInferenceProfiles failed — excluding inference profiles",
      { errorMessage: err instanceof Error ? err.message : String(err) },
    );
  }

  const seen = new Set<string>();
  const eligible: DiscoveredModel[] = [];
  for (const model of [
    ...foundationModels.filter(isEligibleFoundationModel),
    ...inferenceProfiles,
  ]) {
    if (!seen.has(model.modelId)) {
      seen.add(model.modelId);
      eligible.push(model);
    }
  }

  logger.info("ListAgentModels: discovered eligible models", {
    count: eligible.length,
  });
  return eligible;
}

/**
 * Pairs each model with its price. A model with no price is returned without
 * price fields, so it can be shown but not enabled.
 */
function combineModelsAndPrices(
  models: DiscoveredModel[],
  prices: Map<string, PricesWithRefreshTime>,
  logger: FetchAgentModelsWithPricingServices["logger"],
): AgentModelWithPricing[] {
  return models.map((model): AgentModelWithPricing => {
    const details = pickDiscoveredModel(model);
    const price = prices.get(model.modelId);
    if (price === undefined) {
      logger.warn("ListAgentModels: no pricing found for model", {
        modelId: model.modelId,
      });
      return details;
    }
    return {
      ...details,
      ...pickModelPricing(price),
      pricingRefreshedAt: parseDatetime(price.pricingRefreshedAt).toJSDate(),
    };
  });
}

/**
 * Lists the Bedrock models Sandbox Spaces can use, each with its price.
 *
 * Discovers the eligible models ({@link discoverEligibleAgentModels}), then
 * prices them with `priceDiscoveredModels`. That step writes to the price
 * cache: a price cached in the region under 24 hours ago is used as it is, and
 * the missing or stale ones are fetched and saved.
 */
export async function fetchAgentModelsWithPricing(
  services: FetchAgentModelsWithPricingServices,
): Promise<FetchAgentModelsWithPricingResult> {
  const { logger } = services;
  const eligible = await discoverEligibleAgentModels(services);
  const prices = await priceDiscoveredModels(eligible, {
    priceCache: services.priceCache,
    pricingServices: services,
  });
  const models = combineModelsAndPrices(eligible, prices, logger);

  logger.info("ListAgentModels: complete", {
    totalModels: models.length,
    pricedModels: prices.size,
    unpricedModels: models.length - prices.size,
  });

  return { models };
}

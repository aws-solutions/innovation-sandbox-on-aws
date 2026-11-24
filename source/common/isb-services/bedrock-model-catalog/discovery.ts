// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockClient,
  type FoundationModelSummary,
  GetFoundationModelCommand,
  GetInferenceProfileCommand,
  type InferenceProfileSummary,
  ListFoundationModelsCommand,
  type ListFoundationModelsCommandInput,
  paginateListInferenceProfiles,
  ResourceNotFoundException,
  ValidationException,
} from "@aws-sdk/client-bedrock";

import type {
  DiscoveredFoundationModel,
  DiscoveredInferenceProfile,
  DiscoveredModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";

// Discovery lists what Bedrock offers in a region and applies no policy. Which
// models a feature may use is that feature's decision: Sandbox Spaces filters
// them in agent-models, and the token poll takes every model it sees used.

function deriveInferenceProfileAvailability(modelId: string): string {
  if (modelId.startsWith("global.")) return "global";
  const dot = modelId.indexOf(".");
  if (dot < 0) return "global";
  return modelId.substring(0, dot); // e.g. "us", "eu", "ap"
}

function modelIdFromArn(arn: string): string {
  // ARN format: arn:aws:bedrock:<region>::foundation-model/<modelId>
  return arn.substring(arn.lastIndexOf("/") + 1);
}

/**
 * A model's details alone, without the facts a feature filters discovery on
 * (or a catalog row's own fields). The one place that lists the details.
 */
export function pickDiscoveredModel(model: DiscoveredModel): DiscoveredModel {
  return {
    modelId: model.modelId,
    displayName: model.displayName,
    provider: model.provider,
    availability: model.availability,
    description: model.description,
    modelType: model.modelType,
    foundationModelId: model.foundationModelId,
    foundationModelName: model.foundationModelName,
  };
}

/** The foundation model fields Bedrock returns from both its list and get calls. */
type FoundationModelFields = Pick<
  FoundationModelSummary,
  | "modelName"
  | "providerName"
  | "inputModalities"
  | "outputModalities"
  | "responseStreamingSupported"
  | "inferenceTypesSupported"
  | "modelLifecycle"
>;

/** The inference profile fields Bedrock returns from both its list and get calls. */
type InferenceProfileFields = Pick<
  InferenceProfileSummary,
  "inferenceProfileName" | "description" | "status" | "type" | "models"
>;

function toDiscoveredFoundationModel(
  modelId: string,
  m: FoundationModelFields,
): DiscoveredFoundationModel {
  const modelName = m.modelName ?? modelId;
  return {
    modelId,
    displayName: modelName,
    provider: m.providerName ?? "Unknown",
    availability: "global",
    modelType: "foundation-model",
    foundationModelId: modelId,
    foundationModelName: modelName,
    inputModalities: m.inputModalities ?? [],
    outputModalities: m.outputModalities ?? [],
    responseStreamingSupported: m.responseStreamingSupported ?? false,
    inferenceTypesSupported: m.inferenceTypesSupported ?? [],
    lifecycleStatus: m.modelLifecycle?.status,
  };
}

/** The foundation model IDs an inference profile routes to, without duplicates. */
function getRoutedFoundationModelIds(
  profile: InferenceProfileFields,
): string[] {
  const ids = (profile.models ?? [])
    .map((m) => modelIdFromArn(m.modelArn ?? ""))
    .filter(Boolean);
  return [...new Set(ids)];
}

/** Describes a profile with the identity of the first foundation model it routes to. */
function toDiscoveredInferenceProfile(
  modelId: string,
  p: InferenceProfileFields,
  routedModelIds: string[],
  base: DiscoveredFoundationModel,
): DiscoveredInferenceProfile {
  return {
    modelId,
    displayName: p.inferenceProfileName ?? modelId,
    provider: base.provider,
    availability: deriveInferenceProfileAvailability(modelId),
    description: p.description ?? undefined,
    modelType: "inference-profile",
    foundationModelId: base.modelId,
    foundationModelName: base.displayName,
    status: p.status,
    profileType: p.type,
    routedModelIds,
  };
}

/** Bedrock's answer for an identifier it has no record of, or cannot parse. */
function isModelNotFound(error: unknown): boolean {
  return (
    error instanceof ResourceNotFoundException ||
    error instanceof ValidationException
  );
}

/** Every foundation model matching the supplied filters in the client's region. */
export async function discoverFoundationModels(
  client: BedrockClient,
  filters: ListFoundationModelsCommandInput = {},
): Promise<DiscoveredFoundationModel[]> {
  // ListFoundationModels has no pagination token, so one call returns every matching model.
  const response = await client.send(new ListFoundationModelsCommand(filters));
  return (response.modelSummaries ?? [])
    .filter((m) => !!m.modelId)
    .map((m) => toDiscoveredFoundationModel(m.modelId!, m));
}

/**
 * One foundation model in the client's region, or `undefined` when Bedrock
 * has no foundation model with that ID. Other Bedrock errors are thrown.
 */
export async function getFoundationModel(
  client: BedrockClient,
  modelId: string,
): Promise<DiscoveredFoundationModel | undefined> {
  try {
    const { modelDetails } = await client.send(
      new GetFoundationModelCommand({ modelIdentifier: modelId }),
    );
    if (!modelDetails?.modelId) return undefined;
    return toDiscoveredFoundationModel(modelDetails.modelId, modelDetails);
  } catch (error) {
    if (isModelNotFound(error)) return undefined;
    throw error;
  }
}

/**
 * One inference profile in the client's region, with the foundation models it
 * routes to, or `undefined` when Bedrock has no inference profile with that ID.
 * A profile with no usable route, or a route whose foundation model Bedrock
 * does not describe locally, is logged and returned as `undefined`, matching
 * {@link discoverInferenceProfiles}. Other Bedrock errors are thrown.
 */
export async function getInferenceProfile(
  client: BedrockClient,
  profileId: string,
  logger: Logger,
): Promise<
  | {
      profile: DiscoveredInferenceProfile;
      routedModels: DiscoveredFoundationModel[];
    }
  | undefined
> {
  let response;
  try {
    response = await client.send(
      new GetInferenceProfileCommand({ inferenceProfileIdentifier: profileId }),
    );
  } catch (error) {
    if (isModelNotFound(error)) return undefined;
    throw error;
  }
  const modelId = response.inferenceProfileId;
  if (!modelId) return undefined;
  const routedModelIds = getRoutedFoundationModelIds(response);
  if (routedModelIds.length === 0) {
    logger.warn(
      "Bedrock model lookup: inference profile has no usable routed model ARN",
      { modelId },
    );
    return undefined;
  }
  const routed = await Promise.all(
    routedModelIds.map((id) => getFoundationModel(client, id)),
  );
  const routedModels = routed.filter(
    (m): m is DiscoveredFoundationModel => m !== undefined,
  );
  if (routedModels.length !== routedModelIds.length) {
    logger.warn(
      "Bedrock model lookup: routed foundation model metadata is unavailable locally",
      { modelId, routedModelIds },
    );
    return undefined;
  }
  return {
    profile: toDiscoveredInferenceProfile(
      modelId,
      response,
      routedModelIds,
      routedModels[0]!,
    ),
    routedModels,
  };
}

/**
 * Every inference profile Bedrock lists in the client's region whose routed
 * foundation models were all discovered locally. A profile with malformed or
 * unresolved routes is logged and excluded because its agent compatibility
 * cannot be verified.
 */
export async function discoverInferenceProfiles(
  client: BedrockClient,
  foundationModels: DiscoveredFoundationModel[],
  logger: Logger,
): Promise<DiscoveredInferenceProfile[]> {
  const byId = new Map(foundationModels.map((m) => [m.modelId, m]));
  const profiles: DiscoveredInferenceProfile[] = [];
  for await (const page of paginateListInferenceProfiles({ client }, {})) {
    for (const p of page.inferenceProfileSummaries ?? []) {
      const modelId = p.inferenceProfileId;
      if (!modelId) continue;
      const routedModelIds = getRoutedFoundationModelIds(p);
      if (routedModelIds.length === 0) {
        logger.warn(
          "Bedrock model discovery: inference profile has no usable routed model ARN — excluding profile",
          { modelId },
        );
        continue;
      }
      const unresolvedRoutedModelIds = routedModelIds.filter(
        (routedModelId) => !byId.has(routedModelId),
      );
      if (unresolvedRoutedModelIds.length > 0) {
        logger.warn(
          "Bedrock model discovery: routed foundation model metadata is unavailable locally — excluding profile",
          { modelId, routedModelIds, unresolvedRoutedModelIds },
        );
        continue;
      }
      const base = byId.get(routedModelIds[0]!)!;
      profiles.push(
        toDiscoveredInferenceProfile(modelId, p, routedModelIds, base),
      );
    }
  }
  return profiles;
}

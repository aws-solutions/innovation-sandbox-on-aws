// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { BedrockRegionalPrice } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import type { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import type { ConfigStore } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { resolveEligibleAgentModel } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.service.js";
import {
  AgentModelNotEligibleError,
  LastEnabledModelError,
  SaveAgentModelCatalogEntryProps,
  SaveAgentModelCatalogEntryResult,
  SaveAgentModelCatalogEntryServices,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import { getEnabledAgentModelIds } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/catalog-gate.js";
import {
  getStoredModelPrices,
  requireStoredModelPrice,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/model-prices.service.js";
import { pickDiscoveredModel } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js";

/**
 * Adds a model to the Sandbox Spaces catalog, or changes an existing row's
 * enabled state.
 *
 * - A create looks the model up in Bedrock as the given type and stores only
 *   what Bedrock returns; no model metadata comes from the caller.
 * - An update changes only `enabled`, under OCC, and leaves stored metadata as
 *   it is.
 * - Enabling requires a stored price in `region`, checked before anything is
 *   written, so an unpriced model is never enabled.
 * - Disabling the only enabled model is refused while Sandbox Spaces is on.
 *   Concurrent disables of different models can each pass this check.
 *
 * @returns the written row and its stored price, when it has one.
 * @throws AgentModelNotEligibleError when a create names a model Bedrock has no
 *   eligible record of.
 * @throws ModelNotPricedError when enabling a model with no stored price.
 * @throws LastEnabledModelError when disabling the only enabled model while
 *   Sandbox Spaces is on.
 * @throws ConflictError when a create's row already exists or an update's OCC
 *   token is stale.
 */
export async function saveAgentModelCatalogEntry(
  props: SaveAgentModelCatalogEntryProps,
  services: SaveAgentModelCatalogEntryServices,
): Promise<SaveAgentModelCatalogEntryResult> {
  const { entry, editedBy, region } = props;
  const { configStore, priceCache } = services;
  const priceServices = { priceCache };
  const requirePriceIfEnabled = async () =>
    entry.enabled
      ? await requireStoredModelPrice(
          { modelId: entry.modelId, region },
          priceServices,
        )
      : undefined;

  let row: PersistedAgentModelCatalogRow;
  let requiredPrice: BedrockRegionalPrice | undefined;
  if (entry.kind === "create") {
    const model = await resolveEligibleAgentModel(
      { modelId: entry.modelId, modelType: entry.modelType },
      services,
    );
    if (!model) {
      throw new AgentModelNotEligibleError(
        "The selected model is not available for Sandbox Spaces.",
      );
    }
    requiredPrice = await requirePriceIfEnabled();
    row = await configStore.putModelRow(
      { ...pickDiscoveredModel(model), enabled: entry.enabled },
      editedBy,
    );
  } else {
    if (!entry.enabled) {
      await assertSandboxSpacesKeepsAnEnabledModel(entry.modelId, configStore);
    }
    requiredPrice = await requirePriceIfEnabled();
    row = await configStore.updateModelAdminFields(
      entry.modelId,
      { enabled: entry.enabled },
      editedBy,
      entry.expectedLastEditTime,
    );
  }

  // A disabled model needs no price, but one is still shown when it exists.
  const price =
    requiredPrice ??
    (
      await getStoredModelPrices(
        { modelIds: [row.modelId], region },
        priceServices,
      )
    ).get(row.modelId);
  return { row, price };
}

async function assertSandboxSpacesKeepsAnEnabledModel(
  modelId: string,
  configStore: ConfigStore,
): Promise<void> {
  // Settings may have just saved these; default reads can return old values.
  const enabledModelIds = await getEnabledAgentModelIds(
    { configStore },
    { consistentRead: true },
  );
  if (enabledModelIds.length !== 1 || enabledModelIds[0] !== modelId) return;
  const agentConfig = await configStore.getSection("agent", {
    consistentRead: true,
  });
  if (agentConfig?.sandboxSpacesEnabled) {
    throw new LastEnabledModelError(
      "Keep at least one model enabled while Sandbox Spaces is turned on.",
    );
  }
}

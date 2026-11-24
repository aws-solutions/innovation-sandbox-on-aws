// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockClient,
  GetFoundationModelCommand,
  ResourceNotFoundException,
} from "@aws-sdk/client-bedrock";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import type { BedrockRegionalPrice } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import {
  AgentModelNotEligibleError,
  LastEnabledModelError,
  ModelNotPricedError,
  SaveAgentModelCatalogEntryServices,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import { saveAgentModelCatalogEntry } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/model-catalog.service.js";

const mockBedrock = mockClient(BedrockClient);
const modelId = "anthropic.claude-sonnet-4-6";
const region = "us-east-1";
const editedBy = "admin@example.com";

const sonnetDetails = {
  modelId,
  modelArn: `arn:aws:bedrock:${region}::foundation-model/${modelId}`,
  modelName: "Claude Sonnet 4.6",
  providerName: "Anthropic",
  inputModalities: ["TEXT"],
  outputModalities: ["TEXT"],
  responseStreamingSupported: true,
  inferenceTypesSupported: ["ON_DEMAND"],
  modelLifecycle: { status: "ACTIVE" },
} as any;

const price: BedrockRegionalPrice = {
  modelId,
  region,
  inputPricePer1KTokens: 0.003,
  outputPricePer1KTokens: 0.015,
  cacheReadPricePer1KTokens: 0.0003,
  cacheWritePricePer1KTokens: 0.00375,
  pricingSource: "price-list",
  pricingRefreshedAt: "2026-11-01T00:00:00.000Z",
};

const row = { modelId, enabled: true } as any;

function makeServices(
  prices: BedrockRegionalPrice[] = [],
  {
    sandboxSpacesEnabled = false,
    enabledModelIds = [modelId],
  }: { sandboxSpacesEnabled?: boolean; enabledModelIds?: string[] } = {},
) {
  const configStore = {
    putModelRow: vi.fn(async () => row),
    updateModelAdminFields: vi.fn(async () => row),
    getSection: vi.fn(async () => ({ sandboxSpacesEnabled })),
    getAgentModels: vi.fn(async () =>
      enabledModelIds.map((id) => ({ modelId: id, enabled: true })),
    ),
  };
  const services = {
    configStore,
    priceCache: {
      getPrices: vi.fn(async () => prices),
      putPrices: vi.fn(async () => {}),
    },
    bedrockClient: new BedrockClient({}),
    logger: new Logger({ serviceName: "test" }),
  } as unknown as SaveAgentModelCatalogEntryServices;
  return { services, configStore };
}

beforeEach(() => {
  mockBedrock.reset();
  mockBedrock
    .on(GetFoundationModelCommand)
    .rejects(
      new ResourceNotFoundException({ message: "not found", $metadata: {} }),
    )
    .on(GetFoundationModelCommand, { modelIdentifier: modelId })
    .resolves({ modelDetails: sonnetDetails });
});

describe("saveAgentModelCatalogEntry — create", () => {
  const create = (overrides = {}) => ({
    entry: {
      kind: "create" as const,
      modelId,
      modelType: "foundation-model" as const,
      enabled: true,
      ...overrides,
    },
    editedBy,
    region,
  });

  it("stores only Bedrock's metadata and returns the stored price", async () => {
    const { services, configStore } = makeServices([price]);

    const result = await saveAgentModelCatalogEntry(create(), services);

    expect(configStore.putModelRow).toHaveBeenCalledWith(
      {
        modelId,
        displayName: "Claude Sonnet 4.6",
        provider: "Anthropic",
        availability: "global",
        modelType: "foundation-model",
        foundationModelId: modelId,
        foundationModelName: "Claude Sonnet 4.6",
        enabled: true,
      },
      editedBy,
    );
    expect(result).toEqual({ row, price });
  });

  it("throws AgentModelNotEligibleError, before reading prices, for a model Bedrock does not know", async () => {
    const { services, configStore } = makeServices([price]);

    await expect(
      saveAgentModelCatalogEntry(
        create({ modelId: "unknown.model-v1" }),
        services,
      ),
    ).rejects.toBeInstanceOf(AgentModelNotEligibleError);
    expect(services.priceCache.getPrices).not.toHaveBeenCalled();
    expect(configStore.putModelRow).not.toHaveBeenCalled();
  });

  it("throws ModelNotPricedError and writes nothing when enabling an unpriced model", async () => {
    const { services, configStore } = makeServices([]);

    await expect(
      saveAgentModelCatalogEntry(create(), services),
    ).rejects.toBeInstanceOf(ModelNotPricedError);
    expect(configStore.putModelRow).not.toHaveBeenCalled();
  });

  it("passes a ConflictError through when the row already exists", async () => {
    const { services, configStore } = makeServices([price]);
    configStore.putModelRow.mockRejectedValue(new ConflictError("exists"));

    await expect(
      saveAgentModelCatalogEntry(create(), services),
    ).rejects.toBeInstanceOf(ConflictError);
  });

  it("creates a disabled model that has no stored price", async () => {
    const { services, configStore } = makeServices([]);

    const result = await saveAgentModelCatalogEntry(
      create({ enabled: false }),
      services,
    );

    expect(configStore.putModelRow).toHaveBeenCalledOnce();
    expect(result.price).toBeUndefined();
  });
});

describe("saveAgentModelCatalogEntry — update", () => {
  const update = (enabled: boolean) => ({
    entry: {
      kind: "update" as const,
      modelId,
      enabled,
      expectedLastEditTime: "2026-11-01T00:00:00.000Z",
    },
    editedBy,
    region,
  });

  it("changes only enabled, under OCC, without reading Bedrock", async () => {
    const { services, configStore } = makeServices([price]);

    const result = await saveAgentModelCatalogEntry(update(true), services);

    expect(configStore.updateModelAdminFields).toHaveBeenCalledWith(
      modelId,
      { enabled: true },
      editedBy,
      "2026-11-01T00:00:00.000Z",
    );
    expect(mockBedrock.calls()).toHaveLength(0);
    expect(result).toEqual({ row, price });
  });

  it("throws ModelNotPricedError and writes nothing when enabling an unpriced model", async () => {
    const { services, configStore } = makeServices([]);

    await expect(
      saveAgentModelCatalogEntry(update(true), services),
    ).rejects.toBeInstanceOf(ModelNotPricedError);
    expect(configStore.updateModelAdminFields).not.toHaveBeenCalled();
  });

  it("disables an unpriced model", async () => {
    const { services, configStore } = makeServices([]);

    await saveAgentModelCatalogEntry(update(false), services);

    expect(configStore.updateModelAdminFields).toHaveBeenCalledOnce();
  });

  it("checks the last enabled model with strongly consistent reads", async () => {
    const { services, configStore } = makeServices([price]);

    await saveAgentModelCatalogEntry(update(false), services);

    expect(configStore.getAgentModels).toHaveBeenCalledWith({
      consistentRead: true,
    });
    expect(configStore.getSection).toHaveBeenCalledWith("agent", {
      consistentRead: true,
    });
  });

  it("throws LastEnabledModelError and writes nothing when disabling the only enabled model while Sandbox Spaces is on", async () => {
    const { services, configStore } = makeServices([price], {
      sandboxSpacesEnabled: true,
    });

    await expect(
      saveAgentModelCatalogEntry(update(false), services),
    ).rejects.toThrow(
      new LastEnabledModelError(
        "Keep at least one model enabled while Sandbox Spaces is turned on.",
      ),
    );
    expect(configStore.updateModelAdminFields).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "Sandbox Spaces is off",
      sandboxSpacesEnabled: false,
      enabledModelIds: [modelId],
    },
    {
      label: "another model stays enabled",
      sandboxSpacesEnabled: true,
      enabledModelIds: [modelId, "amazon.nova-pro-v1:0"],
    },
  ])(
    "disables the model when $label",
    async ({ sandboxSpacesEnabled, enabledModelIds }) => {
      const { services, configStore } = makeServices([price], {
        sandboxSpacesEnabled,
        enabledModelIds,
      });

      await saveAgentModelCatalogEntry(update(false), services);

      expect(configStore.updateModelAdminFields).toHaveBeenCalledOnce();
    },
  );

  it("passes a stale-token ConflictError through", async () => {
    const { services, configStore } = makeServices([price]);
    configStore.updateModelAdminFields.mockRejectedValue(
      new ConflictError("stale"),
    );

    await expect(
      saveAgentModelCatalogEntry(update(true), services),
    ).rejects.toBeInstanceOf(ConflictError);
  });
});

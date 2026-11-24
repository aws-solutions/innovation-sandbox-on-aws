// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Sandbox Agent typed adapter over the generated aggregate `IsbClient`. The
// shared transport (signed client, CloudFront handler, JSend error
// normalization) lives in `helpers/isbApiClient`; this file is only the
// domain-specific command call and output mapping, matching every other
// migrated domain's shape.
import { DateTime } from "luxon";

import {
  AgentHistoryResponse as SmithyAgentHistoryResponse,
  AgentModelCatalogEntry as SmithyAgentModelCatalogEntry,
  AgentModelInfo,
  GetSandboxSpacesUsageCommand,
  IsbClient,
  ListAgentHistoryCommand,
  ListAgentModelCatalogCommand,
  ListAgentModelsCommand,
  PutAgentModelCatalogEntryCommand,
  SandboxSpacesUsageData,
  SandboxSpacesUserSpend,
} from "@amzn/innovation-sandbox-api-client";
import {
  type SandboxSpacesUsageView,
  SandboxSpacesUsageViewSchema,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/model";
import {
  AgentHistoryResponse,
  AgentModel,
  AgentModelCatalogEntry,
  AgentModelCatalogUpsert,
  AgentModelDiscoveryEntry,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import { AgentHistoryResponseSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

import { normalizeSmithyError } from "../../helpers/isbApiClient";

export {
  CloudFrontFetchHttpHandler,
  createIsbClient as createSandboxAgentClient,
} from "../../helpers/isbApiClient";

function toIsoString(value: Date | undefined): string | undefined {
  return value === undefined
    ? undefined
    : (DateTime.fromJSDate(value, { zone: "utc" }).toISO() ?? undefined);
}

function toAgentHistoryResponse(
  response: SmithyAgentHistoryResponse,
): AgentHistoryResponse {
  return AgentHistoryResponseSchema.parse({
    ...response,
    messages: response.messages?.map((message) => ({
      ...message,
      createdAt: toIsoString(message.createdAt),
    })),
  });
}

function mapSandboxSpacesUserSpend(spend: SandboxSpacesUserSpend) {
  return {
    userId: spend.userId,
    sandboxSpacesEstimatedTokenCostAccrued:
      spend.sandboxSpacesEstimatedTokenCostAccrued,
  } satisfies Record<keyof SandboxSpacesUserSpend, unknown>;
}

function mapSandboxSpacesUsage(usage: SandboxSpacesUsageData) {
  return {
    spendByUsers: usage.spendByUsers?.map(mapSandboxSpacesUserSpend),
  } satisfies Record<keyof SandboxSpacesUsageData, unknown>;
}

/** Maps a generated model to `AgentModel`, dropping rows with no id. */
function toAgentModel(model: AgentModelInfo): AgentModel | undefined {
  if (!model.modelId) return undefined;
  return {
    modelId: model.modelId,
    displayName: model.displayName ?? model.modelId,
    provider: model.provider ?? undefined,
    availability: model.availability ?? undefined,
    description: model.description ?? undefined,
  };
}

/**
 * Maps a live discovery row to the admin `AgentModelDiscoveryEntry`, dropping
 * rows with no id or `modelType`. Carries the identity, `modelType` discriminator, and rate
 * fields the create upsert needs; `pricingRefreshedAt` is normalized from a
 * Date to an ISO string.
 */
function toDiscoveryEntry(
  model: AgentModelInfo,
): AgentModelDiscoveryEntry | undefined {
  // A row with no modelType could never be created: the backend requires it.
  if (!model.modelId || !model.modelType) return undefined;
  return {
    modelId: model.modelId,
    displayName: model.displayName ?? model.modelId,
    provider: model.provider ?? "",
    availability: model.availability ?? "",
    description: model.description ?? undefined,
    modelType: model.modelType,
    foundationModelId: model.foundationModelId ?? undefined,
    foundationModelName: model.foundationModelName ?? undefined,
    pricingSource: model.pricingSource ?? undefined,
    pricingRefreshedAt: toIsoString(model.pricingRefreshedAt),
    inputPricePer1KTokens: model.inputPricePer1KTokens ?? undefined,
    outputPricePer1KTokens: model.outputPricePer1KTokens ?? undefined,
    cacheReadPricePer1KTokens: model.cacheReadPricePer1KTokens ?? undefined,
    cacheWritePricePer1KTokens: model.cacheWritePricePer1KTokens ?? undefined,
  };
}

/**
 * Maps a persisted catalog row to the frontend `AgentModelCatalogEntry`,
 * dropping rows missing an id or the OCC envelope (a row with no
 * `meta.lastEditTime` could not be safely toggled). The four required audit
 * fields (`enabled`, `addedAt`, `lastSavedBy`, `meta`) are guaranteed present
 * by the model, so a row missing them is a contract violation, not a valid state.
 */
function toCatalogEntry(
  model: SmithyAgentModelCatalogEntry,
): AgentModelCatalogEntry | undefined {
  if (!model.modelId || !model.meta?.lastEditTime || !model.meta.createdTime) {
    return undefined;
  }
  return {
    modelId: model.modelId,
    displayName: model.displayName ?? model.modelId,
    provider: model.provider ?? "",
    availability: model.availability ?? "",
    description: model.description ?? undefined,
    modelType: model.modelType ?? undefined,
    foundationModelId: model.foundationModelId ?? undefined,
    foundationModelName: model.foundationModelName ?? undefined,
    pricingSource: model.pricingSource ?? undefined,
    pricingRefreshedAt: model.pricingRefreshedAt ?? undefined,
    inputPricePer1KTokens: model.inputPricePer1KTokens ?? undefined,
    outputPricePer1KTokens: model.outputPricePer1KTokens ?? undefined,
    cacheReadPricePer1KTokens: model.cacheReadPricePer1KTokens ?? undefined,
    cacheWritePricePer1KTokens: model.cacheWritePricePer1KTokens ?? undefined,
    enabled: model.enabled ?? false,
    addedAt: model.addedAt ?? "",
    lastSavedBy: model.lastSavedBy ?? "",
    meta: {
      createdTime: model.meta.createdTime,
      lastEditTime: model.meta.lastEditTime,
    },
  };
}

export interface SmithySandboxAgentApi {
  listHistory(
    leaseId: string | undefined,
    nextToken?: string,
    maxResults?: number,
  ): Promise<AgentHistoryResponse>;
  /** Estimated Sandbox Spaces token spend per user on one lease. */
  getSandboxSpacesUsage(leaseId: string): Promise<SandboxSpacesUsageView>;
  listModels(): Promise<AgentModel[]>;

  /** Live Bedrock discovery for the admin enable-models flow. */
  discoverModels(): Promise<AgentModelDiscoveryEntry[]>;

  /** Every persisted catalog row (all pages), for the admin catalog table. */
  listCatalog(): Promise<AgentModelCatalogEntry[]>;

  /** Create or toggle one catalog row (omit `expectedLastEditTime` to create). */
  putCatalogEntry(
    input: AgentModelCatalogUpsert,
  ): Promise<AgentModelCatalogEntry>;
}

export class SmithySandboxAgentClient implements SmithySandboxAgentApi {
  constructor(private readonly client: IsbClient) {}

  async listHistory(
    leaseId: string | undefined,
    nextToken?: string,
    maxResults?: number,
  ): Promise<AgentHistoryResponse> {
    try {
      const output = await this.client.send(
        new ListAgentHistoryCommand({ leaseId, nextToken, maxResults }),
      );
      if (!output.data) {
        throw new Error("History response did not contain data");
      }
      return toAgentHistoryResponse(output.data);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async getSandboxSpacesUsage(
    leaseId: string,
  ): Promise<SandboxSpacesUsageView> {
    try {
      const output = await this.client.send(
        new GetSandboxSpacesUsageCommand({ leaseId }),
      );
      if (!output.data) {
        throw new Error("Usage response did not contain data");
      }
      return SandboxSpacesUsageViewSchema.parse(
        mapSandboxSpacesUsage(output.data),
      );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listModels(): Promise<AgentModel[]> {
    try {
      const output = await this.client.send(new ListAgentModelsCommand({}));
      if (!output.data) {
        throw new Error("ListAgentModels response did not contain data");
      }
      return (output.data.models ?? [])
        .map(toAgentModel)
        .filter((m): m is AgentModel => m !== undefined);
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async discoverModels(): Promise<AgentModelDiscoveryEntry[]> {
    try {
      const output = await this.client.send(new ListAgentModelsCommand({}));
      return (output.data?.models ?? [])
        .map(toDiscoveryEntry)
        .filter(
          (model): model is AgentModelDiscoveryEntry => model !== undefined,
        );
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async listCatalog(): Promise<AgentModelCatalogEntry[]> {
    try {
      const entries: AgentModelCatalogEntry[] = [];
      let nextToken: string | undefined;
      // Follow nextToken until absent to retrieve the full catalog, per the
      // ListAgentModelCatalog contract.
      do {
        const output = await this.client.send(
          new ListAgentModelCatalogCommand({ nextToken }),
        );
        for (const model of output.data?.models ?? []) {
          const entry = toCatalogEntry(model);
          if (entry !== undefined) {
            entries.push(entry);
          }
        }
        nextToken = output.data?.nextToken ?? undefined;
      } while (nextToken !== undefined);
      return entries;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }

  async putCatalogEntry(
    input: AgentModelCatalogUpsert,
  ): Promise<AgentModelCatalogEntry> {
    try {
      const output = await this.client.send(
        new PutAgentModelCatalogEntryCommand(input),
      );
      if (!output.data) {
        throw new Error("Catalog entry response did not contain data");
      }
      const entry = toCatalogEntry(output.data);
      if (entry === undefined) {
        throw new Error("Catalog entry response was missing required fields");
      }
      return entry;
    } catch (error) {
      throw normalizeSmithyError(error);
    }
  }
}

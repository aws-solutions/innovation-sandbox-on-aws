// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from "@aws-lambda-powertools/logger";
import type { BedrockClient } from "@aws-sdk/client-bedrock";

import type {
  BedrockPriceCache,
  BedrockRegionalPrice,
  PricingSource,
} from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/bedrock-price-cache.js";
import {
  AgentModelType,
  PersistedAgentModelCatalogRow,
} from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { ConfigStore } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { InnovationSandboxError } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import type { BedrockPricingServices } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/bedrock-model-catalog.types.js";
import { AgentConfig } from "@amzn/innovation-sandbox-shared/types/configuration.js";

export type { AgentModelType };

export interface FetchAgentModelsWithPricingServices extends BedrockPricingServices {
  /**
   * The cache of Bedrock prices by model and region. A price cached in `region`
   * under 24 hours ago is used as it is; the missing or stale ones are fetched
   * and saved.
   */
  priceCache: BedrockPriceCache;
}

export interface ResolveEligibleAgentModelProps {
  modelId: string;
  modelType: AgentModelType;
}

export interface ResolveEligibleAgentModelServices {
  bedrockClient: BedrockClient;
  logger: Logger;
}

export interface AgentModelWithPricing {
  modelId: string;
  displayName: string;
  provider: string;
  availability: string;
  description?: string;
  modelType: AgentModelType;
  foundationModelId: string;
  foundationModelName: string;
  /** The price fields are absent for a model that could not be priced. */
  pricingSource?: PricingSource;
  pricingRefreshedAt?: Date;
  inputPricePer1KTokens?: number;
  outputPricePer1KTokens?: number;
  cacheReadPricePer1KTokens?: number;
  cacheWritePricePer1KTokens?: number;
}

export interface FetchAgentModelsWithPricingResult {
  models: AgentModelWithPricing[];
}

export class AgentModelDiscoveryError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelDiscoveryError";
  }
}

export class ModelNotPricedError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "ModelNotPricedError";
  }
}

/** Bedrock has no model of the requested ID and type that Sandbox Spaces can use. */
export class AgentModelNotEligibleError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "AgentModelNotEligibleError";
  }
}

/** Disabling this model would leave Sandbox Spaces on with no enabled model. */
export class LastEnabledModelError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "LastEnabledModelError";
  }
}

export interface StoredModelPricesServices {
  priceCache: BedrockPriceCache;
}

/** Adds a model to the catalog; Bedrock supplies every stored field. */
export interface CreateAgentModelCatalogEntry {
  kind: "create";
  modelId: string;
  modelType: AgentModelType;
  enabled: boolean;
}

/** Changes an existing row's enabled state under OCC. */
export interface UpdateAgentModelCatalogEntry {
  kind: "update";
  modelId: string;
  enabled: boolean;
  expectedLastEditTime: string;
}

export interface SaveAgentModelCatalogEntryProps {
  entry: CreateAgentModelCatalogEntry | UpdateAgentModelCatalogEntry;
  editedBy: string;
  region: string;
}

export interface SaveAgentModelCatalogEntryServices
  extends StoredModelPricesServices, ResolveEligibleAgentModelServices {
  configStore: ConfigStore;
}

export interface SaveAgentModelCatalogEntryResult {
  row: PersistedAgentModelCatalogRow;
  /** The model's stored price in `region`, when it has one. */
  price?: BedrockRegionalPrice;
}

export interface GetStoredModelPricesProps {
  modelIds: string[];
  region: string;
}

export interface RequireStoredModelPriceProps {
  modelId: string;
  region: string;
}

// ─── Catalog gate ───────────────────────────────────────────────────────────
// The persisted catalog (not live Bedrock discovery) is the source of truth for
// which models are enabled. These types back the gates that resolve global
// enablement and constrain lease-template model selection to enabled rows.

export interface GetEnabledAgentModelIdsServices {
  configStore: ConfigStore;
}

export interface IsSandboxSpacesGloballyEnabledProps {
  agentConfig: AgentConfig;
  enabledModelIds: string[];
}

export interface ValidateTemplateAllowedModelIdsProps {
  /** The template's requested model subset; `undefined` inherits the global enabled set. */
  allowedModelIds: string[] | undefined;
  enabledModelIds: string[];
  /**
   * The model subset already permitted by the previous template revision, if
   * any. Newly-added IDs must be enabled; IDs already permitted are grandfathered
   * so an unrelated edit is not blocked after a model is later disabled.
   */
  previousAllowedModelIds?: string[];
}

export interface TemplateAllowedModelIdsValidationResult {
  isValid: boolean;
  /**
   * Requested model IDs not enabled in the catalog. Populated only when invalid.
   * Safe to log server-side; never surfaced to the client verbatim.
   */
  invalidModelIds: string[];
}

export interface ValidateTemplateDefaultModelIdProps {
  defaultModelId: string | undefined;
  /**
   * The template's model subset. When defined and non-empty the default must be
   * one of these IDs; when `undefined` the template inherits the global enabled
   * set and the default is validated against the enabled catalog instead.
   */
  allowedModelIds: string[] | undefined;
  enabledModelIds: string[];
}

export interface TemplateDefaultModelIdValidationResult {
  isValid: boolean;
  /**
   * Why the default was rejected, for server-side logging only. Never surfaced
   * to the client verbatim (it would disclose which models exist).
   */
  reason?: "not-enabled" | "not-in-allowed-subset";
}

export interface ValidateRequestedModelIdProps {
  requestedModelId: string;
  enabledModelIds: string[];
  /**
   * The lease's denormalized model subset snapshot. `undefined` inherits the
   * global enabled set, so only the catalog gate applies; a defined subset
   * further constrains the request to those IDs.
   */
  leaseAllowedModelIds: string[] | undefined;
}

export interface RequestedModelIdValidationResult {
  isValid: boolean;
  /**
   * Why the request was rejected, for server-side logging only. Never surfaced
   * to the client verbatim (it would disclose which models exist).
   */
  reason?: "not-enabled" | "not-in-lease-subset";
}

/**
 * Which catalog models a lease may use. A lease with no `allowedModelIds`
 * inherits the whole enabled catalog; one with a list is limited to those IDs.
 */
export type LeaseModelAccess =
  { mode: "ALL" } | { mode: "SELECTED"; modelIds: string[] };

export interface LeaseSelectableModel {
  modelId: string;
  displayName: string;
  provider: string;
}

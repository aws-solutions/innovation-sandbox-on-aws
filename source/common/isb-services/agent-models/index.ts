// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export {
  discoverEligibleAgentModels,
  fetchAgentModelsWithPricing,
  resolveEligibleAgentModel,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.service.js";

export {
  assertSandboxSpacesModelSelection,
  getEnabledAgentModelIds,
  isSandboxSpacesGloballyEnabled,
  leaseModelAccess,
  selectableModelsForLeaseAccess,
  validateRequestedModelId,
  validateTemplateAllowedModelIds,
  validateTemplateDefaultModelId,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/catalog-gate.js";
export { saveAgentModelCatalogEntry } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/model-catalog.service.js";
export {
  getStoredModelPrices,
  requireStoredModelPrice,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/model-prices.service.js";

export type {
  AgentModelWithPricing,
  CreateAgentModelCatalogEntry,
  FetchAgentModelsWithPricingResult,
  FetchAgentModelsWithPricingServices,
  GetEnabledAgentModelIdsServices,
  GetStoredModelPricesProps,
  IsSandboxSpacesGloballyEnabledProps,
  LeaseModelAccess,
  LeaseSelectableModel,
  RequestedModelIdValidationResult,
  RequireStoredModelPriceProps,
  ResolveEligibleAgentModelProps,
  ResolveEligibleAgentModelServices,
  SaveAgentModelCatalogEntryProps,
  SaveAgentModelCatalogEntryResult,
  SaveAgentModelCatalogEntryServices,
  StoredModelPricesServices,
  TemplateAllowedModelIdsValidationResult,
  TemplateDefaultModelIdValidationResult,
  UpdateAgentModelCatalogEntry,
  ValidateRequestedModelIdProps,
  ValidateTemplateAllowedModelIdsProps,
  ValidateTemplateDefaultModelIdProps,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";

export {
  AgentModelDiscoveryError,
  AgentModelNotEligibleError,
  LastEnabledModelError,
  ModelNotPricedError,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";

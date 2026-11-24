// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Sandbox Spaces catalog gates.
 *
 * The persisted model catalog is the source of truth for which models the
 * organization has enabled — live Bedrock discovery is used only by the admin
 * enable-models flow. These functions resolve the enabled set and enforce two
 * product rules:
 *  - Sandbox Spaces is globally enabled only when its config flag is on AND at
 *    least one catalog model is enabled.
 *  - A lease template's model subset may only reference enabled catalog rows.
 */

import { Logger } from "@aws-lambda-powertools/logger";

import { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { ConfigStore } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import {
  GetEnabledAgentModelIdsServices,
  IsSandboxSpacesGloballyEnabledProps,
  LeaseModelAccess,
  LeaseSelectableModel,
  RequestedModelIdValidationResult,
  TemplateAllowedModelIdsValidationResult,
  TemplateDefaultModelIdValidationResult,
  ValidateRequestedModelIdProps,
  ValidateTemplateAllowedModelIdsProps,
  ValidateTemplateDefaultModelIdProps,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { AgentConfig } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { Lease } from "@amzn/innovation-sandbox-shared/types/lease.js";

/** Returns the model IDs currently enabled in the persisted catalog. */
export async function getEnabledAgentModelIds(
  services: GetEnabledAgentModelIdsServices,
  options?: { consistentRead?: boolean },
): Promise<string[]> {
  const rows = await services.configStore.getAgentModels(options);
  return rows.filter((row) => row.enabled).map((row) => row.modelId);
}

/**
 * Whether Sandbox Spaces is usable: the global capability is enabled AND the
 * catalog has at least one enabled model. A deployment that has enabled the
 * capability but enabled no models is not yet usable.
 */
export function isSandboxSpacesGloballyEnabled(
  props: IsSandboxSpacesGloballyEnabledProps,
): boolean {
  const { agentConfig, enabledModelIds } = props;
  return agentConfig.sandboxSpacesEnabled && enabledModelIds.length > 0;
}

/**
 * Validates a lease template's model subset against the enabled catalog.
 * Change-aware: only newly-added IDs must be enabled, so an edit to an unrelated
 * field is not retroactively blocked after a model the template already permits
 * is later disabled (mirrors `validateFeatureGate`). An unset subset inherits
 * the global enabled set and is always valid.
 */
export function validateTemplateAllowedModelIds(
  props: ValidateTemplateAllowedModelIdsProps,
): TemplateAllowedModelIdsValidationResult {
  const { allowedModelIds, enabledModelIds, previousAllowedModelIds } = props;

  if (allowedModelIds === undefined) {
    return { isValid: true, invalidModelIds: [] };
  }

  const enabled = new Set(enabledModelIds);
  const previouslyPermitted = new Set(previousAllowedModelIds ?? []);

  const invalidModelIds = allowedModelIds.filter(
    (modelId) => !previouslyPermitted.has(modelId) && !enabled.has(modelId),
  );

  return { isValid: invalidModelIds.length === 0, invalidModelIds };
}

/**
 * Not change-aware, unlike the subset gate: new chats preselect the default,
 * so a disabled one must be replaced on the next save.
 */
export function validateTemplateDefaultModelId(
  props: ValidateTemplateDefaultModelIdProps,
): TemplateDefaultModelIdValidationResult {
  const { defaultModelId, allowedModelIds, enabledModelIds } = props;

  if (defaultModelId === undefined) {
    return { isValid: true };
  }

  if (!enabledModelIds.includes(defaultModelId)) {
    return { isValid: false, reason: "not-enabled" };
  }

  if (
    allowedModelIds !== undefined &&
    allowedModelIds.length > 0 &&
    !allowedModelIds.includes(defaultModelId)
  ) {
    return { isValid: false, reason: "not-in-allowed-subset" };
  }

  return { isValid: true };
}

/**
 * Validates a single per-turn requested model ID at the chat routing boundary.
 * The request must reference an enabled catalog model; when the lease carries a
 * model subset it must also be one of those IDs. An unset lease subset inherits
 * the global enabled set, so only the catalog check applies. Result-based so the
 * caller decides how to surface the rejection without leaking the ID to clients.
 */
export function validateRequestedModelId(
  props: ValidateRequestedModelIdProps,
): RequestedModelIdValidationResult {
  const { requestedModelId, enabledModelIds, leaseAllowedModelIds } = props;

  if (!enabledModelIds.includes(requestedModelId)) {
    return { isValid: false, reason: "not-enabled" };
  }

  if (
    leaseAllowedModelIds !== undefined &&
    !leaseAllowedModelIds.includes(requestedModelId)
  ) {
    return { isValid: false, reason: "not-in-lease-subset" };
  }

  return { isValid: true };
}

function toSelectableModel({
  modelId,
  displayName,
  provider,
}: PersistedAgentModelCatalogRow): LeaseSelectableModel {
  return { modelId, displayName, provider };
}

/**
 * The one place a lease's `allowedModelIds` is interpreted: absent means the
 * lease inherits the whole enabled catalog.
 */
export function leaseModelAccess(
  lease: Pick<Lease, "allowedModelIds">,
): LeaseModelAccess {
  return lease.allowedModelIds === undefined
    ? { mode: "ALL" }
    : { mode: "SELECTED", modelIds: lease.allowedModelIds };
}

/**
 * Picker entries for a lease: the enabled catalog models its access allows.
 * Set-valued counterpart of `validateRequestedModelId`; same rule, so a model
 * offered here is one the per-turn gate will accept.
 */
export function selectableModelsForLeaseAccess(
  access: LeaseModelAccess,
  catalogRows: PersistedAgentModelCatalogRow[],
): LeaseSelectableModel[] {
  const enabled = catalogRows.filter((row) => row.enabled);
  if (access.mode === "ALL") {
    return enabled.map(toSelectableModel);
  }
  const selected = new Set(access.modelIds);
  return enabled
    .filter((row) => selected.has(row.modelId))
    .map(toSelectableModel);
}

/**
 * The subset check is change-aware via `previousAllowedModelIds`, so an
 * unrelated edit is not blocked after an already-permitted model is later
 * disabled. Messages name no model ID (avoids echoing request input); details
 * are logged server-side.
 */
export async function assertSandboxSpacesModelSelection(props: {
  resource: "template" | "lease";
  agentConfig: AgentConfig;
  allowedModelIds: string[] | undefined;
  previousAllowedModelIds: string[] | undefined;
  defaultModelId: string | undefined;
  configStore: ConfigStore;
  logger: Logger;
}): Promise<void> {
  const {
    resource,
    agentConfig,
    allowedModelIds,
    previousAllowedModelIds,
    defaultModelId,
    configStore,
    logger,
  } = props;
  const resourceLabel = resource === "template" ? "lease template" : "lease";

  const checksDefault =
    agentConfig.sandboxSpacesEnabled && defaultModelId !== undefined;
  const selectsModels = Boolean(allowedModelIds && allowedModelIds.length > 0);
  if (!selectsModels && !checksDefault) {
    return;
  }

  const enabledModelIds = await getEnabledAgentModelIds({ configStore });

  if (selectsModels) {
    const allowedResult = validateTemplateAllowedModelIds({
      allowedModelIds,
      enabledModelIds,
      previousAllowedModelIds,
    });
    if (!allowedResult.isValid) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: ${resourceLabel} selected models not enabled in catalog`,
        { invalidModelIds: allowedResult.invalidModelIds },
      );
      throw new ValidationException(
        "One or more selected models are not enabled in the model catalog. Refresh the model list and choose from the enabled models.",
      );
    }
  }

  if (!checksDefault) {
    return;
  }

  const defaultResult = validateTemplateDefaultModelId({
    defaultModelId,
    allowedModelIds,
    enabledModelIds,
  });
  if (!defaultResult.isValid) {
    logger.warn(
      `${LogPatterns.DataValidationWarning.pattern}: ${resourceLabel} default model rejected`,
      { reason: defaultResult.reason },
    );
    throw new ValidationException(
      defaultResult.reason === "not-enabled"
        ? "Default model is disabled. Choose a different default model."
        : "Default model must be one of the selected models.",
      { field: "defaultModelId" },
    );
  }
}

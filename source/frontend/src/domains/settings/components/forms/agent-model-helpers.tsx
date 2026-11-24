// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/** Shared display and input helpers for agent model catalog tables. */

import type {
  AgentModelCatalogEntry,
  AgentModelCatalogUpsert,
  AgentModelDiscoveryEntry,
  AgentModelType,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

export const MODEL_TYPE_INFERENCE_PROFILE = "Inference profile";
export const MODEL_TYPE_FOUNDATION_MODEL = "Foundation model";

/**
 * Human-readable label for a discovered model's type. Reads the authoritative
 * `modelType` discriminator (`inference-profile` vs `foundation-model`) that
 * Bedrock discovery supplies. Falls back to the foundation-model label when the
 * field is absent (e.g. a pre-`modelType` row).
 */
export function formatModelType(model: { modelType?: AgentModelType }): string {
  return model.modelType === "inference-profile"
    ? MODEL_TYPE_INFERENCE_PROFILE
    : MODEL_TYPE_FOUNDATION_MODEL;
}

/** Formats a per-1K-token price. Values below $0.0001 show as `<$0.0001`
 * to avoid misleading precision. Returns `—` when absent. */
export function formatTokenPrice(value: number | undefined): string {
  if (value === undefined) return "—";
  if (value === 0) return "$0.0000";
  if (value < 0.0001) return "<$0.0001";
  return `$${value.toFixed(4)}`;
}

/**
 * Returns the Cloudscape color token for catalog-row cell text.
 * Disabled rows use the inactive color; enabled rows inherit the default.
 */
export function catalogCellColor(
  enabled: boolean | undefined,
): "inherit" | "text-status-inactive" {
  return enabled ? "inherit" : "text-status-inactive";
}

/**
 * True when the model has a price. A model the server could not price comes
 * back without any price fields, and it cannot be enabled.
 */
export function hasPrice(
  model: Pick<
    AgentModelCatalogEntry | AgentModelDiscoveryEntry,
    "inputPricePer1KTokens" | "outputPricePer1KTokens"
  >,
): boolean {
  return (
    model.inputPricePer1KTokens !== undefined &&
    model.outputPricePer1KTokens !== undefined
  );
}

/**
 * Builds the client-controlled fields for a catalog create or toggle. A create
 * (no `expectedLastEditTime`) carries the model's `modelType` so the backend
 * knows which Bedrock record to look up; a toggle must not carry it. The
 * overloads make a create without `modelType` a compile error.
 */
export function buildUpsertInput(
  model: { modelId: string; modelType: AgentModelType },
  options: { enabled: boolean; expectedLastEditTime?: string },
): AgentModelCatalogUpsert;
export function buildUpsertInput(
  model: { modelId: string },
  options: { enabled: boolean; expectedLastEditTime: string },
): AgentModelCatalogUpsert;
export function buildUpsertInput(
  model: { modelId: string; modelType?: AgentModelType },
  options: { enabled: boolean; expectedLastEditTime?: string },
): AgentModelCatalogUpsert {
  if (options.expectedLastEditTime) {
    return {
      modelId: model.modelId,
      enabled: options.enabled,
      expectedLastEditTime: options.expectedLastEditTime,
    };
  }
  return {
    modelId: model.modelId,
    enabled: options.enabled,
    modelType: model.modelType,
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import type { AgentModelDiscoveryEntry } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import {
  buildUpsertInput,
  catalogCellColor,
  formatModelType,
  formatTokenPrice,
  MODEL_TYPE_FOUNDATION_MODEL,
  MODEL_TYPE_INFERENCE_PROFILE,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/agent-model-helpers";

// A discovered model carrying pricing data (the shape passed to buildUpsertInput).
const discovered: AgentModelDiscoveryEntry = {
  modelId: "anthropic.claude-3-haiku-20240307-v1:0",
  displayName: "Claude 3 Haiku",
  provider: "Anthropic",
  availability: "global",
  description: "Fast model",
  modelType: "inference-profile",
  pricingSource: "agreement-offers",
  inputPricePer1KTokens: 0.001,
  outputPricePer1KTokens: 0.005,
  cacheReadPricePer1KTokens: 0.0001,
  cacheWritePricePer1KTokens: 0.0002,
};

describe("formatModelType", () => {
  it("returns 'Inference profile' for inference-profile modelType", () => {
    expect(formatModelType({ modelType: "inference-profile" })).toBe(
      MODEL_TYPE_INFERENCE_PROFILE,
    );
  });

  it("returns 'Foundation model' for foundation-model modelType", () => {
    expect(formatModelType({ modelType: "foundation-model" })).toBe(
      MODEL_TYPE_FOUNDATION_MODEL,
    );
  });

  it("regional inference profile correctly labeled via modelType", () => {
    expect(formatModelType({ modelType: "inference-profile" })).toBe(
      MODEL_TYPE_INFERENCE_PROFILE,
    );
  });

  it("returns 'Foundation model' when modelType is absent", () => {
    expect(formatModelType({ modelType: undefined })).toBe(
      MODEL_TYPE_FOUNDATION_MODEL,
    );
  });
});

describe("formatTokenPrice", () => {
  it("returns an em dash when the value is undefined", () => {
    expect(formatTokenPrice(undefined)).toBe("—");
  });

  it("formats a price to 4 decimals with a dollar sign", () => {
    expect(formatTokenPrice(0.001)).toBe("$0.0010");
    expect(formatTokenPrice(0)).toBe("$0.0000");
  });

  it("shows <$0.0001 for sub-threshold values instead of rounding to $0.0000", () => {
    expect(formatTokenPrice(0.000006)).toBe("<$0.0001");
    expect(formatTokenPrice(0.00009)).toBe("<$0.0001");
    expect(formatTokenPrice(0.0001)).toBe("$0.0001"); // exactly at threshold — 4 decimals
  });
});

describe("catalogCellColor", () => {
  it("inherits the default color for enabled rows", () => {
    expect(catalogCellColor(true)).toBe("inherit");
  });

  it("uses the inactive color for disabled or unknown rows", () => {
    expect(catalogCellColor(false)).toBe("text-status-inactive");
    expect(catalogCellColor(undefined)).toBe("text-status-inactive");
  });
});

describe("buildUpsertInput", () => {
  it("builds a first-insert request with only the model type", () => {
    expect(buildUpsertInput(discovered, { enabled: true })).toEqual({
      modelId: discovered.modelId,
      enabled: true,
      modelType: discovered.modelType,
    });
  });

  it("builds an update request with only its concurrency token", () => {
    expect(
      buildUpsertInput(discovered, {
        enabled: false,
        expectedLastEditTime: "2026-09-01T00:00:00.000Z",
      }),
    ).toEqual({
      modelId: discovered.modelId,
      enabled: false,
      expectedLastEditTime: "2026-09-01T00:00:00.000Z",
    });
  });
});

describe("formatModelType", () => {
  it("labels an inference profile", () => {
    expect(formatModelType({ modelType: "inference-profile" })).toBe(
      "Inference profile",
    );
  });

  it("labels a foundation model", () => {
    expect(formatModelType({ modelType: "foundation-model" })).toBe(
      "Foundation model",
    );
  });

  it("falls back to the foundation-model label when modelType is absent", () => {
    expect(formatModelType({ modelType: undefined })).toBe("Foundation model");
  });
});

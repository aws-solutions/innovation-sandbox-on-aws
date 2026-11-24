// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it, vi } from "vitest";

import { GetEnabledAgentModelIdsServices } from "@amzn/innovation-sandbox-commons/isb-services/agent-models/agent-models.types.js";
import {
  getEnabledAgentModelIds,
  isSandboxSpacesGloballyEnabled,
  leaseModelAccess,
  selectableModelsForLeaseAccess,
  validateRequestedModelId,
  validateTemplateAllowedModelIds,
  validateTemplateDefaultModelId,
} from "@amzn/innovation-sandbox-commons/isb-services/agent-models/catalog-gate.js";
import { AgentConfigSchema } from "@amzn/innovation-sandbox-shared/types/configuration.js";

function makeRow(modelId: string, enabled: boolean) {
  // Only the fields the gate reads are relevant; cast keeps the fixture terse.
  return { modelId, enabled } as never;
}

function makeServices(
  rows: ReturnType<typeof makeRow>[],
): GetEnabledAgentModelIdsServices {
  return {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    configStore: { getAgentModels: vi.fn().mockResolvedValue(rows) } as any,
  };
}

describe("getEnabledAgentModelIds", () => {
  it("returns only the enabled model IDs", async () => {
    const services = makeServices([
      makeRow("model-a", true),
      makeRow("model-b", false),
      makeRow("model-c", true),
    ]);

    await expect(getEnabledAgentModelIds(services)).resolves.toEqual([
      "model-a",
      "model-c",
    ]);
  });

  it("returns an empty list when no model is enabled", async () => {
    const services = makeServices([makeRow("model-a", false)]);
    await expect(getEnabledAgentModelIds(services)).resolves.toEqual([]);
  });
});

describe("isSandboxSpacesGloballyEnabled", () => {
  const enabled = AgentConfigSchema.parse({ sandboxSpacesEnabled: true });
  const disabled = AgentConfigSchema.parse({});

  it("is enabled when the capability is enabled and a model is enabled", () => {
    expect(
      isSandboxSpacesGloballyEnabled({
        agentConfig: enabled,
        enabledModelIds: ["m1"],
      }),
    ).toBe(true);
  });

  it("is disabled when the capability is enabled but no model is enabled", () => {
    expect(
      isSandboxSpacesGloballyEnabled({
        agentConfig: enabled,
        enabledModelIds: [],
      }),
    ).toBe(false);
  });

  it("is disabled when the capability is disabled even with an enabled model", () => {
    expect(
      isSandboxSpacesGloballyEnabled({
        agentConfig: disabled,
        enabledModelIds: ["m1"],
      }),
    ).toBe(false);
  });

  it("defaults to disabled", () => {
    expect(disabled.sandboxSpacesEnabled).toBe(false);
  });
});

describe("validateTemplateAllowedModelIds", () => {
  it("is valid when the subset is undefined (inherits the global set)", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: undefined,
        enabledModelIds: ["m1"],
      }),
    ).toEqual({ isValid: true, invalidModelIds: [] });
  });

  it("is valid for an empty subset (nothing selected)", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: [],
        enabledModelIds: [],
      }),
    ).toEqual({ isValid: true, invalidModelIds: [] });
  });

  it("is valid when every selected model is enabled", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: ["m1", "m2"],
        enabledModelIds: ["m1", "m2", "m3"],
      }),
    ).toEqual({ isValid: true, invalidModelIds: [] });
  });

  it("reports the models that are not enabled", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: ["m1", "disabled", "missing"],
        enabledModelIds: ["m1"],
      }),
    ).toEqual({ isValid: false, invalidModelIds: ["disabled", "missing"] });
  });

  it("rejects every selected model when the enabled set is empty", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: ["m1"],
        enabledModelIds: [],
      }),
    ).toEqual({ isValid: false, invalidModelIds: ["m1"] });
  });

  it("grandfathers a previously-permitted model that is now disabled (change-aware)", () => {
    // "grandfathered" was enabled when first added; disabling it must not block
    // an unrelated edit that keeps it in the subset.
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: ["grandfathered", "m2"],
        enabledModelIds: ["m2"],
        previousAllowedModelIds: ["grandfathered"],
      }),
    ).toEqual({ isValid: true, invalidModelIds: [] });
  });

  it("still rejects a newly-added model that is not enabled on update", () => {
    expect(
      validateTemplateAllowedModelIds({
        allowedModelIds: ["grandfathered", "newlyAddedDisabled"],
        enabledModelIds: ["m2"],
        previousAllowedModelIds: ["grandfathered"],
      }),
    ).toEqual({ isValid: false, invalidModelIds: ["newlyAddedDisabled"] });
  });
});

describe("validateTemplateDefaultModelId", () => {
  it("is valid when no default is chosen", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: undefined,
        allowedModelIds: ["m1"],
        enabledModelIds: ["m1"],
      }),
    ).toEqual({ isValid: true });
  });

  it("is valid when the default is one of the selected subset models", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "m2",
        allowedModelIds: ["m1", "m2"],
        enabledModelIds: ["m1", "m2"],
      }),
    ).toEqual({ isValid: true });
  });

  it("rejects a default outside the selected subset", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "m3",
        allowedModelIds: ["m1", "m2"],
        enabledModelIds: ["m1", "m2", "m3"],
      }),
    ).toEqual({ isValid: false, reason: "not-in-allowed-subset" });
  });

  it("rejects a disabled default even when the subset still carries it", () => {
    // The subset gate grandfathers "m1"; the default gate does not, because new
    // chats preselect the default.
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "m1",
        allowedModelIds: ["m1", "m2"],
        enabledModelIds: ["m2"],
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("reports not-enabled before not-in-allowed-subset when both apply", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "m3",
        allowedModelIds: ["m1", "m2"],
        enabledModelIds: ["m1", "m2"],
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("requires an enabled catalog model when the subset is unset (inherits global set)", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "m1",
        allowedModelIds: undefined,
        enabledModelIds: ["m1", "m2"],
      }),
    ).toEqual({ isValid: true });
  });

  it("rejects a disabled default when the subset is unset", () => {
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "disabled",
        allowedModelIds: undefined,
        enabledModelIds: ["m1"],
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("rejects a disabled default when the subset is empty", () => {
    // An empty subset behaves like an unset one (inherits the global set), so the
    // default is validated against the enabled catalog.
    expect(
      validateTemplateDefaultModelId({
        defaultModelId: "disabled",
        allowedModelIds: [],
        enabledModelIds: ["m1"],
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });
});

describe("validateRequestedModelId", () => {
  it("is valid when enabled and the lease has no subset (inherits enabled set)", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-a",
        enabledModelIds: ["model-a", "model-b"],
        leaseAllowedModelIds: undefined,
      }),
    ).toEqual({ isValid: true });
  });

  it("is valid when enabled and present in the lease subset", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-b",
        enabledModelIds: ["model-a", "model-b"],
        leaseAllowedModelIds: ["model-a", "model-b"],
      }),
    ).toEqual({ isValid: true });
  });

  it("rejects a model that is not in the enabled catalog", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-disabled",
        enabledModelIds: ["model-a"],
        leaseAllowedModelIds: undefined,
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("rejects an enabled model that is outside the lease subset", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-b",
        enabledModelIds: ["model-a", "model-b"],
        leaseAllowedModelIds: ["model-a"],
      }),
    ).toEqual({ isValid: false, reason: "not-in-lease-subset" });
  });

  it("prioritises the not-enabled reason when a disabled model is also outside the subset", () => {
    // A disabled model can never be a valid selection regardless of the subset,
    // so the catalog check is reported first.
    expect(
      validateRequestedModelId({
        requestedModelId: "model-disabled",
        enabledModelIds: ["model-a"],
        leaseAllowedModelIds: ["model-a"],
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("rejects every model when the enabled catalog is empty", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-a",
        enabledModelIds: [],
        leaseAllowedModelIds: undefined,
      }),
    ).toEqual({ isValid: false, reason: "not-enabled" });
  });

  it("rejects when the lease subset is empty (nothing permitted)", () => {
    expect(
      validateRequestedModelId({
        requestedModelId: "model-a",
        enabledModelIds: ["model-a"],
        leaseAllowedModelIds: [],
      }),
    ).toEqual({ isValid: false, reason: "not-in-lease-subset" });
  });
});

describe("leaseModelAccess", () => {
  it("is ALL when the lease has no allowedModelIds", () => {
    expect(leaseModelAccess({ allowedModelIds: undefined })).toEqual({
      mode: "ALL",
    });
  });

  it("is SELECTED with the lease's ids, including an empty list", () => {
    expect(leaseModelAccess({ allowedModelIds: ["m1"] })).toEqual({
      mode: "SELECTED",
      modelIds: ["m1"],
    });
    expect(leaseModelAccess({ allowedModelIds: [] })).toEqual({
      mode: "SELECTED",
      modelIds: [],
    });
  });
});

describe("selectableModelsForLeaseAccess", () => {
  function makeCatalogRow(
    modelId: string,
    enabled: boolean,
    extra: Record<string, unknown> = {},
  ) {
    return {
      modelId,
      enabled,
      displayName: `${modelId} name`,
      provider: "Anthropic",
      inputPricePer1KTokens: 1,
      ...extra,
    } as never;
  }

  const rows = [
    makeCatalogRow("model-a", true),
    makeCatalogRow("model-b", false),
    makeCatalogRow("model-c", true),
  ];

  it("returns every enabled model for ALL access", () => {
    expect(selectableModelsForLeaseAccess({ mode: "ALL" }, rows)).toEqual([
      {
        modelId: "model-a",
        displayName: "model-a name",
        provider: "Anthropic",
      },
      {
        modelId: "model-c",
        displayName: "model-c name",
        provider: "Anthropic",
      },
    ]);
  });

  it("narrows enabled models to the selected ids", () => {
    expect(
      selectableModelsForLeaseAccess(
        { mode: "SELECTED", modelIds: ["model-c", "model-unknown"] },
        rows,
      ).map((model) => model.modelId),
    ).toEqual(["model-c"]);
  });

  it("excludes a selected model that is no longer enabled", () => {
    expect(
      selectableModelsForLeaseAccess(
        { mode: "SELECTED", modelIds: ["model-b"] },
        rows,
      ),
    ).toEqual([]);
  });

  it("returns an empty list for an empty selection", () => {
    expect(
      selectableModelsForLeaseAccess({ mode: "SELECTED", modelIds: [] }, rows),
    ).toEqual([]);
  });

  it("agrees with validateRequestedModelId for every offered model", () => {
    const leaseAllowedModelIds = ["model-a", "model-b"];
    const enabledModelIds = rows
      .filter((row: { enabled: boolean }) => row.enabled)
      .map((row: { modelId: string }) => row.modelId);
    const offered = selectableModelsForLeaseAccess(
      leaseModelAccess({ allowedModelIds: leaseAllowedModelIds }),
      rows,
    );
    expect(offered.map((model) => model.modelId)).toEqual(["model-a"]);
    for (const model of offered) {
      expect(
        validateRequestedModelId({
          requestedModelId: model.modelId,
          enabledModelIds,
          leaseAllowedModelIds,
        }).isValid,
      ).toBe(true);
    }
  });
});

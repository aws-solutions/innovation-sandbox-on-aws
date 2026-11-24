// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

// Import shared validation schemas and factories
import {
  AccessAndSharingValidationSchema,
  BlueprintSelectionValidationSchema,
  BudgetSettingsValidationSchema,
  CostReportSettingsValidationSchema,
  createBlueprintSelectionValidationRefinement,
  createBudgetSettingsValidationRefinement,
  createCostReportSettingsValidationRefinement,
  createDurationSettingsValidationRefinement,
  DurationSettingsValidationSchema,
} from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { VisibilitySchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { FreeTextSchema } from "@amzn/innovation-sandbox-shared/utils/zod.js";

/**
 * Validation schemas for lease template forms.
 * Base schemas define field types and basic validation.
 * Config-based validation (required fields, global limits, cross-field rules) happens in .superRefine().
 */

export const BasicDetailsValidationSchema = z.object({
  name: z
    .string()
    .min(1, "Template name is required")
    .max(50, "Template name must be 50 characters or less"),
  description: FreeTextSchema.optional(),
  requiresApproval: z.boolean(),
  visibility: VisibilitySchema,
});

export const SANDBOX_SPACES_CONSTRAINTS = {
  ERROR_DEFAULT_MODEL_DISABLED:
    "Default model is disabled. Choose a different default model.",
  ERROR_DEFAULT_MODEL_NOT_SELECTED:
    "Default model must be one of the selected models.",
  ERROR_NO_MODELS_SELECTED:
    "Add at least one model, or turn off Limit available models.",
  ERROR_NO_ENABLED_MODELS_SELECTED:
    "None of the selected models are enabled. Add an enabled model, or turn off Limit available models.",
  SELECTED_MODELS_DISABLED: (modelNames: string[]) =>
    `Disabled models: ${modelNames.join(", ")}`,
  DEFAULT_MODEL_DISABLED: (modelName: string) => `${modelName} (disabled)`,
  DEFAULT_MODEL_DISABLED_HINT: "A different default model is needed.",
  DEFAULT_MODEL_DISABLED_DETAILS:
    "Globally disabled. Set a different model as the default or remove this one. An administrator can enable it again under Sandbox Spaces on the Settings page.",
  MODEL_DISABLED_DETAILS:
    "Globally disabled. Remove this model, or an administrator can enable it again under Sandbox Spaces on the Settings page.",
} as const;

export const SandboxSpacesValidationSchema = z.object({
  sandboxSpacesEnabled: z.boolean(),
  allowedModelIds: z.array(z.string()),
  // The model preselected for new chats. Part of the shared LeaseTemplate
  // contract; this wizard-step schema mirrors it so the cross-field rule below
  // can give inline feedback before submit.
  defaultModelId: z.string().optional(),
  // Set by the step on lease template and lease forms; listed so the parsed
  // submit values keep it.
  bedrockTokenMonitoringEnabled: z.boolean().optional(),
  // Form-only: whether users are limited to `allowedModelIds`. Not saved; an
  // empty selection is stored as "every enabled model".
  limitModels: z.boolean().optional(),
});

export const createSandboxSpacesValidationRefinement =
  (config: {
    enabledModelIds?: string[];
  }): ((
    values: z.infer<typeof SandboxSpacesValidationSchema>,
    ctx: z.RefinementCtx,
  ) => void) =>
  (values, ctx) => {
    // Turning Sandbox Spaces off must work even when no replacement default
    // exists; model fields are not saved then.
    if (!values.sandboxSpacesEnabled) {
      return;
    }
    const { enabledModelIds } = config;
    // An empty selection is saved as "every enabled model", so limiting to
    // nothing would silently allow everything.
    if (values.limitModels && values.allowedModelIds.length === 0) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedModelIds"],
        message: SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_MODELS_SELECTED,
      });
    } else if (
      values.limitModels &&
      enabledModelIds !== undefined &&
      !values.allowedModelIds.some((id) => enabledModelIds.includes(id))
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["allowedModelIds"],
        message: SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_ENABLED_MODELS_SELECTED,
      });
    }
    if (values.defaultModelId === undefined) {
      return;
    }
    if (
      config.enabledModelIds !== undefined &&
      !config.enabledModelIds.includes(values.defaultModelId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelId"],
        message: SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
      });
      return;
    }
    if (
      values.allowedModelIds.length > 0 &&
      !values.allowedModelIds.includes(values.defaultModelId)
    ) {
      ctx.addIssue({
        code: "custom",
        path: ["defaultModelId"],
        message: SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_NOT_SELECTED,
      });
    }
  };

/**
 * Combined validation schema for the lease template wizard.
 * Combines all form schemas and applies config-based validation via .superRefine().
 */
export const createLeaseTemplateWizardValidationSchema = (config: {
  globalMaxBudget?: number;
  requireMaxBudget?: boolean;
  globalMaxDurationHours?: number;
  requireMaxDuration?: boolean;
  requireCostReportGroup?: boolean;
  enabledModelIds?: string[];
}) => {
  return BasicDetailsValidationSchema.extend({
    ...BlueprintSelectionValidationSchema.shape,
    ...BudgetSettingsValidationSchema.shape,
    ...DurationSettingsValidationSchema.shape,
    ...CostReportSettingsValidationSchema.shape,
    ...SandboxSpacesValidationSchema.shape,
    ...AccessAndSharingValidationSchema.shape,
  })
    .superRefine(createBlueprintSelectionValidationRefinement())
    .superRefine(
      createBudgetSettingsValidationRefinement(
        config.globalMaxBudget,
        config.requireMaxBudget,
      ),
    )
    .superRefine(
      createDurationSettingsValidationRefinement(
        config.globalMaxDurationHours,
        config.requireMaxDuration,
      ),
    )
    .superRefine(
      createCostReportSettingsValidationRefinement(
        config.requireCostReportGroup,
      ),
    )
    .superRefine(
      createSandboxSpacesValidationRefinement({
        enabledModelIds: config.enabledModelIds,
      }),
    );
};

export const createSandboxSpacesEditValidationSchema = (config: {
  enabledModelIds?: string[];
}) =>
  SandboxSpacesValidationSchema.superRefine(
    createSandboxSpacesValidationRefinement(config),
  );

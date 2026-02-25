// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { VisibilitySchema } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { FreeTextSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
// Import shared validation schemas and factories
import {
  BlueprintSelectionValidationSchema,
  BudgetSettingsValidationSchema,
  CostReportSettingsValidationSchema,
  createBlueprintSelectionValidationRefinement,
  createBudgetSettingsValidationRefinement,
  createCostReportSettingsValidationRefinement,
  createDurationSettingsValidationRefinement,
  DurationSettingsValidationSchema,
} from "@amzn/innovation-sandbox-frontend/components/Forms/validation";

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

/**
 * Combined validation schema for the lease template wizard.
 * Merges all form schemas and applies config-based validation via .superRefine().
 */
export const createLeaseTemplateWizardValidationSchema = (config: {
  globalMaxBudget?: number;
  requireMaxBudget?: boolean;
  globalMaxDurationHours?: number;
  requireMaxDuration?: boolean;
  requireCostReportGroup?: boolean;
}) => {
  return BasicDetailsValidationSchema.merge(BlueprintSelectionValidationSchema)
    .merge(BudgetSettingsValidationSchema)
    .merge(DurationSettingsValidationSchema)
    .merge(CostReportSettingsValidationSchema)
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
    );
};

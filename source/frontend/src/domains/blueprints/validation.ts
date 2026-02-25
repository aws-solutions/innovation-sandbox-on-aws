// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Validation schemas for blueprint registration wizard.
 * Base schemas define field types and basic validation.
 * Combined wizard schema merges all steps for complete form validation.
 */

// Constants
export const BLUEPRINT_NAME_CONSTRAINTS = {
  MIN_LENGTH: 1,
  MAX_LENGTH: 50,
  CONSTRAINT_TEXT:
    "1-50 characters. Must start with a letter. Only letters, numbers, and hyphens allowed.",
  PATTERN: /^[a-zA-Z][a-zA-Z0-9-]{0,49}$/,
  ERROR_REQUIRED: "Blueprint name is required",
  ERROR_TOO_LONG: "Blueprint name must be 50 characters or less",
  ERROR_INVALID_FORMAT:
    "Blueprint name must start with a letter and contain only letters, numbers, and hyphens",
} as const;

export const BLUEPRINT_TAG_CONSTRAINTS = {
  MAX_TAGS: 10,
  KEY_MIN_LENGTH: 1,
  KEY_MAX_LENGTH: 128,
  VALUE_MAX_LENGTH: 256,
  // AWS-compatible character set, blocking only XSS-dangerous chars (<, >, ", ')
  // Allows: letters, numbers, space, and all AWS special chars except XSS vectors
  ALLOWED_CHARS_PATTERN: /^[a-zA-Z0-9_\-:./@ +=$%&*()[\]{}|\\!#^~?]+$/,
  KEY_CONSTRAINT_TEXT: "1-128 characters. Most characters allowed",
  VALUE_CONSTRAINT_TEXT: "0-256 characters (optional)",
  ERROR_KEY_EMPTY: "Tag key is required",
  ERROR_KEY_TOO_LONG: "Tag key must be 128 characters or less",
  ERROR_VALUE_TOO_LONG: "Tag value must be 256 characters or less",
  ERROR_INVALID_CHARS: "Invalid characters in tag",
  ERROR_AWS_PREFIX: "Tag key cannot start with 'aws:' (reserved by AWS)",
  ERROR_MAX_TAGS: "Maximum 10 tags allowed",
  ERROR_DUPLICATE_KEY: "Duplicate tag key",
} as const;

export const BLUEPRINT_DEPLOYMENT_TIMEOUT = {
  DEFAULT: 30,
  MIN: 5,
  MAX: 480,
  STEP: 5,
  REFERENCE_VALUES: [60, 120, 180, 240, 300, 360, 420, 480],
} as const;

export const CONCURRENT_PERCENTAGE_CONSTRAINTS = {
  MIN: 1,
  MAX: 100,
  STEP: 1,
  REFERENCE_VALUES: [25, 50, 75, 100],
} as const;

export const FAILURE_TOLERANCE_CONSTRAINTS = {
  MIN: 0,
  MAX: 100,
  STEP: 1,
  REFERENCE_VALUES: [0, 25, 50, 75, 100],
} as const;

// ============================================================================
// Base Schemas
// ============================================================================

/**
 * Step 1: Basic Details
 */
export const BasicDetailsValidationSchema = z.object({
  name: z
    .string()
    .min(
      BLUEPRINT_NAME_CONSTRAINTS.MIN_LENGTH,
      BLUEPRINT_NAME_CONSTRAINTS.ERROR_REQUIRED,
    )
    .max(
      BLUEPRINT_NAME_CONSTRAINTS.MAX_LENGTH,
      BLUEPRINT_NAME_CONSTRAINTS.ERROR_TOO_LONG,
    )
    .regex(
      BLUEPRINT_NAME_CONSTRAINTS.PATTERN,
      BLUEPRINT_NAME_CONSTRAINTS.ERROR_INVALID_FORMAT,
    ),
  tags: z
    .array(
      z.object({
        key: z
          .string()
          .min(
            BLUEPRINT_TAG_CONSTRAINTS.KEY_MIN_LENGTH,
            BLUEPRINT_TAG_CONSTRAINTS.ERROR_KEY_EMPTY,
          )
          .max(
            BLUEPRINT_TAG_CONSTRAINTS.KEY_MAX_LENGTH,
            BLUEPRINT_TAG_CONSTRAINTS.ERROR_KEY_TOO_LONG,
          )
          .regex(
            BLUEPRINT_TAG_CONSTRAINTS.ALLOWED_CHARS_PATTERN,
            BLUEPRINT_TAG_CONSTRAINTS.ERROR_INVALID_CHARS,
          )
          .refine((key) => !key.toLowerCase().startsWith("aws:"), {
            message: BLUEPRINT_TAG_CONSTRAINTS.ERROR_AWS_PREFIX,
          }),
        value: z
          .string()
          .max(
            BLUEPRINT_TAG_CONSTRAINTS.VALUE_MAX_LENGTH,
            BLUEPRINT_TAG_CONSTRAINTS.ERROR_VALUE_TOO_LONG,
          )
          .refine(
            (value) => {
              if (value === "" || value === undefined) return true;
              return BLUEPRINT_TAG_CONSTRAINTS.ALLOWED_CHARS_PATTERN.test(
                value,
              );
            },
            { message: BLUEPRINT_TAG_CONSTRAINTS.ERROR_INVALID_CHARS },
          )
          .optional(),
      }),
    )
    .default([])
    .refine((tags) => tags.length <= BLUEPRINT_TAG_CONSTRAINTS.MAX_TAGS, {
      message: BLUEPRINT_TAG_CONSTRAINTS.ERROR_MAX_TAGS,
    }),
});

/**
 * Creates validation super refinement for blueprint basic details
 */
export const createBasicDetailsValidationRefinement = () => {
  return (data: BasicDetailsFormValues, ctx: z.RefinementCtx) => {
    const keyIndices: Record<string, number[]> = {};

    // Build object of keys to their indices
    data.tags?.forEach(({ key }, index) => {
      keyIndices[key] ??= [];
      keyIndices[key].push(index);
    });

    // Add errors only to duplicate keys
    Object.values(keyIndices).forEach((indices) => {
      if (indices.length > 1) {
        indices.forEach((index) => {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: BLUEPRINT_TAG_CONSTRAINTS.ERROR_DUPLICATE_KEY,
            path: ["tags", index, "key"],
          });
        });
      }
    });
  };
};

/** Basic details validation schema with duplicate key validation applied via .superRefine() */
export const createBasicDetailsValidationSchema = () => {
  return BasicDetailsValidationSchema.superRefine(
    createBasicDetailsValidationRefinement(),
  );
};

/**
 * Step 2: StackSet Selection
 * Schema matches StackSet type from API response
 */
export const StackSetSelectionValidationSchema = z.object({
  selectedStackSet: z
    .object({
      stackSetName: z.string(),
      stackSetId: z.string(),
      description: z.string().optional(),
      status: z.enum(["ACTIVE", "DELETED", "DELETING"]),
      permissionModel: z
        .enum(["SERVICE_MANAGED", "SELF_MANAGED"])
        .nullable()
        .optional(),
    })
    .optional()
    .refine((val) => val !== undefined, {
      message: "Please select a StackSet",
    }),
});

/**
 * Step 3: Deployment Configuration
 */
export const DeploymentConfigurationValidationSchema = z.object({
  selectedRegions: z
    .array(z.string())
    .min(1, "At least one region is required"),
  deploymentTimeout: z
    .number({
      invalid_type_error: "Deployment timeout must be a number",
    })
    .min(
      BLUEPRINT_DEPLOYMENT_TIMEOUT.MIN,
      `Deployment timeout must be at least ${BLUEPRINT_DEPLOYMENT_TIMEOUT.MIN} minutes`,
    )
    .max(
      BLUEPRINT_DEPLOYMENT_TIMEOUT.MAX,
      `Deployment timeout must be at most ${BLUEPRINT_DEPLOYMENT_TIMEOUT.MAX} minutes`,
    ),
  deploymentStrategy: z.enum(["Default", "Custom"]),
  regionConcurrencyType: z.object({
    value: z.string(),
    label: z.string(),
    description: z.string().optional(),
  }),
  maxConcurrentPercentage: z
    .number({
      invalid_type_error: "Maximum concurrent percentage must be a number",
    })
    .min(1, "Maximum concurrent percentage must be at least 1%")
    .max(100, "Maximum concurrent percentage must be at most 100%"),
  failureTolerancePercentage: z
    .number({
      invalid_type_error: "Failure tolerance percentage must be a number",
    })
    .min(0, "Failure tolerance percentage must be at least 0%")
    .max(100, "Failure tolerance percentage must be at most 100%"),
  concurrencyMode: z.enum([
    "STRICT_FAILURE_TOLERANCE",
    "SOFT_FAILURE_TOLERANCE",
  ]),
});

// ============================================================================
// Combined Wizard Schema
// ============================================================================

/**
 * Creates the complete blueprint wizard validation schema.
 * Combines all step schemas with native Zod validation.
 */
export const createBlueprintWizardValidationSchema = () => {
  return BasicDetailsValidationSchema.merge(StackSetSelectionValidationSchema)
    .merge(DeploymentConfigurationValidationSchema)
    .superRefine(createBasicDetailsValidationRefinement());
};

// ============================================================================
// Edit Schemas
// ============================================================================

/**
 * Edit Deployment Configuration Schema
 * Reuses DeploymentConfigurationValidationSchema but excludes selectedRegions
 * (regions are not editable after blueprint registration)
 */
export const EditDeploymentConfigValidationSchema =
  DeploymentConfigurationValidationSchema.omit({
    selectedRegions: true,
  });

// ============================================================================
// Type Exports
// ============================================================================

export type BlueprintWizardFormValues = z.infer<
  ReturnType<typeof createBlueprintWizardValidationSchema>
>;

export type BasicDetailsFormValues = z.input<
  typeof BasicDetailsValidationSchema
>;
export type StackSetSelectionFormValues = z.infer<
  typeof StackSetSelectionValidationSchema
>;
export type DeploymentConfigurationFormValues = z.infer<
  typeof DeploymentConfigurationValidationSchema
>;
export type EditDeploymentConfigFormValues = z.infer<
  typeof EditDeploymentConfigValidationSchema
>;

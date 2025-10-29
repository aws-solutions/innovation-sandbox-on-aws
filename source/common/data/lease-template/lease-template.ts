// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { FreeTextSchema } from "@amzn/innovation-sandbox-commons/data/common-schemas.js";
import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseTemplateSchemaVersion = 2; // v1.1.0

// Define supported version range for backwards compatibility
const LeaseTemplateSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseTemplateSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const LeaseTemplateItemWithMetadataSchema = createItemWithMetadataSchema(
  LeaseTemplateSupportedVersionsSchema,
);

export const ThresholdActionSchema = z.enum(["ALERT", "FREEZE_ACCOUNT"]);

export const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"]);

export const BudgetThresholdSchema = z
  .object({
    dollarsSpent: z.number().gt(0),
    action: ThresholdActionSchema,
  })
  .strict();

export const BudgetConfigSchema = z
  .object({
    maxSpend: z.number().gt(0).optional(),
    budgetThresholds: z.array(BudgetThresholdSchema).optional(),
  })
  .strict();

export const DurationThresholdSchema = z
  .object({
    hoursRemaining: z.number().gt(0),
    action: ThresholdActionSchema,
  })
  .strict();

export const DurationConfigSchema = z
  .object({
    leaseDurationInHours: z.number().gt(0).optional(),
    durationThresholds: z.array(DurationThresholdSchema).optional(),
  })
  .strict();

export const LeaseTemplateSchema = z
  .object({
    uuid: z.string().uuid(),
    name: z.string().max(50).min(1),
    description: FreeTextSchema.optional(),
    requiresApproval: z.boolean(),
    createdBy: z.string().email(),
    visibility: VisibilitySchema.default("PUBLIC"),
    costReportGroup: z.string().min(1).max(50).optional(),
  })
  .merge(BudgetConfigSchema)
  .merge(DurationConfigSchema)
  .merge(LeaseTemplateItemWithMetadataSchema)
  .strict();

export type ThresholdAction = z.infer<typeof ThresholdActionSchema>;
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type DurationThreshold = z.infer<typeof DurationThresholdSchema>;
export type DurationConfig = z.infer<typeof DurationConfigSchema>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type LeaseTemplate = z.infer<typeof LeaseTemplateSchema>;

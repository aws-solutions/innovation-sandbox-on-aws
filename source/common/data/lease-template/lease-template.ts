// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  enumErrorMap,
  FreeTextSchema,
} from "@amzn/innovation-sandbox-commons/utils/zod.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseTemplateSchemaVersion = 3; // v1.2.0 - Added blueprintId support

// Define supported version range for backwards compatibility
const LeaseTemplateSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseTemplateSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const LeaseTemplateItemWithMetadataSchema = createItemWithMetadataSchema(
  LeaseTemplateSupportedVersionsSchema,
);

export const ThresholdActionSchema = z.enum(["ALERT", "FREEZE_ACCOUNT"], {
  errorMap: enumErrorMap,
});

export const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"], {
  errorMap: enumErrorMap,
});

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
    blueprintId: z.string().uuid().nullable().optional(), // References attached blueprint (null = no blueprint, undefined = field removed by DynamoDB transformation)
    blueprintName: z.string().nullable().optional(), // Resolved from blueprint store on create/update (not client-provided)
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

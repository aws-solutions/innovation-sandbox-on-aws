// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { enumErrorMap, FreeTextSchema } from "../utils/zod.js";
import { RateBasisSchema } from "./cost-history.js";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  PermissionSetArnSchema,
} from "./permission-set.js";

/**
 * Lease-template values shared by the API supplement validation, persistence
 * schema, and frontend model. Persistence-specific version bounds and UI-only
 * state do not belong in this module.
 */
export const ThresholdActionSchema = z.enum(["ALERT", "FREEZE_ACCOUNT"], {
  error: enumErrorMap,
});

export const ThresholdTriggerOnSchema = z.enum(["REPORTED", "PREDICTED"], {
  error: enumErrorMap,
});

export const VisibilitySchema = z.enum(["PUBLIC", "PRIVATE"], {
  error: enumErrorMap,
});

export const BudgetThresholdSchema = z.strictObject({
  dollarsSpent: z.number().gt(0),
  action: ThresholdActionSchema,
  triggerOn: ThresholdTriggerOnSchema.optional(),
});

export const MAX_RATE_LIMIT_ENTRIES = 10;

/**
 * One spend-rate limit: the measured rate of `basis` crossing `rate` USD per
 * hour or per day takes `action`. Several may share a basis and an action;
 * only an identical (basis, rate) pair is rejected, since it is one line.
 */
export const RateLimitEntrySchema = z.strictObject({
  basis: RateBasisSchema,
  rate: z.number().gt(0),
  action: ThresholdActionSchema,
});

export const RateLimitsSchema = z
  .array(RateLimitEntrySchema)
  .max(MAX_RATE_LIMIT_ENTRIES)
  .superRefine((entries, ctx) => {
    const seen = new Set<string>();
    entries.forEach((entry, index) => {
      const key = `${entry.basis}:${entry.rate}`;
      if (seen.has(key)) {
        ctx.addIssue({
          code: "custom",
          path: [index, "rate"],
          message: `duplicate rate limit: ${entry.basis} at ${entry.rate} is already set`,
        });
      }
      seen.add(key);
    });
  });

export const BudgetConfigSchema = z.strictObject({
  maxSpend: z.number().gt(0).optional(),
  budgetThresholds: z.array(BudgetThresholdSchema).optional(),
  rateLimits: RateLimitsSchema.optional(),
});

export const DurationThresholdSchema = z.strictObject({
  hoursRemaining: z.number().gt(0),
  action: ThresholdActionSchema,
});

export const DurationConfigSchema = z.strictObject({
  leaseDurationInHours: z.number().gt(0).optional(),
  durationThresholds: z.array(DurationThresholdSchema).optional(),
});

export const PermissionProfileConfigSchema = z.strictObject({
  defaultPermissionSetArn: PermissionSetArnSchema.optional(),
  allowedPermissionSetArns: z
    .array(PermissionSetArnSchema)
    .max(MAX_ALLOWED_PERMISSION_SETS)
    .optional(),
});

export const LeaseTemplateMetadataSchema = z.object({
  createdTime: z.iso.datetime().optional(),
  lastEditTime: z.iso.datetime().optional(),
  schemaVersion: z.number().int(),
});

export const LeaseTemplateWritableSchema = z.strictObject({
  name: z.string().max(50).min(1),
  description: FreeTextSchema.optional(),
  requiresApproval: z.boolean(),
  visibility: VisibilitySchema.default("PUBLIC"),
  costReportGroup: z.string().min(1).max(50).optional(),
  blueprintId: z.uuid().nullable().optional(),
  allowOwnerToShareLease: z.boolean().default(false),
  predictiveBudgetEnabled: z.boolean().default(false),
  bedrockTokenMonitoringEnabled: z.boolean().default(false),
  sandboxSpacesEnabled: z.boolean().default(false),
  // Unset inherits the globally enabled model set; leases snapshot this list.
  allowedModelIds: z.array(z.string().min(1).max(300)).max(100).optional(),
  // Sandbox Spaces default model, preselected first when a chat opens.
  defaultModelId: z.string().min(1).max(300).optional(),
  ...BudgetConfigSchema.shape,
  ...DurationConfigSchema.shape,
  ...PermissionProfileConfigSchema.shape,
});

export type ThresholdAction = z.infer<typeof ThresholdActionSchema>;
export type ThresholdTriggerOn = z.infer<typeof ThresholdTriggerOnSchema>;
export type BudgetThreshold = z.infer<typeof BudgetThresholdSchema>;
export type RateLimitEntry = z.infer<typeof RateLimitEntrySchema>;
export type BudgetConfig = z.infer<typeof BudgetConfigSchema>;
export type DurationThreshold = z.infer<typeof DurationThresholdSchema>;
export type DurationConfig = z.infer<typeof DurationConfigSchema>;
export type PermissionProfileConfig = z.infer<
  typeof PermissionProfileConfigSchema
>;
export type Visibility = z.infer<typeof VisibilitySchema>;
export type LeaseTemplateMetadata = z.infer<typeof LeaseTemplateMetadataSchema>;
export type LeaseTemplateWritable = z.infer<typeof LeaseTemplateWritableSchema>;

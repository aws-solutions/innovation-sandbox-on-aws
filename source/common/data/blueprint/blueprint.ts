// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { StackSetOperationStatus } from "@aws-sdk/client-cloudformation";
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
// Schema Version Changelog:
// v1 (2024-10-24): Initial blueprint schema with 3-item-type data model
//   - BlueprintItem: Core blueprint entity with aggregated health metrics
//   - StackSetItem: StackSet configuration per blueprint
//   - DeploymentHistoryItem: Deployment tracking with 90-day TTL
export const BlueprintSchemaVersion = 1;

// Define supported version range for backwards compatibility
const BlueprintSupportedVersionsSchema = createVersionRangeSchema(
  1,
  BlueprintSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const BlueprintItemWithMetadataSchema = createItemWithMetadataSchema(
  BlueprintSupportedVersionsSchema,
);

// Item type enumeration for the 3-item-type data model
export const ItemTypeSchema = z.enum(["BLUEPRINT", "STACKSET", "DEPLOYMENT"], {
  errorMap: enumErrorMap,
});

// Blueprint Item (Primary Blueprint Entity) - Sort Key Pattern: "blueprint"
export const BlueprintItemSchema = z
  .object({
    // Primary Keys (DynamoDB)
    PK: z.string(), // "bp#{blueprintId}"
    SK: z.literal("blueprint"), // Fixed value for blueprint-level data

    // Business Data Fields
    blueprintId: z.string().uuid(),
    itemType: z.literal("BLUEPRINT"),

    // Blueprint name validation follows AWS CloudFormation StackSet naming pattern
    // Pattern: ^[a-zA-Z][a-zA-Z0-9-]{0,49}$
    // - Must start with a letter
    // - Can contain letters, numbers, and hyphens
    // - Maximum 50 characters (ISB constraint, AWS allows 128)
    name: z
      .string()
      .min(1, "Blueprint name is required")
      .max(50, "Blueprint name must be 50 characters or less")
      .regex(
        /^[a-zA-Z][a-zA-Z0-9-]{0,49}$/,
        "Blueprint name must start with a letter and contain only letters, numbers, and hyphens",
      ),
    tags: z
      .record(
        z
          .string()
          .min(1)
          .max(128)
          .regex(/^[a-zA-Z0-9_\-:./@ +=$%&*()[\]{}|\\!#^~?]+$/)
          .refine((key) => !key.toLowerCase().startsWith("aws:")),
        z
          .string()
          .max(256)
          .regex(/^[a-zA-Z0-9_\-:./@ +=$%&*()[\]{}|\\!#^~?]*$/),
      )
      .refine((tags) => Object.keys(tags).length <= 10)
      .optional(),
    createdBy: z.string().email(),
    deploymentTimeoutMinutes: z.number().min(5).max(480).default(30),

    regionConcurrencyType: z.enum(["SEQUENTIAL", "PARALLEL"], {
      errorMap: enumErrorMap,
    })
      .default("SEQUENTIAL"),

    // Aggregated Health Metrics (computed from all StackSets)
    totalHealthMetrics: z
      .object({
        totalDeploymentCount: z.number().default(0),
        totalSuccessfulCount: z.number().default(0),
        lastDeploymentAt: z.string().datetime().optional(),
      })
      .default({
        totalDeploymentCount: 0,
        totalSuccessfulCount: 0,
      }),
  })
  .merge(BlueprintItemWithMetadataSchema)
  .strict();

// StackSet Configuration Item - Sort Key Pattern: "stackset#{stackSetId}"
export const StackSetItemSchema = z
  .object({
    // Primary Keys (DynamoDB)
    PK: z.string(), // "bp#{blueprintId}" - Same partition as blueprint item
    SK: z.string(), // "stackset#{stackSetId}"

    // Business Data Fields
    blueprintId: z.string().uuid(),
    itemType: z.literal("STACKSET"),

    // StackSet-Specific Configuration
    stackSetId: z.string().min(1),
    administrationRoleArn: z.string().min(1),
    executionRoleName: z.string().min(1),
    regions: z
      .array(z.string())
      .min(1, "At least one region is required")
      .refine((regions) => new Set(regions).size === regions.length, {
        message:
          "Duplicate regions are not allowed. Each region must be unique.",
      }),
    deploymentOrder: z.number().min(1).default(1),

    // Deployment Configuration
    maxConcurrentPercentage: z.number().int().min(1).max(100).default(100),
    failureTolerancePercentage: z.number().int().min(0).max(100).default(0),
    concurrencyMode: z
      .enum(["STRICT_FAILURE_TOLERANCE", "SOFT_FAILURE_TOLERANCE"])
      .default("STRICT_FAILURE_TOLERANCE"),

    // Per-StackSet Health Metrics
    healthMetrics: z
      .object({
        deploymentCount: z.number().default(0),
        successfulDeploymentCount: z.number().default(0),
        lastFailureAt: z.string().datetime().optional(),
        lastSuccessAt: z.string().datetime().optional(),
        consecutiveFailures: z.number().default(0),
      })
      .default({
        deploymentCount: 0,
        successfulDeploymentCount: 0,
        consecutiveFailures: 0,
      }),
  })
  .merge(BlueprintItemWithMetadataSchema)
  .strict();

// Deployment History Item - Sort Key Pattern: "deployment#{timestamp}#{operationId}"
export const DeploymentHistoryItemSchema = z
  .object({
    // Primary Keys (DynamoDB)
    PK: z.string(), // "bp#{blueprintId}" - Same partition as blueprint item
    SK: z.string(), // "deployment#{timestamp}#{operationId}"

    // Business Data Fields
    itemType: z.literal("DEPLOYMENT"),

    // Deployment Identification
    stackSetId: z.string(),
    leaseId: z.string().uuid(),
    accountId: z.string(),

    // Deployment Status (matches CloudFormation StackSet operation status)
    status: z.enum(
      [
        StackSetOperationStatus.RUNNING,
        StackSetOperationStatus.SUCCEEDED,
        StackSetOperationStatus.FAILED,
        StackSetOperationStatus.QUEUED,
      ],
      {
        errorMap: enumErrorMap,
      },
    ),

    // CloudFormation Integration
    operationId: z.string(),

    // Timing Information
    deploymentStartedAt: z.string().datetime(),
    deploymentCompletedAt: z.string().datetime().optional(),
    duration: z.number().optional(), // Duration in minutes

    // Error Information (for failed deployments)
    errorType: z.string().optional(),
    errorMessage: z.string().optional(),

    // Automatic Cleanup (DynamoDB TTL)
    ttl: z.number(), // Unix timestamp for automatic deletion after 90 days
  })
  .merge(BlueprintItemWithMetadataSchema)
  .strict();

// Composite types for API responses
export const BlueprintWithStackSetsSchema = z.object({
  blueprint: BlueprintItemSchema,
  stackSets: z.array(StackSetItemSchema),
  recentDeployments: z.array(DeploymentHistoryItemSchema).optional(),
});

// Type exports
export type ItemType = z.infer<typeof ItemTypeSchema>;
export type BlueprintItem = z.infer<typeof BlueprintItemSchema>;
export type StackSetItem = z.infer<typeof StackSetItemSchema>;
export type DeploymentHistoryItem = z.infer<typeof DeploymentHistoryItemSchema>;
export type BlueprintWithStackSets = z.infer<
  typeof BlueprintWithStackSetsSchema
>;

// Union type for all blueprint table items
export type BlueprintTableItem =
  | BlueprintItem
  | StackSetItem
  | DeploymentHistoryItem;

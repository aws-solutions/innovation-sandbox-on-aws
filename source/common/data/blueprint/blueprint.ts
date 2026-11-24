// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { enumErrorMap } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  BlueprintItemSchema,
  DeploymentHistoryItemSchema,
  StackSetItemSchema,
} from "@amzn/innovation-sandbox-shared/types/blueprint.js";

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
const PersistedBlueprintItemWithMetadataSchema = createItemWithMetadataSchema(
  BlueprintSupportedVersionsSchema,
);

// Item type enumeration for the 3-item-type data model
export const PersistedBlueprintItemTypeSchema = z.enum(
  ["BLUEPRINT", "STACKSET", "DEPLOYMENT"],
  {
    error: enumErrorMap,
  },
);

export const PersistedBlueprintTableKeySchema = z.strictObject({
  PK: z.string(),
  SK: z.string(),
});

// Blueprint Item (Primary Blueprint Entity) - Sort Key Pattern: "blueprint"
export const PersistedBlueprintItemSchema = z.strictObject({
  // Primary Keys (DynamoDB)
  ...PersistedBlueprintTableKeySchema.shape,
  SK: z.literal("blueprint"), // Fixed value for blueprint-level data

  itemType: z.literal("BLUEPRINT"),
  ...BlueprintItemSchema.omit({ meta: true }).shape,
  ...PersistedBlueprintItemWithMetadataSchema.shape,
});

// StackSet Configuration Item - Sort Key Pattern: "stackset#{stackSetId}"
export const PersistedStackSetItemSchema = z.strictObject({
  // Primary Keys (DynamoDB)
  ...PersistedBlueprintTableKeySchema.shape,

  itemType: z.literal("STACKSET"),
  ...StackSetItemSchema.omit({ meta: true }).shape,
  ...PersistedBlueprintItemWithMetadataSchema.shape,
});

// Deployment History Item - Sort Key Pattern: "deployment#{timestamp}#{operationId}"
export const PersistedDeploymentHistoryItemSchema = z.strictObject({
  // Primary Keys (DynamoDB)
  ...PersistedBlueprintTableKeySchema.shape,

  itemType: z.literal("DEPLOYMENT"),
  ...DeploymentHistoryItemSchema.shape,
  // Automatic Cleanup (DynamoDB TTL)
  ttl: z.number(), // Unix timestamp for automatic deletion after 90 days

  ...PersistedBlueprintItemWithMetadataSchema.shape,
});

export const PersistedBlueprintListCursorSchema =
  PersistedBlueprintItemSchema.pick({
    PK: true,
    SK: true,
    itemType: true,
    blueprintId: true,
  });

// Composite types for API responses
export const PersistedBlueprintWithStackSetsSchema = z.object({
  blueprint: PersistedBlueprintItemSchema,
  stackSets: z.array(PersistedStackSetItemSchema),
  recentDeployments: z.array(PersistedDeploymentHistoryItemSchema).optional(),
});

// Type exports
export type PersistedBlueprintItemType = z.infer<
  typeof PersistedBlueprintItemTypeSchema
>;
export type PersistedBlueprintItem = z.infer<
  typeof PersistedBlueprintItemSchema
>;
export type PersistedStackSetItem = z.infer<typeof PersistedStackSetItemSchema>;
export type PersistedDeploymentHistoryItem = z.infer<
  typeof PersistedDeploymentHistoryItemSchema
>;
export type PersistedBlueprintWithStackSets = z.infer<
  typeof PersistedBlueprintWithStackSetsSchema
>;

// Union type for all blueprint table items
export type PersistedBlueprintTableItem =
  | PersistedBlueprintItem
  | PersistedStackSetItem
  | PersistedDeploymentHistoryItem;

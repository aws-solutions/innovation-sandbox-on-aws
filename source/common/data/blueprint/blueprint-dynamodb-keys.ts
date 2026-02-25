// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * DynamoDB Key Constants and Helper Functions for Blueprint Table
 *
 * The Blueprint table uses a 3-item-type data model with the following structure:
 *
 * Item Type 1: Blueprint (Core Entity)
 *   - PK: "bp#{blueprintId}"
 *   - SK: "blueprint"
 *
 * Item Type 2: StackSet Configuration
 *   - PK: "bp#{blueprintId}"
 *   - SK: "stackset#{stackSetId}"
 *
 * Item Type 3: Deployment History
 *   - PK: "bp#{blueprintId}"
 *   - SK: "deployment#{timestamp}#{operationId}"
 *
 * All items for a blueprint share the same partition key (PK) to enable
 * efficient querying of related data using sort key (SK) patterns.
 */

// Partition Key (PK) Prefix
export const BLUEPRINT_PK_PREFIX = "bp#";

// Sort Key (SK) Patterns
export const BLUEPRINT_SK = "blueprint";
export const STACKSET_SK_PREFIX = "stackset#";
export const DEPLOYMENT_SK_PREFIX = "deployment#";

/**
 * Generate partition key for a blueprint
 * @param blueprintId - UUID of the blueprint
 * @returns Formatted partition key: "bp#{blueprintId}"
 */
export function generateBlueprintPK(blueprintId: string): string {
  return `${BLUEPRINT_PK_PREFIX}${blueprintId}`;
}

/**
 * Generate sort key for a StackSet item
 * @param stackSetId - UUID of the StackSet
 * @returns Formatted sort key: "stackset#{stackSetId}"
 */
export function generateStackSetSK(stackSetId: string): string {
  return `${STACKSET_SK_PREFIX}${stackSetId}`;
}

/**
 * Generate sort key for a deployment history item
 * @param timestamp - ISO 8601 timestamp of deployment start
 * @param operationId - CloudFormation operation ID
 * @returns Formatted sort key: "deployment#{timestamp}#{operationId}"
 */
export function generateDeploymentSK(
  timestamp: string,
  operationId: string,
): string {
  return `${DEPLOYMENT_SK_PREFIX}${timestamp}#${operationId}`;
}

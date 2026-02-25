// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type {
  BlueprintItem,
  DeploymentHistoryItem,
  StackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

/**
 * Creates a test BlueprintItem with sensible defaults.
 * Override any fields as needed for specific test scenarios.
 */
export function createTestBlueprintItem(
  overrides?: Partial<BlueprintItem>,
): BlueprintItem {
  const blueprintId =
    overrides?.blueprintId ?? "650e8400-e29b-41d4-a716-446655440000";
  const now = nowAsIsoDatetimeString();

  return {
    PK: `bp#${blueprintId}`,
    SK: "blueprint",
    itemType: "BLUEPRINT",
    blueprintId,
    name: "Test-Blueprint",
    tags: {},
    createdBy: "test@example.com",
    deploymentTimeoutMinutes: 30,
    regionConcurrencyType: "SEQUENTIAL",
    totalHealthMetrics: {
      totalDeploymentCount: 0,
      totalSuccessfulCount: 0,
    },
    meta: {
      createdTime: now,
      lastEditTime: now,
      schemaVersion: 1,
    },
    ...overrides,
  };
}

/**
 * Creates a test StackSetItem with sensible defaults.
 * Override any fields as needed for specific test scenarios.
 */
export function createTestStackSetItem(
  overrides?: Partial<StackSetItem>,
): StackSetItem {
  const blueprintId =
    overrides?.blueprintId ?? "650e8400-e29b-41d4-a716-446655440000";
  const stackSetId =
    overrides?.stackSetId ??
    "test-stackset:12345678-1234-1234-1234-123456789012";
  const now = nowAsIsoDatetimeString();

  return {
    PK: `bp#${blueprintId}`,
    SK: `stackset#${stackSetId}`,
    itemType: "STACKSET",
    blueprintId,
    stackSetId,
    administrationRoleArn:
      "arn:aws:iam::123456789012:role/AWSCloudFormationStackSetAdministrationRole",
    executionRoleName: "AWSCloudFormationStackSetExecutionRole",
    regions: ["us-east-1"],
    deploymentOrder: 1,
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    healthMetrics: {
      deploymentCount: 0,
      successfulDeploymentCount: 0,
      consecutiveFailures: 0,
    },
    meta: {
      createdTime: now,
      lastEditTime: now,
      schemaVersion: 1,
    },
    ...overrides,
  };
}

/**
 * Creates a test DeploymentHistoryItem with sensible defaults.
 * Override any fields as needed for specific test scenarios.
 */
export function createTestDeploymentHistoryItem(
  overrides?: Partial<DeploymentHistoryItem>,
): DeploymentHistoryItem {
  const deploymentTimestamp =
    overrides?.deploymentStartedAt ?? "2024-01-15T10:00:00.000Z";
  const operationId =
    overrides?.operationId ?? "12345678-1234-1234-1234-123456789abc";
  const blueprintId = "650e8400-e29b-41d4-a716-446655440000";
  const now = nowAsIsoDatetimeString();

  return {
    PK: `bp#${blueprintId}`,
    SK: `deployment#${deploymentTimestamp}#${operationId}`,
    itemType: "DEPLOYMENT",
    stackSetId: "test-stackset:12345678-1234-1234-1234-123456789012",
    leaseId: "550e8400-e29b-41d4-a716-446655440000",
    accountId: "123456789012",
    operationId,
    status: "SUCCEEDED",
    deploymentStartedAt: deploymentTimestamp,
    duration: 300,
    ttl: Math.floor(Date.now() / 1000) + 90 * 24 * 60 * 60, // 90 days from now
    meta: {
      createdTime: now,
      lastEditTime: now,
      schemaVersion: 1,
    },
    ...overrides,
  };
}

/**
 * Creates multiple test BlueprintItems with sequential IDs.
 * Useful for testing list operations and pagination.
 */
export function createTestBlueprints(count: number): BlueprintItem[] {
  return Array.from({ length: count }, (_, i) =>
    createTestBlueprintItem({
      blueprintId: `650e8400-e29b-41d4-a716-44665544000${i}`,
      name: `Test-Blueprint-${i + 1}`,
    }),
  );
}

/**
 * Creates multiple test StackSetItems for a blueprint.
 * Useful for testing multi-stackset scenarios.
 */
export function createTestStackSets(
  blueprintId: string,
  count: number,
): StackSetItem[] {
  return Array.from({ length: count }, (_, i) =>
    createTestStackSetItem({
      blueprintId,
      stackSetId: `stackset-${i}:12345678-1234-1234-1234-12345678901${i}`,
      deploymentOrder: i + 1,
    }),
  );
}

/**
 * Creates multiple test DeploymentHistoryItems with sequential timestamps.
 * Useful for testing deployment history queries and pagination.
 */
export function createTestDeploymentHistory(
  blueprintId: string,
  count: number,
): DeploymentHistoryItem[] {
  return Array.from({ length: count }, (_, i) => {
    const day = String(15 - i).padStart(2, "0");
    const timestamp = `2024-01-${day}T10:00:00.000Z`;
    const operationId = `1234567${i}-1234-1234-1234-123456789abc`;

    return createTestDeploymentHistoryItem({
      PK: `bp#${blueprintId}`,
      deploymentStartedAt: timestamp,
      operationId,
      status: i % 3 === 0 ? "FAILED" : "SUCCEEDED",
    });
  });
}

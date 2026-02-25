// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Blueprint,
  BlueprintWithStackSets,
  DeploymentHistory,
  StackSet,
  StackSetConfig,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

export function createBlueprint(overrides?: Partial<Blueprint>): Blueprint {
  const now = new Date().toISOString();
  return {
    blueprintId: "12345678-1234-1234-1234-123456789012",
    name: "Test-Blueprint",
    tags: { environment: "test", team: "platform" },
    createdBy: "admin@example.com",
    deploymentTimeoutMinutes: 30,
    regionConcurrencyType: "SEQUENTIAL",
    totalHealthMetrics: {
      totalDeploymentCount: 10,
      totalSuccessfulCount: 8,
      lastDeploymentAt: now,
    },
    meta: {
      schemaVersion: 1,
      createdTime: now,
      lastEditTime: now,
    },
    ...overrides,
  };
}

export function createStackSetConfig(
  overrides?: Partial<StackSetConfig>,
): StackSetConfig {
  const now = new Date().toISOString();
  return {
    blueprintId: "12345678-1234-1234-1234-123456789012",
    stackSetId: "12345678-1234-1234-1234-123456789013",
    administrationRoleArn:
      "arn:aws:iam::123456789012:role/AWSCloudFormationStackSetAdministrationRole",
    executionRoleName: "AWSCloudFormationStackSetExecutionRole",
    regions: ["us-east-1", "us-west-2"],
    deploymentOrder: 1,
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    healthMetrics: {
      deploymentCount: 10,
      successfulDeploymentCount: 8,
      consecutiveFailures: 0,
      lastSuccessAt: now,
    },
    meta: {
      schemaVersion: 1,
      createdTime: now,
      lastEditTime: now,
    },
    ...overrides,
  };
}

export function createDeploymentHistory(
  overrides?: Partial<DeploymentHistory>,
): DeploymentHistory {
  const now = new Date().toISOString();
  return {
    stackSetId: "12345678-1234-1234-1234-123456789013",
    leaseId: "12345678-1234-1234-1234-123456789014",
    accountId: "123456789012",
    status: "SUCCEEDED",
    operationId: "12345678-1234-1234-1234-123456789015",
    deploymentStartedAt: now,
    deploymentCompletedAt: now,
    duration: 300,
    ...overrides,
  };
}

export function createBlueprintWithStackSets(
  overrides?: Partial<BlueprintWithStackSets>,
): BlueprintWithStackSets {
  const blueprint = createBlueprint();
  const stackSets = [createStackSetConfig()];
  const recentDeployments = [
    createDeploymentHistory(),
    createDeploymentHistory({
      status: "FAILED",
      errorType: "TIMEOUT",
      errorMessage: "Deployment timed out",
    }),
  ];

  return {
    blueprint,
    stackSets,
    recentDeployments,
    ...overrides,
  };
}

export function createStackSet(overrides?: Partial<StackSet>): StackSet {
  return {
    stackSetName: "TestStackSet",
    stackSetId: "12345678-1234-1234-1234-123456789013",
    description: "Test StackSet for blueprints",
    status: "ACTIVE",
    permissionModel: "SELF_MANAGED",
    ...overrides,
  };
}

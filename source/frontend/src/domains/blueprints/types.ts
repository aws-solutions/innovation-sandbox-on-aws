// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// ============================================================================
// Type Aliases - CloudFormation API Types
// ============================================================================

/**
 * CloudFormation StackSet region concurrency type (API format).
 * Controls whether regions are deployed sequentially or in parallel.
 */
export type RegionConcurrencyType = "SEQUENTIAL" | "PARALLEL";

/**
 * CloudFormation StackSet concurrency mode.
 * Controls how the concurrency level behaves when failures occur during deployment.
 */
export type ConcurrencyMode =
  | "STRICT_FAILURE_TOLERANCE"
  | "SOFT_FAILURE_TOLERANCE";

/**
 * CloudFormation StackSet permission model.
 * Note: May be null/undefined in member accounts due to AWS API limitation
 */
export type PermissionModel =
  | "SERVICE_MANAGED"
  | "SELF_MANAGED"
  | null
  | undefined;

// ============================================================================
// Type Aliases - Deployment Status Types
// ============================================================================

/**
 * Blueprint deployment status.
 */
export type DeploymentStatus = "RUNNING" | "SUCCEEDED" | "FAILED" | "QUEUED";

/**
 * CloudFormation StackSet status.
 */
export type StackSetStatus = "ACTIVE" | "DELETED" | "DELETING";

// ============================================================================
// Type Aliases - Frontend-Specific Types
// ============================================================================

/**
 * Deployment strategy presets for blueprint deployment configuration.
 * Used in the registration wizard to simplify deployment parameter selection.
 */
export type DeploymentStrategy = "Default" | "Custom";

/**
 * Region concurrency type for UI components (display format).
 * Note: API uses uppercase format (RegionConcurrencyType).
 * Use transformRegionConcurrencyTypeForApi() to convert between formats.
 */
export type RegionConcurrencyTypeUI = "Sequential" | "Parallel";

// ============================================================================
// Deployment Configuration Constants
// ============================================================================

/**
 * Region concurrency type options for UI.
 */
export const REGION_CONCURRENCY_OPTIONS = {
  SEQUENTIAL: {
    value: "Sequential" as const,
    label: "Sequential",
    description: "Deploy to one region at a time",
  },
  PARALLEL: {
    value: "Parallel" as const,
    label: "Parallel",
    description: "Deploy to all regions simultaneously",
  },
} as const;

/**
 * Concurrency mode options for UI.
 */
export const CONCURRENCY_MODE_OPTIONS = {
  STRICT: {
    value: "STRICT_FAILURE_TOLERANCE" as const,
    label: "Strict",
    description: "Reduces concurrency as failures occur",
  },
  SOFT: {
    value: "SOFT_FAILURE_TOLERANCE" as const,
    label: "Soft",
    description: "Maintains maximum concurrency",
  },
} as const;

/**
 * Get display label for concurrency mode (combines label and description).
 */
export const getConcurrencyModeLabel = (mode: ConcurrencyMode): string => {
  const option = Object.values(CONCURRENCY_MODE_OPTIONS).find(
    (opt) => opt.value === mode,
  );
  return option ? `${option.label}: ${option.description}` : mode;
};

// ============================================================================
// Deployment Configuration Types
// ============================================================================

/**
 * Deployment configuration returned by strategy presets.
 */
export interface DeploymentConfig {
  regionConcurrencyType: RegionConcurrencyTypeUI;
  maxConcurrentPercentage: number;
  failureTolerancePercentage: number;
  concurrencyMode: ConcurrencyMode;
}

/**
 * Complete deployment strategy configuration including UI labels and descriptions.
 */
export interface DeploymentStrategyConfig extends DeploymentConfig {
  label: string;
  description: string;
}

/**
 * Deployment strategy preset configurations.
 * Single source of truth for all strategy settings, labels, and descriptions.
 */
export const DEPLOYMENT_STRATEGY_CONFIGS: Record<
  DeploymentStrategy,
  DeploymentStrategyConfig
> = {
  Default: {
    regionConcurrencyType: "Sequential",
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    label: "Default",
    description:
      "Deploys one region at a time with 0% failure tolerance. Safest approach.",
  },
  Custom: {
    regionConcurrencyType: "Sequential",
    maxConcurrentPercentage: 100,
    failureTolerancePercentage: 0,
    concurrencyMode: "STRICT_FAILURE_TOLERANCE",
    label: "Custom",
    description: "Configure each deployment parameter individually",
  },
} as const;

// ============================================================================
// Interfaces
// ============================================================================

export interface Blueprint {
  blueprintId: string;
  name: string;
  tags: Record<string, string>;
  createdBy: string;
  deploymentTimeoutMinutes: number;
  regionConcurrencyType: RegionConcurrencyType;
  totalHealthMetrics: {
    totalDeploymentCount: number;
    totalSuccessfulCount: number;
    lastDeploymentAt?: string;
  };
  recentDeployments?: DeploymentHistory[];
  meta: {
    schemaVersion: number;
    createdTime: string;
    lastEditTime: string;
  };
}

export interface StackSetConfig {
  blueprintId: string;
  stackSetId: string;
  administrationRoleArn: string;
  executionRoleName: string;
  regions: string[];
  deploymentOrder: number;
  maxConcurrentPercentage: number;
  failureTolerancePercentage: number;
  concurrencyMode: ConcurrencyMode;
  healthMetrics: {
    deploymentCount: number;
    successfulDeploymentCount: number;
    lastFailureAt?: string;
    lastSuccessAt?: string;
    consecutiveFailures: number;
  };
  meta: {
    schemaVersion: number;
    createdTime: string;
    lastEditTime: string;
  };
}

export interface DeploymentHistory {
  stackSetId: string;
  leaseId: string;
  accountId: string;
  status: DeploymentStatus;
  operationId: string;
  deploymentStartedAt: string;
  deploymentCompletedAt?: string;
  duration?: number;
  errorType?: string;
  errorMessage?: string;
}

export interface BlueprintWithStackSets {
  blueprint: Blueprint;
  stackSets: StackSetConfig[];
  recentDeployments?: DeploymentHistory[];
}

export interface StackSet {
  stackSetName: string;
  stackSetId: string;
  description?: string;
  status: StackSetStatus;
  permissionModel?: PermissionModel | null;
}

export interface RegisterBlueprintRequest {
  name: string;
  stackSetId: string;
  regions: string[];
  tags?: Record<string, string>;
  deploymentTimeoutMinutes?: number;
  regionConcurrencyType?: RegionConcurrencyType;
  maxConcurrentPercentage?: number;
  failureTolerancePercentage?: number;
  concurrencyMode?: ConcurrencyMode;
}

export type UpdateBlueprintRequest =
  // Blueprint-level fields (from BlueprintItem)
  Partial<
    Pick<
      Blueprint,
      "name" | "tags" | "deploymentTimeoutMinutes" | "regionConcurrencyType"
    >
  > &
    // StackSet-level fields (from StackSetConfig)
    Partial<
      Pick<
        StackSetConfig,
        | "maxConcurrentPercentage"
        | "failureTolerancePercentage"
        | "concurrencyMode"
      >
    >;

export interface BlueprintListResponse {
  blueprints: BlueprintWithStackSets[];
  nextPageIdentifier?: string;
}

export interface BlueprintDetailResponse {
  blueprint: Blueprint;
  stackSets: StackSetConfig[];
  recentDeployments?: DeploymentHistory[];
}

export interface StackSetListResponse {
  result: StackSet[];
  nextPageIdentifier?: string;
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";
import { Duration } from "luxon";

import { MultiselectProps } from "@cloudscape-design/components";
import { BoxProps } from "@cloudscape-design/components/box";
import { IconProps } from "@cloudscape-design/components/icon";

import {
  Blueprint,
  BlueprintDetailResponse,
  DEPLOYMENT_STRATEGY_CONFIGS,
  DeploymentConfig,
  DeploymentStrategy,
  RegionConcurrencyType,
} from "./types";

export interface DeploymentStatusConfig {
  iconName: IconProps.Name;
  color: BoxProps.Color;
}

/**
 * Get Cloudscape Icon name and Box color for deployment status.
 */
export const getDeploymentStatusConfig = (
  status: string,
): DeploymentStatusConfig => {
  const configs: Record<string, DeploymentStatusConfig> = {
    SUCCEEDED: { iconName: "status-positive", color: "text-status-success" },
    FAILED: { iconName: "status-negative", color: "text-status-error" },
    RUNNING: { iconName: "status-in-progress", color: "text-status-info" },
    QUEUED: { iconName: "status-pending", color: "text-status-inactive" },
  };

  return (
    configs[status] || {
      iconName: "status-info",
      color: "text-status-inactive",
    }
  );
};

/**
 * Get human-readable display name for deployment status
 * Converts uppercase status values to proper case
 */
export const getDeploymentStatusDisplayName = (status: string): string => {
  const displayNames: Record<string, string> = {
    SUCCEEDED: "Succeeded",
    FAILED: "Failed",
    RUNNING: "Running",
    QUEUED: "Queued",
  };
  return displayNames[status] || status;
};

/**
 * Generate breadcrumb items for blueprint pages
 * Handles loading and error states gracefully
 */
export const generateBreadcrumb = (
  query: UseQueryResult<BlueprintDetailResponse | undefined, unknown>,
) => {
  const { data, isLoading, isError } = query;

  const breadcrumbItems = [
    { text: "Home", href: "/" },
    { text: "Blueprints", href: "/blueprints" },
  ];

  if (isLoading) {
    breadcrumbItems.push({ text: "Loading...", href: "#" });
    return breadcrumbItems;
  }

  if (isError || !data) {
    breadcrumbItems.push({ text: "Error", href: "#" });
    return breadcrumbItems;
  }

  breadcrumbItems.push({
    text: data.blueprint.name,
    href: `/blueprints/${data.blueprint.blueprintId}`,
  });

  return breadcrumbItems;
};

/**
 * Custom sorting comparator for deployment success rate
 * Sorts by success rate (higher success rate first)
 * Success rate = totalSuccessfulCount / totalDeploymentCount
 */
export const deploymentSuccessRateSortingComparator = (
  a: Blueprint,
  b: Blueprint,
): number => {
  const getSuccessRate = (blueprint: Blueprint): number => {
    const { totalDeploymentCount, totalSuccessfulCount } =
      blueprint.totalHealthMetrics;
    return totalDeploymentCount > 0
      ? totalSuccessfulCount / totalDeploymentCount
      : 0;
  };

  const successRateA = getSuccessRate(a);
  const successRateB = getSuccessRate(b);

  return successRateB - successRateA;
};

/**
 * Transform region concurrency type from UI format to API format.
 */
export const transformRegionConcurrencyTypeForApi = (
  uiValue: string,
): RegionConcurrencyType => {
  return uiValue.toUpperCase() as RegionConcurrencyType;
};

/**
 * Convert ISB-managed region codes to Multiselect options.
 * Displays region codes as-is (e.g., "us-east-1") without human-readable labels.
 * This avoids maintaining a static region list and handles new regions automatically.
 */
export const getRegionsMultiSelectOptions = (
  isbManagedRegions: string[],
): MultiselectProps.Option[] => {
  return isbManagedRegions.map((regionCode) => ({
    label: regionCode,
    value: regionCode,
  }));
};

/**
 * Format deployment success metrics for display as "X / Y" format.
 */
export const formatDeploymentSuccessMetrics = (
  successfulCount: number,
  totalCount: number,
): string => {
  if (totalCount === 0) {
    return "-";
  }
  return `${successfulCount} / ${totalCount}`;
};

/**
 * Format minutes as human-readable duration using luxon.
 * Examples: "30 minutes", "1 hour", "2 hours, 30 minutes"
 */
export const formatMinutesAsDuration = (minutes: number): string => {
  return Duration.fromObject({ minutes }).toHuman();
};

/**
 * Format minutes as compact duration for slider display.
 * Examples: "30 min", "1h", "2h 30m"
 */
export const formatMinutesAsCompactDuration = (minutes: number): string => {
  const hours = Math.floor(minutes / 60);
  const mins = minutes % 60;

  if (hours === 0) return `${minutes} min`;
  if (mins === 0) return `${hours}h`;
  return `${hours}h ${mins}m`;
};

/**
 * Get deployment configuration for a selected strategy.
 * Returns configuration from DEPLOYMENT_STRATEGY_CONFIGS constant.
 */
export const getDeploymentConfig = (
  strategy: DeploymentStrategy,
): DeploymentConfig => {
  return (
    DEPLOYMENT_STRATEGY_CONFIGS[strategy] || DEPLOYMENT_STRATEGY_CONFIGS.Default
  );
};

// ============================================================================
// StackSet Helpers
// ============================================================================

/**
 * Extract StackSet name from composite StackSet ID.
 * Composite format: "stackset-name:uuid-suffix"
 * Returns the name portion before the first colon, or the full ID if no colon.
 */
export const extractStackSetNameFromId = (stackSetId: string): string => {
  const parts = stackSetId.split(":");
  return parts[0] || stackSetId;
};

// ============================================================================
// Tag Validation
// ============================================================================

export interface TagItem {
  key: string;
  value?: string;
}

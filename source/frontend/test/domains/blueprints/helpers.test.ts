// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";
import { describe, expect, it } from "vitest";

import {
  deploymentSuccessRateSortingComparator,
  extractStackSetNameFromId,
  formatDeploymentSuccessMetrics,
  formatMinutesAsCompactDuration,
  formatMinutesAsDuration,
  generateBreadcrumb,
  getDeploymentConfig,
  getDeploymentStatusConfig,
  getDeploymentStatusDisplayName,
  getRegionsMultiSelectOptions,
  transformRegionConcurrencyTypeForApi,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import {
  BlueprintDetailResponse,
  getConcurrencyModeLabel,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { createBlueprint } from "@amzn/innovation-sandbox-frontend/mocks/factories/blueprintFactory";

describe("Blueprint Helpers", () => {
  describe("transformRegionConcurrencyTypeForApi", () => {
    it("should transform Sequential to SEQUENTIAL", () => {
      expect(transformRegionConcurrencyTypeForApi("Sequential")).toBe(
        "SEQUENTIAL",
      );
    });

    it("should transform Parallel to PARALLEL", () => {
      expect(transformRegionConcurrencyTypeForApi("Parallel")).toBe("PARALLEL");
    });

    it("should handle lowercase input", () => {
      expect(transformRegionConcurrencyTypeForApi("sequential")).toBe(
        "SEQUENTIAL",
      );
    });
  });

  describe("getRegionsMultiSelectOptions", () => {
    it("should convert region codes to Multiselect options", () => {
      const isbManaged = ["us-east-1", "us-west-2"];
      const filtered = getRegionsMultiSelectOptions(isbManaged);

      expect(filtered).toHaveLength(2);
      expect(filtered[0]).toEqual({ label: "us-east-1", value: "us-east-1" });
      expect(filtered[1]).toEqual({ label: "us-west-2", value: "us-west-2" });
    });

    it("should return empty array when no ISB-managed regions", () => {
      const filtered = getRegionsMultiSelectOptions([]);
      expect(filtered).toHaveLength(0);
    });

    it("should preserve input order from backend", () => {
      const isbManaged = ["us-west-2", "us-east-1", "eu-west-1"];
      const filtered = getRegionsMultiSelectOptions(isbManaged);

      expect(filtered[0].value).toBe("us-west-2");
      expect(filtered[1].value).toBe("us-east-1");
      expect(filtered[2].value).toBe("eu-west-1");
    });

    it("should use region code as both label and value", () => {
      const isbManaged = ["ap-southeast-1"];
      const filtered = getRegionsMultiSelectOptions(isbManaged);

      expect(filtered[0].label).toBe("ap-southeast-1");
      expect(filtered[0].value).toBe("ap-southeast-1");
    });

    it("should handle multiple regions", () => {
      const regions = ["us-east-1", "us-west-2", "eu-west-1", "ap-southeast-1"];
      const filtered = getRegionsMultiSelectOptions(regions);

      expect(filtered).toHaveLength(4);
      filtered.forEach((option, index) => {
        expect(option.label).toBe(regions[index]);
        expect(option.value).toBe(regions[index]);
      });
    });
  });

  describe("formatDeploymentSuccessMetrics", () => {
    it("should format success metrics as X / Y", () => {
      expect(formatDeploymentSuccessMetrics(5, 10)).toBe("5 / 10");
    });

    it("should return - when no deployments", () => {
      expect(formatDeploymentSuccessMetrics(0, 0)).toBe("-");
    });

    it("should handle 100% success rate", () => {
      expect(formatDeploymentSuccessMetrics(10, 10)).toBe("10 / 10");
    });

    it("should handle 0% success rate", () => {
      expect(formatDeploymentSuccessMetrics(0, 10)).toBe("0 / 10");
    });

    it("should handle single deployment success", () => {
      expect(formatDeploymentSuccessMetrics(1, 1)).toBe("1 / 1");
    });

    it("should handle single deployment failure", () => {
      expect(formatDeploymentSuccessMetrics(0, 1)).toBe("0 / 1");
    });

    it("should handle large numbers", () => {
      expect(formatDeploymentSuccessMetrics(999, 1000)).toBe("999 / 1000");
    });
  });

  describe("getDeploymentStatusConfig", () => {
    it.each([
      {
        status: "SUCCEEDED",
        iconName: "status-positive",
        color: "text-status-success",
      },
      {
        status: "FAILED",
        iconName: "status-negative",
        color: "text-status-error",
      },
      {
        status: "RUNNING",
        iconName: "status-in-progress",
        color: "text-status-info",
      },
      {
        status: "QUEUED",
        iconName: "status-pending",
        color: "text-status-inactive",
      },
    ])(
      "should return iconName=$iconName and color=$color for $status status",
      ({ status, iconName, color }) => {
        const config = getDeploymentStatusConfig(status);
        expect(config.iconName).toBe(iconName);
        expect(config.color).toBe(color);
      },
    );

    it("should return default config for unknown status", () => {
      const config = getDeploymentStatusConfig("UNKNOWN_STATUS");
      expect(config.iconName).toBe("status-info");
      expect(config.color).toBe("text-status-inactive");
    });
  });

  describe("getDeploymentStatusDisplayName", () => {
    it("should return 'Succeeded' for SUCCEEDED", () => {
      expect(getDeploymentStatusDisplayName("SUCCEEDED")).toBe("Succeeded");
    });

    it("should return 'Failed' for FAILED", () => {
      expect(getDeploymentStatusDisplayName("FAILED")).toBe("Failed");
    });

    it("should return 'Running' for RUNNING", () => {
      expect(getDeploymentStatusDisplayName("RUNNING")).toBe("Running");
    });

    it("should return 'Queued' for QUEUED", () => {
      expect(getDeploymentStatusDisplayName("QUEUED")).toBe("Queued");
    });

    it("should return original status for unknown status", () => {
      expect(getDeploymentStatusDisplayName("UNKNOWN")).toBe("UNKNOWN");
    });
  });

  describe("generateBreadcrumb", () => {
    it("should generate breadcrumb with loading state", () => {
      const mockQuery: UseQueryResult<
        BlueprintDetailResponse | undefined,
        unknown
      > = {
        data: undefined,
        isLoading: true,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Blueprints", href: "/blueprints" },
        { text: "Loading...", href: "#" },
      ]);
    });

    it("should generate breadcrumb with error state", () => {
      const mockQuery: UseQueryResult<
        BlueprintDetailResponse | undefined,
        unknown
      > = {
        data: undefined,
        isLoading: false,
        isError: true,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Blueprints", href: "/blueprints" },
        { text: "Error", href: "#" },
      ]);
    });

    it("should generate breadcrumb with blueprint data", () => {
      const mockBlueprint = createBlueprint({
        name: "TestBlueprint",
        blueprintId: "650e8400-e29b-41d4-a716-446655440001",
      });
      const mockQuery: UseQueryResult<
        BlueprintDetailResponse | undefined,
        unknown
      > = {
        data: {
          blueprint: mockBlueprint,
          stackSets: [],
          recentDeployments: [],
        },
        isLoading: false,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Blueprints", href: "/blueprints" },
        {
          text: "TestBlueprint",
          href: "/blueprints/650e8400-e29b-41d4-a716-446655440001",
        },
      ]);
    });

    it("should handle undefined blueprint data", () => {
      const mockQuery: UseQueryResult<
        BlueprintDetailResponse | undefined,
        unknown
      > = {
        data: undefined,
        isLoading: false,
        isError: false,
      } as any;

      const breadcrumbs = generateBreadcrumb(mockQuery);

      expect(breadcrumbs).toEqual([
        { text: "Home", href: "/" },
        { text: "Blueprints", href: "/blueprints" },
        { text: "Error", href: "#" },
      ]);
    });
  });

  describe("deploymentSuccessRateSortingComparator", () => {
    it("should sort by success rate descending (higher first)", () => {
      const blueprintA = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 10,
          totalSuccessfulCount: 8, // 80% success
        },
      });
      const blueprintB = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 10,
          totalSuccessfulCount: 5, // 50% success
        },
      });

      const result = deploymentSuccessRateSortingComparator(
        blueprintA,
        blueprintB,
      );
      expect(result).toBeLessThan(0); // A should come before B
    });

    it("should handle blueprints with no deployments", () => {
      const blueprintA = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 0,
          totalSuccessfulCount: 0, // 0% (no deployments)
        },
      });
      const blueprintB = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 10,
          totalSuccessfulCount: 5, // 50% success
        },
      });

      const result = deploymentSuccessRateSortingComparator(
        blueprintA,
        blueprintB,
      );
      expect(result).toBeGreaterThan(0); // B should come before A
    });

    it("should handle equal success rates", () => {
      const blueprintA = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 10,
          totalSuccessfulCount: 5, // 50% success
        },
      });
      const blueprintB = createBlueprint({
        totalHealthMetrics: {
          totalDeploymentCount: 20,
          totalSuccessfulCount: 10, // 50% success
        },
      });

      const result = deploymentSuccessRateSortingComparator(
        blueprintA,
        blueprintB,
      );
      expect(result).toBe(0); // Equal
    });
  });

  describe("getDeploymentConfig", () => {
    it("should return default configuration", () => {
      const config = getDeploymentConfig("Default");

      expect(config.regionConcurrencyType).toBe("Sequential");
      expect(config.maxConcurrentPercentage).toBe(100);
      expect(config.failureTolerancePercentage).toBe(0);
      expect(config.concurrencyMode).toBe("STRICT_FAILURE_TOLERANCE");
    });

    it("should return custom default configuration", () => {
      const config = getDeploymentConfig("Custom");

      expect(config.regionConcurrencyType).toBe("Sequential");
      expect(config.maxConcurrentPercentage).toBe(100);
      expect(config.failureTolerancePercentage).toBe(0);
      expect(config.concurrencyMode).toBe("STRICT_FAILURE_TOLERANCE");
    });

    it("should return default configuration for unknown strategy (fallback)", () => {
      const config = getDeploymentConfig("unknown" as any);

      expect(config.regionConcurrencyType).toBe("Sequential");
      expect(config.maxConcurrentPercentage).toBe(100);
      expect(config.failureTolerancePercentage).toBe(0);
      expect(config.concurrencyMode).toBe("STRICT_FAILURE_TOLERANCE");
    });
  });

  describe("formatMinutesAsDuration", () => {
    it("should format minutes only", () => {
      expect(formatMinutesAsDuration(30)).toBe("30 minutes");
      expect(formatMinutesAsDuration(45)).toBe("45 minutes");
    });

    it("should format hours only", () => {
      expect(formatMinutesAsDuration(60)).toBe("60 minutes");
      expect(formatMinutesAsDuration(120)).toBe("120 minutes");
      expect(formatMinutesAsDuration(480)).toBe("480 minutes");
    });

    it("should format hours and minutes", () => {
      expect(formatMinutesAsDuration(90)).toBe("90 minutes");
      expect(formatMinutesAsDuration(150)).toBe("150 minutes");
      expect(formatMinutesAsDuration(125)).toBe("125 minutes");
    });
  });

  describe("getConcurrencyModeLabel", () => {
    it("should return label for STRICT_FAILURE_TOLERANCE", () => {
      expect(getConcurrencyModeLabel("STRICT_FAILURE_TOLERANCE")).toBe(
        "Strict: Reduces concurrency as failures occur",
      );
    });

    it("should return label for SOFT_FAILURE_TOLERANCE", () => {
      expect(getConcurrencyModeLabel("SOFT_FAILURE_TOLERANCE")).toBe(
        "Soft: Maintains maximum concurrency",
      );
    });
  });

  describe("formatMinutesAsCompactDuration", () => {
    it("should format minutes only", () => {
      expect(formatMinutesAsCompactDuration(30)).toBe("30 min");
      expect(formatMinutesAsCompactDuration(45)).toBe("45 min");
    });

    it("should format hours only", () => {
      expect(formatMinutesAsCompactDuration(60)).toBe("1h");
      expect(formatMinutesAsCompactDuration(120)).toBe("2h");
      expect(formatMinutesAsCompactDuration(480)).toBe("8h");
    });

    it("should format hours and minutes", () => {
      expect(formatMinutesAsCompactDuration(90)).toBe("1h 30m");
      expect(formatMinutesAsCompactDuration(150)).toBe("2h 30m");
      expect(formatMinutesAsCompactDuration(125)).toBe("2h 5m");
    });
  });

  describe("extractStackSetNameFromId", () => {
    it("should extract name from composite ID", () => {
      expect(extractStackSetNameFromId("my-stackset:abc-123-uuid")).toBe(
        "my-stackset",
      );
    });

    it("should return full ID when no colon", () => {
      expect(extractStackSetNameFromId("my-stackset")).toBe("my-stackset");
    });

    it("should handle empty string", () => {
      expect(extractStackSetNameFromId("")).toBe("");
    });
  });
});

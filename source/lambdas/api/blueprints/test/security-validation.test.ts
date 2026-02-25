// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Security validation tests for Blueprint API handlers
 * Validates tags validation for AWS compliance and DoS prevention
 */

import { BlueprintItemSchema } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { describe, expect, it } from "vitest";

describe("Tags Validation", () => {
  const createBlueprintWithTags = (tags: Record<string, string>) => {
    return BlueprintItemSchema.pick({ tags: true }).safeParse({ tags });
  };

  describe("Happy Path (Valid Input)", () => {
    it("should accept compliant tags within the 10-item limit", () => {
      const standardTags = {
        Env: "Prod",
        Dept: "Engineering",
        Project: "Alpha",
      };
      const result = createBlueprintWithTags(standardTags);
      expect(result.success).toBe(true);

      const maxValidTags = Object.fromEntries(
        Array.from({ length: 10 }, (_, i) => [`key${i}`, "value"]),
      );
      expect(createBlueprintWithTags(maxValidTags).success).toBe(true);
    });

    it("should accept tags with empty values", () => {
      const tagsWithEmptyValues = {
        Reviewed: "",
        Public: "",
        Deprecated: "",
      };
      const result = createBlueprintWithTags(tagsWithEmptyValues);
      expect(result.success).toBe(true);
    });
  });

  describe("AWS Platform Compliance", () => {
    it("should enforce the strict 10-tag limit", () => {
      const excessiveTags = Object.fromEntries(
        Array.from({ length: 11 }, (_, i) => [`key${i}`, "value"]),
      );
      const result = createBlueprintWithTags(excessiveTags);
      expect(result.success).toBe(false);
    });

    it("should reject restricted 'aws:' prefix in keys", () => {
      const result = createBlueprintWithTags({ "aws:internal": "true" });
      expect(result.success).toBe(false);
    });

    it("should reject 'AWS:' prefix case-insensitively", () => {
      const result = createBlueprintWithTags({ "AWS:internal": "true" });
      expect(result.success).toBe(false);
    });

    it("should accept keys containing 'aws' but not as prefix", () => {
      const result = createBlueprintWithTags({ "my-aws-resource": "value" });
      expect(result.success).toBe(true);
    });

    it.each([
      { char: "<", name: "less than" },
      { char: ">", name: "greater than" },
      { char: '"', name: "double quote" },
      { char: "'", name: "single quote" },
      { char: "\n", name: "newline" },
      { char: "\x00", name: "null byte" },
    ])("should block $name character ($char) in keys", ({ char }) => {
      const result = createBlueprintWithTags({ [`key${char}name`]: "value" });
      expect(result.success).toBe(false);
    });
  });

  describe("Character & Length Bounds", () => {
    it("should enforce the 128-character limit on keys", () => {
      const result = createBlueprintWithTags({ ["a".repeat(129)]: "value" });
      expect(result.success).toBe(false);
    });

    it("should enforce the 256-character limit on values", () => {
      const result = createBlueprintWithTags({ key: "a".repeat(257) });
      expect(result.success).toBe(false);
    });

    it("should reject empty tag keys", () => {
      const result = createBlueprintWithTags({ "": "value" });
      expect(result.success).toBe(false);
    });
  });
});

describe("Integration: Full Blueprint Validation", () => {
  it("should validate complete blueprint with diverse tags", () => {
    const blueprint = {
      PK: "bp#550e8400-e29b-41d4-a716-446655440000",
      SK: "blueprint",
      blueprintId: "550e8400-e29b-41d4-a716-446655440000",
      itemType: "BLUEPRINT" as const,
      name: "TestBlueprint",
      tags: {
        Environment: "Production",
        Cost$Center: "Finance/IT",
        "App[Version]": "v1.0",
        Owner: "team@example.com",
      },
      createdBy: "admin@example.com",
      deploymentTimeoutMinutes: 30,
      regionConcurrencyType: "SEQUENTIAL" as const,
      totalHealthMetrics: {
        totalDeploymentCount: 0,
        totalSuccessfulCount: 0,
      },
      meta: {
        version: 1,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const result = BlueprintItemSchema.safeParse(blueprint);
    if (!result.success) {
      console.error(
        "Validation errors:",
        JSON.stringify(result.error.issues, null, 2),
      );
    }
    expect(result.success).toBe(true);
  });

  it("should reject blueprint with aws: prefix tags", () => {
    const blueprint = {
      PK: "bp#550e8400-e29b-41d4-a716-446655440000",
      SK: "blueprint",
      blueprintId: "550e8400-e29b-41d4-a716-446655440000",
      itemType: "BLUEPRINT" as const,
      name: "TestBlueprint",
      tags: {
        "aws:reserved": "value",
      },
      createdBy: "admin@example.com",
      deploymentTimeoutMinutes: 30,
      regionConcurrencyType: "SEQUENTIAL" as const,
      totalHealthMetrics: {
        totalDeploymentCount: 0,
        totalSuccessfulCount: 0,
      },
      meta: {
        version: 1,
        schemaVersion: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
    };

    const result = BlueprintItemSchema.safeParse(blueprint);
    expect(result.success).toBe(false);
  });
});

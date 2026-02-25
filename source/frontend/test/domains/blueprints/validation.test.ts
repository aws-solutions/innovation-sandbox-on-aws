// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Frontend validation tests for Blueprint wizard
 * Ensures frontend validation matches backend security rules
 */

import {
  BasicDetailsValidationSchema,
  createBasicDetailsValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";
import { describe, expect, it } from "vitest";

describe("Blueprint Tags Validation (Frontend)", () => {
  const TagsOnlySchema = BasicDetailsValidationSchema.pick({ tags: true });

  const createBlueprintWithTags = (
    tags: Array<{ key: string; value?: string }>,
  ) => {
    return TagsOnlySchema.safeParse({ tags });
  };

  describe("Happy Path (Valid Input)", () => {
    it("should accept compliant tags within the 10-item limit", () => {
      const standardTags = [
        { key: "Env", value: "Prod" },
        { key: "Dept", value: "Engineering" },
        { key: "Project", value: "Alpha" },
      ];
      const result = createBlueprintWithTags(standardTags);
      expect(result.success).toBe(true);

      const maxValidTags = Array.from({ length: 10 }, (_, i) => ({
        key: `key${i}`,
        value: "value",
      }));
      expect(createBlueprintWithTags(maxValidTags).success).toBe(true);
    });

    it("should accept AWS-compliant special characters", () => {
      const validTags = [
        { key: "Environment", value: "Production" },
        { key: "Cost$Center", value: "Finance/IT" },
        { key: "App[Version]", value: "v1.0" },
        { key: "Query{param}", value: "Value%20" },
        { key: "Path|Name", value: "File\\Name" },
        { key: "constructor", value: "allowed" }, // React handles prototype pollution
        { key: "prototype", value: "allowed" },
      ];
      const result = createBlueprintWithTags(validTags);
      expect(result.success).toBe(true);
    });

    it("should accept tags with empty values", () => {
      const tagsWithEmptyValues = [
        { key: "Reviewed", value: "" },
        { key: "Public", value: "" },
        { key: "Deprecated" },
      ];
      const result = createBlueprintWithTags(tagsWithEmptyValues);
      expect(result.success).toBe(true);
    });
  });

  describe("AWS Platform Compliance", () => {
    it("should enforce the strict 10-tag limit", () => {
      const excessiveTags = Array.from({ length: 11 }, (_, i) => ({
        key: `key${i}`,
        value: "value",
      }));
      const result = createBlueprintWithTags(excessiveTags);
      expect(result.success).toBe(false);
    });

    it("should reject restricted 'aws:' prefix in keys", () => {
      const result = createBlueprintWithTags([
        { key: "aws:internal", value: "true" },
      ]);
      expect(result.success).toBe(false);
    });

    it("should reject 'AWS:' prefix case-insensitively", () => {
      const result = createBlueprintWithTags([
        { key: "AWS:internal", value: "true" },
      ]);
      expect(result.success).toBe(false);
    });

    it("should accept keys containing 'aws' but not as prefix", () => {
      const result = createBlueprintWithTags([
        { key: "my-aws-resource", value: "value" },
      ]);
      expect(result.success).toBe(true);
    });

    it("should still block XSS-dangerous characters via regex", () => {
      const xssChars = ["<", ">", '"', "'"];
      xssChars.forEach((char) => {
        const result = createBlueprintWithTags([
          { key: `key${char}name`, value: "value" },
        ]);
        expect(result.success).toBe(false);
      });
    });
  });

  describe("Character & Length Bounds", () => {
    it("should enforce the 128-character limit on keys", () => {
      const oversizedKey = [{ key: "a".repeat(129), value: "value" }];
      expect(createBlueprintWithTags(oversizedKey).success).toBe(false);
    });

    it("should enforce the 256-character limit on values", () => {
      const oversizedValue = [{ key: "key", value: "a".repeat(257) }];
      expect(createBlueprintWithTags(oversizedValue).success).toBe(false);
    });

    it("should reject empty tag keys", () => {
      const result = createBlueprintWithTags([{ key: "", value: "value" }]);
      expect(result.success).toBe(false);
    });
  });

  describe("Duplicate Tag Keys (Cross-Field Validation)", () => {
    const SchemaWithDuplicateValidation = createBasicDetailsValidationSchema();

    const createBlueprintWithDuplicateValidation = (
      tags: Array<{ key: string; value?: string }>,
    ) => {
      return SchemaWithDuplicateValidation.safeParse({
        name: "TestBlueprint",
        tags,
      });
    };

    it("should reject duplicate tag keys", () => {
      const duplicateTags = [
        { key: "Environment", value: "Production" },
        { key: "Environment", value: "Development" },
      ];
      const result = createBlueprintWithDuplicateValidation(duplicateTags);

      expect(result.success).toBe(false);
      if (!result.success) {
        const errors = result.error.errors;
        // Both duplicate keys should have errors
        expect(errors).toHaveLength(2);
        expect(errors[0].path).toEqual(["tags", 0, "key"]);
        expect(errors[0].message).toBe("Duplicate tag key");
        expect(errors[1].path).toEqual(["tags", 1, "key"]);
        expect(errors[1].message).toBe("Duplicate tag key");
      }
    });

    it("should accept unique keys with different casing", () => {
      const uniqueTags = [
        { key: "Environment", value: "Production" },
        { key: "Env", value: "Development" },
        { key: "ENV_TYPE", value: "Staging" },
      ];
      const result = createBlueprintWithDuplicateValidation(uniqueTags);
      expect(result.success).toBe(true);
    });
  });
});

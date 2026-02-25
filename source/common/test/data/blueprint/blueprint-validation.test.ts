// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, test } from "vitest";

import {
  BlueprintItemSchema,
  StackSetItemSchema,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";

describe("Blueprint Validation", () => {
  describe("Name Validation", () => {
    test("should accept valid blueprint names", () => {
      const validNames = [
        "MyBlueprint",
        "Blueprint-123",
        "A",
        "A" + "b".repeat(49), // 50 characters (max length)
      ];

      validNames.forEach((name) => {
        const result = BlueprintItemSchema.pick({ name: true }).safeParse({
          name,
        });
        expect(result.success).toBe(true);
      });
    });

    test("should reject names not starting with a letter", () => {
      const result = BlueprintItemSchema.pick({ name: true }).safeParse({
        name: "123-invalid",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain(
          "must start with a letter",
        );
      }
    });

    test("should reject names with invalid characters", () => {
      const result = BlueprintItemSchema.pick({ name: true }).safeParse({
        name: "invalid_name",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain(
          "letters, numbers, and hyphens",
        );
      }
    });

    test("should reject empty name", () => {
      const result = BlueprintItemSchema.pick({ name: true }).safeParse({
        name: "",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain("required");
      }
    });

    test("should reject names exceeding maximum length", () => {
      const result = BlueprintItemSchema.pick({ name: true }).safeParse({
        name: "A" + "b".repeat(50), // 51 characters
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain(
          "50 characters or less",
        );
      }
    });
  });

  describe("Regions Validation", () => {
    test("should accept unique regions", () => {
      const result = StackSetItemSchema.pick({ regions: true }).safeParse({
        regions: ["us-east-1", "us-west-2", "eu-west-1"],
      });

      expect(result.success).toBe(true);
    });

    test("should accept single region", () => {
      const result = StackSetItemSchema.pick({ regions: true }).safeParse({
        regions: ["us-east-1"],
      });

      expect(result.success).toBe(true);
    });

    test("should reject duplicate regions", () => {
      const result = StackSetItemSchema.pick({ regions: true }).safeParse({
        regions: ["us-east-1", "us-west-2", "us-east-1"],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain("Duplicate regions");
      }
    });

    test("should reject empty regions array", () => {
      const result = StackSetItemSchema.pick({ regions: true }).safeParse({
        regions: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.errors[0]?.message).toContain(
          "At least one region",
        );
      }
    });
  });
});

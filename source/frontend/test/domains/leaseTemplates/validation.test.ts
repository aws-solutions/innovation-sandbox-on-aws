// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  BudgetSettingsValidationSchema,
  CostReportSettingsValidationSchema,
  createBudgetSettingsValidationSchema,
  createCostReportSettingsValidationSchema,
  createDurationSettingsValidationSchema,
  DurationSettingsValidationSchema,
} from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import {
  BasicDetailsValidationSchema,
  createLeaseTemplateWizardValidationSchema,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";

describe("Lease Template Validation", () => {
  describe("BasicDetailsValidationSchema", () => {
    it("validates valid basic details", () => {
      const validData = {
        name: "Test Template",
        description: "Test Description",
        requiresApproval: true,
        visibility: "PRIVATE" as const,
      };

      const result = BasicDetailsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it.each([
      ["", "Template name is required"],
      ["a".repeat(51), "Template name must be 50 characters or less"],
    ])("rejects invalid name: %s", (name, expectedError) => {
      const invalidData = {
        name,
        requiresApproval: true,
        visibility: "PRIVATE" as const,
      };

      const result = BasicDetailsValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(expectedError);
      }
    });
  });

  describe("BudgetSettingsValidationSchema", () => {
    it("validates budget settings without max spend", () => {
      const validData = {
        maxBudgetEnabled: false,
        budgetThresholds: [],
      };

      const result = BudgetSettingsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates budget settings with max spend and thresholds", () => {
      const validData = {
        maxBudgetEnabled: true,
        maxSpend: 1000,
        budgetThresholds: [
          { dollarsSpent: 500, action: "ALERT" as const },
          { dollarsSpent: 800, action: "FREEZE_ACCOUNT" as const },
        ],
      };

      const result = BudgetSettingsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("rejects negative or zero max spend", () => {
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: 0,
      };

      const result = BudgetSettingsValidationSchema.safeParse(invalidData);
      expect(result.success).toBe(false);
    });
  });

  describe("createBudgetSettingsValidationSchema", () => {
    it("requires max spend when maxBudgetEnabled is true (regardless of requireMaxBudget)", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("requires max spend when requireMaxBudget is true", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, true);
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("allows missing max spend when toggle is disabled and not required", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);
      const validData = {
        maxBudgetEnabled: false,
        maxSpend: undefined,
      };

      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("enforces global max budget limit", () => {
      const schema = createBudgetSettingsValidationSchema(1000, false);
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: 1500,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("global limit");
      }
    });

    it("rejects multiple FREEZE_ACCOUNT thresholds", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: 1000,
        budgetThresholds: [
          { dollarsSpent: 500, action: "FREEZE_ACCOUNT" as const },
          { dollarsSpent: 800, action: "FREEZE_ACCOUNT" as const },
        ],
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Only one");
      }
    });

    it("rejects thresholds exceeding max spend", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);
      const invalidData = {
        maxBudgetEnabled: true,
        maxSpend: 1000,
        budgetThresholds: [{ dollarsSpent: 1500, action: "ALERT" as const }],
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("exceed maximum");
      }
    });
  });

  describe("DurationSettingsValidationSchema", () => {
    it("validates duration settings without max duration", () => {
      const validData = {
        maxDurationEnabled: false,
        durationThresholds: [],
      };

      const result = DurationSettingsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates duration settings with max duration and thresholds", () => {
      const validData = {
        maxDurationEnabled: true,
        leaseDurationInHours: 168,
        durationThresholds: [
          { hoursRemaining: 24, action: "ALERT" as const },
          { hoursRemaining: 1, action: "FREEZE_ACCOUNT" as const },
        ],
      };

      const result = DurationSettingsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe("createDurationSettingsValidationSchema", () => {
    it("requires max duration when maxDurationEnabled is true (regardless of requireMaxDuration)", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);
      const invalidData = {
        maxDurationEnabled: true,
        leaseDurationInHours: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("requires max duration when requireMaxDuration is true", () => {
      const schema = createDurationSettingsValidationSchema(undefined, true);
      const invalidData = {
        maxDurationEnabled: true,
        leaseDurationInHours: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("allows missing max duration when toggle is disabled and not required", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);
      const validData = {
        maxDurationEnabled: false,
        leaseDurationInHours: undefined,
      };

      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("enforces global max duration limit", () => {
      const schema = createDurationSettingsValidationSchema(168, false);
      const invalidData = {
        maxDurationEnabled: true,
        leaseDurationInHours: 200,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("global limit");
      }
    });

    it("rejects thresholds exceeding max duration", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);
      const invalidData = {
        maxDurationEnabled: true,
        leaseDurationInHours: 100,
        durationThresholds: [{ hoursRemaining: 150, action: "ALERT" as const }],
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("exceed maximum");
      }
    });
  });

  describe("CostReportSettingsValidationSchema", () => {
    it("validates cost report settings", () => {
      const validData = {
        costReportGroupEnabled: true,
        selectedCostReportGroup: "group-123",
      };

      const result = CostReportSettingsValidationSchema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe("createCostReportSettingsValidationSchema", () => {
    it("requires cost report group when costReportGroupEnabled is true (regardless of requireCostReportGroup)", () => {
      const schema = createCostReportSettingsValidationSchema(false);
      const invalidData = {
        costReportGroupEnabled: true,
        selectedCostReportGroup: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("requires cost report group when enabled and required", () => {
      const schema = createCostReportSettingsValidationSchema(true);
      const invalidData = {
        costReportGroupEnabled: true,
        selectedCostReportGroup: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("required");
      }
    });

    it("allows missing cost report group when toggle is disabled and not required", () => {
      const schema = createCostReportSettingsValidationSchema(false);
      const validData = {
        costReportGroupEnabled: false,
        selectedCostReportGroup: undefined,
      };

      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);
    });
  });

  describe("createLeaseTemplateWizardValidationSchema", () => {
    it("validates complete wizard form data", () => {
      const schema = createLeaseTemplateWizardValidationSchema({
        globalMaxBudget: 5000,
        requireMaxBudget: false,
        globalMaxDurationHours: 720,
        requireMaxDuration: false,
        requireCostReportGroup: false,
      });

      const validData = {
        name: "Test Template",
        description: "Test Description",
        requiresApproval: true,
        visibility: "PRIVATE" as const,
        blueprintEnabled: false,
        maxBudgetEnabled: true,
        maxSpend: 1000,
        budgetThresholds: [],
        maxDurationEnabled: true,
        leaseDurationInHours: 168,
        durationThresholds: [],
        costReportGroupEnabled: false,
        selectedCostReportGroup: undefined,
      };

      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("validates all config-based rules together", () => {
      const schema = createLeaseTemplateWizardValidationSchema({
        globalMaxBudget: 1000,
        requireMaxBudget: true,
        globalMaxDurationHours: 168,
        requireMaxDuration: true,
        requireCostReportGroup: true,
      });

      const invalidData = {
        name: "Test",
        requiresApproval: true,
        visibility: "PRIVATE" as const,
        blueprintEnabled: false,
        maxBudgetEnabled: true,
        maxSpend: undefined,
        maxDurationEnabled: true,
        leaseDurationInHours: undefined,
        costReportGroupEnabled: true,
        selectedCostReportGroup: undefined,
      };

      const result = schema.safeParse(invalidData);
      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.length).toBeGreaterThan(0);
      }
    });
  });
});

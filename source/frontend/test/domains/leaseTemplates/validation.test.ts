// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  AccessAndSharingValidationSchema,
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
  createSandboxSpacesEditValidationSchema,
  SANDBOX_SPACES_CONSTRAINTS,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";

const defaultPermissionSet = {
  permissionSetArn:
    "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-0123456789abcdef",
  permissionSetId: "ps-0123456789abcdef",
  name: "test_IsbUsersPS",
  availability: "AVAILABLE" as const,
};

describe("Lease Template Validation", () => {
  describe("AccessAndSharingValidationSchema", () => {
    it("allows a default without additional permission sets", () => {
      const result = AccessAndSharingValidationSchema.safeParse({
        allowOwnerToShareLease: false,
        defaultPermissionSet,
        allowedPermissionSets: [],
      });

      expect(result.success).toBe(true);
    });

    it("limits the form to 19 additional permission sets", () => {
      const result = AccessAndSharingValidationSchema.safeParse({
        allowOwnerToShareLease: false,
        defaultPermissionSet,
        allowedPermissionSets: Array.from({ length: 20 }, (_, index) => {
          const permissionSetId = `ps-${index.toString(16).padStart(16, "0")}`;
          return {
            ...defaultPermissionSet,
            permissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/${permissionSetId}`,
            permissionSetId,
          };
        }),
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "Choose no more than 19 additional permission sets.",
        );
      }
    });
  });

  describe("BasicDetailsValidationSchema", () => {
    it("validates valid basic details", () => {
      const validData = {
        name: "Test Template",
        description: "Test Description",
        requiresApproval: true,
        visibility: "PRIVATE" as const,
        allowOwnerToShareLease: false,
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
        allowOwnerToShareLease: false,
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
        expect(result.error.issues[0].message).toContain(
          "Must be less than the Terminate lease amount ($1,000.00)",
        );
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
        sandboxSpacesEnabled: false,
        allowedModelIds: [],
        defaultPermissionSet,
        allowedPermissionSets: [],
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
        allowOwnerToShareLease: false,
        blueprintEnabled: false,
        maxBudgetEnabled: true,
        maxSpend: 1000,
        budgetThresholds: [],
        maxDurationEnabled: true,
        leaseDurationInHours: 168,
        durationThresholds: [],
        costReportGroupEnabled: false,
        selectedCostReportGroup: undefined,
        sandboxSpacesEnabled: false,
        allowedModelIds: [],
        defaultPermissionSet,
        allowedPermissionSets: [],
      };

      const result = schema.safeParse(validData);
      expect(result.success).toBe(true);
    });

    it("applies the predictive-budget rules through the merged wizard schema", () => {
      const schema = createLeaseTemplateWizardValidationSchema({
        globalMaxBudget: 5000,
        requireMaxBudget: false,
        globalMaxDurationHours: 720,
        requireMaxDuration: false,
        requireCostReportGroup: false,
      });

      const baseData = {
        name: "Test Template",
        requiresApproval: true,
        visibility: "PRIVATE" as const,
        allowOwnerToShareLease: false,
        blueprintEnabled: false,
        maxBudgetEnabled: true,
        maxSpend: 1000,
        maxDurationEnabled: true,
        leaseDurationInHours: 168,
        durationThresholds: [],
        costReportGroupEnabled: false,
        selectedCostReportGroup: undefined,
        predictiveBudgetEnabled: true,
        sandboxSpacesEnabled: false,
        allowedModelIds: [],
        defaultPermissionSet,
        allowedPermissionSets: [],
      };

      const predictedAtMax = schema.safeParse({
        ...baseData,
        budgetThresholds: [
          { dollarsSpent: 1000, action: "ALERT", triggerOn: "PREDICTED" },
        ],
      });
      expect(predictedAtMax.success).toBe(false);

      const predictedBelowMax = schema.safeParse({
        ...baseData,
        budgetThresholds: [
          { dollarsSpent: 999.99, action: "ALERT", triggerOn: "PREDICTED" },
        ],
      });
      expect(predictedBelowMax.success).toBe(true);

      const reportedAtMax = schema.safeParse({
        ...baseData,
        budgetThresholds: [
          { dollarsSpent: 1000, action: "ALERT", triggerOn: "REPORTED" },
        ],
      });
      expect(reportedAtMax.success).toBe(false);

      const badRateCap = schema.safeParse({
        ...baseData,
        budgetThresholds: [],
        rateLimits: [{ basis: "DAILY", rate: -1, action: "ALERT" }],
      });
      expect(badRateCap.success).toBe(false);
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
        allowOwnerToShareLease: false,
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

  describe("createSandboxSpacesEditValidationSchema", () => {
    const base = { sandboxSpacesEnabled: true, allowedModelIds: ["m1", "m2"] };

    const messagesFor = (
      values: Record<string, unknown>,
      enabledModelIds?: string[],
    ) => {
      const result = createSandboxSpacesEditValidationSchema({
        enabledModelIds,
      }).safeParse(values);
      return result.success
        ? []
        : result.error.issues.map((issue) => [
            issue.path.join("."),
            issue.message,
          ]);
    };

    it("accepts an enabled default that is one of the selected models", () => {
      expect(messagesFor({ ...base, defaultModelId: "m1" }, ["m1"])).toEqual(
        [],
      );
    });

    it("accepts an unset default", () => {
      expect(messagesFor({ ...base, defaultModelId: undefined }, [])).toEqual(
        [],
      );
    });

    it("rejects a default that is not enabled, even when it is selected", () => {
      expect(messagesFor({ ...base, defaultModelId: "m1" }, ["m2"])).toEqual([
        [
          "defaultModelId",
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_DISABLED,
        ],
      ]);
    });

    it("rejects an enabled default outside the selected models", () => {
      expect(
        messagesFor({ ...base, defaultModelId: "m3" }, ["m1", "m2", "m3"]),
      ).toEqual([
        [
          "defaultModelId",
          SANDBOX_SPACES_CONSTRAINTS.ERROR_DEFAULT_MODEL_NOT_SELECTED,
        ],
      ]);
    });

    it("skips the enabled-ness rule until the catalog has loaded", () => {
      expect(messagesFor({ ...base, defaultModelId: "m1" })).toEqual([]);
    });

    it("allows turning Sandbox Spaces off with a disabled default when no model is enabled", () => {
      expect(
        messagesFor(
          { ...base, sandboxSpacesEnabled: false, defaultModelId: "m1" },
          [],
        ),
      ).toEqual([]);
    });

    it("rejects limiting to no models, which would save as every enabled model", () => {
      expect(
        messagesFor({
          sandboxSpacesEnabled: true,
          allowedModelIds: [],
          limitModels: true,
        }),
      ).toEqual([
        [
          "allowedModelIds",
          SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_MODELS_SELECTED,
        ],
      ]);
    });

    it("rejects limiting to models that are all disabled", () => {
      expect(
        messagesFor(
          {
            sandboxSpacesEnabled: true,
            allowedModelIds: ["m1", "m2"],
            limitModels: true,
          },
          ["m3"],
        ),
      ).toEqual([
        [
          "allowedModelIds",
          SANDBOX_SPACES_CONSTRAINTS.ERROR_NO_ENABLED_MODELS_SELECTED,
        ],
      ]);
    });

    it("accepts a limited selection with at least one enabled model, or before the catalog has loaded", () => {
      const values = {
        sandboxSpacesEnabled: true,
        allowedModelIds: ["m1", "m2"],
        limitModels: true,
      };
      expect(messagesFor(values, ["m2"])).toEqual([]);
      expect(messagesFor(values)).toEqual([]);
    });

    it("accepts an empty selection when the limit is off or Sandbox Spaces is off", () => {
      expect(
        messagesFor({
          sandboxSpacesEnabled: true,
          allowedModelIds: [],
          limitModels: false,
        }),
      ).toEqual([]);
      expect(
        messagesFor({
          sandboxSpacesEnabled: false,
          allowedModelIds: [],
          limitModels: true,
        }),
      ).toEqual([]);
    });
  });
});

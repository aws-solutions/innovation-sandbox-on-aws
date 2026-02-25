// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { describe, expect, it } from "vitest";

import {
  BlueprintSelectionValidationSchema,
  createBlueprintSelectionValidationSchema,
  createBudgetSettingsValidationSchema,
  createDurationSettingsValidationSchema,
  createLeaseExpirationValidationSchema,
} from "@amzn/innovation-sandbox-frontend/components/Forms/validation";

describe("Budget Settings Validation", () => {
  describe("createBudgetSettingsValidationSchema", () => {
    it("validates when max budget is disabled", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: false,
        budgetThresholds: [],
      });

      expect(result.success).toBe(true);
    });

    it("requires maxSpend when max budget is enabled", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        budgetThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Maximum spend is required",
        );
      }
    });

    it("enforces global max budget limit", () => {
      const schema = createBudgetSettingsValidationSchema(100, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 150,
        budgetThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("100");
      }
    });

    it("allows maxSpend within global limit", () => {
      const schema = createBudgetSettingsValidationSchema(100, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 50,
        budgetThresholds: [],
      });

      expect(result.success).toBe(true);
    });

    it("validates threshold amounts are less than maxSpend", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [{ dollarsSpent: 150, action: "ALERT" }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Threshold cannot exceed maximum spend",
        );
      }
    });

    it("allows only one FREEZE_ACCOUNT threshold", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 25, action: "FREEZE_ACCOUNT" },
          { dollarsSpent: 50, action: "FREEZE_ACCOUNT" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Only one 'Freeze Lease' threshold is allowed",
        );
      }
    });

    it("allows multiple ALERT thresholds", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 25, action: "ALERT" },
          { dollarsSpent: 50, action: "ALERT" },
          { dollarsSpent: 75, action: "ALERT" },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("requires maxSpend when requireMaxBudget is true", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, true);

      const result = schema.safeParse({
        maxBudgetEnabled: false,
        budgetThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Maximum spend is required",
        );
      }
    });
  });
});

describe("Duration Settings Validation", () => {
  describe("createDurationSettingsValidationSchema", () => {
    it("validates when duration is disabled", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxDurationEnabled: false,
        durationThresholds: [],
      });

      expect(result.success).toBe(true);
    });

    it("requires leaseDurationInHours when duration is enabled", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Duration is required",
        );
      }
    });

    it("enforces global max duration limit", () => {
      const schema = createDurationSettingsValidationSchema(720, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        leaseDurationInHours: 1000,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("720");
      }
    });

    it("allows duration within global limit", () => {
      const schema = createDurationSettingsValidationSchema(720, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        leaseDurationInHours: 500,
        durationThresholds: [],
      });

      expect(result.success).toBe(true);
    });

    it("validates threshold hours are less than leaseDurationInHours", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        leaseDurationInHours: 100,
        durationThresholds: [{ hoursRemaining: 150, action: "ALERT" }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Hours remaining cannot exceed maximum duration",
        );
      }
    });

    it("allows only one FREEZE_ACCOUNT threshold", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        leaseDurationInHours: 100,
        durationThresholds: [
          { hoursRemaining: 25, action: "FREEZE_ACCOUNT" },
          { hoursRemaining: 50, action: "FREEZE_ACCOUNT" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Only one 'Freeze Lease' threshold is allowed",
        );
      }
    });

    it("requires duration when requireDuration is true", () => {
      const schema = createDurationSettingsValidationSchema(undefined, true);

      const result = schema.safeParse({
        maxDurationEnabled: false,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Duration is required",
        );
      }
    });
  });
});

describe("Lease Expiration Validation", () => {
  describe("createLeaseExpirationValidationSchema", () => {
    // Use a future date for lease start to avoid "must be in the future" validation
    const leaseStartDate = DateTime.utc().plus({ days: 1 }).toISO()!;

    it("requires expiration date", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );

      const result = schema.safeParse({ maxDurationEnabled: true });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Expiration date is required",
        );
      }
    });

    it("validates expiration date is in the future", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );
      const pastDate = DateTime.utc().minus({ hours: 1 }).toISO();

      const result = schema.safeParse({
        maxDurationEnabled: true,
        expirationDate: pastDate,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("future");
      }
    });

    it("validates expiration doesn't exceed max duration from lease start", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );

      // 31 days from start (721 hours) exceeds 720 hour limit
      const tooFarFuture = DateTime.fromISO(leaseStartDate, { zone: "utc" })
        .plus({ hours: 721 })
        .toISO();

      // Ensure we have a valid ISO string
      expect(tooFarFuture).toBeTruthy();

      const result = schema.safeParse({
        maxDurationEnabled: true,
        expirationDate: tooFarFuture!,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("720");
      }
    });

    it("allows expiration within max duration", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );
      // 15 days from start (360 hours) should be valid - use ISO string
      const validDate = DateTime.fromISO(leaseStartDate, { zone: "utc" })
        .plus({ hours: 360 })
        .toISO();

      // Ensure we have a valid ISO string
      expect(validDate).toBeTruthy();

      const result = schema.safeParse({
        maxDurationEnabled: true,
        expirationDate: validDate!,
        durationThresholds: [],
      });

      expect(result.success).toBe(true);
    });

    it("validates threshold hours are less than remaining hours", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );
      // 10 days = 240 hours - use ISO string
      const expirationDate = DateTime.fromISO(leaseStartDate, { zone: "utc" })
        .plus({ hours: 240 })
        .toISO();

      // Ensure we have a valid ISO string
      expect(expirationDate).toBeTruthy();

      const result = schema.safeParse({
        maxDurationEnabled: true,
        expirationDate: expirationDate!,
        durationThresholds: [
          { hoursRemaining: 300, action: "ALERT" }, // More than 240 hours
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Hours remaining cannot exceed maximum duration",
        );
      }
    });
  });
});

describe("Blueprint Selection Validation", () => {
  describe("BlueprintSelectionValidationSchema", () => {
    it("accepts a valid UUID string", () => {
      const validUuid = "123e4567-e89b-12d3-a456-426614174000";

      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: true,
        blueprintId: validUuid,
      });

      expect(result.success).toBe(true);
    });

    it("accepts null value", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: false,
        blueprintId: null,
      });

      expect(result.success).toBe(true);
    });

    it("accepts undefined value", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: false,
        blueprintId: undefined,
      });

      expect(result.success).toBe(true);
    });

    it("rejects invalid UUID format", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: true,
        blueprintId: "not-a-valid-uuid",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid uuid");
      }
    });

    it("rejects empty string", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: true,
        blueprintId: "",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid uuid");
      }
    });

    it("rejects missing blueprintEnabled field", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintId: undefined,
      });

      expect(result.success).toBe(false);
    });
  });

  describe("createBlueprintSelectionValidationSchema", () => {
    it("requires blueprintId when blueprintEnabled is true", () => {
      const schema = createBlueprintSelectionValidationSchema();

      const result = schema.safeParse({
        blueprintEnabled: true,
        blueprintId: undefined,
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Select a blueprint or disable blueprint selection",
        );
      }
    });

    it("allows no blueprintId when blueprintEnabled is false", () => {
      const schema = createBlueprintSelectionValidationSchema();

      const result = schema.safeParse({
        blueprintEnabled: false,
        blueprintId: undefined,
      });

      expect(result.success).toBe(true);
    });

    it("accepts valid blueprintId when blueprintEnabled is true", () => {
      const schema = createBlueprintSelectionValidationSchema();

      const result = schema.safeParse({
        blueprintEnabled: true,
        blueprintId: "123e4567-e89b-12d3-a456-426614174000",
      });

      expect(result.success).toBe(true);
    });
  });
});

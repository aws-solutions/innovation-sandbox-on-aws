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
  RATE_LIMIT_CONSTRAINTS,
} from "@amzn/innovation-sandbox-frontend/components/Forms/validation";
import { RateBasisSchema } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { ThresholdActionSchema } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

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
          "Maximum budget is required",
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
          "Must be less than the Terminate lease amount ($100.00)",
        );
      }
    });

    it("rejects a PREDICTED threshold at exactly maxSpend while predictive controls are on", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT", triggerOn: "PREDICTED" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Must be less than the Terminate lease amount ($100.00)",
        );
      }
    });

    it("allows a threshold one cent below maxSpend whichever cost basis it uses", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 99.99, action: "ALERT", triggerOn: "PREDICTED" },
          {
            dollarsSpent: 99.99,
            action: "FREEZE_ACCOUNT",
            triggerOn: "REPORTED",
          },
        ],
      });

      expect(result.success).toBe(true);
    });

    it("rejects a REPORTED threshold at exactly maxSpend", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT", triggerOn: "REPORTED" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Must be less than the Terminate lease amount ($100.00)",
        );
      }
    });

    it("rejects a threshold without triggerOn at exactly maxSpend (treated as reported)", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" }],
      });

      expect(result.success).toBe(false);
    });

    it("rejects a PREDICTED threshold above maxSpend", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 101, action: "ALERT", triggerOn: "PREDICTED" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Must be less than the Terminate lease amount ($100.00)",
        );
      }
    });

    it("still allows only one FREEZE_ACCOUNT threshold whichever figure each watches", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        budgetThresholds: [
          { dollarsSpent: 25, action: "FREEZE_ACCOUNT", triggerOn: "REPORTED" },
          {
            dollarsSpent: 50,
            action: "FREEZE_ACCOUNT",
            triggerOn: "PREDICTED",
          },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain(
          "Only one 'Freeze lease' threshold is allowed",
        );
      }
    });

    it("flags every threshold at maxSpend in a mixed array", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxBudgetEnabled: true,
        maxSpend: 100,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT", triggerOn: "PREDICTED" },
          { dollarsSpent: 100, action: "ALERT", triggerOn: "REPORTED" },
        ],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        const paths = result.error.issues.map((issue) => issue.path.join("."));
        expect(paths).toEqual([
          "budgetThresholds.0.dollarsSpent",
          "budgetThresholds.1.dollarsSpent",
        ]);
      }
    });

    describe("rate limit rows", () => {
      const schema = createBudgetSettingsValidationSchema(undefined, false);
      const parseRows = (rateLimits: unknown[]) =>
        schema.safeParse({
          maxBudgetEnabled: false,
          budgetThresholds: [],
          predictiveBudgetEnabled: true,
          rateLimits,
        });
      const issuesOf = (result: ReturnType<typeof parseRows>) =>
        result.success
          ? []
          : result.error.issues.map((issue) => ({
              path: issue.path.join("."),
              message: issue.message,
            }));

      // A number input the user empties hands the form "", not undefined.
      it.each([
        { name: "zero", rate: 0, message: "Rate must be greater than 0" },
        { name: "negative", rate: -5, message: "Rate must be greater than 0" },
        { name: "missing", rate: undefined, message: "Rate is required" },
        { name: "cleared", rate: "", message: "Rate is required" },
      ])("rejects a $name rate", ({ rate, message }) => {
        expect(
          issuesOf(parseRows([{ rate, basis: "HOURLY", action: "ALERT" }])),
        ).toEqual([{ path: "rateLimits.0.rate", message }]);
      });

      it("accepts every shared period and action, and keeps the form's messages for others", () => {
        const rows = RateBasisSchema.options.flatMap((basis, i) =>
          ThresholdActionSchema.options.map((action, j) => ({
            rate: 10 * (i + 1) + j,
            basis,
            action,
          })),
        );
        expect(parseRows(rows).success).toBe(true);
        expect(
          issuesOf(
            parseRows([{ rate: 10, basis: "WEEKLY", action: "DELETE" }]),
          ),
        ).toEqual([
          { path: "rateLimits.0.basis", message: "Period is required" },
          { path: "rateLimits.0.action", message: "Action is required" },
        ]);
      });

      it("accepts several freeze rows and the same rate on different periods", () => {
        const result = parseRows([
          { rate: 10, basis: "HOURLY", action: "FREEZE_ACCOUNT" },
          { rate: 10, basis: "DAILY", action: "FREEZE_ACCOUNT" },
          { rate: 15, basis: "HOURLY", action: "FREEZE_ACCOUNT" },
        ]);
        expect(result.success).toBe(true);
      });

      it("flags a repeated period and rate whatever the action", () => {
        expect(
          issuesOf(
            parseRows([
              { rate: 10, basis: "HOURLY", action: "ALERT" },
              { rate: 10, basis: "HOURLY", action: "FREEZE_ACCOUNT" },
            ]),
          ),
        ).toEqual([
          {
            path: "rateLimits.1.rate",
            message: RATE_LIMIT_CONSTRAINTS.ERROR_DUPLICATE,
          },
        ]);
      });

      it("allows ten rows and rejects an eleventh", () => {
        const rows = (count: number) =>
          Array.from({ length: count }, (_, i) => ({
            rate: i + 1,
            basis: "HOURLY",
            action: "ALERT",
          }));
        expect(parseRows(rows(10)).success).toBe(true);
        expect(issuesOf(parseRows(rows(11)))).toEqual([
          {
            path: "rateLimits",
            message: RATE_LIMIT_CONSTRAINTS.ERROR_TOO_MANY,
          },
        ]);
      });
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
          "Only one 'Freeze lease' threshold is allowed",
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
          "Maximum budget is required",
        );
      }
    });

    it("ignores a maximum budget left in the form while it is off", () => {
      const schema = createBudgetSettingsValidationSchema(50, false);

      const result = schema.safeParse({
        maxBudgetEnabled: false,
        maxSpend: 100,
        budgetThresholds: [{ dollarsSpent: 150, action: "ALERT" }],
      });

      expect(result.success).toBe(true);
    });

    it("still checks the maximum budget while one is required and the toggle value is off", () => {
      const schema = createBudgetSettingsValidationSchema(50, true);

      const result = schema.safeParse({
        maxBudgetEnabled: false,
        maxSpend: 100,
        budgetThresholds: [{ dollarsSpent: 150, action: "ALERT" }],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues.map((issue) => issue.message)).toEqual([
          "Maximum budget cannot exceed global limit of $50.00",
          "Must be less than the Terminate lease amount ($100.00)",
        ]);
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

    it("rejects a duration threshold at exactly leaseDurationInHours", () => {
      const schema = createDurationSettingsValidationSchema(undefined, false);

      const result = schema.safeParse({
        maxDurationEnabled: true,
        leaseDurationInHours: 100,
        durationThresholds: [{ hoursRemaining: 100, action: "ALERT" }],
      });

      expect(result.success).toBe(false);
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

    it("ignores a duration left in the form while duration is off", () => {
      const schema = createDurationSettingsValidationSchema(50, false);

      const result = schema.safeParse({
        maxDurationEnabled: false,
        leaseDurationInHours: 100,
        durationThresholds: [{ hoursRemaining: 150, action: "ALERT" }],
      });

      expect(result.success).toBe(true);
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

    it("ignores an expiration date left in the form while expiration is off", () => {
      const schema = createLeaseExpirationValidationSchema(
        false,
        720,
        leaseStartDate,
      );
      const pastDate = DateTime.utc().minus({ hours: 1 }).toISO();

      const result = schema.safeParse({
        maxDurationEnabled: false,
        expirationDate: pastDate,
        durationThresholds: [{ hoursRemaining: 300, action: "ALERT" }],
      });

      expect(result.success).toBe(true);
    });

    it("still checks the expiration date while one is required and the toggle value is off", () => {
      const schema = createLeaseExpirationValidationSchema(
        true,
        720,
        leaseStartDate,
      );
      const pastDate = DateTime.utc().minus({ hours: 1 }).toISO();

      const result = schema.safeParse({
        maxDurationEnabled: false,
        expirationDate: pastDate,
        durationThresholds: [],
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toBe(
          "Expiration date must be in the future",
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
        expect(result.error.issues[0].message).toContain("Invalid UUID");
      }
    });

    it("rejects empty string", () => {
      const result = BlueprintSelectionValidationSchema.safeParse({
        blueprintEnabled: true,
        blueprintId: "",
      });

      expect(result.success).toBe(false);
      if (!result.success) {
        expect(result.error.issues[0].message).toContain("Invalid UUID");
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
          "Select a blueprint or turn off Deploy a blueprint",
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

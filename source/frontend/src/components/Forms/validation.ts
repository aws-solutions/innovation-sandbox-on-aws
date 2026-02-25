// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DateTime } from "luxon";
import { z } from "zod";

/**
 * Shared validation schemas for budget, duration, and cost report settings.
 * These schemas are used across both lease templates and lease management.
 */

export const BudgetSettingsValidationSchema = z.object({
  maxBudgetEnabled: z.boolean(),
  maxSpend: z
    .number({ invalid_type_error: "Maximum spend must be a number" })
    .gt(0, "Maximum spend must be greater than 0")
    .optional(),
  budgetThresholds: z
    .array(
      z.object({
        dollarsSpent: z
          .number({
            required_error: "Threshold amount is required",
            invalid_type_error: "Threshold amount must be a number",
          })
          .gt(0, "Threshold amount must be greater than 0"),
        action: z.enum(["ALERT", "FREEZE_ACCOUNT"], {
          required_error: "Threshold action is required",
        }),
      }),
    )
    .optional(),
});

export const DurationSettingsValidationSchema = z.object({
  maxDurationEnabled: z.boolean(),
  leaseDurationInHours: z
    .number({ invalid_type_error: "Duration must be a number" })
    .gt(0, "Duration must be greater than 0")
    .optional(),
  expirationDate: z.string().datetime().optional(),
  durationThresholds: z
    .array(
      z.object({
        hoursRemaining: z
          .number({
            required_error: "Threshold amount is required",
            invalid_type_error: "Threshold amount must be a number",
          })
          .gt(0, "Hours remaining must be greater than 0"),
        action: z.enum(["ALERT", "FREEZE_ACCOUNT"], {
          required_error: "Threshold action is required",
        }),
      }),
    )
    .optional(),
});

export const CostReportSettingsValidationSchema = z.object({
  costReportGroupEnabled: z.boolean(),
  selectedCostReportGroup: z.string().optional(),
});

export const BlueprintSelectionValidationSchema = z.object({
  blueprintEnabled: z.boolean(),
  blueprintId: z.string().uuid().nullish(),
  blueprintName: z.string().nullish(),
});

export type BlueprintSelectionFormValues = z.infer<
  typeof BlueprintSelectionValidationSchema
>;

/**
 * Creates validation refinement for blueprint selection.
 * Requires a blueprint to be selected when the toggle is enabled.
 */
export const createBlueprintSelectionValidationRefinement = () => {
  return (data: any, ctx: z.RefinementCtx) => {
    if (data.blueprintEnabled && !data.blueprintId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Select a blueprint or disable blueprint selection",
        path: ["blueprintId"],
      });
    }
  };
};

/** Blueprint validation schema with required-when-enabled rule applied via .superRefine() */
export const createBlueprintSelectionValidationSchema = () => {
  return BlueprintSelectionValidationSchema.superRefine(
    createBlueprintSelectionValidationRefinement(),
  );
};

/**
 * Validates that max value is provided when required.
 */
const validateMaxValueRequired = (
  data: any,
  ctx: z.RefinementCtx,
  config: {
    enabledField: string;
    maxValueField: string;
    requireMaxValue?: boolean;
    requiredMessage: string;
  },
) => {
  const { enabledField, maxValueField, requireMaxValue, requiredMessage } =
    config;

  const isValueMissing =
    data[maxValueField] === null || data[maxValueField] === undefined;
  const isEnabledWithoutValue = data[enabledField] && isValueMissing;
  const isGloballyRequiredWithoutValue = requireMaxValue && isValueMissing;

  if (isEnabledWithoutValue || isGloballyRequiredWithoutValue) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: requiredMessage,
      path: [maxValueField],
    });
  }
};

/**
 * Validates that max value does not exceed global limit.
 */
const validateGlobalLimit = (
  data: any,
  ctx: z.RefinementCtx,
  config: {
    maxValueField: string;
    globalMaxValue?: number;
    exceedsLimitMessage: (limit: number) => string;
  },
) => {
  const { maxValueField, globalMaxValue, exceedsLimitMessage } = config;

  const hasValue = data[maxValueField] !== undefined;
  const hasGlobalLimit = globalMaxValue !== undefined;
  const exceedsLimit =
    hasValue && hasGlobalLimit && data[maxValueField] > globalMaxValue;

  if (exceedsLimit) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: exceedsLimitMessage(globalMaxValue),
      path: [maxValueField],
    });
  }
};

/**
 * Finds indices of all FREEZE_ACCOUNT thresholds.
 */
const findFreezeActionIndices = <T extends { action: string }>(
  thresholds: T[],
): number[] => {
  return thresholds
    .map((t, idx) => (t.action === "FREEZE_ACCOUNT" ? idx : -1))
    .filter((idx) => idx !== -1);
};

/**
 * Validates that only one FREEZE_ACCOUNT threshold exists.
 */
const validateUniqueFreezeAction = <T extends { action: string }>(
  thresholds: T[],
  ctx: z.RefinementCtx,
  config: {
    thresholdsField: string;
    multipleFreezeMessage: string;
  },
) => {
  const { thresholdsField, multipleFreezeMessage } = config;
  const freezeIndices = findFreezeActionIndices(thresholds);

  if (freezeIndices.length > 1) {
    freezeIndices.forEach((idx) => {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: multipleFreezeMessage,
        path: [thresholdsField, idx, "action"],
      });
    });
  }
};

/**
 * Validates that threshold values do not exceed max value.
 */
const validateThresholdValues = (
  thresholds: any[],
  maxValue: number,
  ctx: z.RefinementCtx,
  config: {
    thresholdsField: string;
    thresholdValueField: string;
    exceedsMaxMessage: string;
  },
) => {
  const { thresholdsField, thresholdValueField, exceedsMaxMessage } = config;

  thresholds.forEach((threshold, idx) => {
    if (threshold[thresholdValueField] >= maxValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: exceedsMaxMessage,
        path: [thresholdsField, idx, thresholdValueField],
      });
    }
  });
};

/**
 * Generic threshold validation for budget and duration settings.
 * Validates: required fields, global limits, unique FREEZE_ACCOUNT, thresholds vs max values.
 */
const createThresholdValidationRefinement = <
  T extends { action: string },
>(config: {
  enabledField: string;
  maxValueField: string;
  thresholdsField: string;
  thresholdValueField: string;
  requireMaxValue?: boolean;
  globalMaxValue?: number;
  messages: {
    required: string;
    exceedsGlobalLimit: (limit: number) => string;
    multipleFreezeAccount: string;
    exceedsMaxValue: string;
  };
}) => {
  return (data: any, ctx: z.RefinementCtx) => {
    const {
      enabledField,
      maxValueField,
      thresholdsField,
      thresholdValueField,
      requireMaxValue,
      globalMaxValue,
      messages,
    } = config;

    validateMaxValueRequired(data, ctx, {
      enabledField,
      maxValueField,
      requireMaxValue,
      requiredMessage: messages.required,
    });

    validateGlobalLimit(data, ctx, {
      maxValueField,
      globalMaxValue,
      exceedsLimitMessage: messages.exceedsGlobalLimit,
    });

    const thresholds = data[thresholdsField];
    if (thresholds && thresholds.length > 0) {
      validateUniqueFreezeAction<T>(thresholds, ctx, {
        thresholdsField,
        multipleFreezeMessage: messages.multipleFreezeAccount,
      });

      if (data[maxValueField]) {
        validateThresholdValues(thresholds, data[maxValueField], ctx, {
          thresholdsField,
          thresholdValueField,
          exceedsMaxMessage: messages.exceedsMaxValue,
        });
      }
    }
  };
};

/**
 * Creates validation refinement for budget settings based on global config.
 */
export const createBudgetSettingsValidationRefinement = (
  globalMaxBudget?: number,
  requireMaxBudget?: boolean,
) => {
  return createThresholdValidationRefinement({
    enabledField: "maxBudgetEnabled",
    maxValueField: "maxSpend",
    thresholdsField: "budgetThresholds",
    thresholdValueField: "dollarsSpent",
    requireMaxValue: requireMaxBudget,
    globalMaxValue: globalMaxBudget,
    messages: {
      required: "Maximum spend is required and must be greater than 0",
      exceedsGlobalLimit: (limit) =>
        `Maximum spend cannot exceed global limit of $${limit}`,
      multipleFreezeAccount: "Only one 'Freeze Lease' threshold is allowed",
      exceedsMaxValue: "Threshold cannot exceed maximum spend",
    },
  });
};

/** Budget validation schema with config-based rules applied via .superRefine() */
export const createBudgetSettingsValidationSchema = (
  globalMaxBudget?: number,
  requireMaxBudget?: boolean,
) => {
  return BudgetSettingsValidationSchema.superRefine(
    createBudgetSettingsValidationRefinement(globalMaxBudget, requireMaxBudget),
  );
};

/**
 * Creates validation refinement for duration settings based on global config.
 * Used for lease templates with hours-based duration.
 */
export const createDurationSettingsValidationRefinement = (
  globalMaxDurationHours?: number,
  requireMaxDuration?: boolean,
) => {
  return createThresholdValidationRefinement({
    enabledField: "maxDurationEnabled",
    maxValueField: "leaseDurationInHours",
    thresholdsField: "durationThresholds",
    thresholdValueField: "hoursRemaining",
    requireMaxValue: requireMaxDuration,
    globalMaxValue: globalMaxDurationHours,
    messages: {
      required: "Duration is required and must be greater than 0",
      exceedsGlobalLimit: (limit) =>
        `Duration cannot exceed global limit of ${limit} hours`,
      multipleFreezeAccount: "Only one 'Freeze Lease' threshold is allowed",
      exceedsMaxValue: "Hours remaining cannot exceed maximum duration",
    },
  });
};

/** Duration validation schema for lease templates with config-based rules applied via .superRefine() */
export const createDurationSettingsValidationSchema = (
  globalMaxDurationHours?: number,
  requireMaxDuration?: boolean,
) => {
  return DurationSettingsValidationSchema.superRefine(
    createDurationSettingsValidationRefinement(
      globalMaxDurationHours,
      requireMaxDuration,
    ),
  );
};

/**
 * Creates validation refinement for lease expiration date settings.
 * Used for lease management with date/time picker.
 */
export const createLeaseExpirationValidationRefinement = (
  requireMaxDuration?: boolean,
  globalMaxDurationHours?: number,
  leaseStartDate?: string,
) => {
  return (data: any, ctx: z.RefinementCtx) => {
    const { maxDurationEnabled, expirationDate, durationThresholds } = data;

    // Validate that expiration date is provided when required
    const isEnabledWithoutValue = maxDurationEnabled && !expirationDate;
    const isGloballyRequiredWithoutValue =
      requireMaxDuration && !expirationDate;

    if (isEnabledWithoutValue || isGloballyRequiredWithoutValue) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expiration date is required",
        path: ["expirationDate"],
      });
    }

    // Validate expiration date is in the future
    if (expirationDate && DateTime.fromISO(expirationDate) <= DateTime.utc()) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Expiration date must be in the future",
        path: ["expirationDate"],
      });
    }

    // Validate expiration date doesn't exceed global max duration from lease start
    if (expirationDate && globalMaxDurationHours && leaseStartDate) {
      const leaseStart = DateTime.fromISO(leaseStartDate);
      const maxExpirationDateTime = leaseStart.plus({
        hours: globalMaxDurationHours,
      });
      const expirationDateTime = DateTime.fromISO(expirationDate);

      if (expirationDateTime > maxExpirationDateTime) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `Expiration date cannot exceed ${globalMaxDurationHours} hours from lease start (${maxExpirationDateTime.toLocaleString(DateTime.DATETIME_SHORT)})`,
          path: ["expirationDate"],
        });
      }
    }

    // Validate threshold hours against actual duration from lease start to expiration
    if (
      expirationDate &&
      leaseStartDate &&
      durationThresholds &&
      durationThresholds.length > 0
    ) {
      const leaseStart = DateTime.fromISO(leaseStartDate);
      const expirationDateTime = DateTime.fromISO(expirationDate);
      const totalDurationHours = expirationDateTime.diff(
        leaseStart,
        "hours",
      ).hours;

      durationThresholds.forEach((threshold: any, idx: number) => {
        if (threshold.hoursRemaining >= totalDurationHours) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            message: "Hours remaining cannot exceed maximum duration",
            path: ["durationThresholds", idx, "hoursRemaining"],
          });
        }
      });

      // Validate unique FREEZE_ACCOUNT threshold
      validateUniqueFreezeAction(durationThresholds, ctx, {
        thresholdsField: "durationThresholds",
        multipleFreezeMessage: "Only one 'Freeze Account' threshold is allowed",
      });
    }
  };
};

/** Lease expiration validation schema with config-based rules applied via .superRefine() */
export const createLeaseExpirationValidationSchema = (
  requireMaxDuration?: boolean,
  globalMaxDurationHours?: number,
  leaseStartDate?: string,
) => {
  return DurationSettingsValidationSchema.superRefine(
    createLeaseExpirationValidationRefinement(
      requireMaxDuration,
      globalMaxDurationHours,
      leaseStartDate,
    ),
  );
};

/**
 * Creates validation refinement for cost report settings based on global config.
 */
export const createCostReportSettingsValidationRefinement = (
  requireCostReportGroup?: boolean,
) => {
  return (data: any, ctx: z.RefinementCtx) => {
    // Require value if toggle is enabled (regardless of global requirement)
    if (data.costReportGroupEnabled && !data.selectedCostReportGroup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cost report group is required",
        path: ["selectedCostReportGroup"],
      });
    }

    // Also require value if globally required
    if (requireCostReportGroup && !data.selectedCostReportGroup) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: "Cost report group is required",
        path: ["selectedCostReportGroup"],
      });
    }
  };
};

/** Cost report validation schema with config-based rules applied via .superRefine() */
export const createCostReportSettingsValidationSchema = (
  requireCostReportGroup?: boolean,
) => {
  return CostReportSettingsValidationSchema.superRefine(
    createCostReportSettingsValidationRefinement(requireCostReportGroup),
  );
};

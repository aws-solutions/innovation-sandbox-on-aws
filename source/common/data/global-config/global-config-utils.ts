// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseTemplateWritable } from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { isMonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { DateTime } from "luxon";

export class ValidationException extends Error {
  readonly field?: string;

  constructor(message?: string, options?: { field?: string }) {
    super(message);
    this.name = "ValidationException";
    this.field = options?.field;
  }
}

export function validateLeaseCompliesWithGlobalConfig(
  lease: PersistedLease,
  globalConfig: GlobalConfig,
  options?: { previous: PersistedLease },
) {
  validateLeaseSharingEnabled(
    lease.allowOwnerToShareLease,
    globalConfig,
    options && { previous: options.previous.allowOwnerToShareLease },
  );
  validateBudgetFeatureGates(lease, globalConfig, options?.previous);
  validateMaxSpend(
    lease.maxSpend,
    globalConfig,
    options && { previous: options.previous.maxSpend },
  );

  if (isMonitoredLease(lease)) {
    //monitored leases consider expirationDate to be authoritative over leaseDuration, so this is the field we must validate
    validateMaxDuration(
      leaseDurationInHours(lease),
      globalConfig,
      options && { previous: leaseDurationInHours(options.previous) },
    );
  } else {
    validateMaxDuration(
      lease.leaseDurationInHours,
      globalConfig,
      options && { previous: options.previous.leaseDurationInHours },
    );
  }
}

export function validateLeaseTemplateCompliesWithGlobalConfig(
  leaseTemplate: Pick<
    LeaseTemplateWritable,
    | "maxSpend"
    | "leaseDurationInHours"
    | "allowOwnerToShareLease"
    | "predictiveBudgetEnabled"
    | "bedrockTokenMonitoringEnabled"
    | "sandboxSpacesEnabled"
  >,
  globalConfig: GlobalConfig,
  options?: {
    previous: Pick<
      LeaseTemplateWritable,
      | "maxSpend"
      | "leaseDurationInHours"
      | "allowOwnerToShareLease"
      | "predictiveBudgetEnabled"
      | "bedrockTokenMonitoringEnabled"
      | "sandboxSpacesEnabled"
    >;
  },
) {
  validateLeaseSharingEnabled(
    leaseTemplate.allowOwnerToShareLease,
    globalConfig,
    options && { previous: options.previous.allowOwnerToShareLease },
  );
  validateBudgetFeatureGates(leaseTemplate, globalConfig, options?.previous);
  validateMaxSpend(
    leaseTemplate.maxSpend,
    globalConfig,
    options && { previous: options.previous.maxSpend },
  );
  validateMaxDuration(
    leaseTemplate.leaseDurationInHours,
    globalConfig,
    options && { previous: options.previous.leaseDurationInHours },
  );
}

/**
 * Rejects a PREDICTED budget threshold when predictive budget controls are off.
 * With them off there is no projection, so the threshold never fires.
 */
export function validatePredictiveBudgetFields(
  budget: Partial<
    Pick<LeaseTemplateWritable, "predictiveBudgetEnabled" | "budgetThresholds">
  >,
) {
  if (budget.predictiveBudgetEnabled === true) {
    return;
  }
  if (
    budget.budgetThresholds?.some(
      (threshold) => threshold.triggerOn === "PREDICTED",
    )
  ) {
    throw new ValidationException(
      "triggerOn PREDICTED is only supported when predictiveBudgetEnabled is true.",
      { field: "budgetThresholds" },
    );
  }
}

type BudgetAmounts = Partial<
  Pick<LeaseTemplateWritable, "maxSpend" | "budgetThresholds">
>;

/**
 * Rejects a budget threshold at or above maxSpend, the amount that terminates
 * the lease. With `previous`, an unchanged maxSpend and unchanged threshold
 * amounts are not checked, so a stored record never blocks an unrelated edit.
 */
export function validateBudgetThresholdsBelowMaxSpend(
  budget: BudgetAmounts,
  options?: { previous: BudgetAmounts },
) {
  const { maxSpend, budgetThresholds } = budget;
  if (maxSpend === undefined) {
    return;
  }
  if (options && !budgetAmountsChanged(budget, options.previous)) {
    return;
  }
  if (
    budgetThresholds?.some((threshold) => threshold.dollarsSpent >= maxSpend)
  ) {
    throw new ValidationException(
      `Every budget threshold dollarsSpent must be less than maxSpend (${maxSpend}).`,
      { field: "budgetThresholds" },
    );
  }
}

function budgetAmountsChanged(
  next: BudgetAmounts,
  previous: BudgetAmounts,
): boolean {
  const nextAmounts =
    next.budgetThresholds?.map((threshold) => threshold.dollarsSpent) ?? [];
  const previousAmounts =
    previous.budgetThresholds?.map((threshold) => threshold.dollarsSpent) ?? [];
  return (
    next.maxSpend !== previous.maxSpend ||
    nextAmounts.length !== previousAmounts.length ||
    nextAmounts.some((amount, index) => amount !== previousAmounts[index])
  );
}

/**
 * Rejects Sandbox Spaces on a template or lease without Bedrock token
 * monitoring. Token polling selects leases by their monitoring value, so a
 * lease without it would leave its Sandbox Spaces inference unmonitored.
 */
export function validateSandboxSpacesFields(
  settings: Partial<
    Pick<
      LeaseTemplateWritable,
      "sandboxSpacesEnabled" | "bedrockTokenMonitoringEnabled"
    >
  >,
) {
  if (
    settings.sandboxSpacesEnabled === true &&
    settings.bedrockTokenMonitoringEnabled !== true
  ) {
    throw new ValidationException(
      "Sandbox Spaces requires Bedrock token monitoring. Set bedrockTokenMonitoringEnabled to true to enable Sandbox Spaces.",
      { field: "sandboxSpacesEnabled" },
    );
  }
}

/**
 * Duration in hours for a lease, using expirationDate (authoritative for
 * monitored leases) when present, else the configured leaseDurationInHours.
 */
function leaseDurationInHours(lease: PersistedLease): number | undefined {
  if (isMonitoredLease(lease)) {
    const start = DateTime.fromISO(lease.startDate, { zone: "utc" });
    const expiration = lease.expirationDate
      ? DateTime.fromISO(lease.expirationDate, { zone: "utc" })
      : undefined;
    return computeDurationBetweenInHours(start, expiration);
  }
  return lease.leaseDurationInHours;
}

function validateLeaseSharingEnabled(
  allowOwnerToShareLease: boolean | undefined,
  globalConfig: GlobalConfig,
  options?: { previous?: boolean },
) {
  validateFeatureGate({
    fieldName: "allowOwnerToShareLease",
    featureName: "lease sharing",
    enabled: allowOwnerToShareLease,
    previousEnabled: options?.previous,
    gateOpen: globalConfig.leases.leaseSharingEnabled,
  });
}

type BudgetFeatureFlags = Partial<
  Pick<
    LeaseTemplateWritable,
    | "predictiveBudgetEnabled"
    | "bedrockTokenMonitoringEnabled"
    | "sandboxSpacesEnabled"
  >
>;

/**
 * The global gates on a template's or lease's budget features and Sandbox
 * Spaces. Bedrock token monitoring may also be switched on while Sandbox
 * Spaces is enabled, which requires it.
 */
function validateBudgetFeatureGates(
  current: BudgetFeatureFlags,
  globalConfig: GlobalConfig,
  previous?: BudgetFeatureFlags,
) {
  validateFeatureGate({
    fieldName: "predictiveBudgetEnabled",
    featureName: "predictive budget controls",
    enabled: current.predictiveBudgetEnabled,
    previousEnabled: previous?.predictiveBudgetEnabled,
    gateOpen: globalConfig.leases.allowPredictiveBudgetControls,
  });
  validateFeatureGate({
    fieldName: "sandboxSpacesEnabled",
    featureName: "Sandbox Spaces",
    enabled: current.sandboxSpacesEnabled,
    previousEnabled: previous?.sandboxSpacesEnabled,
    gateOpen: globalConfig.agent.sandboxSpacesEnabled,
  });
  // When this save turns Sandbox Spaces off while Bedrock token monitoring is
  // off globally, the template or lease can't keep it on just because it was
  // on before: Sandbox Spaces may have been the only reason it was allowed.
  const sandboxSpacesTurnedOff =
    previous?.sandboxSpacesEnabled === true && !current.sandboxSpacesEnabled;
  validateFeatureGate({
    fieldName: "bedrockTokenMonitoringEnabled",
    featureName: "Bedrock token monitoring",
    enabled: current.bedrockTokenMonitoringEnabled,
    previousEnabled: sandboxSpacesTurnedOff
      ? undefined
      : previous?.bedrockTokenMonitoringEnabled,
    gateOpen:
      globalConfig.leases.allowBedrockTokenMonitoring ||
      current.sandboxSpacesEnabled === true,
  });
}

/**
 * Only blocks ENABLING the feature while its global gate is off. A template
 * or lease that already has it enabled keeps working (unchanged updates pass)
 * and may always be switched off.
 */
function validateFeatureGate(args: {
  fieldName: string;
  featureName: string;
  enabled: boolean | undefined;
  previousEnabled: boolean | undefined;
  gateOpen: boolean;
}) {
  if (args.enabled !== true || args.gateOpen) {
    return;
  }
  if (args.previousEnabled === true) {
    return;
  }
  throw new ValidationException(
    `Cannot enable ${args.fieldName} because ${args.featureName} is not available.`,
  );
}

function computeDurationBetweenInHours(
  startDate: DateTime,
  expirationDate?: DateTime,
) {
  if (!expirationDate) return undefined;
  return expirationDate.diff(startDate, "hours").hours;
}

function validateMaxSpend(
  maxSpend: number | undefined,
  globalConfig: GlobalConfig,
  options?: { previous?: number },
) {
  //maxSpend must be within global settings when used
  if (maxSpend && maxSpend > globalConfig.leases.maxBudget) {
    throw new ValidationException(
      `Max budget cannot be greater than the global max budget (${globalConfig.leases.maxBudget}).`,
    );
  }

  // On updates that leave the value unchanged, don't retroactively block edits
  // to unrelated fields just because a required max budget is missing. Only
  // enforce the requirement on create, or when the value is actually changed.
  const isUnchangedUpdate =
    options !== undefined && maxSpend === options.previous;

  //unlimited spend is not allowed if not enabled in global config
  if (!maxSpend && globalConfig.leases.requireMaxBudget && !isUnchangedUpdate) {
    throw new ValidationException(
      "A max budget must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a max budget.",
    );
  }
}

function validateMaxDuration(
  durationInHours: number | undefined,
  globalConfig: GlobalConfig,
  options?: { previous?: number },
) {
  if (
    durationInHours &&
    durationInHours > globalConfig.leases.maxDurationHours
  ) {
    throw new ValidationException(
      `Duration cannot be greater than the global max duration (${globalConfig.leases.maxDurationHours}).`,
    );
  }

  // See validateMaxSpend: unchanged updates must not be blocked retroactively.
  const isUnchangedUpdate =
    options !== undefined && durationInHours === options.previous;

  if (
    !durationInHours &&
    globalConfig.leases.requireMaxDuration &&
    !isUnchangedUpdate
  ) {
    throw new ValidationException(
      "A duration must be provided as required by administrator settings. Please contact your administrator if you need to create a lease without specifying a duration.",
    );
  }
}

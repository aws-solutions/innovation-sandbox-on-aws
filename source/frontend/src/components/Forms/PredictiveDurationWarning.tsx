// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Alert } from "@cloudscape-design/components";

import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";

/**
 * A spending rate can need up to two days of billed history before it exists,
 * so estimated-cost thresholds on a lease shorter than this may never fire.
 */
export const PREDICTIVE_MIN_DURATION_HOURS = 48;

/**
 * Warns — never blocks — when estimated cost tracking is on but the lease
 * duration is under 48 hours. Rendered by the budget, duration, and expiration
 * forms so every place the offending combination can be created shows it.
 */
export function PredictiveDurationWarning({
  predictiveBudgetEnabled,
  durationHours,
  variant,
}: Readonly<{
  predictiveBudgetEnabled?: boolean;
  durationHours?: number;
  /** Whether the form edits a template or one lease. */
  variant: SettingsFormVariant;
}>) {
  const show =
    !!predictiveBudgetEnabled &&
    durationHours !== undefined &&
    Number.isFinite(durationHours) &&
    durationHours < PREDICTIVE_MIN_DURATION_HOURS;

  if (!show) {
    return null;
  }

  return (
    <Alert type="warning">
      Estimated cost tracking is enabled, but a spending rate can need up to two
      days of history to form. With a lease duration under 48 hours,
      estimated-cost thresholds may never fire for{" "}
      {variant === "lease" ? "this lease" : "these leases"}.
    </Alert>
  );
}

/**
 * Hours between a lease's start and a chosen expiry, or undefined when either
 * timestamp is missing or unparseable.
 */
export function hoursBetween(
  startDate?: string,
  expirationDate?: string,
): number | undefined {
  if (!startDate || !expirationDate) {
    return undefined;
  }
  const start = new Date(startDate).getTime();
  const end = new Date(expirationDate).getTime();
  if (Number.isNaN(start) || Number.isNaN(end)) {
    return undefined;
  }
  return (end - start) / 3_600_000;
}

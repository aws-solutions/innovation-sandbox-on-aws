// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Popover,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import {
  colorTextInteractiveDefault,
  colorTextStatusError,
  colorTextStatusWarning,
} from "@cloudscape-design/design-tokens";
import type { ReactNode } from "react";

import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import type { BudgetThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

export type LeaseBudgetTrackerProps = {
  leaseCurrentSpend?: number;
  maxSpend?: number;
  budgetThresholds?: BudgetThreshold[];
  callerEstimatedAgentSpend?: number;
  isAgentSpendLoading?: boolean;
};

const FULL_BUDGET_FRACTION = 1;
const RING_SIZE = 18;
const RING_RADIUS = 7;
const RING_STROKE_WIDTH = 2.5;
const RING_CIRCUMFERENCE = 2 * Math.PI * RING_RADIUS;

/**
 * Returns the first configured reported-spend threshold for an action as a
 * fraction of the lease maximum. Predicted thresholds cannot be compared with
 * this current-spend ring, and thresholds at or above the maximum lose to the
 * lease's max-spend control.
 */
const firstReportedThresholdFraction = (
  thresholds: BudgetThreshold[] | undefined,
  action: BudgetThreshold["action"],
  maxSpend: number,
): number | undefined => {
  let firstThreshold: number | undefined;
  for (const threshold of thresholds ?? []) {
    if (
      threshold.action !== action ||
      (threshold.triggerOn ?? "REPORTED") !== "REPORTED" ||
      threshold.dollarsSpent >= maxSpend
    ) {
      continue;
    }
    firstThreshold =
      firstThreshold === undefined
        ? threshold.dollarsSpent
        : Math.min(firstThreshold, threshold.dollarsSpent);
  }
  return firstThreshold === undefined ? undefined : firstThreshold / maxSpend;
};

const ringColorForBudgetFraction = (
  budgetFraction: number,
  warningThresholdFraction: number | undefined,
  errorThresholdFraction: number | undefined,
): string => {
  if (
    errorThresholdFraction !== undefined &&
    budgetFraction >= errorThresholdFraction
  ) {
    return colorTextStatusError;
  }
  if (
    warningThresholdFraction !== undefined &&
    budgetFraction >= warningThresholdFraction
  ) {
    return colorTextStatusWarning;
  }
  return colorTextInteractiveDefault;
};

const CallerSpendContent = ({
  callerEstimatedAgentSpend,
  isAgentSpendLoading,
}: Pick<
  LeaseBudgetTrackerProps,
  "callerEstimatedAgentSpend" | "isAgentSpendLoading"
>) => {
  if (isAgentSpendLoading) {
    return (
      <StatusIndicator type="loading">
        Loading Sandbox Spaces spend
      </StatusIndicator>
    );
  }
  if (callerEstimatedAgentSpend === undefined) {
    return (
      <Box fontSize="body-s">
        Your Sandbox Space spend estimate is not available.
      </Box>
    );
  }
  return (
    <Box fontSize="body-s">
      Your Sandbox Space has used an estimated{" "}
      {formatCostAmount(callerEstimatedAgentSpend)} of the lease budget.
    </Box>
  );
};

export const LeaseBudgetTracker = ({
  leaseCurrentSpend,
  maxSpend,
  budgetThresholds,
  callerEstimatedAgentSpend,
  isAgentSpendLoading = false,
}: LeaseBudgetTrackerProps) => {
  const hasBudget =
    leaseCurrentSpend !== undefined && maxSpend !== undefined && maxSpend > 0;
  const percentage = hasBudget
    ? Math.min(100, Math.max(0, (leaseCurrentSpend / maxSpend) * 100))
    : 0;
  const budgetFraction = percentage / 100;
  const budgetPercent = Math.round(percentage);
  const warningThresholdFraction = hasBudget
    ? firstReportedThresholdFraction(budgetThresholds, "ALERT", maxSpend)
    : undefined;
  const errorThresholdFraction = hasBudget
    ? (firstReportedThresholdFraction(
        budgetThresholds,
        "FREEZE_ACCOUNT",
        maxSpend,
      ) ?? FULL_BUDGET_FRACTION)
    : undefined;
  const ringColor = ringColorForBudgetFraction(
    budgetFraction,
    warningThresholdFraction,
    errorThresholdFraction,
  );
  const ringCenter = RING_SIZE / 2;
  const budgetRing = (
    <svg
      width={RING_SIZE}
      height={RING_SIZE}
      viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
      aria-hidden="true"
      focusable="false"
      color={ringColor}
    >
      <circle
        cx={ringCenter}
        cy={ringCenter}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE_WIDTH}
        opacity={0.25}
      />
      <circle
        cx={ringCenter}
        cy={ringCenter}
        r={RING_RADIUS}
        fill="none"
        stroke="currentColor"
        strokeWidth={RING_STROKE_WIDTH}
        strokeLinecap="round"
        strokeDasharray={`${RING_CIRCUMFERENCE * budgetFraction} ${RING_CIRCUMFERENCE}`}
        transform={`rotate(-90 ${ringCenter} ${ringCenter})`}
      />
    </svg>
  );

  let budgetContent: ReactNode;
  if (leaseCurrentSpend === undefined) {
    budgetContent = (
      <StatusIndicator type="warning">
        Lease spend not available
      </StatusIndicator>
    );
  } else {
    budgetContent = (
      <BudgetProgressBar
        currentValue={leaseCurrentSpend}
        maxValue={maxSpend}
        formatValue={formatCostAmount}
        variant="standalone"
        ariaLabel="Lease budget used"
      />
    );
  }

  return (
    <Popover
      position="top"
      size="medium"
      fixedWidth
      triggerType="custom"
      header="Lease budget"
      dismissButton
      dismissAriaLabel="Close lease budget"
      content={
        <SpaceBetween size="s">
          {budgetContent}
          <CallerSpendContent
            callerEstimatedAgentSpend={callerEstimatedAgentSpend}
            isAgentSpendLoading={isAgentSpendLoading}
          />
        </SpaceBetween>
      }
    >
      <Button
        variant="icon"
        iconSvg={budgetRing}
        ariaLabel={
          hasBudget
            ? `Lease budget: ${budgetPercent}% used`
            : "View lease budget"
        }
        ariaHaspopup="dialog"
        formAction="none"
      />
    </Popover>
  );
};

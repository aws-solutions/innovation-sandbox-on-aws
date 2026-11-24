// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  ProgressBar,
  type ProgressBarProps,
  StatusIndicator,
} from "@cloudscape-design/components";

import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";

interface BudgetProgressBarProps {
  currentValue: number;
  maxValue?: number;
  formatValue?: (value: number) => string;
  variant?: ProgressBarProps.Variant;
  ariaLabel?: string;
}

export const BudgetProgressBar = ({
  currentValue,
  maxValue,
  formatValue = formatCurrency,
  variant = "key-value",
  ariaLabel = "Budget used",
}: BudgetProgressBarProps) => {
  const hasBudget = maxValue !== undefined && maxValue > 0;
  if (hasBudget) {
    const isOverrun = currentValue > maxValue;
    const percentage = Math.min(
      100,
      Math.max(0, (currentValue / maxValue) * 100),
    );
    return (
      <ProgressBar
        value={percentage}
        variant={variant}
        additionalInfo={`${formatValue(currentValue)} of ${formatValue(maxValue)}`}
        ariaLabel={ariaLabel}
        style={{
          progressBar: {
            backgroundColor: "light-dark(#faf5ff, #2d1b69)",
            height: "8px",
          },
          progressValue: isOverrun
            ? { backgroundColor: "light-dark(#d91515, #ff7a7a)" }
            : undefined,
        }}
      />
    );
  }

  return (
    <>
      <StatusIndicator data-small type="warning">
        No max budget
      </StatusIndicator>
      <Box>{formatValue(currentValue)}</Box>
    </>
  );
};

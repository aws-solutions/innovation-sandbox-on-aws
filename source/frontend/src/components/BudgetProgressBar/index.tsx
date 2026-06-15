// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ProgressBar, StatusIndicator } from "@cloudscape-design/components";

import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";

interface BudgetProgressBarProps {
  currentValue: number;
  maxValue?: number;
}

export const BudgetProgressBar = ({
  currentValue,
  maxValue,
}: BudgetProgressBarProps) => {
  if (maxValue) {
    const isOverrun = currentValue > maxValue;
    const percentage = Math.min(100, (currentValue / maxValue) * 100);
    return (
      <ProgressBar
        value={percentage}
        variant="key-value"
        additionalInfo={`${formatCurrency(currentValue)} of ${formatCurrency(maxValue)}`}
        ariaLabel="Budget used"
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
      <div>{formatCurrency(currentValue)}</div>
    </>
  );
};

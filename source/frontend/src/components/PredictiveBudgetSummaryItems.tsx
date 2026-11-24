// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  KeyValuePairsProps,
  StatusIndicator,
} from "@cloudscape-design/components";

import { RateLimitEntry } from "@amzn/innovation-sandbox-shared/types/lease-template";

interface PredictiveBudgetSource {
  predictiveBudgetEnabled?: boolean;
  bedrockTokenMonitoringEnabled?: boolean;
  rateLimits?: RateLimitEntry[] | null;
}

const RATE_UNIT: Record<RateLimitEntry["basis"], string> = {
  HOURLY: "hour",
  DAILY: "day",
};

const RATE_ACTION_LABEL: Record<RateLimitEntry["action"], string> = {
  ALERT: "Send alert",
  FREEZE_ACCOUNT: "Freeze lease",
};

const renderFeatureStatus = (enabled?: boolean) => {
  return enabled ? (
    <StatusIndicator type="success">Enabled</StatusIndicator>
  ) : (
    <StatusIndicator type="stopped">Disabled</StatusIndicator>
  );
};

/**
 * "$X.XX/hour (Send alert), $Y.YY/day (Freeze lease)" for the configured
 * limits; undefined when there are none.
 */
const formatRateLimits = (source: PredictiveBudgetSource) => {
  const limits = source.rateLimits ?? [];
  if (limits.length === 0) {
    return undefined;
  }
  return limits
    .map(
      (limit) =>
        `$${limit.rate.toFixed(2)}/${RATE_UNIT[limit.basis]} (${RATE_ACTION_LABEL[limit.action]})`,
    )
    .join(", ");
};

/**
 * The predictive budget rows shared by the lease and lease template summaries.
 * `rateLimitNotSet` is the empty state for the rate-limit row, so each summary
 * can match the style of the rows around it.
 */
export const predictiveBudgetSummaryItems = (
  source: PredictiveBudgetSource,
  rateLimitNotSet: React.ReactNode,
): KeyValuePairsProps.Pair[] => [
  {
    label: <Box variant="h3">Estimated cost tracking</Box>,
    value: renderFeatureStatus(source.predictiveBudgetEnabled),
  },
  {
    label: <Box variant="h3">Amazon Bedrock token monitoring</Box>,
    value: renderFeatureStatus(source.bedrockTokenMonitoringEnabled),
  },
  {
    label: <Box variant="h3">Spend rate thresholds</Box>,
    value: formatRateLimits(source) ?? rateLimitNotSet,
  },
];

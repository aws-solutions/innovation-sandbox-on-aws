// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Container,
  Header,
  KeyValuePairs,
  KeyValuePairsProps,
  SpaceBetween,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";

import {
  CostHistoryCurrent,
  RateBasis,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import { formatRelativeTime } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

import {
  accruedSinceLastCheck,
  formatCostRate,
  formatShare,
  RATE_BASIS_UNIT,
} from "./cost-history-helpers";

const NOT_ENOUGH_DATA = "Not enough data yet";

const hoursFormatter = new Intl.NumberFormat(undefined, {
  maximumFractionDigits: 1,
});

const formatHours = (hours: number): string =>
  `${hoursFormatter.format(hours)} ${hours === 1 ? "hour" : "hours"}`;

/**
 * The window a rate was measured over, stated beside it: a daily rate
 * extrapolated from a three-hour window would otherwise read as established.
 */
const formatMeasuredRate = (
  rate: number,
  basis: RateBasis,
  windowHours?: number | null,
): string => {
  const rateText = formatCostRate(rate, RATE_BASIS_UNIT[basis]);
  return windowHours == null
    ? rateText
    : `${rateText}, measured over ${formatHours(windowHours)}`;
};

/**
 * A moment as the date it falls on, with its rough distance from now underneath. A
 * countdown alone ran to six units -- "1 year, 4 months, 1 week, 3 days, 20 hours,
 * 54 minutes" -- which is far more precision than a projection off a few hours of
 * spend has, and still leaves the reader to work out what day that is. The distance
 * is kept, where a reader who only wants "about a year" can take it without reading
 * the date.
 */
const dateWithDistance = (instant: DateTime) => (
  <SpaceBetween size="xxs">
    <Box>{instant.toLocaleString(DateTime.DATETIME_MED)}</Box>
    <Box variant="small">{instant.toRelative()}</Box>
  </SpaceBetween>
);

/** When the budget is projected to run out. */
const exhaustionValue = (lastCheckedAt: string, hours: number) =>
  hours <= 0
    ? "Budget already reached"
    : dateWithDistance(DateTime.fromISO(lastCheckedAt).plus({ hours }));

/**
 * When the lease ends: its expiry while it is running, and the moment it actually
 * ended once it has. Sat beside budget exhaustion, because which of the two comes
 * first is the question a reader has about both of them.
 */
const leaseEndValue = (leaseEnd?: string) =>
  leaseEnd === undefined
    ? "No end date set"
    : dateWithDistance(DateTime.fromISO(leaseEnd));

const billedValue = (
  current: CostHistoryCurrent,
  maxSpend?: number,
): string => {
  const billed = formatCostAmount(current.billedCostAccrued);
  return maxSpend == null
    ? billed
    : `${billed} of ${formatCostAmount(maxSpend)} (${formatShare(
        current.billedCostAccrued / maxSpend,
      )})`;
};

/**
 * The estimate at this moment, not at the last monitoring run: the reading is up to
 * an interval old, so what it projected is carried forward at the rate it measured.
 */
const estimateValue = (current: CostHistoryCurrent, now: Date) => {
  if (current.rateSource == null) {
    return NOT_ENOUGH_DATA;
  }
  const { accrued } = accruedSinceLastCheck(current, now);
  return `≈ ${formatCostAmount(current.predictedCost + accrued)}`;
};

const rateValue = (current: CostHistoryCurrent) => {
  const lines: string[] = [];
  if (current.hourlyRate != null) {
    lines.push(
      formatMeasuredRate(
        current.hourlyRate,
        "HOURLY",
        current.hourlyRateWindowHours,
      ),
    );
  }
  if (current.dailyRate != null) {
    lines.push(
      formatMeasuredRate(
        current.dailyRate,
        "DAILY",
        current.dailyRateWindowHours,
      ),
    );
  }
  if (lines.length === 0) {
    return NOT_ENOUGH_DATA;
  }
  return (
    <SpaceBetween size="xxs">
      {lines.map((line) => (
        <Box key={line}>{line}</Box>
      ))}
    </SpaceBetween>
  );
};

const freshnessValue = (current: CostHistoryCurrent) => (
  <SpaceBetween size="xxs">
    <Box>
      {DateTime.fromISO(current.latestPeriodStart).toLocaleString(
        DateTime.DATE_FULL,
      )}
    </Box>
    <Box variant="small">
      {`Last checked ${formatRelativeTime(current.lastCheckedAt)}`}
    </Box>
  </SpaceBetween>
);

type CostHeadlineProps = {
  current?: CostHistoryCurrent | null;
  /** The lease's budget, from the lease. */
  maxSpend?: number;
  leaseEnd?: string;
  leaseEndedAt?: string;
};

export const CostHeadline = ({
  current,
  maxSpend,
  leaseEnd,
  leaseEndedAt,
}: CostHeadlineProps) => {
  const header = <Header variant="h2">Spend summary</Header>;

  if (current == null) {
    return (
      <Container header={header}>
        <Alert type="warning" header="Cost figures unavailable">
          The most recent reading could not be read. This is not a report of
          zero spend — this lease may already be at its budget.
        </Alert>
      </Container>
    );
  }

  const now = DateTime.now();
  const estimateAt =
    leaseEndedAt === undefined
      ? now
      : DateTime.min(now, DateTime.fromISO(leaseEndedAt));
  const items: KeyValuePairsProps.Pair[] = [
    {
      label: "Billed to date",
      value: billedValue(current, maxSpend),
    },
    {
      label:
        leaseEndedAt === undefined
          ? "Predicted spend now"
          : "Predicted spend at lease end",
      value: estimateValue(current, estimateAt.toJSDate()),
    },
    {
      label: "Spend rate",
      value: rateValue(current),
    },
  ];

  if (maxSpend != null) {
    items.push({
      label: "Budget exhausted by",
      value:
        current.hoursToBudgetExhaustion == null
          ? NOT_ENOUGH_DATA
          : exhaustionValue(
              current.lastCheckedAt,
              current.hoursToBudgetExhaustion,
            ),
    });
  }

  items.push(
    {
      label: "Lease end date",
      value: leaseEndValue(leaseEnd),
    },
    {
      label: "Billing data covers",
      value: freshnessValue(current),
    },
  );

  return (
    <Container header={header}>
      <KeyValuePairs columns={3} items={items} />
    </Container>
  );
};

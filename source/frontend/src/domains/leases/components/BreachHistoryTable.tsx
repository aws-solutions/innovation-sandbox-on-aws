// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Badge,
  BadgeProps,
  Box,
  Button,
  Header,
  Pagination,
  Table,
} from "@cloudscape-design/components";
import { ReactNode, useEffect } from "react";

import { TimePopover } from "@amzn/innovation-sandbox-frontend/components/TimePopover";
import {
  BreachAction,
  BreachEntry,
  BreachInsight,
  BreachTriggeredBy,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import { formatCurrency } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

import {
  formatCostRate,
  formatPercent,
  formatShare,
  RATE_BASIS_UNIT,
} from "./cost-history-helpers";

// Keyed by the enum rather than switched on, so a fourth producer value is a
// compile error here instead of a blank cell.
export const TRIGGERED_BY_LABELS: Record<BreachTriggeredBy, string> = {
  REPORTED: "Billed cost",
  PREDICTED: "Projected cost",
  RATE: "Spend rate",
  MAX_SPEND: "Max spend",
  DURATION: "Time remaining",
  EXPIRY: "Expiry",
};

// Only the projection is an estimate and only max spend and expiry end the
// lease, so only those are set apart.
const TRIGGERED_BY_COLORS: Record<BreachTriggeredBy, BadgeProps["color"]> = {
  REPORTED: "grey",
  PREDICTED: "blue",
  RATE: "grey",
  MAX_SPEND: "red",
  DURATION: "grey",
  EXPIRY: "red",
};

const ACTION_LABELS: Record<BreachAction, string> = {
  ALERT: "Send alert",
  FREEZE_ACCOUNT: "Freeze account",
  TERMINATE: "Terminate lease",
};

const formatThreshold = (breach: BreachEntry): string => {
  if (breach.triggeredBy === "RATE") {
    return breach.thresholdRate == null || breach.thresholdRateBasis == null
      ? "—"
      : formatCostRate(
          breach.thresholdRate,
          RATE_BASIS_UNIT[breach.thresholdRateBasis],
        );
  }
  if (breach.triggeredBy === "DURATION") {
    return breach.thresholdHoursRemaining == null
      ? "—"
      : `${breach.thresholdHoursRemaining} hours`;
  }
  return breach.thresholdDollars == null
    ? "—"
    : formatCostAmount(breach.thresholdDollars);
};

/**
 * The figure compared against the threshold, as stored. `evaluatedSpendAtFire`
 * is that figure when the token poll substitutes monitored Bedrock token
 * cost for the billed Bedrock slice. A duration threshold and expiry compare
 * time, not a figure; their billed total is context.
 */
const formatFigureAtFire = (breach: BreachEntry): string => {
  if (breach.triggeredBy === "DURATION" || breach.triggeredBy === "EXPIRY") {
    return "—";
  }
  if (breach.triggeredBy === "RATE") {
    return breach.rateAtFire == null || breach.rateSourceAtFire == null
      ? "—"
      : formatCostRate(
          breach.rateAtFire,
          RATE_BASIS_UNIT[breach.rateSourceAtFire],
        );
  }
  if (breach.triggeredBy === "PREDICTED") {
    return breach.predictedCostAtFire == null
      ? "—"
      : `≈ ${formatCostAmount(breach.predictedCostAtFire)}`;
  }
  return formatCostAmount(
    breach.evaluatedSpendAtFire ?? breach.billedCostAtFire,
  );
};

/**
 * The sentence the notification sent, rebuilt from the insight stored with it, so
 * its amount is formatted as the email formatted it.
 */
const formatInsight = (insight: BreachInsight): string => {
  const amount = formatCurrency(insight.amount);
  switch (insight.kind) {
    case "COMPOSITION": {
      const share =
        insight.shareOfComparedSpend == null
          ? ""
          : ` (${formatShare(insight.shareOfComparedSpend)})`;
      return `The largest service is ${insight.service}, ${amount}${share}.`;
    }
    case "CHANGE": {
      if (insight.changePercent == null) {
        return `The biggest change is ${insight.service}, now ${amount}.`;
      }
      const direction = insight.changePercent < 0 ? "down" : "up";
      return `The biggest change is ${insight.service}, ${direction} ${formatPercent(
        Math.abs(insight.changePercent),
      )} since the previous interval, now ${amount}.`;
    }
    case "NEW_ENTRANT":
      return `New this interval: ${insight.service}, ${amount}.`;
  }
};

/** The badge naming what a breach fired on. */
const renderTriggeredBy = (breach: BreachEntry) => (
  <Badge color={TRIGGERED_BY_COLORS[breach.triggeredBy]}>
    {TRIGGERED_BY_LABELS[breach.triggeredBy]}
  </Badge>
);

const renderTimestamp = (breach: BreachEntry) => (
  <TimePopover time={breach.timestamp} />
);

const BREACHES_PER_PAGE = 10;

type BreachHistoryTableProps = {
  breaches: BreachEntry[];
  /** The range picker, for the table's header. */
  headerActions?: ReactNode;
  loading?: boolean;
  /** Puts the picker back on the whole lease, offered where a narrower range has no breaches. */
  onResetRange?: () => void;
  /** A new value returns the table to its first page, as a new range does. */
  firstPageKey?: string;
  /** Shown in place of the empty states, as a failed load is. */
  empty?: ReactNode;
};

export const BreachHistoryTable = ({
  breaches,
  headerActions,
  loading = false,
  onResetRange,
  firstPageKey,
  empty,
}: BreachHistoryTableProps) => {
  const { items, actions, collectionProps, paginationProps } = useCollection(
    breaches,
    { pagination: { pageSize: BREACHES_PER_PAGE } },
  );
  useEffect(() => {
    actions.setCurrentPage(1);
  }, [actions, firstPageKey]);
  return (
    <Table<BreachEntry>
      {...collectionProps}
      variant="container"
      loading={loading}
      loadingText="Loading breach history"
      pagination={<Pagination {...paginationProps} />}
      header={
        <Header
          actions={headerActions}
          // No count while the breaches are loading or could not be loaded.
          {...(loading || empty !== undefined
            ? {}
            : { counter: `(${breaches.length})` })}
          description="The figures as they stood when each threshold fired. Nothing here is recalculated from the current cost."
        >
          Breach history
        </Header>
      }
      columnDefinitions={[
        {
          id: "timestamp",
          header: "When",
          cell: renderTimestamp,
        },
        {
          id: "triggeredBy",
          header: "Fired on",
          cell: renderTriggeredBy,
        },
        {
          id: "threshold",
          header: "Threshold",
          cell: formatThreshold,
        },
        {
          id: "figureAtFire",
          header: "Figure at the time",
          cell: formatFigureAtFire,
        },
        {
          id: "action",
          header: "Action",
          cell: (breach) => ACTION_LABELS[breach.action],
        },
        {
          id: "insight",
          header: "Insight",
          cell: (breach) =>
            breach.insight == null ? "—" : formatInsight(breach.insight),
        },
      ]}
      items={items}
      trackBy={(breach) => breach.timestamp}
      empty={
        empty ??
        (onResetRange === undefined ? (
          <Box textAlign="center" color="inherit" variant="p">
            No thresholds have fired on this lease
          </Box>
        ) : (
          <Box textAlign="center" color="inherit">
            <Box variant="p" color="inherit">
              No thresholds fired in the selected range
            </Box>
            <Button onClick={onResetRange}>Reset filters</Button>
          </Box>
        ))
      }
    />
  );
};

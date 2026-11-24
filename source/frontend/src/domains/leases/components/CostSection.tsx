// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  DateRangePickerProps,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { ReactNode, useMemo, useState } from "react";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { BedrockTokenUsage } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BedrockTokenUsage";
import { BreachHistory } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistory";
import {
  CostRangePicker,
  lastIncludedInstant,
  PartialRangeAlert,
  toCostHistoryRange,
  WHOLE_LEASE,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";
import {
  CostChart,
  CostChartBudget,
  CostChartContainer,
  CostChartLeaseSpan,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart";
import { CostHeadline } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostHeadline";
import { CostServicesTable } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostServicesTable";
import {
  useGetLeaseCostSummary,
  useGetMergedLeaseCostHistory,
  useRefetchLeaseById,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { buildPredictedSegments } from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import {
  CostHistoryCurrent,
  PredictedSegment,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { BudgetThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const sectionHeader = (
  <Header
    variant="h2"
    info={<InfoLink markdown="lease-cost" />}
    description="What this lease has spent, how fast it is spending, and every threshold that has fired."
  >
    Cost
  </Header>
);

// The chart needs a data shape to render its own loading state, and no readings
// draws no series.
const NO_READINGS = { result: [], predicted: [] };

type SpendChartInput = {
  history: ReturnType<typeof useGetMergedLeaseCostHistory>;
  summaryPending: boolean;
  predicted: PredictedSegment[];
  current: CostHistoryCurrent | null | undefined;
  budget: CostChartBudget;
  picker: ReactNode;
  page: ReturnType<typeof toCostHistoryRange>;
  leaseSpan: CostChartLeaseSpan | undefined;
  leaseEndedAt: string | undefined;
  onResetRange: () => void;
};

/** The spend chart in whichever state the history read is in. */
const spendChart = ({
  history,
  summaryPending,
  predicted,
  current,
  budget,
  picker,
  page,
  leaseSpan,
  leaseEndedAt,
  onResetRange,
}: SpendChartInput): ReactNode => {
  if (history.isError) {
    return (
      <CostChartContainer actions={picker}>
        <ErrorPanel
          description="There was a problem loading cost history for this lease."
          retry={history.refetch}
          error={history.error ?? undefined}
        />
      </CostChartContainer>
    );
  }
  if (history.data === undefined || summaryPending) {
    // Drawn once the figures it continues the line with have settled too, read
    // or failed, so the line is not drawn twice.
    return (
      <CostChart {...NO_READINGS} budget={budget} loading actions={picker} />
    );
  }
  // The lease's length only bounds the chart where the whole lease was asked
  // for -- no query bounds -- since any narrower range was asked for instead of
  // it. Its end date goes across whatever was picked, because a narrower range
  // does not make a lease that has ended go on spending. The chart ends at the
  // range's last included instant, not at the exclusive end the API is sent.
  return (
    <CostChart
      result={history.data.result}
      predicted={predicted}
      current={current}
      budget={budget}
      actions={picker}
      {...(page === undefined
        ? {}
        : {
            range: {
              fromTimestamp: page.afterTimestamp,
              toTimestamp: lastIncludedInstant(page),
            },
          })}
      {...(page === undefined && leaseSpan !== undefined ? { leaseSpan } : {})}
      {...(leaseEndedAt === undefined ? {} : { leaseEndedAt })}
      onResetRange={onResetRange}
    />
  );
};

type SpendHeadlineInput = {
  summary: ReturnType<typeof useGetLeaseCostSummary>;
  current: CostHistoryCurrent | null | undefined;
  readingCount: number;
  maxSpend: number | undefined;
  leaseEnd: string | undefined;
  leaseEndedAt: string | undefined;
};

/** The spend summary over the chart, or nothing before the lease has readings. */
const spendHeadline = ({
  summary,
  current,
  readingCount,
  maxSpend,
  leaseEnd,
  leaseEndedAt,
}: SpendHeadlineInput): ReactNode => {
  if (summary.isError) {
    return (
      <ErrorPanel
        description="There was a problem loading the spend summary for this lease."
        retry={summary.refetch}
        error={summary.error ?? undefined}
      />
    );
  }
  // A lease whose first monitoring run has not landed has nothing to head, and
  // the chart's empty state says so without the headline reporting the newest
  // reading as unreadable.
  const hasReadings =
    current != null || (summary.data !== undefined && readingCount > 0);
  if (!hasReadings) {
    return undefined;
  }
  return (
    <CostHeadline
      current={current}
      {...(maxSpend === undefined ? {} : { maxSpend })}
      {...(leaseEnd === undefined ? {} : { leaseEnd })}
      {...(leaseEndedAt === undefined ? {} : { leaseEndedAt })}
    />
  );
};

type CostSectionProps = {
  leaseId: string;
  predictiveBudgetEnabled: boolean;
  bedrockTokenMonitoringEnabled: boolean;
  /** The lease's budget and thresholds, from the lease. */
  maxSpend?: number;
  budgetThresholds?: BudgetThreshold[];
  leaseSpan?: CostChartLeaseSpan;
  leaseEndedAt?: string;
  /** The figure the lease's thresholds were last compared against, from the lease. */
  lastEvaluatedSpend?: number;
};

export const CostSection = ({
  leaseId,
  predictiveBudgetEnabled,
  bedrockTokenMonitoringEnabled,
  maxSpend,
  budgetThresholds,
  leaseSpan,
  leaseEndedAt,
  lastEvaluatedSpend,
}: CostSectionProps) => {
  // Opens on the whole lease: the billed series is cumulative from the lease's
  // first reading, so a window that starts partway through it opens on a total
  // with no account of how it got there. Held as the option rather than as null so
  // that the dropdown shows what is being looked at.
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(
    WHOLE_LEASE,
  );
  const page = useMemo(() => toCostHistoryRange(range), [range]);
  const history = useGetMergedLeaseCostHistory(leaseId, page);
  const { data, isError } = history;
  // The lease's newest figures, whatever the range, read on their own so that
  // either read can fail without taking the other with it.
  const summary = useGetLeaseCostSummary(leaseId);
  const refetchLease = useRefetchLeaseById(leaseId);
  const current = summary.isError ? undefined : summary.data?.current;
  const budget = useMemo<CostChartBudget>(
    () => ({
      ...(maxSpend === undefined ? {} : { maxSpend }),
      thresholds: budgetThresholds ?? [],
    }),
    [maxSpend, budgetThresholds],
  );
  const predicted = useMemo(
    () =>
      data === undefined
        ? []
        : buildPredictedSegments(data.result, current, page),
    [data, current, page],
  );

  // The newest figures are read again with every range, and the lease with them
  // for its budget, so the headline, the current estimate and the budget
  // lines are never older than what the chart draws, nor than each other.
  const pickRange = (value: DateRangePickerProps.Value | null) => {
    setRange(value);
    void summary.refetch();
    void refetchLease();
  };

  // The range bounds the chart, as the Bedrock token panel and the breach history
  // have their own, so it is picked from the chart's own header.
  // Rendered in every branch, including the error one: a range that fails to load
  // has to be changeable from where it was picked.
  const picker = (
    <CostRangePicker
      value={range}
      onChange={pickRange}
      ariaLabel="Spend over time range"
    />
  );

  // Its own range: token usage reads best over its own span, whatever the spend
  // chart is showing. In every branch, under one key, so that loading or failing
  // to load a new spend range neither resets it nor reads the whole lease again.
  const tokenUsage = bedrockTokenMonitoringEnabled && (
    <BedrockTokenUsage
      key="bedrock-token-usage"
      leaseId={leaseId}
      {...(leaseEndedAt === undefined ? {} : { leaseEndedAt })}
      {...(lastEvaluatedSpend === undefined ? {} : { lastEvaluatedSpend })}
    />
  );

  // Its own range too, since the thresholds that fired are not the spend chart's
  // to filter.
  const breachHistory = (
    <BreachHistory key="breach-history" leaseId={leaseId} />
  );

  const chart = spendChart({
    history,
    summaryPending: summary.isPending,
    predicted,
    current,
    budget,
    picker,
    page,
    leaseSpan,
    leaseEndedAt,
    onResetRange: () => pickRange(WHOLE_LEASE),
  });
  const headline = spendHeadline({
    summary,
    current,
    readingCount: data?.result.length ?? 0,
    maxSpend,
    leaseEnd: leaseSpan?.to,
    leaseEndedAt,
  });

  const loaded = !isError && data !== undefined;
  // The drain stops at its cap and leaves the unconsumed cursor here. Said
  // out loud rather than left to the console: what this range draws is drawn from
  // a partial series, and a reader who is not told reads it as the whole range.
  // A loose check because the member is optional: an absent cursor is a finished
  // range, not a truncated one.
  const isTruncated = loaded && data.nextPageIdentifier != null;
  // Newest first, so the last row is the oldest reading the drain loaded.
  const loadedSince = data?.result.at(-1)?.timestamp;

  return (
    <SpaceBetween size="l">
      {sectionHeader}
      {loaded && !predictiveBudgetEnabled && (
        <Alert
          type="info"
          header="Estimated cost tracking is off for this lease"
        >
          The estimated cost, spend rate and projected lines on the chart stay
          empty. Estimated cost tracking is set in the lease's budget settings,
          not here.
        </Alert>
      )}
      {isTruncated && (
        <PartialRangeAlert
          header="Showing part of this range"
          subject="usage"
          loadedSince={loadedSince}
          fallback="This range holds more than the section loads at once, so the spend chart covers only its newest readings. Pick a narrower range to see earlier."
        />
      )}
      {headline}
      {chart}
      {summary.data !== undefined && !summary.isError && (
        <CostServicesTable services={current?.services ?? []} />
      )}
      {tokenUsage}
      {breachHistory}
    </SpaceBetween>
  );
};

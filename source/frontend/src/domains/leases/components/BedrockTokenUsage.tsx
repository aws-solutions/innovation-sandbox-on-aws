// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Button,
  Container,
  DateRangePickerProps,
  Header,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { ReactNode, useMemo, useState } from "react";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  BedrockTokenPanel,
  RangePickerRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/BedrockTokenPanel";
import {
  CostRangePicker,
  lastIncludedInstant,
  toCostHistoryRange,
  WHOLE_LEASE,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";
import { TokenSpan } from "@amzn/innovation-sandbox-frontend/domains/leases/components/token-charts";
import {
  useGetLeaseBedrockTokenBaseline,
  useGetLeaseBedrockTokenHistory,
  useGetMergedLeaseBedrockTokenHistory,
  useRefetchLeaseById,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  BedrockTokenHistoryData,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";

/** `now`, or where the range or the lease stops short of it. */
const spanEnd = (now: number, ends: (string | undefined)[]): Date =>
  new Date(
    Math.min(
      now,
      ...ends.flatMap((end) =>
        end === undefined ? [] : [DateTime.fromISO(end).toMillis()],
      ),
    ),
  );

// Reduced rather than spread, since a long lease holds more rows than a call takes.
const newestReadingOf = (tokens: TokenSeriesRow[]): number =>
  tokens.reduce(
    (newest, { timestamp }) => Math.max(newest, Date.parse(timestamp)),
    0,
  );

const oldestReadingOf = (tokens: TokenSeriesRow[]): number =>
  tokens.reduce(
    (oldest, { timestamp }) => Math.min(oldest, Date.parse(timestamp)),
    Number.POSITIVE_INFINITY,
  );

/**
 * The rows of the newest reading before a range, from the one-reading page that
 * reads it: none where no reading came before the range, and undefined where that
 * reading could not be read, which an empty page with more to read means.
 */
const baselineOf = (
  page: BedrockTokenHistoryData,
): TokenSeriesRow[] | undefined =>
  page.result.length === 0 && page.nextPageIdentifier != null
    ? undefined
    : page.result;

type BedrockTokenUsageProps = {
  leaseId: string;
  /** When the lease ended, for one that has. */
  leaseEndedAt?: string;
  /** The figure the lease's thresholds were last compared against, from the lease. */
  lastEvaluatedSpend?: number;
};

/**
 * The Bedrock token panel with a range of its own, which it asks for, as the spend
 * chart does, so a range reaches back past what one load of the whole lease holds.
 * The counts are lease-to-date, so a range's first period is measured from the
 * newest reading before it, read alongside. Past the drain's cap
 * only the newest readings arrive, and the panel says so. Its figures are the
 * lease's latest, whatever the range: its newest reading, read on its own, and
 * the lease's last evaluated spend.
 */
export const BedrockTokenUsage = ({
  leaseId,
  leaseEndedAt,
  lastEvaluatedSpend,
}: BedrockTokenUsageProps) => {
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(
    WHOLE_LEASE,
  );
  // Resolved once, when the range is picked, so the request holds still rather
  // than asking again at every render. What a relative range draws is measured
  // from each read instead, below.
  const bounds = useMemo(() => toCostHistoryRange(range), [range]);
  const { data, dataUpdatedAt, isError, error, refetch } =
    useGetMergedLeaseBedrockTokenHistory(leaseId, bounds);
  // No range, so the newest stored reading, whatever the range shows.
  const latest = useGetLeaseBedrockTokenHistory(leaseId, { maxResults: 1 });
  // Keyed by the range, so a new range reads its own; the whole lease reads none.
  const baseline = useGetLeaseBedrockTokenBaseline(
    leaseId,
    bounds?.afterTimestamp,
  );
  const refetchLease = useRefetchLeaseById(leaseId);
  const baselineSettled =
    bounds === undefined || baseline.data !== undefined || baseline.isError;
  // Ended when the data was read, not at each render, so the span moves only with
  // the data or the range.
  const readAt = dataUpdatedAt || Date.now();
  // Unavailable where its read failed, and set aside where the drain stopped
  // short: the charts are then measured from the oldest reading loaded, which is
  // not the one the baseline precedes.
  const baselineReading =
    bounds === undefined ||
    baseline.isError ||
    baseline.data === undefined ||
    data?.nextPageIdentifier != null
      ? undefined
      : baselineOf(baseline.data);
  const tokens = useMemo(
    () =>
      data === undefined
        ? undefined
        : [...data.result, ...(baselineReading ?? [])],
    [data, baselineReading],
  );
  const view = useMemo(() => {
    if (data === undefined || tokens === undefined || !baselineSettled) {
      return undefined;
    }
    // Now reaches the newest reading, which the server's clock may have stamped
    // after this browser's; the range's end and the lease's still cap it, as they
    // do the spend chart.
    const now = Math.max(readAt, newestReadingOf(tokens));
    const truncated = data.nextPageIdentifier != null;
    // Where the readings before what loaded did not arrive, the charts are measured
    // from the first reading that did, rather than from nothing, which would count
    // everything used before it in their first period: a range without its
    // baseline, or a load the drain stopped short, the whole lease included.
    const unmeasured =
      tokens.length > 0 &&
      (truncated || (bounds !== undefined && baselineReading === undefined));
    const measuredFrom = unmeasured ? oldestReadingOf(tokens) + 1 : 0;
    // A relative range sends only its start, and the server ends it at each read,
    // so what it draws reaches back from the read, as the picker names it, rather
    // than from when it was picked. The request reaches back at least as far, so
    // the readings that measure its first period are in the data.
    const drawn = toCostHistoryRange(range, DateTime.fromMillis(readAt));
    const drawnFrom =
      drawn?.afterTimestamp === undefined
        ? undefined
        : DateTime.fromISO(drawn.afterTimestamp).toMillis();
    const from = unmeasured
      ? Math.max(drawnFrom ?? 0, measuredFrom)
      : drawnFrom;
    const span: TokenSpan = {
      ...(from === undefined ? {} : { from: new Date(from) }),
      to: spanEnd(now, [lastIncludedInstant(bounds), leaseEndedAt]),
      ...(unmeasured ? { unknownBefore: true } : {}),
    };
    const rangeEnd =
      bounds?.beforeTimestamp === undefined
        ? undefined
        : DateTime.fromISO(bounds.beforeTimestamp).toMillis();
    return {
      span,
      truncated,
      // A range running to now with nothing in it and nothing before it means
      // nothing has been read for the lease, as the whole lease would say. Not
      // where the readings before it did not arrive, which may hold some.
      wholeLease:
        bounds === undefined ||
        (rangeEnd === undefined &&
          tokens.length === 0 &&
          baselineReading !== undefined &&
          !truncated),
      measuredFromFirstReading: unmeasured && !truncated,
      // Where the drain stopped short, the oldest reading it loaded, which the
      // charts are measured from.
      loadedSince:
        truncated && tokens.length > 0
          ? new Date(oldestReadingOf(tokens))
          : undefined,
    };
  }, [
    data,
    tokens,
    baselineReading,
    baselineSettled,
    range,
    bounds,
    readAt,
    leaseEndedAt,
  ]);

  // The newest reading is read again with every range, and the lease with it for
  // its last evaluated spend, so the figures above the charts are never older than
  // what the charts draw, nor than each other. A new range reads its own
  // baseline, being keyed by it.
  const pickRange = (value: DateRangePickerProps.Value | null) => {
    setRange(value);
    void latest.refetch();
    void refetchLease();
  };
  const retry = () => {
    void refetch();
    void latest.refetch();
    void refetchLease();
    if (bounds !== undefined) {
      void baseline.refetch();
    }
  };
  // Sits with what it filters: in the token chart's header once there is one,
  // and on a row of its own above whatever stands in for the charts until then.
  const picker = (
    <CostRangePicker
      value={range}
      onChange={pickRange}
      ariaLabel="Bedrock token usage range"
    />
  );
  // Its figures are left out while it loads or where it fails, even with an
  // earlier read in hand, as they are where it brings back no row -- which is
  // also what a newest reading that could not be read brings back.
  const latestReading = latest.isError ? undefined : latest.data?.result;

  let body: ReactNode;
  if (data !== undefined && tokens !== undefined && view !== undefined) {
    // A failed refresh keeps what was already read, and says so.
    body = (
      <SpaceBetween size="l">
        {isError && (
          <Alert
            type="warning"
            header="Showing token usage read earlier"
            action={<Button onClick={retry}>Try again</Button>}
          >
            The latest token usage could not be loaded.
          </Alert>
        )}
        <BedrockTokenPanel
          key="panel"
          tokens={tokens}
          {...(latestReading === undefined ? {} : { latestReading })}
          {...(lastEvaluatedSpend === undefined ? {} : { lastEvaluatedSpend })}
          span={view.span}
          wholeLease={view.wholeLease}
          truncated={view.truncated}
          measuredFromFirstReading={view.measuredFromFirstReading}
          {...(view.loadedSince === undefined
            ? {}
            : { loadedSince: view.loadedSince })}
          rangePicker={picker}
          onResetRange={() => pickRange(WHOLE_LEASE)}
        />
      </SpaceBetween>
    );
  } else if (isError) {
    body = (
      <SpaceBetween size="l">
        <RangePickerRow>{picker}</RangePickerRow>
        <ErrorPanel
          description="There was a problem loading Bedrock token usage for this lease."
          retry={retry}
          error={error ?? undefined}
        />
      </SpaceBetween>
    );
  } else {
    body = (
      <SpaceBetween size="l">
        <RangePickerRow>{picker}</RangePickerRow>
        <StatusIndicator type="loading">
          Loading Bedrock token usage
        </StatusIndicator>
      </SpaceBetween>
    );
  }

  // One container and header in every state, whichever part of the body holds
  // the range picker.
  return (
    <Container
      header={
        <Header
          variant="h2"
          description="Bedrock tokens counted for this lease so far, priced before AWS Cost Explorer bills them."
        >
          Bedrock token usage
        </Header>
      }
    >
      {body}
    </Container>
  );
};

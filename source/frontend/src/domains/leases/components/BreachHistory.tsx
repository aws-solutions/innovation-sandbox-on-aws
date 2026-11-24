// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Button,
  DateRangePickerProps,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useMemo, useState } from "react";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { BreachHistoryTable } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistoryTable";
import {
  CostRangePicker,
  PartialRangeAlert,
  toCostHistoryRange,
  WHOLE_LEASE,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";
import { useGetMergedLeaseBreachHistory } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";

/**
 * The breach history under a range picker of its own, so the range picked for the
 * spend chart leaves it whole. It loads every breach of the range before the
 * table pages through them.
 */
export const BreachHistory = ({ leaseId }: { leaseId: string }) => {
  const [range, setRange] = useState<DateRangePickerProps.Value | null>(
    WHOLE_LEASE,
  );
  const bounds = useMemo(() => toCostHistoryRange(range), [range]);
  const { data, isError, error, refetch } = useGetMergedLeaseBreachHistory(
    leaseId,
    bounds,
  );
  const picker = (
    <CostRangePicker
      value={range}
      onChange={setRange}
      ariaLabel="Breach history range"
    />
  );

  // The load stops at its cap and leaves the cursor here, so the oldest breaches
  // of a long range may not have arrived. Dated from the oldest breach shown,
  // newest first: breach pages carry no readings to date it from instead.
  const loadedSince = data?.result.at(-1)?.timestamp;
  // One table in every state, failed loads included, so the range picker in its
  // header is the same one throughout and keeps focus when a range fails.
  return (
    <SpaceBetween size="s">
      {data !== undefined && isError && (
        <Alert
          type="warning"
          header="Showing breach history read earlier"
          action={<Button onClick={() => void refetch()}>Try again</Button>}
        >
          The latest breach history could not be loaded.
        </Alert>
      )}
      {data?.nextPageIdentifier != null && (
        <PartialRangeAlert
          header="Showing part of this range's breaches"
          subject="breaches"
          loadedSince={loadedSince}
          fallback="This range holds more than the section loads at once, so only its newest breaches are shown. Pick a narrower range to see earlier."
        />
      )}
      <BreachHistoryTable
        breaches={data?.result ?? []}
        headerActions={picker}
        // A new range starts again on its first page.
        firstPageKey={JSON.stringify(bounds ?? null)}
        loading={data === undefined && !isError}
        {...(data === undefined && isError
          ? {
              empty: (
                <ErrorPanel
                  description="There was a problem loading the breach history for this lease."
                  retry={refetch}
                  error={error ?? undefined}
                />
              ),
            }
          : {})}
        {...(bounds === undefined
          ? {}
          : { onResetRange: () => setRange(WHOLE_LEASE) })}
      />
    </SpaceBetween>
  );
};

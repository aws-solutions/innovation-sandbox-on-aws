// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AreaChart,
  Box,
  Button,
  Header,
  KeyValuePairs,
  KeyValuePairsProps,
  MixedLineBarChart,
  SegmentedControl,
  SpaceBetween,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { ReactNode, useMemo, useState } from "react";

import { PartialRangeAlert } from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-range";
import {
  buildTokenCharts,
  DERIVED_COST_TITLE,
  formatTokenCount,
  OTHER_MODELS_TITLE,
  TokenCharts,
  TokenPeriodUnit,
  TokenSpan,
  TokenStackDimension,
  tokensUsedSoFar,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/token-charts";
import { TokenSeriesRow } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";
import { UNATTRIBUTED_MODEL_ID } from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import { formatCurrency } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

/** Shorter than a chart's default, since the panel carries two of them. */
const CHART_HEIGHT = 300;

const tokenTickFormatter = new Intl.NumberFormat(undefined, {
  notation: "compact",
});

const formatTime = (x: Date): string =>
  DateTime.fromJSDate(x).toLocaleString(DateTime.DATETIME_SHORT);

/** A period's label: its day, or its day and hour. */
const PERIOD_FORMATS: Record<TokenPeriodUnit, Intl.DateTimeFormatOptions> = {
  hour: { month: "numeric", day: "numeric", hour: "numeric" },
  day: { month: "numeric", day: "numeric" },
};

const figureWithNote = (figure: string, note: string) => (
  <SpaceBetween size="xxs">
    <Box>{figure}</Box>
    <Box variant="small">{note}</Box>
  </SpaceBetween>
);

/** Every token the lease has counted, as of its newest reading. */
function tokensSoFar(
  latestReading: TokenSeriesRow[],
): KeyValuePairsProps.Pair[] {
  const soFar = tokensUsedSoFar(latestReading);
  if (soFar === undefined) {
    return [];
  }
  return [
    {
      label: "Tokens used so far",
      value: figureWithNote(
        formatTokenCount(soFar.total),
        `Last changed ${formatTime(soFar.at)}`,
      ),
    },
  ];
}

/**
 * Evaluated spend is shown only beside the monitored token cost: without
 * that value, evaluated spend is the billed total unchanged. Even with it, the
 * monitored value replaces the bill's Bedrock token charges only once the
 * bill's share of them is known, which the response does not say. The note
 * therefore states that rule rather than claiming it applied.
 */
function spendItems(
  monitoredBedrockTokenCost: number | null | undefined,
  lastEvaluatedSpend: number | null | undefined,
): KeyValuePairsProps.Pair[] {
  if (monitoredBedrockTokenCost == null) {
    return [];
  }
  const items: KeyValuePairsProps.Pair[] = [];
  if (lastEvaluatedSpend != null) {
    items.push({
      label: "Spend for budget thresholds",
      value: figureWithNote(
        `≈ ${formatCostAmount(lastEvaluatedSpend)}`,
        "An estimate: the billed total, with its Bedrock token charges replaced by the monitored figure once the bill's share of them is known. Until then it can trail the monitored figure",
      ),
    });
  }
  items.push({
    label: "Monitored Bedrock token cost",
    value: figureWithNote(
      formatCostAmount(monitoredBedrockTokenCost),
      "Priced from the tokens counted so far, ahead of the bill",
    ),
  });
  return items;
}

const STACK_OPTIONS = [
  { id: "model", text: "By model" },
  { id: "tokenType", text: "By token type" },
];

type TokenUsageChartsProps = {
  charts: TokenCharts;
  stackBy: TokenStackDimension;
  onStackByChange: (stackBy: TokenStackDimension) => void;
  rangePicker?: ReactNode;
  rangeNotes: ReactNode;
};

const TokenUsageCharts = ({
  charts,
  stackBy,
  onStackByChange,
  rangePicker,
  rangeNotes,
}: TokenUsageChartsProps) => {
  const {
    unit,
    tokenBands,
    foldedModels,
    costLine,
    hasCostGap,
    endsUnpriced,
    carriesCostIn,
    hasUnattributed,
    xDomain,
    tokenDomain,
    costDomain,
  } = charts;
  const formatPeriod = (x: Date) =>
    DateTime.fromJSDate(x).toLocaleString(PERIOD_FORMATS[unit]);

  return (
    <SpaceBetween size="l">
      <SpaceBetween size="xs">
        <Header
          variant="h3"
          description={`Tokens used in each ${unit}, by model or token type. The top of the stack is the ${unit}'s total; the first and last can be partial.`}
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <SegmentedControl
                label="Stack tokens by"
                selectedId={stackBy}
                options={STACK_OPTIONS}
                onChange={({ detail }) =>
                  onStackByChange(detail.selectedId as TokenStackDimension)
                }
              />
              {rangePicker}
            </SpaceBetween>
          }
        >
          {`Tokens used per ${unit}`}
        </Header>
        {rangeNotes}
        <AreaChart<Date>
          series={tokenBands}
          xScaleType="categorical"
          xTitle="Time"
          yTitle="Tokens"
          ariaLabel={`Bedrock tokens used per ${unit}`}
          height={CHART_HEIGHT}
          hideFilter
          {...(xDomain === undefined ? {} : { xDomain })}
          yDomain={tokenDomain}
          xTickFormatter={formatPeriod}
          yTickFormatter={(y) => tokenTickFormatter.format(y)}
          detailTotalFormatter={formatTokenCount}
          i18nStrings={{ detailTotalLabel: "Total" }}
        />
        {foldedModels.length > 0 && (
          <Box variant="small">
            {`${OTHER_MODELS_TITLE} combines the ${foldedModels.length === 1 ? "model" : "models"} with the fewest tokens over the lease: ${foldedModels.join(", ")}.`}
          </Box>
        )}
      </SpaceBetween>
      <SpaceBetween size="xs">
        <Header
          variant="h3"
          description={`Estimated cost of the Bedrock tokens used each ${unit}, at Bedrock list prices, ahead of the bill.`}
        >
          {`${DERIVED_COST_TITLE} per ${unit}`}
        </Header>
        <MixedLineBarChart<Date>
          series={costLine}
          xScaleType="categorical"
          xTitle="Time"
          yTitle="Cost"
          ariaLabel={`${DERIVED_COST_TITLE} per ${unit}`}
          height={CHART_HEIGHT}
          hideFilter
          hideLegend
          {...(xDomain === undefined ? {} : { xDomain })}
          yDomain={costDomain}
          xTickFormatter={formatPeriod}
          yTickFormatter={formatCurrency}
          empty={
            <Box textAlign="center" color="inherit">
              <Box variant="strong">No cost derived yet</Box>
              <Box variant="p">
                No price was available for the tokens counted, so no cost is
                derived from them. This is not a report of zero spend.
              </Box>
            </Box>
          }
        />
        {hasCostGap && costLine.length > 0 && (
          <Box variant="small">
            {`A gap in the line is a stretch whose tokens could not all be priced, not a stretch without spend. Its cost is counted in the next ${unit} that could be priced.`}
          </Box>
        )}
        {carriesCostIn && (
          <Box variant="small">
            {`The cost of the first ${unit} priced in this range also includes tokens from before it that could not be priced then.`}
          </Box>
        )}
        {endsUnpriced && costLine.length > 0 && (
          <Box variant="small">
            The newest tokens could not all be priced yet, so the line stops
            before them.
          </Box>
        )}
        {hasUnattributed && (
          <Box variant="small">
            Tokens counted as {UNATTRIBUTED_MODEL_ID} could not be matched to a
            model, so they are not priced and not included in the estimated
            cost.
          </Box>
        )}
      </SpaceBetween>
    </SpaceBetween>
  );
};

/**
 * A token row is written only when counts move, so a narrower range with no usage
 * means the counts did not change in it, not that none have been read. Where only
 * a range's newest readings were loaded, it may look empty for that reason alone.
 */
const NoTokenReadings = ({
  wholeLease,
  truncated,
  onResetRange,
}: {
  wholeLease: boolean;
  truncated: boolean;
  onResetRange?: () => void;
}) =>
  wholeLease ? (
    <Box textAlign="center" color="inherit">
      <Box variant="strong">No token usage read yet</Box>
      <Box variant="p">
        No Bedrock token usage has been read for this lease yet. This is not a
        report of zero spend.
      </Box>
    </Box>
  ) : (
    <Box textAlign="center" color="inherit">
      <Box variant="strong">No change in token usage over this range</Box>
      <Box variant="p">
        {truncated
          ? "The token counts loaded did not change over the selected range. This range holds more readings than the panel loads at once, so it can look empty only because the readings that changed were not loaded. This is not a report of zero spend."
          : "The token counts did not change over the selected range. Choose the whole lease to see all of its token usage. This is not a report of zero spend."}
      </Box>
      {!truncated && onResetRange !== undefined && (
        <Button onClick={onResetRange}>Reset filters</Button>
      )}
    </Box>
  );

type BedrockTokenPanelProps = {
  /** The range's token rows, and the readings before it that it is measured from. */
  tokens: TokenSeriesRow[];
  /** The lease's newest reading, a row per region and model, whatever the range. */
  latestReading?: TokenSeriesRow[];
  /** The figure the lease's thresholds were last compared against. */
  lastEvaluatedSpend?: number | null;
  span: TokenSpan;
  /** Whether the whole lease is picked rather than a narrower range. */
  wholeLease: boolean;
  /** Whether the range held more readings than one load, so only the newest were read. */
  truncated?: boolean;
  /** Whether the readings before the range did not arrive, so it is measured from its first. */
  measuredFromFirstReading?: boolean;
  /** Where only the newest readings loaded, the oldest of them, which the charts start from. */
  loadedSince?: Date;
  /** The range picker, placed in the token chart's header, or on a row of its own without one. */
  rangePicker?: ReactNode;
  /** Puts the panel's picker back on the whole lease. */
  onResetRange?: () => void;
};

/** The range picker on a row of its own, at the right, where no chart header holds it. */
export const RangePickerRow = ({ children }: { children: ReactNode }) => (
  <SpaceBetween size="xs" alignItems="end">
    {children}
  </SpaceBetween>
);

const TokenPanelBody = ({
  tokens,
  span,
  wholeLease,
  truncated,
  rangePicker,
  rangeNotes,
  onResetRange,
}: Omit<
  BedrockTokenPanelProps,
  | "latestReading"
  | "lastEvaluatedSpend"
  | "truncated"
  | "measuredFromFirstReading"
  | "loadedSince"
> & {
  truncated: boolean;
  rangeNotes: ReactNode;
}) => {
  const [stackBy, setStackBy] = useState<TokenStackDimension>("model");
  const charts = useMemo(
    () => buildTokenCharts(tokens, stackBy, span),
    [tokens, stackBy, span],
  );
  if (charts.hasUsage) {
    return (
      <TokenUsageCharts
        charts={charts}
        stackBy={stackBy}
        onStackByChange={setStackBy}
        rangePicker={rangePicker}
        rangeNotes={rangeNotes}
      />
    );
  }
  // With no chart header to hold it, the picker takes a row of its own, and the
  // range's notes follow it as they follow the header.
  const withoutCharts = (content: ReactNode) => (
    <SpaceBetween size="l">
      {rangePicker !== undefined && (
        <RangePickerRow>{rangePicker}</RangePickerRow>
      )}
      {rangeNotes}
      {content}
    </SpaceBetween>
  );
  return withoutCharts(
    <NoTokenReadings
      wholeLease={wholeLease}
      truncated={truncated}
      {...(onResetRange === undefined ? {} : { onResetRange })}
    />,
  );
};

/**
 * The panel's figures and charts. The caller holds the container and hands in
 * the range picker, which the panel places with the charts it filters.
 */
export const BedrockTokenPanel = ({
  latestReading,
  lastEvaluatedSpend,
  truncated = false,
  measuredFromFirstReading = false,
  loadedSince,
  ...body
}: BedrockTokenPanelProps) => {
  // The lease's latest figures, whatever the range. The monitored cost is
  // lease-wide as of the reading, so each of its rows carries the same one.
  const summary = [
    ...tokensSoFar(latestReading ?? []),
    ...spendItems(
      latestReading?.[0]?.monitoredBedrockTokenCost,
      lastEvaluatedSpend,
    ),
  ];
  // What the range draws, and what it leaves out, said just below its picker.
  const rangeNotes = [
    truncated && (
      <PartialRangeAlert
        key="truncated"
        header="Showing part of this range's token usage"
        subject="usage"
        loadedSince={
          loadedSince === undefined
            ? undefined
            : (DateTime.fromJSDate(loadedSince).toISO() ?? undefined)
        }
        fallback="This range holds more readings than the panel loads at once, so it draws only the newest of them. Pick a narrower range to see earlier."
      />
    ),
    measuredFromFirstReading && (
      <Box key="measuredFromFirstReading" variant="small">
        The readings just before this range could not be read, so it is measured
        from its own first reading, and its first period leaves out what was
        used before that.
      </Box>
    ),
  ];

  return (
    <SpaceBetween size="l">
      {summary.length > 0 && (
        <KeyValuePairs columns={summary.length} items={summary} />
      )}
      <TokenPanelBody {...body} truncated={truncated} rangeNotes={rangeNotes} />
    </SpaceBetween>
  );
};

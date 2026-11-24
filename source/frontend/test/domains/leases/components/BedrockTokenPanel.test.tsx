// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { BedrockTokenPanel } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BedrockTokenPanel";
import { buildTokenCharts } from "@amzn/innovation-sandbox-frontend/domains/leases/components/token-charts";
import { createMockBedrockTokenCostHistory } from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";
import {
  CLAUDE_HAIKU,
  costRunsAsIso,
  NOVA_PRO,
  ONE_READING_SPAN,
  READINGS,
  sevenModels,
  SPAN,
  tokenRow,
  withoutCostAt,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/tokenChartFixtures";
import { UNATTRIBUTED_MODEL_ID } from "@amzn/innovation-sandbox-shared/types/cost-history.js";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

const defaultZone = Settings.defaultZone;
beforeAll(() => {
  // Hours and days start where they do in UTC, whatever zone the tests run in.
  Settings.defaultZone = "utc";
});
afterAll(() => {
  Settings.defaultZone = defaultZone;
});

const legendTitles = () =>
  createWrapper()
    .findAreaChart()!
    .findLegend()!
    .findItems()
    .map((item) => item.getElement().textContent?.trim());

/** The fixture's newest reading, as the read of it alone returns it. */
const LATEST_READING = createMockBedrockTokenCostHistory().data.tokens.filter(
  ({ timestamp }) => timestamp === READINGS[4],
);

const tokenChartHeader = () =>
  createWrapper()
    .findAllHeaders()
    .find((header) =>
      header
        .findHeadingText()
        .getElement()
        .textContent?.startsWith("Tokens used per"),
    )!;

describe("BedrockTokenPanel", () => {
  it("switches the stack between model and token type", async () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(<BedrockTokenPanel tokens={data.tokens} span={SPAN} wholeLease />);

    expect(screen.getByText("Tokens used per hour")).toBeInTheDocument();
    expect(legendTitles()).toEqual([NOVA_PRO, CLAUDE_HAIKU]);

    await userEvent.click(
      createWrapper()
        .findSegmentedControl()!
        .findSegmentById("tokenType")!
        .getElement(),
    );

    expect(legendTitles()).toEqual([
      "Input",
      "Output",
      "Cache read",
      "Cache write",
    ]);
  });

  it("labels each hour of a short range once, rather than at every tick of a time axis", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const lastThreeHours = { ...SPAN, from: new Date(READINGS[2]) };

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={lastThreeHours}
        wholeLease={false}
      />,
    );

    // The cost chart, since jsdom gives the token chart no width to tick across.
    const labels = createWrapper()
      .findMixedLineBarChart()!
      .findXTicks()
      .map((tick) => tick.getElement().textContent);
    expect(labels).toHaveLength(3);
    expect(new Set(labels).size).toBe(3);
  });

  it("notes that a narrower range's first priced hour carries an unpriced reading from before it", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    // The 09:00 reading just before the range could not be priced.
    const lastTwoHours = { ...SPAN, from: new Date(READINGS[3]) };

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={lastTwoHours}
        wholeLease={false}
      />,
    );

    expect(
      screen.getByText(
        "The cost of the first hour priced in this range also includes tokens from before it that could not be priced then.",
      ),
    ).toBeInTheDocument();
  });

  it("leaves an hour it could not price as a gap, and counts its cost in the next", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(<BedrockTokenPanel tokens={data.tokens} span={SPAN} wholeLease />);

    // 10:00 carries the unpriced 09:00: 3.00 less the 1.50 priced by 08:00.
    const [, after] = costRunsAsIso(data.tokens);
    expect(after[0]).toEqual({ x: READINGS[3], y: 1.5 });
    expect(
      screen.getByText(
        "A gap in the line is a stretch whose tokens could not all be priced, not a stretch without spend. Its cost is counted in the next hour that could be priced.",
      ),
    ).toBeInTheDocument();
    // The whole lease has nothing before it to carry in.
    expect(
      screen.queryByText(/from before it that could not be priced/),
    ).toBeNull();
  });

  it("says the line stops, not that it has a gap, where idle hours follow an unpriced newest reading", () => {
    const priced = (
      timestamp: string,
      input: number,
      monitoredBedrockTokenCost: number,
    ) => ({
      ...tokenRow(timestamp, NOVA_PRO, input),
      monitoredBedrockTokenCost,
    });
    const tokens = [
      priced(READINGS[0], 100, 1),
      priced(READINGS[1], 200, 2),
      tokenRow(READINGS[2], NOVA_PRO, 300),
    ];
    // Hours past the newest reading, as a lease that has gone quiet reads now.
    const span = { to: new Date("2026-08-11T12:30:00.000Z") };

    render(<BedrockTokenPanel tokens={tokens} span={span} wholeLease />);

    expect(screen.getByText(/newest tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/A gap in the line/)).toBeNull();
  });

  it("notes the newest hour only when its tokens could not be priced", () => {
    const { data } = createMockBedrockTokenCostHistory();
    const note = /newest tokens could not all be priced/;
    const newestUnpriced = withoutCostAt(data.tokens, READINGS[4]);

    expect(buildTokenCharts(newestUnpriced, "model", SPAN).endsUnpriced).toBe(
      true,
    );
    const { unmount } = render(
      <BedrockTokenPanel tokens={newestUnpriced} span={SPAN} wholeLease />,
    );
    expect(screen.getByText(note)).toBeInTheDocument();
    unmount();

    render(<BedrockTokenPanel tokens={data.tokens} span={SPAN} wholeLease />);
    expect(screen.queryByText(note)).toBeNull();
  });

  it("leaves out the gap note where only the newest hour is unpriced", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const onlyNewestUnpriced = withoutCostAt(
      tokens.map((row) =>
        row.timestamp === READINGS[2]
          ? { ...row, monitoredBedrockTokenCost: 2 }
          : row,
      ),
      READINGS[4],
    );

    render(
      <BedrockTokenPanel tokens={onlyNewestUnpriced} span={SPAN} wholeLease />,
    );

    expect(screen.getByText(/newest tokens/)).toBeInTheDocument();
    expect(screen.queryByText(/A gap in the line/)).toBeNull();
  });

  it("says no cost was derived where no reading could be priced", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const unpriced = tokens.map(
      ({ monitoredBedrockTokenCost: _dropped, ...row }) => row,
    );

    render(<BedrockTokenPanel tokens={unpriced} span={SPAN} wholeLease />);

    expect(buildTokenCharts(unpriced, "model", SPAN).costLine).toEqual([]);
    expect(screen.getByText("No cost derived yet")).toBeInTheDocument();
    expect(screen.queryByText(/newest tokens/)).toBeNull();
    expect(screen.queryByText(/A gap in the line/)).toBeNull();
    // The counts are still drawn: an unpriced reading is still usage.
    expect(legendTitles()).toEqual([NOVA_PRO, CLAUDE_HAIKU]);
  });

  it("shows every token used so far, and when the counts last changed", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        latestReading={LATEST_READING}
        span={SPAN}
        wholeLease
      />,
    );

    expect(screen.getByText("Tokens used so far")).toBeInTheDocument();
    // 11,900 on Nova and 16,800 on Claude by 11:00.
    expect(screen.getByText("28,700")).toBeInTheDocument();
    expect(screen.getByText(/^Last changed /)).toBeInTheDocument();
  });

  it("shows evaluated spend as an estimate beside the monitored Bedrock figure", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        latestReading={LATEST_READING}
        lastEvaluatedSpend={62.5}
        span={SPAN}
        wholeLease
      />,
    );

    expect(screen.getByText("Spend for budget thresholds")).toBeInTheDocument();
    expect(screen.getByText("≈ USD 62.50")).toBeInTheDocument();
    expect(
      screen.getByText(/once the bill's share of them is known/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText("Monitored Bedrock token cost"),
    ).toBeInTheDocument();
    expect(screen.getByText("USD 4.25")).toBeInTheDocument();
  });

  it("omits the spend figures rather than showing zero where there is no monitored term", () => {
    const { data } = createMockBedrockTokenCostHistory();
    const unpriced = LATEST_READING.map(
      ({ monitoredBedrockTokenCost: _dropped, ...row }) => row,
    );

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        latestReading={unpriced}
        lastEvaluatedSpend={62.5}
        span={SPAN}
        wholeLease
      />,
    );

    expect(screen.queryByText("Spend for budget thresholds")).toBeNull();
    expect(screen.queryByText("Monitored Bedrock token cost")).toBeNull();
    expect(screen.getByText("Tokens used so far")).toBeInTheDocument();
  });

  it("shows the monitored value alone where no evaluated spend is known", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        latestReading={LATEST_READING}
        span={SPAN}
        wholeLease
      />,
    );

    expect(
      screen.getByText("Monitored Bedrock token cost"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Spend for budget thresholds")).toBeNull();
  });

  it("names the reason where no token usage has been read, rather than a zero chart", () => {
    const { data } = createMockBedrockTokenCostHistory({ tokens: [] });

    render(<BedrockTokenPanel tokens={data.tokens} span={SPAN} wholeLease />);

    expect(screen.getByText("No token usage read yet")).toBeInTheDocument();
    expect(createWrapper().findAreaChart()).toBeNull();
    expect(createWrapper().findMixedLineBarChart()).toBeNull();
    expect(screen.queryByText("Tokens used so far")).toBeNull();
  });

  it("says a narrower range with no readings did not change, since readings can follow it", () => {
    render(<BedrockTokenPanel tokens={[]} span={SPAN} wholeLease={false} />);

    expect(
      screen.getByText("No change in token usage over this range"),
    ).toBeInTheDocument();
    expect(screen.queryByText("No token usage read yet")).toBeNull();
  });

  it("takes its figures from the lease's latest reading alone, not the range's rows", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    // A range that ended at 09:00, whose newest reading could not be priced.
    const byNine = tokens.filter(({ timestamp }) => timestamp <= READINGS[2]);

    const { unmount } = render(
      <BedrockTokenPanel
        tokens={byNine}
        latestReading={LATEST_READING}
        span={SPAN}
        wholeLease={false}
      />,
    );
    expect(screen.getByText("Tokens used so far")).toBeInTheDocument();
    expect(screen.getByText("28,700")).toBeInTheDocument();
    expect(screen.getByText("USD 4.25")).toBeInTheDocument();
    unmount();

    // Until the latest reading is read, there are no figures to show.
    render(
      <BedrockTokenPanel tokens={byNine} span={SPAN} wholeLease={false} />,
    );
    expect(screen.queryByText("Tokens used so far")).toBeNull();
    expect(screen.queryByText("Monitored Bedrock token cost")).toBeNull();
  });

  it("says the counts did not change over a narrower range with no usage in it", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const afterTheReadings = {
      from: new Date("2026-08-11T12:00:00.000Z"),
      to: new Date("2026-08-11T13:00:00.000Z"),
    };

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={afterTheReadings}
        wholeLease={false}
      />,
    );

    expect(
      screen.getByText("No change in token usage over this range"),
    ).toBeInTheDocument();
    expect(createWrapper().findAreaChart()).toBeNull();
  });

  it("offers to reset a narrower range with no usage in it to the whole lease", async () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const onResetRange = vi.fn();

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={{
          from: new Date("2026-08-11T12:00:00.000Z"),
          to: new Date("2026-08-11T13:00:00.000Z"),
        }}
        wholeLease={false}
        onResetRange={onResetRange}
      />,
    );

    await userEvent.click(
      screen.getByRole("button", { name: "Reset filters" }),
    );
    expect(onResetRange).toHaveBeenCalledOnce();
  });

  it("warns where only the newest of the lease's readings were loaded", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        span={SPAN}
        wholeLease
        truncated
      />,
    );

    expect(
      screen.getByText("Showing part of this range's token usage"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        "This range holds more readings than the panel loads at once, so it draws only the newest of them. Pick a narrower range to see earlier.",
      ),
    ).toBeInTheDocument();
  });

  it("gives the undated warning where the oldest loaded reading has no valid date", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(
      <BedrockTokenPanel
        tokens={data.tokens}
        span={SPAN}
        wholeLease
        truncated
        loadedSince={new Date("not a date")}
      />,
    );

    expect(
      screen.getByText(/^This range holds more readings than the panel loads/),
    ).toBeInTheDocument();
  });

  it("says a range can look empty because the readings that changed were not loaded", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const beforeTheReadings = {
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-10T12:00:00.000Z"),
    };

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={beforeTheReadings}
        wholeLease={false}
        truncated
      />,
    );

    expect(
      screen.getByText(
        /only because the readings that changed were not loaded/,
      ),
    ).toBeInTheDocument();
  });

  it("puts the range picker in the token chart's header, beside the stack toggle", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;

    render(
      <BedrockTokenPanel
        tokens={tokens}
        span={SPAN}
        wholeLease
        rangePicker={<button type="button">Pick a range</button>}
      />,
    );

    const actions = tokenChartHeader().findActions()!;
    expect(actions.findSegmentedControl()).not.toBeNull();
    expect(
      within(actions.getElement()).getByRole("button", {
        name: "Pick a range",
      }),
    ).toBeInTheDocument();
  });

  it("says what the range leaves out below the token chart's header, under the figures and above the chart", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const notes = [
      [{ truncated: true }, "Showing part of this range's token usage"],
      [
        { measuredFromFirstReading: true },
        /measured from its own first reading/,
      ],
    ] as const;

    for (const [props, note] of notes) {
      const { unmount } = render(
        <BedrockTokenPanel
          tokens={tokens}
          latestReading={LATEST_READING}
          span={SPAN}
          wholeLease={false}
          {...props}
        />,
      );

      const header = tokenChartHeader().getElement();
      const shown = screen.getByText(note);
      expect(
        screen.getByText("Tokens used so far").compareDocumentPosition(header),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      expect(header.compareDocumentPosition(shown)).toBe(
        Node.DOCUMENT_POSITION_FOLLOWING,
      );
      expect(
        shown.compareDocumentPosition(
          createWrapper().findAreaChart()!.getElement(),
        ),
      ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
      unmount();
    }
  });

  it("puts the range picker on a row of its own where there is no chart, above what the range leaves out", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const picker = <button type="button">Pick a range</button>;
    const beforeTheReadings = {
      from: new Date("2026-08-10T00:00:00.000Z"),
      to: new Date("2026-08-10T12:00:00.000Z"),
    };

    const { unmount } = render(
      <BedrockTokenPanel
        tokens={tokens}
        span={beforeTheReadings}
        wholeLease={false}
        truncated
        rangePicker={picker}
      />,
    );
    const alert = screen.getByText("Showing part of this range's token usage");
    expect(
      screen
        .getByRole("button", { name: "Pick a range" })
        .compareDocumentPosition(alert),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    expect(
      alert.compareDocumentPosition(
        screen.getByText("No change in token usage over this range"),
      ),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
    unmount();

    render(
      <BedrockTokenPanel
        tokens={[]}
        span={SPAN}
        wholeLease
        rangePicker={picker}
      />,
    );
    expect(
      screen
        .getByRole("button", { name: "Pick a range" })
        .compareDocumentPosition(screen.getByText("No token usage read yet")),
    ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
  });

  it("does not warn where every reading was loaded", () => {
    const { data } = createMockBedrockTokenCostHistory();

    render(<BedrockTokenPanel tokens={data.tokens} span={SPAN} wholeLease />);

    expect(
      screen.queryByText("Showing part of this range's token usage"),
    ).toBeNull();
  });

  it("says unattributed tokens are left out of the monitored token cost", () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const newest = tokens[0];
    const withUnattributed = [
      { ...newest, modelId: UNATTRIBUTED_MODEL_ID, input: 500, output: 0 },
      ...tokens,
    ];

    const { unmount } = render(
      <BedrockTokenPanel tokens={withUnattributed} span={SPAN} wholeLease />,
    );
    expect(
      screen.getByText(/could not be matched to a model/i),
    ).toBeInTheDocument();
    unmount();

    render(<BedrockTokenPanel tokens={tokens} span={SPAN} wholeLease />);
    expect(screen.queryByText(/could not be matched to a model/i)).toBeNull();
  });

  describe("past five models", () => {
    it("names the folded models under the chart", async () => {
      render(
        <BedrockTokenPanel
          tokens={sevenModels}
          span={ONE_READING_SPAN}
          wholeLease
        />,
      );

      expect(legendTitles().at(-1)).toBe("Other models");
      expect(screen.getByText(/m1, m2/)).toBeInTheDocument();

      await userEvent.click(
        createWrapper()
          .findSegmentedControl()!
          .findSegmentById("tokenType")!
          .getElement(),
      );
      expect(screen.queryByText(/m1, m2/)).toBeNull();
    });
  });
});

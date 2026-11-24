// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "luxon";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { ComponentProps } from "react";
import { MemoryRouter } from "react-router-dom";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { BreachHistory } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistory";
import { CostChart } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart";
import { CostSection } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostSection";
import {
  useGetLeaseCostSummary,
  useGetMergedLeaseBedrockTokenHistory,
  useGetMergedLeaseCostHistory,
  useRefetchLeaseById,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  bedrockTokenHistoryOf,
  costHistoryOf,
  costSummaryOf,
  createMockBedrockTokenCostHistory,
  createMockCostHistory,
  createMockNeverOptedInCostHistory,
  createMockNoCurrentCostHistory,
  LeaseHistoryFixture,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

// The section's own logic is which panels a query state and a lease's opt-in
// produce; the hook's paging and error mapping are covered where it is defined.
vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks", () => ({
  useGetMergedLeaseCostHistory: vi.fn(),
  useGetLeaseCostSummary: vi.fn(),
  useGetMergedLeaseBedrockTokenHistory: vi.fn(),
  // The token panel's reads of the lease's newest reading and of the reading
  // before its range, still in flight.
  useGetLeaseBedrockTokenHistory: vi.fn(() => ({ data: undefined })),
  useGetLeaseBedrockTokenBaseline: vi.fn(() => ({ data: undefined })),
  // The lease's own read, which picking a range reads again.
  useRefetchLeaseById: vi.fn(() => vi.fn()),
}));

// The breach history reads its own range and is tested where it is defined;
// here it only has to be placed.
const breachHistoryMounted = vi.hoisted(() => vi.fn());
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistory",
  async () => {
    const { useEffect } = await import("react");
    return {
      BreachHistory: vi.fn(() => {
        useEffect(() => {
          breachHistoryMounted();
        }, []);
        return <h2>Breach history</h2>;
      }),
    };
  },
);

// Drawn as it is, and watched, so that the range the chart is drawn over can be
// read.
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart")
      >();
    return { ...actual, CostChart: vi.fn(actual.CostChart) };
  },
);

type CostHistoryQuery = ReturnType<typeof useGetMergedLeaseCostHistory>;
type SummaryQuery = ReturnType<typeof useGetLeaseCostSummary>;
type TokenHistoryQuery = ReturnType<
  typeof useGetMergedLeaseBedrockTokenHistory
>;

const stubQuery = (query: Partial<CostHistoryQuery>) =>
  vi
    .mocked(useGetMergedLeaseCostHistory)
    .mockReturnValue(query as CostHistoryQuery);

const stubSummary = (query: Partial<SummaryQuery>) =>
  vi.mocked(useGetLeaseCostSummary).mockReturnValue(query as SummaryQuery);

/** The section's reads and its token panel's drain, each served from `fixture`. */
const stubFixture = (fixture: LeaseHistoryFixture) => {
  stubQuery({ data: costHistoryOf(fixture) });
  stubSummary({ data: costSummaryOf(fixture), refetch: vi.fn() });
  vi.mocked(useGetMergedLeaseBedrockTokenHistory).mockReturnValue({
    data: bedrockTokenHistoryOf(fixture),
  } as TokenHistoryQuery);
};

const renderSection = (
  predictiveBudgetEnabled = true,
  bedrockTokenMonitoringEnabled = false,
  budget: Pick<
    ComponentProps<typeof CostSection>,
    "maxSpend" | "budgetThresholds"
  > = {},
) =>
  render(
    <MemoryRouter>
      <CostSection
        leaseId="dXNlckBleGFtcGxlLmNvbXxsZWFzZS0xMjM"
        predictiveBudgetEnabled={predictiveBudgetEnabled}
        bedrockTokenMonitoringEnabled={bedrockTokenMonitoringEnabled}
        {...budget}
      />
    </MemoryRouter>,
  );

const chartLegendTitles = () =>
  createWrapper()
    .findMixedLineBarChart()!
    .findLegend()!
    .findItems()
    .map((item) => item.getElement().textContent?.trim());

const lastRangeAsked = () => {
  const calls = vi.mocked(useGetMergedLeaseCostHistory).mock.calls;
  return calls[calls.length - 1]?.[1];
};

const pickRelativeRange = async (value: string) => {
  const picker = createWrapper().findDateRangePicker()!;
  await userEvent.click(picker.findTrigger().getElement());
  const dropdown = picker.findDropdown({ expandToViewport: true })!;
  await userEvent.click(
    dropdown
      .findRelativeRangeRadioGroup()!
      .findInputByValue(value)!
      .getElement(),
  );
  await userEvent.click(dropdown.findApplyButton().getElement());
};

const pickAbsoluteRange = async (start: string, end: string) => {
  const picker = createWrapper().findDateRangePicker()!;
  await userEvent.click(picker.findTrigger().getElement());
  const dropdown = picker.findDropdown({ expandToViewport: true })!;
  act(() => {
    dropdown
      .findSelectionModeSwitch()
      .findModesAsSegments()
      .findSegmentById("absolute")!
      .click();
  });
  // The date inputs take the picker's own slashed form.
  const [startDate, startTime] = start.replaceAll("-", "/").split("T");
  const [endDate, endTime] = end.replaceAll("-", "/").split("T");
  act(() => {
    dropdown.findStartDateInput()!.setInputValue(startDate!);
    dropdown.findStartTimeInput()!.setInputValue(startTime!);
    dropdown.findEndDateInput()!.setInputValue(endDate!);
    dropdown.findEndTimeInput()!.setInputValue(endTime!);
  });
  await userEvent.click(dropdown.findApplyButton().getElement());
};

const lastHelpFile = (setTools: ReturnType<typeof vi.fn>) =>
  (
    setTools.mock.calls[setTools.mock.calls.length - 1]?.[0] as
      { props: { file: string } } | undefined
  )?.props.file;

const mockSetTools = () => {
  const setTools = vi.fn();
  const setToolsOpen = vi.fn();
  vi.mocked(useAppLayoutContext).mockReturnValue({
    toolsOpen: false,
    setTools,
    setToolsOpen,
  });
  return { setTools, setToolsOpen };
};

describe("CostSection", () => {
  beforeEach(() => {
    stubFixture(createMockCostHistory());
  });

  // The stable stub above would otherwise leak into every later test in this
  // file; restore setupTests' fresh-fns-per-call default.
  afterEach(() => {
    vi.mocked(useAppLayoutContext).mockReset();
    vi.mocked(useAppLayoutContext).mockImplementation(() => ({
      toolsOpen: false,
      setTools: vi.fn(),
      setToolsOpen: vi.fn(),
    }));
  });

  it("gives the breach history only the lease, in every state, so the spend range never filters it", async () => {
    const leaseProps = { leaseId: "dXNlckBleGFtcGxlLmNvbXxsZWFzZS0xMjM" };

    stubQuery({});
    const loading = renderSection();
    expect(screen.getByText("Breach history")).toBeInTheDocument();
    loading.unmount();

    stubQuery({ isError: true, error: new Error("no"), refetch: vi.fn() });
    const failed = renderSection();
    expect(screen.getByText("Breach history")).toBeInTheDocument();
    failed.unmount();

    stubQuery({ data: costHistoryOf(createMockCostHistory()) });
    renderSection();
    await pickRelativeRange("last-24-hours");

    expect(lastRangeAsked()?.afterTimestamp).toBeDefined();
    expect(vi.mocked(BreachHistory).mock.calls.at(-1)![0]).toEqual(leaseProps);
  });

  it("keeps one breach history mounted while the spend range loads or fails", () => {
    breachHistoryMounted.mockClear();
    const view = renderSection();
    const rerender = () =>
      view.rerender(
        <MemoryRouter>
          <CostSection
            leaseId="dXNlckBleGFtcGxlLmNvbXxsZWFzZS0xMjM"
            predictiveBudgetEnabled
            bedrockTokenMonitoringEnabled={false}
          />
        </MemoryRouter>,
      );

    stubQuery({});
    rerender();
    stubQuery({ isError: true, error: new Error("no"), refetch: vi.fn() });
    rerender();
    stubQuery({ data: costHistoryOf(createMockCostHistory()) });
    rerender();

    expect(breachHistoryMounted).toHaveBeenCalledTimes(1);
  });

  it("renders the headline, the chart, the service ranking and the breach history", () => {
    renderSection();

    expect(screen.getByText("Spend summary")).toBeInTheDocument();
    expect(screen.getByText("Spend over time")).toBeInTheDocument();
    // The current estimate, from the summary's newest figures.
    expect(screen.getAllByText("Predicted spend").length).toBeGreaterThan(0);
    expect(screen.getByText("Top services")).toBeInTheDocument();
    expect(screen.getByText("Breach history")).toBeInTheDocument();
    expect(screen.queryByText(/Estimated cost tracking is off/)).toBeNull();
  });

  it("states that prediction is off for the lease without offering to turn it on", () => {
    stubFixture(createMockNeverOptedInCostHistory());

    renderSection(false);

    expect(
      screen.getByText("Estimated cost tracking is off for this lease"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/enable/i)).toBeNull();
    expect(screen.queryByRole("checkbox")).toBeNull();
    // The billed half of the section is unaffected by the opt-in.
    expect(screen.getByText("Billed to date")).toBeInTheDocument();
    expect(screen.getByText("Top services")).toBeInTheDocument();
    expect(screen.getByText("Breach history")).toBeInTheDocument();
  });

  it("leaves the Bedrock token panel out where token monitoring is off", () => {
    stubFixture(createMockBedrockTokenCostHistory());

    renderSection(true, false);

    expect(screen.queryByText("Bedrock token usage")).toBeNull();
    expect(screen.getByText("Top services")).toBeInTheDocument();
  });

  it("places the Bedrock token panel between the services and the breach history", () => {
    stubFixture(createMockBedrockTokenCostHistory());

    renderSection(true, true);

    const [services, tokens, breaches] = [
      "Top services",
      "Bedrock token usage",
      "Breach history",
    ].map((title) => screen.getByText(title));
    expect(services.compareDocumentPosition(tokens)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
    expect(tokens.compareDocumentPosition(breaches)).toBe(
      Node.DOCUMENT_POSITION_FOLLOWING,
    );
  });

  it("keeps the Bedrock token panel and its choices while a new spend range loads", async () => {
    const fixture = createMockBedrockTokenCostHistory();
    stubFixture(fixture);
    // The whole lease is read; a narrower spend range is still in flight.
    vi.mocked(useGetMergedLeaseCostHistory).mockImplementation(
      (_leaseId, range) =>
        (range === undefined
          ? { data: costHistoryOf(fixture) }
          : { data: undefined }) as CostHistoryQuery,
    );

    renderSection(true, true);
    await userEvent.click(
      createWrapper()
        .findSegmentedControl()!
        .findSegmentById("tokenType")!
        .getElement(),
    );
    const spendPicker = createWrapper().findDateRangePicker()!;
    await userEvent.click(spendPicker.findTrigger().getElement());
    const dropdown = spendPicker.findDropdown({ expandToViewport: true })!;
    await userEvent.click(
      dropdown
        .findRelativeRangeRadioGroup()!
        .findInputByValue("last-24-hours")!
        .getElement(),
    );
    await userEvent.click(dropdown.findApplyButton().getElement());

    expect(screen.getByText("Loading cost history")).toBeInTheDocument();
    expect(
      createWrapper()
        .findSegmentedControl()!
        .findSelectedSegment()!
        .getElement().textContent,
    ).toBe("By token type");
  });

  it("keeps the Bedrock token panel where a new spend range fails to load", async () => {
    const fixture = createMockBedrockTokenCostHistory();
    stubFixture(fixture);
    const failed: Partial<CostHistoryQuery> = {
      isError: true,
      error: new Error("no"),
      refetch: vi.fn(),
    };
    vi.mocked(useGetMergedLeaseCostHistory).mockImplementation(
      (_leaseId, range) =>
        (range === undefined
          ? { data: costHistoryOf(fixture) }
          : failed) as CostHistoryQuery,
    );

    renderSection(true, true);
    const spendPicker = createWrapper().findDateRangePicker()!;
    await userEvent.click(spendPicker.findTrigger().getElement());
    const dropdown = spendPicker.findDropdown({ expandToViewport: true })!;
    await userEvent.click(
      dropdown
        .findRelativeRangeRadioGroup()!
        .findInputByValue("last-24-hours")!
        .getElement(),
    );
    await userEvent.click(dropdown.findApplyButton().getElement());

    expect(
      screen.getByText(
        "There was a problem loading cost history for this lease.",
      ),
    ).toBeInTheDocument();
    expect(createWrapper().findAreaChart()).not.toBeNull();
  });

  it("shows the chart's loading state while the first page is in flight", () => {
    stubQuery({ data: undefined, isLoading: true });
    stubSummary({ data: undefined, isPending: true });

    renderSection();

    expect(screen.getByText("Loading cost history")).toBeInTheDocument();
    expect(screen.queryByText("Spend summary")).toBeNull();
  });

  it("draws the chart once the figures it continues the line with have settled", () => {
    stubSummary({ data: undefined, isPending: true });

    renderSection();

    expect(screen.getByText("Loading cost history")).toBeInTheDocument();
  });

  it("reports a failed load with a retry, keeping the headline", async () => {
    const refetch = vi.fn();
    const summaryRefetch = vi.fn();
    stubQuery({ isError: true, error: new Error("no"), refetch });
    stubSummary({
      data: costSummaryOf(createMockCostHistory()),
      refetch: summaryRefetch,
    });

    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      screen.getByText(
        "There was a problem loading cost history for this lease.",
      ),
    ).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    expect(summaryRefetch).not.toHaveBeenCalled();
    expect(screen.getByText("Spend summary")).toBeInTheDocument();
    expect(screen.getByText("Top services")).toBeInTheDocument();
  });

  it("reports a failed summary with a retry, keeping the chart without the current estimate", async () => {
    const refetch = vi.fn();
    const summaryRefetch = vi.fn();
    stubQuery({ data: costHistoryOf(createMockCostHistory()), refetch });
    stubSummary({
      isError: true,
      error: new Error("no"),
      refetch: summaryRefetch,
    });

    renderSection();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      screen.getByText(
        "There was a problem loading the spend summary for this lease.",
      ),
    ).toBeInTheDocument();
    expect(summaryRefetch).toHaveBeenCalled();
    expect(refetch).not.toHaveBeenCalled();
    expect(screen.queryByText("Spend summary")).toBeNull();
    expect(screen.queryByText("Top services")).toBeNull();
    expect(screen.queryByText("Loading cost history")).toBeNull();
    expect(screen.queryByText("Predicted spend")).toBeNull();
    expect(screen.getAllByText("Previous estimates").length).toBeGreaterThan(0);
  });

  it("heads the section with the lease's own budget", () => {
    const { maxSpend, thresholds } = createMockCostHistory().data.budget;
    renderSection(true, false, { maxSpend, budgetThresholds: thresholds });

    expect(
      screen.getByText("USD 60.00 of USD 100.00 (60%)"),
    ).toBeInTheDocument();
    expect(screen.getByText("Budget exhausted by")).toBeInTheDocument();
    // The chart draws the same budget's lines.
    expect(chartLegendTitles()).toEqual(
      expect.arrayContaining(["Budget", "Alert at USD 70.00 (projected)"]),
    );
  });

  it("leaves the headline out until the first monitoring run has landed", () => {
    stubQuery({ data: { result: [], nextPageIdentifier: null } });
    stubSummary({ data: {} });

    renderSection();

    expect(
      screen.getByText("No cost readings for this lease yet"),
    ).toBeInTheDocument();
    expect(screen.queryByText("Cost figures unavailable")).toBeNull();
  });

  it("reports the figures unavailable where the summary has none but the history has readings", () => {
    stubSummary({ data: costSummaryOf(createMockNoCurrentCostHistory()) });

    renderSection();

    expect(screen.getByText("Cost figures unavailable")).toBeInTheDocument();
    expect(chartLegendTitles()).toContain("Billed");
  });

  it("leaves the prediction-off note out while the history loads or where it fails", () => {
    stubQuery({ data: undefined, isLoading: true });
    const loading = renderSection(false);
    expect(
      screen.queryByText("Estimated cost tracking is off for this lease"),
    ).toBeNull();
    loading.unmount();

    stubQuery({ isError: true, error: new Error("no"), refetch: vi.fn() });
    renderSection(false);
    expect(
      screen.queryByText("Estimated cost tracking is off for this lease"),
    ).toBeNull();
  });

  it("says so when the drain stopped short of the range's end", () => {
    stubQuery({
      data: costHistoryOf(createMockCostHistory(), "eyJ2ZXJzaW9uIjoxfQ"),
    });

    renderSection();

    expect(screen.getByText("Showing part of this range")).toBeInTheDocument();
    // Any of the drain's caps can stop it, so the copy cites none of them, only
    // where the loaded readings begin.
    expect(
      screen.getByText(
        /^Showing usage since Aug 10, 2026; pick a narrower range to see earlier\.$/,
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/5,000/)).toBeNull();
  });

  it("says so without a date where the drain stopped short before any reading arrived", () => {
    stubQuery({
      data: { result: [], nextPageIdentifier: "eyJ2ZXJzaW9uIjoxfQ" },
    });

    renderSection();

    expect(
      screen.getByText(
        "This range holds more than the section loads at once, so the spend chart covers only its newest readings. Pick a narrower range to see earlier.",
      ),
    ).toBeInTheDocument();
  });

  it("says so without a date where the oldest loaded reading's date does not parse", () => {
    const { data } = createMockCostHistory();
    const oldest = data.result.at(-1)!;
    stubQuery({
      data: {
        result: [
          ...data.result.slice(0, -1),
          { ...oldest, timestamp: "not a date" },
        ],
        nextPageIdentifier: "eyJ2ZXJzaW9uIjoxfQ",
      },
    });

    renderSection();

    expect(
      screen.getByText(
        "This range holds more than the section loads at once, so the spend chart covers only its newest readings. Pick a narrower range to see earlier.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/Invalid DateTime/)).toBeNull();
  });

  it("treats a finished range as whole, however the cursor is absent", () => {
    // Null is what the drain returns; undefined is what the optional member
    // allows, and both mean there is nothing left to read.
    for (const nextPageIdentifier of [null, undefined]) {
      stubQuery({
        data: { ...costHistoryOf(createMockCostHistory()), nextPageIdentifier },
      });

      const { unmount } = renderSection();

      expect(screen.queryByText("Showing part of this range")).toBeNull();
      unmount();
    }
  });

  it("asks for the whole series until a range is picked", () => {
    renderSection();

    expect(vi.mocked(useGetMergedLeaseCostHistory)).toHaveBeenCalledWith(
      "dXNlckBleGFtcGxlLmNvbXxsZWFzZS0xMjM",
      undefined,
    );
  });

  it("asks for no bounds at all when the whole lease is picked", async () => {
    renderSection();
    const picker = createWrapper().findDateRangePicker()!;
    await userEvent.click(picker.findTrigger().getElement());
    const dropdown = picker.findDropdown({ expandToViewport: true })!;
    await userEvent.click(
      dropdown
        .findRelativeRangeRadioGroup()!
        .findInputByValue("last-7-days")!
        .getElement(),
    );
    await userEvent.click(dropdown.findApplyButton().getElement());
    await userEvent.click(picker.findTrigger().getElement());
    await userEvent.click(
      picker
        .findDropdown({ expandToViewport: true })!
        .findRelativeRangeRadioGroup()!
        .findInputByValue("whole-lease")!
        .getElement(),
    );
    await userEvent.click(
      picker
        .findDropdown({ expandToViewport: true })!
        .findApplyButton()
        .getElement(),
    );

    // Not a ten-year lookback: the option's duration is only what the picker
    // requires, and the request drops it.
    expect(lastRangeAsked()).toBeUndefined();
    expect(picker.findTrigger().getElement().textContent).toContain(
      "Whole lease",
    );
  });

  it("turns a relative range into a lower bound and leaves the upper open", async () => {
    renderSection();
    const picker = createWrapper().findDateRangePicker()!;
    await userEvent.click(picker.findTrigger().getElement());
    const dropdown = picker.findDropdown({ expandToViewport: true })!;
    await userEvent.click(
      dropdown
        .findRelativeRangeRadioGroup()!
        .findInputByValue("last-24-hours")!
        .getElement(),
    );
    await userEvent.click(dropdown.findApplyButton().getElement());

    // No upper bound: the API fills it with now, so the newest reading stays in
    // range as the lease keeps spending.
    const page = lastRangeAsked();
    expect(page?.afterTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
    expect(page?.beforeTimestamp).toBeUndefined();
  });

  describe("for an absolute range", () => {
    const defaultZone = Settings.defaultZone;

    beforeAll(() => {
      Settings.defaultZone = "utc";
      // The date picker reads typed times in the machine's zone, which
      // Luxon's defaultZone doesn't reach.
      vi.stubEnv("TZ", "UTC");
    });

    afterAll(() => {
      Settings.defaultZone = defaultZone;
      vi.unstubAllEnvs();
    });

    it("asks for the millisecond past its end and ends the chart at its end", async () => {
      renderSection();

      await pickAbsoluteRange("2026-08-09T11:00", "2026-08-11T11:00");

      expect(lastRangeAsked()).toEqual({
        afterTimestamp: "2026-08-09T11:00:00.000Z",
        beforeTimestamp: "2026-08-11T11:00:00.001Z",
      });
      expect(vi.mocked(CostChart).mock.calls.at(-1)![0].range).toEqual({
        fromTimestamp: "2026-08-09T11:00:00.000Z",
        toTimestamp: "2026-08-11T11:00:00.000Z",
      });
    });
  });

  it("draws no current estimate for a range that starts after the newest reading", async () => {
    renderSection();
    expect(chartLegendTitles()).toContain("Predicted spend");

    // The fixture's newest reading is from August 2026, before the last 24 hours.
    await pickRelativeRange("last-24-hours");

    expect(chartLegendTitles()).not.toContain("Predicted spend");
    expect(chartLegendTitles()).toContain("Previous estimates");
  });

  it("reads the newest figures and the lease again with every range picked", async () => {
    const summaryRefetch = vi.fn();
    const refetchLease = vi.fn();
    stubSummary({
      data: costSummaryOf(createMockCostHistory()),
      refetch: summaryRefetch,
    });
    vi.mocked(useRefetchLeaseById).mockReturnValue(refetchLease);
    renderSection();

    await pickRelativeRange("last-24-hours");

    expect(summaryRefetch).toHaveBeenCalledTimes(1);
    // The budget the headline and the chart's lines are drawn with is the lease's.
    expect(refetchLease).toHaveBeenCalledTimes(1);
    expect(vi.mocked(useRefetchLeaseById)).toHaveBeenCalledWith(
      "dXNlckBleGFtcGxlLmNvbXxsZWFzZS0xMjM",
    );
  });

  it("reads the newest figures and the lease again when the chart resets to the whole lease", async () => {
    const summaryRefetch = vi.fn();
    const refetchLease = vi.fn();
    stubQuery({ data: { result: [], nextPageIdentifier: null } });
    stubSummary({ data: {}, refetch: summaryRefetch });
    vi.mocked(useRefetchLeaseById).mockReturnValue(refetchLease);
    renderSection();
    await pickRelativeRange("last-24-hours");

    await userEvent.click(
      screen.getByRole("button", { name: "Reset filters" }),
    );

    expect(summaryRefetch).toHaveBeenCalledTimes(2);
    expect(refetchLease).toHaveBeenCalledTimes(2);
    expect(lastRangeAsked()).toBeUndefined();
  });

  it("picks the range from the chart's header rather than the section's", () => {
    renderSection();

    const chartHeader = createWrapper()
      .findAllContainers()
      .map((container) => container.findHeader()!)
      .find((header) =>
        header.getElement().textContent!.includes("Spend over time"),
      )!;
    expect(
      createWrapper(chartHeader.getElement()).findDateRangePicker(),
    ).not.toBeNull();
    // The section header carries the help link and nothing to act on.
    expect(createWrapper().findHeader()!.findActions()).toBeNull();
  });

  it("keeps the range picker on the error panel", () => {
    stubQuery({ isError: true, error: new Error("no"), refetch: vi.fn() });

    renderSection();

    // A range that fails to load has to be changeable from where it was picked.
    expect(createWrapper().findDateRangePicker()).not.toBeNull();
  });

  it("opens the cost help panel from the section header", async () => {
    const { setTools, setToolsOpen } = mockSetTools();

    renderSection();
    await userEvent.click(
      createWrapper().findHeader()!.findInfo()!.findLink()!.getElement(),
    );

    expect(lastHelpFile(setTools)).toBe("lease-cost");
    expect(setToolsOpen).toHaveBeenCalledWith(true);
  });

  it("has its help file in public/markdown", () => {
    expect(
      existsSync(join(__dirname, "../../../../public/markdown/lease-cost.md")),
    ).toBe(true);
  });
});

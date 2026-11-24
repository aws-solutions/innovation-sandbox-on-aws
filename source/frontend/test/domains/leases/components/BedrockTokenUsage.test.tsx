// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { Settings } from "luxon";
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

import { BedrockTokenUsage } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BedrockTokenUsage";
import {
  useGetLeaseBedrockTokenBaseline,
  useGetLeaseBedrockTokenHistory,
  useGetMergedLeaseBedrockTokenHistory,
  useRefetchLeaseById,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { TokenSeriesRow } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  bedrockTokenHistoryOf,
  createMockBedrockTokenCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

// Mock ResizeObserver
class ResizeObserver {
  observe() {}
  unobserve() {}
  disconnect() {}
}

window.ResizeObserver = ResizeObserver;

const defaultZone = Settings.defaultZone;
beforeAll(() => {
  // Days start where they do in UTC, whatever zone the tests run in.
  Settings.defaultZone = "utc";
  // The date picker reads typed times in the machine's zone, which Luxon's
  // defaultZone doesn't reach.
  vi.stubEnv("TZ", "UTC");
});
afterAll(() => {
  Settings.defaultZone = defaultZone;
  vi.unstubAllEnvs();
});

vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks", () => ({
  useGetMergedLeaseBedrockTokenHistory: vi.fn(),
  useGetLeaseBedrockTokenHistory: vi.fn(),
  useGetLeaseBedrockTokenBaseline: vi.fn(),
  useRefetchLeaseById: vi.fn(),
}));

type TokenHistoryQuery = ReturnType<
  typeof useGetMergedLeaseBedrockTokenHistory
>;

const stubQuery = (query: Partial<TokenHistoryQuery>) =>
  vi
    .mocked(useGetMergedLeaseBedrockTokenHistory)
    .mockReturnValue(query as TokenHistoryQuery);

/** The drain of the given token rows, finished unless a cursor is given. */
const drained = (
  result: TokenSeriesRow[],
  nextPageIdentifier: string | null = null,
) => ({ result, nextPageIdentifier });

const FIXTURE = createMockBedrockTokenCostHistory();
const TOKENS = FIXTURE.data.tokens;

type LatestQuery = ReturnType<typeof useGetLeaseBedrockTokenHistory>;

// Picking a range and retrying read the newest reading again, so it always has a refetch.
const stubLatest = (query: Partial<LatestQuery>) =>
  vi
    .mocked(useGetLeaseBedrockTokenHistory)
    .mockReturnValue({ refetch: vi.fn(), ...query } as LatestQuery);

type BaselineQuery = ReturnType<typeof useGetLeaseBedrockTokenBaseline>;

// Retrying reads it again, so it always has a refetch too.
const stubBaseline = (query: Partial<BaselineQuery>) =>
  vi
    .mocked(useGetLeaseBedrockTokenBaseline)
    .mockReturnValue({ refetch: vi.fn(), ...query } as BaselineQuery);

// Picking a range and retrying read the lease again too, for its evaluated spend.
const stubRefetchLease = () => {
  const refetchLease = vi.fn();
  vi.mocked(useRefetchLeaseById).mockReturnValue(refetchLease);
  return refetchLease;
};

/** The token rows of one of the fixture's readings. */
const rowsAt = (timestamp: string) =>
  TOKENS.filter((row) => row.timestamp === timestamp);

/** A reading of the fixture's, as the read of the newest reading alone returns it. */
const readingAt = (timestamp: string) => ({ data: drained(rowsAt(timestamp)) });

// The newest reading before a range could not be read: the read failed, or came
// back empty with more to read, which is a reading the store left out.
const BASELINE_UNREADABLE: [string, Partial<BaselineQuery>][] = [
  ["came back empty with more to read", { data: drained([], "more") }],
  ["failed", { isError: true, error: new Error("boom") }],
];

const NEWEST = "2026-08-11T11:00:00.000Z";

const tokenChartHeader = () =>
  createWrapper()
    .findAllHeaders()
    .find((header) =>
      header
        .findHeadingText()
        .getElement()
        .textContent?.startsWith("Tokens used per"),
    );

/** The range picker sits on a row of its own above `element`, not in a header. */
const expectPickerAbove = (element: Element) => {
  expect(
    createWrapper().findContainer()!.findHeader()!.findDateRangePicker(),
  ).toBeNull();
  expect(tokenChartHeader()).toBeUndefined();
  expect(
    createWrapper()
      .findDateRangePicker()!
      .getElement()
      .compareDocumentPosition(element),
  ).toBe(Node.DOCUMENT_POSITION_FOLLOWING);
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
  // The inputs take the picker's own forms: slashed dates, and `hh:mm` times
  // (its `timeInputFormat`), which reject a seconds field.
  const [startDate, startTime] = start.replaceAll("-", "/").split("T");
  const [endDate, endTime] = end.replaceAll("-", "/").split("T");
  act(() => {
    dropdown.findStartDateInput()!.setInputValue(startDate!);
    dropdown.findStartTimeInput()!.setInputValue(startTime!.slice(0, 5));
    dropdown.findEndDateInput()!.setInputValue(endDate!);
    dropdown.findEndTimeInput()!.setInputValue(endTime!.slice(0, 5));
  });
  await userEvent.click(dropdown.findApplyButton().getElement());
};

describe("BedrockTokenUsage", () => {
  beforeEach(() => {
    stubLatest(readingAt(NEWEST));
    // No reading came before the range, unless a test says otherwise.
    stubBaseline({ data: drained([]) });
    stubRefetchLease();
  });

  afterEach(() => {
    vi.mocked(useGetMergedLeaseBedrockTokenHistory).mockReset();
    vi.mocked(useGetLeaseBedrockTokenHistory).mockReset();
    vi.mocked(useGetLeaseBedrockTokenBaseline).mockReset();
    vi.mocked(useRefetchLeaseById).mockReset();
    vi.useRealTimers();
  });

  it("reads the whole lease and draws it under its own range picker", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(
      vi.mocked(useGetMergedLeaseBedrockTokenHistory),
    ).toHaveBeenCalledWith("lease-1", undefined);
    expect(createWrapper().findDateRangePicker()).not.toBeNull();
    expect(screen.getByText("Tokens used so far")).toBeInTheDocument();
    expect(createWrapper().findAreaChart()).not.toBeNull();
  });

  it("asks for the picked range, reaching back from when it was picked", async () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    const before = Date.now();
    await pickRelativeRange("last-24-hours");
    const after = Date.now();

    const [, range] = vi
      .mocked(useGetMergedLeaseBedrockTokenHistory)
      .mock.calls.at(-1)!;
    const day = 24 * 60 * 60 * 1000;
    const from = Date.parse(range!.afterTimestamp!);
    expect(from).toBeGreaterThanOrEqual(before - day);
    expect(from).toBeLessThanOrEqual(after - day);
    expect(range!.beforeTimestamp).toBeUndefined();
  });

  it("asks for the reading before a picked range's start, and none for the whole lease", async () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });
    render(<BedrockTokenUsage leaseId="lease-1" />);
    expect(
      vi.mocked(useGetLeaseBedrockTokenBaseline).mock.calls.at(-1),
    ).toStrictEqual(["lease-1", undefined]);

    await pickRelativeRange("last-24-hours");

    const [, range] = vi
      .mocked(useGetMergedLeaseBedrockTokenHistory)
      .mock.calls.at(-1)!;
    expect(
      vi.mocked(useGetLeaseBedrockTokenBaseline).mock.calls.at(-1),
    ).toStrictEqual(["lease-1", range!.afterTimestamp]);
  });

  it("asks for the lease's newest reading alone, with no range, whatever range is picked", async () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickRelativeRange("last-24-hours");

    expect(
      vi.mocked(useGetMergedLeaseBedrockTokenHistory).mock.calls.at(-1)?.[1]
        ?.afterTimestamp,
    ).toBeDefined();
    const calls = vi.mocked(useGetLeaseBedrockTokenHistory).mock.calls;
    expect(calls.length).toBeGreaterThan(1);
    for (const call of calls) {
      expect(call).toStrictEqual(["lease-1", { maxResults: 1 }]);
    }
  });

  it("reads the newest reading and the lease again when a range is picked and when the range is reset", async () => {
    // A range with no readings of its own, which offers to reset to the whole lease.
    stubQuery({ data: drained([]) });
    stubBaseline({ data: drained([], "more") });
    const refetch = vi.fn();
    stubLatest({ ...readingAt(NEWEST), refetch });
    const refetchLease = stubRefetchLease();
    render(<BedrockTokenUsage leaseId="lease-1" />);
    expect(refetch).not.toHaveBeenCalled();
    expect(refetchLease).not.toHaveBeenCalled();
    expect(vi.mocked(useRefetchLeaseById)).toHaveBeenCalledWith("lease-1");

    await pickRelativeRange("last-24-hours");
    expect(refetch).toHaveBeenCalledOnce();
    expect(refetchLease).toHaveBeenCalledOnce();

    await userEvent.click(
      screen.getByRole("button", { name: "Reset filters" }),
    );
    expect(refetch).toHaveBeenCalledTimes(2);
    expect(refetchLease).toHaveBeenCalledTimes(2);
  });

  it("draws a relative range back from each read, as the server ends it there", async () => {
    // Only the clock is faked, so the picker reads it while its own timers run.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.parse("2026-08-11T11:30:00.000Z"));
    // Nothing was read before the range's start, so it is measured from nothing.
    stubBaseline({ data: drained([]) });
    const read = { data: bedrockTokenHistoryOf(FIXTURE) };
    stubQuery({ ...read, dataUpdatedAt: Date.now() });
    const { rerender } = render(<BedrockTokenUsage leaseId="lease-1" />);
    await pickRelativeRange("last-24-hours");
    expect(screen.getByText("Tokens used per hour")).toBeInTheDocument();

    // A refetch a day and an hour on, with no usage since: the server ends the
    // range at that read, so the last 24 hours drawn are that read's, rather than
    // the 49 hours since the start the range was asked for with.
    stubQuery({ ...read, dataUpdatedAt: Date.now() + 25 * 60 * 60 * 1000 });
    rerender(<BedrockTokenUsage leaseId="lease-1" />);

    expect(screen.queryByText("Tokens used per day")).toBeNull();
    expect(
      screen.getByText("No change in token usage over this range"),
    ).toBeInTheDocument();
  });

  it("measures a range's first period from the reading before it", async () => {
    // A range holding the 11:00 reading alone, measured from the 10:00 one.
    stubQuery({
      data: drained(rowsAt(NEWEST)),
      dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
    });
    // With a cursor, as the one-reading page that holds a reading mostly comes
    // back: the read stops at its limit.
    stubBaseline({ data: drained(rowsAt("2026-08-11T10:00:00.000Z"), "1") });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickAbsoluteRange("2026-08-11T10:30", "2026-08-11T12:00");

    expect(createWrapper().findAreaChart()).not.toBeNull();
    expect(
      screen.queryByText(/measured from its own first reading/),
    ).toBeNull();
  });

  it("shows the lease's latest figures for a range that ended before the read", async () => {
    // The range's own readings, the newest of them unpriced.
    const tokens = TOKENS.filter(
      ({ timestamp }) => timestamp <= "2026-08-11T09:00:00.000Z",
    );
    stubQuery({
      data: drained(tokens),
      dataUpdatedAt: Date.parse("2026-08-12T00:00:00.000Z"),
    });
    render(<BedrockTokenUsage leaseId="lease-1" lastEvaluatedSpend={62.5} />);

    await pickAbsoluteRange("2026-08-11T07:00", "2026-08-11T09:00");

    expect(
      vi.mocked(useGetMergedLeaseBedrockTokenHistory).mock.calls.at(-1)?.[1]
        ?.beforeTimestamp,
    ).toBeDefined();
    expect(screen.getByText("Tokens used so far")).toBeInTheDocument();
    expect(screen.getByText("28,700")).toBeInTheDocument();
    expect(screen.getByText("USD 4.25")).toBeInTheDocument();
    expect(screen.getByText("≈ USD 62.50")).toBeInTheDocument();
  });

  it("shows the lease's latest figures for a range running to now", async () => {
    // Read just before the newest reading landed, which the read of it alone has.
    stubQuery({ data: drained([]) });
    stubBaseline({ data: drained(rowsAt("2026-08-11T10:00:00.000Z")) });
    render(<BedrockTokenUsage leaseId="lease-1" lastEvaluatedSpend={62.5} />);

    await pickRelativeRange("last-24-hours");

    expect(screen.getByText("28,700")).toBeInTheDocument();
    expect(screen.getByText("USD 4.25")).toBeInTheDocument();
    expect(screen.getByText("≈ USD 62.50")).toBeInTheDocument();
    // The reading before the range reaches the panel, so the range is not taken
    // for a lease with nothing read.
    expect(
      screen.getByText("No change in token usage over this range"),
    ).toBeInTheDocument();
  });

  it("leaves the latest figures out while the newest reading loads, where it fails, or where it brings back no row", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });
    const latestReads: Partial<LatestQuery>[] = [
      { data: undefined, isLoading: true },
      // A refresh that failed, still holding the reading read before it.
      { ...readingAt(NEWEST), isError: true, error: new Error("boom") },
      { data: drained([]) },
      // The newest reading could not be read.
      { data: drained([], "more") },
    ];

    for (const latest of latestReads) {
      stubLatest(latest);
      const { unmount } = render(
        <BedrockTokenUsage leaseId="lease-1" lastEvaluatedSpend={62.5} />,
      );

      expect(createWrapper().findAreaChart()).not.toBeNull();
      expect(screen.queryByText("Tokens used so far")).toBeNull();
      expect(screen.queryByText("Monitored Bedrock token cost")).toBeNull();
      expect(screen.queryByText("Spend for budget thresholds")).toBeNull();
      unmount();
    }
  });

  it("says nothing has been read where a range running to now has no readings", async () => {
    stubQuery({ data: drained([]) });
    stubBaseline({ data: drained([]) });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickRelativeRange("last-24-hours");

    expect(screen.getByText("No token usage read yet")).toBeInTheDocument();
    expectPickerAbove(screen.getByText("No token usage read yet"));
  });

  it.each(BASELINE_UNREADABLE)(
    "measures a range from its first reading where the read of the reading before it %s",
    async (_case, baseline) => {
      // What was used before the range is unknown.
      stubBaseline(baseline);
      stubQuery({
        data: bedrockTokenHistoryOf(FIXTURE),
        dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
      });
      render(<BedrockTokenUsage leaseId="lease-1" />);

      await pickAbsoluteRange("2026-08-11T00:00", "2026-08-11T12:00");

      expect(
        screen.getByText(/measured from its own first reading/),
      ).toBeInTheDocument();
    },
  );

  it("measures a range from nothing where the page of the reading before it omits the cursor", async () => {
    // As the wire carries an empty last page: with no cursor member, not a null one.
    stubBaseline({ data: { result: [] } });
    stubQuery({
      data: bedrockTokenHistoryOf(FIXTURE),
      dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
    });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickAbsoluteRange("2026-08-11T00:00", "2026-08-11T12:00");

    expect(createWrapper().findAreaChart()).not.toBeNull();
    expect(
      screen.queryByText(/measured from its own first reading/),
    ).toBeNull();
  });

  it("waits for the reading before a range before drawing it", async () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });
    render(<BedrockTokenUsage leaseId="lease-1" />);
    stubBaseline({ data: undefined, isPending: true });

    await pickRelativeRange("last-24-hours");

    expect(screen.getByText("Loading Bedrock token usage")).toBeInTheDocument();
    expect(createWrapper().findAreaChart()).toBeNull();
  });

  it("leaves the measured-from note to the truncation alert where the drain stopped short", async () => {
    // Set aside, since the charts start from the oldest reading loaded instead.
    stubBaseline({
      data: drained(
        rowsAt("2026-08-11T07:00:00.000Z").map((row) => ({
          ...row,
          timestamp: "2026-08-10T07:00:00.000Z",
        })),
      ),
    });
    stubQuery({
      data: bedrockTokenHistoryOf(FIXTURE, "more"),
      dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
    });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickAbsoluteRange("2026-08-11T00:00", "2026-08-11T12:00");

    expect(
      screen.queryByText(/measured from its own first reading/),
    ).toBeNull();
    expect(
      screen.getByText(
        /^Showing usage since Aug 11, 2026; pick a narrower range to see earlier\.$/,
      ),
    ).toBeInTheDocument();
  });

  it("measures a whole lease the drain stopped short of from its oldest loaded reading", () => {
    stubQuery({
      data: bedrockTokenHistoryOf(FIXTURE, "more"),
      dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
    });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    // The oldest loaded reading is where the charts start, not a period that
    // counts everything used before it.
    expect(
      screen.getByText(/^Showing usage since Aug 11, 2026;/),
    ).toBeInTheDocument();
    expect(
      screen.queryByText(/measured from its own first reading/),
    ).toBeNull();
  });

  it.each(BASELINE_UNREADABLE)(
    "does not say nothing has been read where the read of the reading before a range %s",
    async (_case, baseline) => {
      stubQuery({ data: drained([]) });
      stubBaseline(baseline);
      render(<BedrockTokenUsage leaseId="lease-1" />);

      await pickRelativeRange("last-24-hours");

      expect(screen.queryByText("No token usage read yet")).toBeNull();
      expect(
        screen.getByText("No change in token usage over this range"),
      ).toBeInTheDocument();
    },
  );

  it("warns where the whole lease did not fit in one load", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE, "more") });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(
      screen.getByText("Showing part of this range's token usage"),
    ).toBeInTheDocument();
  });

  it("stops the charts where the lease ended rather than at now", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });

    // The fixture's readings are months old, so run on to now they would count days.
    render(
      <BedrockTokenUsage
        leaseId="lease-1"
        leaseEndedAt="2026-08-11T11:30:00.000Z"
      />,
    );

    expect(screen.getByText("Tokens used per hour")).toBeInTheDocument();
  });

  it("ends a picked range's charts at its last included instant, not the exclusive end it asks for", async () => {
    // Two days to the millisecond counts hours, which a millisecond more would
    // count as days.
    const start = "2026-08-09T11:00:00.000Z";
    const tokens = [
      ...rowsAt(NEWEST),
      ...rowsAt("2026-08-11T07:00:00.000Z").map((row) => ({
        ...row,
        timestamp: start,
      })),
    ];
    stubQuery({
      data: drained(tokens),
      dataUpdatedAt: Date.parse("2026-08-12T00:00:00.000Z"),
    });
    render(<BedrockTokenUsage leaseId="lease-1" />);

    await pickAbsoluteRange("2026-08-09T11:00", "2026-08-11T11:00");

    expect(
      vi.mocked(useGetMergedLeaseBedrockTokenHistory).mock.calls.at(-1)?.[1],
    ).toEqual({
      afterTimestamp: start,
      beforeTimestamp: "2026-08-11T11:00:00.001Z",
    });
    expect(screen.getByText("Tokens used per hour")).toBeInTheDocument();
  });

  it("ends the charts when the data was read, not at each render", () => {
    stubQuery({
      data: bedrockTokenHistoryOf(FIXTURE),
      dataUpdatedAt: Date.parse("2026-08-11T11:30:00.000Z"),
    });

    // Run on to now, the fixture's months-old readings would count days.
    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(screen.getByText("Tokens used per hour")).toBeInTheDocument();
  });

  it("keeps what it read where a later refresh fails, says so, and retries", async () => {
    const refetch = vi.fn();
    const latestRefetch = vi.fn();
    const baselineRefetch = vi.fn();
    stubQuery({
      data: bedrockTokenHistoryOf(FIXTURE),
      isError: true,
      error: new Error("boom"),
      refetch,
    });
    stubLatest({ ...readingAt(NEWEST), refetch: latestRefetch });
    stubBaseline({ data: drained([]), refetch: baselineRefetch });
    const refetchLease = stubRefetchLease();

    render(
      <MemoryRouter>
        <BedrockTokenUsage leaseId="lease-1" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(createWrapper().findAreaChart()).not.toBeNull();
    expect(
      screen.getByText("Showing token usage read earlier"),
    ).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
    expect(latestRefetch).toHaveBeenCalled();
    expect(refetchLease).toHaveBeenCalledOnce();
    // The whole lease reads no baseline to read again.
    expect(baselineRefetch).not.toHaveBeenCalled();
  });

  it("reads the reading before a picked range again on a retry", async () => {
    const baselineRefetch = vi.fn();
    stubQuery({ isError: true, error: new Error("boom"), refetch: vi.fn() });
    stubBaseline({ data: drained([]), refetch: baselineRefetch });
    render(
      <MemoryRouter>
        <BedrockTokenUsage leaseId="lease-1" />
      </MemoryRouter>,
    );

    await pickRelativeRange("last-24-hours");
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(baselineRefetch).toHaveBeenCalledOnce();
  });

  it("still stops at the lease end where a reading was stamped after it", () => {
    // A poll that scanned the lease before it ended wrote its row just after.
    stubQuery({
      data: drained(rowsAt(NEWEST)),
      dataUpdatedAt: Date.parse("2026-08-11T10:58:00.000Z"),
    });

    render(
      <BedrockTokenUsage
        leaseId="lease-1"
        leaseEndedAt="2026-08-11T10:59:00.000Z"
      />,
    );

    expect(createWrapper().findAreaChart()).toBeNull();
  });

  it("reaches the newest reading where the server stamped it after the read", () => {
    // Read a minute before the lease's only reading, by this browser's clock.
    stubQuery({
      data: drained(rowsAt(NEWEST)),
      dataUpdatedAt: Date.parse("2026-08-11T10:59:00.000Z"),
    });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(createWrapper().findAreaChart()).not.toBeNull();
    expect(screen.queryByText("No token usage read yet")).toBeNull();
  });

  it("puts its range picker in the token chart's header", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    const actions = tokenChartHeader()!.findActions()!;
    expect(actions.findDateRangePicker()).not.toBeNull();
    expect(
      createWrapper().findContainer()!.findHeader()!.findDateRangePicker(),
    ).toBeNull();
  });

  it("names its range picker for the token panel", () => {
    stubQuery({ data: bedrockTokenHistoryOf(FIXTURE) });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(
      screen.getByRole("button", { name: /Bedrock token usage range/ }),
    ).toBeInTheDocument();
  });

  it("keeps its header, and its picker on a row above the loading indicator, while the history loads", () => {
    stubQuery({ data: undefined, isLoading: true });

    render(<BedrockTokenUsage leaseId="lease-1" />);

    expect(screen.getByText("Loading Bedrock token usage")).toBeInTheDocument();
    expect(screen.getByText("Bedrock token usage")).toBeInTheDocument();
    expectPickerAbove(screen.getByText("Loading Bedrock token usage"));
  });

  it("keeps its picker on a row above the error panel where the history fails to load, and retries", async () => {
    const refetch = vi.fn();
    const latestRefetch = vi.fn();
    stubQuery({ isError: true, error: new Error("boom"), refetch });
    stubLatest({ ...readingAt(NEWEST), refetch: latestRefetch });
    const refetchLease = stubRefetchLease();

    render(
      <MemoryRouter>
        <BedrockTokenUsage leaseId="lease-1" />
      </MemoryRouter>,
    );
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      screen.getByText(/problem loading Bedrock token usage/),
    ).toBeInTheDocument();
    expectPickerAbove(screen.getByText(/problem loading Bedrock token usage/));
    expect(refetch).toHaveBeenCalled();
    expect(latestRefetch).toHaveBeenCalled();
    expect(refetchLease).toHaveBeenCalledOnce();
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { MemoryRouter } from "react-router-dom";
import { afterEach, describe, expect, it, vi } from "vitest";

import { BreachHistory } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistory";
import { useGetMergedLeaseBreachHistory } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  breachHistoryOf,
  createMockCostHistory,
  createMockLeaseEndBreachCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks", () => ({
  useGetMergedLeaseBreachHistory: vi.fn(),
}));

type BreachHistoryQuery = ReturnType<typeof useGetMergedLeaseBreachHistory>;

const stubQuery = (query: Partial<BreachHistoryQuery>) =>
  vi
    .mocked(useGetMergedLeaseBreachHistory)
    .mockReturnValue(query as BreachHistoryQuery);

const lastRangeAsked = () =>
  vi.mocked(useGetMergedLeaseBreachHistory).mock.calls.at(-1)?.[1];

const renderHistory = () =>
  render(
    <MemoryRouter>
      <BreachHistory leaseId="lease-1" />
    </MemoryRouter>,
  );

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

describe("BreachHistory", () => {
  afterEach(() => {
    vi.mocked(useGetMergedLeaseBreachHistory).mockReset();
  });

  it("reads the whole lease under a range picker of its own", () => {
    const fixture = createMockCostHistory();
    stubQuery({ data: breachHistoryOf(fixture) });

    renderHistory();

    expect(useGetMergedLeaseBreachHistory).toHaveBeenCalledWith(
      "lease-1",
      undefined,
    );
    expect(
      screen.getByText(`(${fixture.data.breaches.length})`),
    ).toBeInTheDocument();
    expect(
      createWrapper().findDateRangePicker()!.findTrigger().getElement()
        .textContent,
    ).toContain("Whole lease");
  });

  it("asks for the range picked in its own picker", async () => {
    stubQuery({ data: breachHistoryOf(createMockCostHistory()) });

    renderHistory();
    await pickRelativeRange("last-24-hours");

    expect(lastRangeAsked()?.afterTimestamp).toMatch(/^\d{4}-\d{2}-\d{2}T.*Z$/);
  });

  it("offers to reset a narrower range with no breaches to the whole lease", async () => {
    stubQuery({
      data: breachHistoryOf(createMockCostHistory({ breaches: [] })),
    });

    renderHistory();
    expect(
      screen.getByText("No thresholds have fired on this lease"),
    ).toBeInTheDocument();
    await pickRelativeRange("last-24-hours");
    expect(
      screen.getByText("No thresholds fired in the selected range"),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole("button", { name: "Reset filters" }),
    );

    expect(lastRangeAsked()).toBeUndefined();
    expect(
      screen.getByText("No thresholds have fired on this lease"),
    ).toBeInTheDocument();
  });

  it("says only the newest breaches arrived where the load stopped short, since the oldest one shown", () => {
    const fixture = createMockCostHistory();
    stubQuery({ data: breachHistoryOf(fixture, "next") });

    renderHistory();

    const oldest = DateTime.fromISO(fixture.data.breaches.at(-1)!.timestamp);
    expect(
      screen.getByText("Showing part of this range's breaches"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(
        `Showing breaches since ${oldest.toLocaleString(DateTime.DATE_MED)}; pick a narrower range to see earlier.`,
      ),
    ).toBeInTheDocument();
  });

  it("dates a load stopped short from its oldest breach where that is a duration threshold", () => {
    const fixture = createMockLeaseEndBreachCostHistory();
    stubQuery({ data: breachHistoryOf(fixture, "next") });

    renderHistory();

    const duration = fixture.data.breaches.find(
      ({ triggeredBy }) => triggeredBy === "DURATION",
    )!;
    expect(
      screen.getByText(
        `Showing breaches since ${DateTime.fromISO(duration.timestamp).toLocaleString(DateTime.DATE_MED)}; pick a narrower range to see earlier.`,
      ),
    ).toBeInTheDocument();
  });

  it("says the range is partial without a date where the load stopped short before any breach arrived", () => {
    stubQuery({
      data: breachHistoryOf(createMockCostHistory({ breaches: [] }), "next"),
    });

    renderHistory();

    expect(
      screen.getByText(
        "This range holds more than the section loads at once, so only its newest breaches are shown. Pick a narrower range to see earlier.",
      ),
    ).toBeInTheDocument();
  });

  it("keeps the same range picker through a failed load and the loads after it", () => {
    stubQuery({ isError: true, error: new Error("no"), refetch: vi.fn() });
    const view = renderHistory();
    const trigger = () =>
      createWrapper().findDateRangePicker()!.findTrigger().getElement();
    const failedTrigger = trigger();

    stubQuery({});
    view.rerender(
      <MemoryRouter>
        <BreachHistory leaseId="lease-1" />
      </MemoryRouter>,
    );
    expect(trigger()).toBe(failedTrigger);

    stubQuery({ data: breachHistoryOf(createMockCostHistory()) });
    view.rerender(
      <MemoryRouter>
        <BreachHistory leaseId="lease-1" />
      </MemoryRouter>,
    );
    expect(trigger()).toBe(failedTrigger);
  });

  it("reports a failed load with a retry, keeping its range picker", async () => {
    const refetch = vi.fn();
    stubQuery({ isError: true, error: new Error("no"), refetch });

    renderHistory();
    expect(createWrapper().findDateRangePicker()).not.toBeNull();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(
      screen.getByText(
        "There was a problem loading the breach history for this lease.",
      ),
    ).toBeInTheDocument();
    expect(refetch).toHaveBeenCalled();
  });

  it("shows the table loading until the breaches arrive, without a count", () => {
    stubQuery({});

    renderHistory();

    expect(screen.getByText("Loading breach history")).toBeInTheDocument();
    expect(screen.queryByText("(0)")).toBeNull();
  });

  it("keeps the breaches already read where a refresh fails, and offers to try again", async () => {
    const refetch = vi.fn();
    const fixture = createMockCostHistory();
    stubQuery({
      data: breachHistoryOf(fixture),
      isError: true,
      error: new Error("no"),
      refetch,
    });

    renderHistory();
    expect(
      screen.getByText("Showing breach history read earlier"),
    ).toBeInTheDocument();
    expect(
      screen.getByText(`(${fixture.data.breaches.length})`),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalled();
  });

  it("starts a new range on its first page", async () => {
    const [breach] = createMockCostHistory().data.breaches;
    const breaches = Array.from({ length: 25 }, (_, index) => ({
      ...breach!,
      timestamp: `2026-08-11T${String(index).padStart(2, "0")}:00:00.000Z`,
    }));
    stubQuery({ data: breachHistoryOf(createMockCostHistory({ breaches })) });

    renderHistory();
    const table = createWrapper().findTable()!;
    await userEvent.click(
      table.findPagination()!.findPageNumberByIndex(3)!.getElement(),
    );
    expect(table.findRows()).toHaveLength(5);
    await pickRelativeRange("last-24-hours");

    expect(table.findRows()).toHaveLength(10);
    expect(
      table.findPagination()!.findCurrentPage().getElement().textContent,
    ).toBe("1");
  });
});

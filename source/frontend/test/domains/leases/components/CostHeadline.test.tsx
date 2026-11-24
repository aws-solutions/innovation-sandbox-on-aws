// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { DateTime } from "luxon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

import { CostHeadline } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostHeadline";
import {
  createMockCostHistory,
  createMockFirstIntervalCostHistory,
  createMockNeverOptedInCostHistory,
  createMockNoBreakdownCostHistory,
  createMockNoCurrentCostHistory,
  createMockRateBreachCostHistory,
  LeaseHistoryFixtureData,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

const renderHeadline = (
  { current, budget }: LeaseHistoryFixtureData,
  leaseEnd?: string,
  leaseEndedAt?: string,
) =>
  render(
    <CostHeadline
      current={current}
      {...(budget.maxSpend === undefined ? {} : { maxSpend: budget.maxSpend })}
      {...(leaseEnd === undefined ? {} : { leaseEnd })}
      {...(leaseEndedAt === undefined ? {} : { leaseEndedAt })}
    />,
  );

// Half an hour past the fixtures' last monitoring run, so that the distances the
// headline states are the ones a reader would see on a live lease.
const NOW = new Date("2026-08-11T11:30:00.000Z");

describe("CostHeadline", () => {
  beforeAll(() => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW);
  });

  afterAll(() => {
    vi.useRealTimers();
  });

  it("renders the estimate carried forward, and the billed figure plainly", () => {
    renderHeadline(createMockCostHistory().data);

    // Half an hour past the reading at $3.50/hour, so the estimate is carried
    // forward by $1.75 rather than reported as of the reading.
    expect(screen.getByText("≈ USD 72.25")).toBeInTheDocument();
    expect(screen.queryByText(/^Range /)).not.toBeInTheDocument();
    expect(
      screen.getByText("USD 60.00 of USD 100.00 (60%)"),
    ).toBeInTheDocument();
  });

  it("renders each rate with the window it was measured over", () => {
    renderHeadline(createMockCostHistory().data);

    expect(
      screen.getByText("USD 3.50/hour, measured over 8 hours"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("USD 52.00/day, measured over 24 hours"),
    ).toBeInTheDocument();
  });

  it("renders a daily window shorter than a day beside the daily rate", () => {
    const { current } = createMockCostHistory().data;
    renderHeadline(
      createMockCostHistory({
        current: { ...current!, dailyRateWindowHours: 3 },
      }).data,
    );

    expect(
      screen.getByText("USD 52.00/day, measured over 3 hours"),
    ).toBeInTheDocument();
  });

  it("renders exhaustion as a date, with the rough distance under it", () => {
    renderHeadline(createMockCostHistory().data);

    // 8.4 hours past the 11:00 reading, stated as the moment it falls on rather
    // than as a duration to add up.
    expect(
      screen.getByText(
        DateTime.fromISO("2026-08-11T19:24:00.000Z").toLocaleString(
          DateTime.DATETIME_MED,
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("in 7 hours")).toBeInTheDocument();
    expect(screen.getByText("August 11, 2026")).toBeInTheDocument();
    expect(screen.getByText(/^Last checked /)).toBeInTheDocument();
  });

  it("renders the lease's end date beside the exhaustion date", () => {
    renderHeadline(createMockCostHistory().data, "2026-08-14T08:00:00.000Z");

    // The two dates answer the same question -- which runs out first, the money or
    // the lease -- so they are stated the same way and sit next to each other.
    expect(screen.getByText("Lease end date")).toBeInTheDocument();
    expect(
      screen.getByText(
        DateTime.fromISO("2026-08-14T08:00:00.000Z").toLocaleString(
          DateTime.DATETIME_MED,
        ),
      ),
    ).toBeInTheDocument();
    expect(screen.getByText("in 2 days")).toBeInTheDocument();
  });

  it("stops carrying the estimate at a terminal lease's end", () => {
    const endedAt = "2026-08-11T11:15:00.000Z";

    renderHeadline(createMockCostHistory().data, endedAt, endedAt);

    // The lease ended fifteen minutes after the last check. Reopening it later
    // must not keep accruing the last measured rate to browser now.
    expect(
      screen.getByText("Predicted spend at lease end"),
    ).toBeInTheDocument();
    expect(screen.getByText("≈ USD 71.38")).toBeInTheDocument();
    expect(screen.queryByText("Predicted spend now")).not.toBeInTheDocument();
  });

  it("says so where the lease has no end date to compare against", () => {
    renderHeadline(createMockCostHistory().data);

    expect(screen.getByText("No end date set")).toBeInTheDocument();
  });

  it("renders no figure where no rate exists yet on a first-interval lease", () => {
    renderHeadline(createMockFirstIntervalCostHistory().data);

    expect(screen.getAllByText("Not enough data yet")).toHaveLength(3);
    expect(screen.queryByText(/^≈ /)).not.toBeInTheDocument();
    expect(screen.queryByText(/measured over/)).not.toBeInTheDocument();
  });

  it("renders no estimate for a lease that never opted into prediction", () => {
    renderHeadline(createMockNeverOptedInCostHistory().data);

    expect(screen.getAllByText("Not enough data yet")).toHaveLength(3);
    expect(
      screen.getByText("USD 60.00 of USD 100.00 (60%)"),
    ).toBeInTheDocument();
  });

  it("renders the figures for a lease with no stored service breakdown", () => {
    renderHeadline(createMockNoBreakdownCostHistory().data);

    expect(screen.getByText("≈ USD 72.25")).toBeInTheDocument();
    expect(
      screen.getByText("USD 60.00 of USD 100.00 (60%)"),
    ).toBeInTheDocument();
  });

  it("renders the figures for a lease carrying a rate breach", () => {
    renderHeadline(createMockRateBreachCostHistory().data);

    expect(screen.getByText("≈ USD 72.25")).toBeInTheDocument();
    expect(
      screen.getByText("USD 3.50/hour, measured over 8 hours"),
    ).toBeInTheDocument();
  });

  it("says the figures are unavailable rather than showing a zero", () => {
    renderHeadline(createMockNoCurrentCostHistory().data);

    expect(screen.getByText("Cost figures unavailable")).toBeInTheDocument();
    expect(
      screen.getByText(
        "The most recent reading could not be read. This is not a report of zero spend — this lease may already be at its budget.",
      ),
    ).toBeInTheDocument();
    expect(screen.queryByText(/\USD 0\.00/)).not.toBeInTheDocument();
  });

  it("renders no exhaustion date and no percentage where the lease has no budget", () => {
    const { current, budget } = createMockCostHistory().data;
    const { maxSpend: _dropped, ...withoutMaxSpend } = budget;
    const { hoursToBudgetExhaustion: _also, ...withoutCountdown } = current!;
    renderHeadline(
      createMockCostHistory({
        current: withoutCountdown,
        budget: withoutMaxSpend,
      }).data,
    );

    expect(screen.queryByText("Budget exhausted by")).not.toBeInTheDocument();
    expect(screen.getByText("USD 60.00")).toBeInTheDocument();
    expect(screen.queryByText(/%/)).not.toBeInTheDocument();
  });

  it("renders a spend of a fraction of a cent as under a cent, not as zero", () => {
    const { current } = createMockCostHistory().data;
    renderHeadline(
      createMockCostHistory({
        current: {
          ...current!,
          billedCostAccrued: 0.0001616799,
          predictedCost: 0.0002,
          hourlyRate: 0.00001,
          dailyRate: 0.0002,
        },
      }).data,
    );

    expect(
      screen.getByText("< USD 0.01 of USD 100.00 (0%)"),
    ).toBeInTheDocument();
    expect(screen.getByText("≈ < USD 0.01")).toBeInTheDocument();
    expect(
      screen.getByText("< USD 0.01/hour, measured over 8 hours"),
    ).toBeInTheDocument();
    expect(
      screen.getByText("< USD 0.01/day, measured over 24 hours"),
    ).toBeInTheDocument();
    expect(screen.queryByText(/USD 0\.00/)).not.toBeInTheDocument();
  });

  it("renders a billed total of exactly zero as zero", () => {
    const { current } = createMockCostHistory().data;
    renderHeadline(
      createMockCostHistory({
        current: { ...current!, billedCostAccrued: 0 },
      }).data,
    );

    expect(screen.getByText("USD 0.00 of USD 100.00 (0%)")).toBeInTheDocument();
  });
});

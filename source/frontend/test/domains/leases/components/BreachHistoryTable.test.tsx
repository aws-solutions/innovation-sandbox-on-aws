// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { BreachHistoryTable } from "@amzn/innovation-sandbox-frontend/domains/leases/components/BreachHistoryTable";
import { BreachEntry } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  createMockCostHistory,
  createMockNeverOptedInCostHistory,
  createMockNoBreakdownCostHistory,
  createMockRateBreachCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

const cellsOf = (text: string) =>
  Array.from(screen.getByText(text).closest("tr")!.querySelectorAll("td")).map(
    (cell) => cell.textContent,
  );

describe("BreachHistoryTable", () => {
  it("renders a rate breach with its cap and basis and no dollar threshold", () => {
    const { breaches } = createMockRateBreachCostHistory().data;

    render(<BreachHistoryTable breaches={breaches} />);

    expect(cellsOf("Spend rate").slice(2)).toEqual([
      "USD 12.00/hour",
      "USD 14.00/hour",
      "Send alert",
      "—",
    ]);
  });

  it("renders a max spend breach with its cap, the figure that reached it and the termination", () => {
    const maxSpend: BreachEntry = {
      timestamp: "2026-08-11T11:00:00.000Z",
      triggeredBy: "MAX_SPEND",
      action: "TERMINATE",
      thresholdDollars: 100,
      billedCostAtFire: 90,
      evaluatedBy: "TOKEN_POLL",
      evaluatedSpendAtFire: 101.5,
      monitoredBedrockTokenCostAtFire: 31,
    };

    render(
      <BreachHistoryTable
        breaches={[maxSpend, ...createMockCostHistory().data.breaches]}
      />,
    );

    expect(cellsOf("Max spend").slice(2)).toEqual([
      "USD 100.00",
      "USD 101.50",
      "Terminate lease",
      "—",
    ]);
    expect(screen.getByText("Max spend").className).not.toEqual(
      screen.getByText("Projected cost").className,
    );
  });

  it("renders a duration threshold breach with its hours, and an expiry with the termination, neither with a figure", () => {
    const duration: BreachEntry = {
      timestamp: "2026-08-11T10:00:00.000Z",
      triggeredBy: "DURATION",
      action: "FREEZE_ACCOUNT",
      thresholdHoursRemaining: 24,
      billedCostAtFire: 40,
      evaluatedBy: "LEASE_MONITORING",
    };
    const expiry: BreachEntry = {
      timestamp: "2026-08-12T11:00:00.000Z",
      triggeredBy: "EXPIRY",
      action: "TERMINATE",
      billedCostAtFire: 45,
      evaluatedBy: "LEASE_MONITORING",
    };

    const maxSpend: BreachEntry = {
      timestamp: "2026-08-12T10:00:00.000Z",
      triggeredBy: "MAX_SPEND",
      action: "TERMINATE",
      thresholdDollars: 100,
      billedCostAtFire: 101,
      evaluatedBy: "LEASE_MONITORING",
    };

    render(<BreachHistoryTable breaches={[expiry, maxSpend, duration]} />);

    expect(cellsOf("Time remaining").slice(2)).toEqual([
      "24 hours",
      "—",
      "Freeze account",
      "—",
    ]);
    expect(cellsOf("Expiry").slice(2)).toEqual([
      "—",
      "—",
      "Terminate lease",
      "—",
    ]);
    // Expiry ends the lease, so it is set apart as max spend is; a duration
    // threshold is not.
    expect(screen.getByText("Expiry").className).toEqual(
      screen.getByText("Max spend").className,
    );
    expect(screen.getByText("Time remaining").className).not.toEqual(
      screen.getByText("Expiry").className,
    );
  });

  it("describes the action without claiming it completed", () => {
    const breach: BreachEntry = {
      ...createMockCostHistory().data.breaches[0],
      action: "FREEZE_ACCOUNT",
    };

    render(<BreachHistoryTable breaches={[breach]} />);

    expect(screen.getByText("Action")).toBeInTheDocument();
    expect(screen.getByText("Freeze account")).toBeInTheDocument();
    expect(screen.queryByText("Account frozen")).not.toBeInTheDocument();
  });

  it("sets the projected figure apart from the billed one", () => {
    render(
      <BreachHistoryTable
        breaches={[
          ...createMockCostHistory().data.breaches,
          ...createMockNeverOptedInCostHistory().data.breaches,
        ]}
      />,
    );

    expect(cellsOf("Projected cost").slice(2, 4)).toEqual([
      "USD 70.00",
      "≈ USD 70.50",
    ]);
    expect(cellsOf("Billed cost").slice(2, 4)).toEqual([
      "USD 50.00",
      "USD 60.00",
    ]);
    expect(screen.getByText("Projected cost").className).not.toEqual(
      screen.getByText("Billed cost").className,
    );
  });

  it("shows evaluated spend where the token poll recorded one", () => {
    const evaluatedSpendBreach: BreachEntry = {
      ...createMockNeverOptedInCostHistory().data.breaches[0],
      evaluatedBy: "TOKEN_POLL",
      evaluatedSpendAtFire: 74.25,
    };

    render(<BreachHistoryTable breaches={[evaluatedSpendBreach]} />);

    expect(cellsOf("Billed cost")[3]).toEqual("USD 74.25");
  });

  it("renders the stored insight as the sentence the alert sent", () => {
    const { breaches } = createMockCostHistory().data;

    render(<BreachHistoryTable breaches={breaches} />);

    expect(
      screen.getByText(
        "The biggest change is Amazon Bedrock, up 112% since the previous interval, now USD 52.10.",
      ),
    ).toBeInTheDocument();
  });

  it("formats the insight's amount as the email did, even below a cent", () => {
    const [breach] = createMockCostHistory().data.breaches;
    const subCent: BreachEntry = {
      ...breach,
      insight: { kind: "CHANGE", service: "Amazon Bedrock", amount: 0.004 },
    };

    render(<BreachHistoryTable breaches={[subCent]} />);

    expect(
      screen.getByText("The biggest change is Amazon Bedrock, now USD 0.00."),
    ).toBeInTheDocument();
  });

  it("names the share alongside the largest service where one was stored", () => {
    const [breach] = createMockCostHistory().data.breaches;
    const composition: BreachEntry = {
      ...breach,
      insight: {
        kind: "COMPOSITION",
        service: "Amazon Bedrock",
        amount: 52.1,
        shareOfComparedSpend: 0.87,
      },
    };

    render(<BreachHistoryTable breaches={[composition]} />);

    expect(
      screen.getByText(
        "The largest service is Amazon Bedrock, USD 52.10 (87%).",
      ),
    ).toBeInTheDocument();
  });

  it("names the unbilled Bedrock usage as the largest service where the token poll stored it", () => {
    const [breach] = createMockCostHistory().data.breaches;
    const composition: BreachEntry = {
      ...breach,
      insight: {
        kind: "COMPOSITION",
        service: "Amazon Bedrock token usage not yet billed",
        amount: 5.45,
        shareOfComparedSpend: 0.7,
      },
    };

    render(<BreachHistoryTable breaches={[composition]} />);

    expect(
      screen.getByText(
        "The largest service is Amazon Bedrock token usage not yet billed, USD 5.45 (70%).",
      ),
    ).toBeInTheDocument();
  });

  it("omits the share where a stored composition insight carries none", () => {
    const [breach] = createMockCostHistory().data.breaches;
    const withoutShare: BreachEntry = {
      ...breach,
      insight: {
        kind: "COMPOSITION",
        service: "Amazon Bedrock",
        amount: 52.1,
      },
    };

    render(<BreachHistoryTable breaches={[withoutShare]} />);

    expect(
      screen.getByText("The largest service is Amazon Bedrock, USD 52.10."),
    ).toBeInTheDocument();
  });

  it("renders a new entrant as the interval it first appeared in", () => {
    const [breach] = createMockCostHistory().data.breaches;
    const newEntrant: BreachEntry = {
      ...breach,
      insight: {
        kind: "NEW_ENTRANT",
        service: "Amazon Bedrock",
        amount: 52.1,
      },
    };

    render(<BreachHistoryTable breaches={[newEntrant]} />);

    expect(
      screen.getByText("New this interval: Amazon Bedrock, USD 52.10."),
    ).toBeInTheDocument();
  });

  it("omits the sentence for a breach with no stored insight", () => {
    const { breaches } = createMockNoBreakdownCostHistory().data;
    expect(breaches[0].insight).toBeUndefined();

    render(<BreachHistoryTable breaches={breaches} />);

    expect(cellsOf("Projected cost")[5]).toEqual("—");
  });

  it("pages a long history ten breaches at a time, counting all of them", async () => {
    const [breach] = createMockCostHistory().data.breaches;
    const breaches: BreachEntry[] = Array.from({ length: 25 }, (_, index) => ({
      ...breach!,
      timestamp: `2026-08-11T${String(index).padStart(2, "0")}:00:00.000Z`,
    }));

    render(<BreachHistoryTable breaches={breaches} />);

    const table = createWrapper().findTable()!;
    expect(screen.getByText("(25)")).toBeInTheDocument();
    expect(table.findRows()).toHaveLength(10);
    await userEvent.click(
      table.findPagination()!.findPageNumberByIndex(3)!.getElement(),
    );
    expect(table.findRows()).toHaveLength(5);
  });

  it("shows when each breach fired as a relative time", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-11T14:00:00.000Z"));
    const [breach] = createMockCostHistory().data.breaches;

    render(
      <BreachHistoryTable
        breaches={[{ ...breach!, timestamp: "2026-08-11T11:00:00.000Z" }]}
      />,
    );

    expect(screen.getByText("3 hours ago")).toBeInTheDocument();
    vi.useRealTimers();
  });
});

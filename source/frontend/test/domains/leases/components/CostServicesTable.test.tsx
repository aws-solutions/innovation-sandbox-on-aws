// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { CostServicesTable } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostServicesTable";
import {
  createMockCostHistory,
  createMockFirstIntervalCostHistory,
  createMockNoBreakdownCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

const cellsOf = (service: string) =>
  Array.from(
    screen.getByText(service).closest("tr")!.querySelectorAll("td"),
  ).map((cell) => cell.textContent);

describe("CostServicesTable", () => {
  it("renders each service with its cost, share and change", () => {
    const { services } = createMockCostHistory().data.current!;

    render(<CostServicesTable services={services} />);

    expect(cellsOf("Amazon Bedrock")).toEqual([
      "Amazon Bedrock",
      "USD 52.10",
      "87%",
      "↑ 112%",
    ]);
    expect(cellsOf("Amazon Simple Storage Service")).toEqual([
      "Amazon Simple Storage Service",
      "USD 1.50",
      "2%",
      "↑ 25%",
    ]);
  });

  it("points the arrow down on a fall and drops it on a flat interval", () => {
    const [entry] = createMockCostHistory().data.current!.services;

    render(
      <CostServicesTable
        services={[
          { ...entry, service: "Fell", changePercent: -40 },
          { ...entry, service: "Flat", changePercent: 0 },
        ]}
      />,
    );

    expect(cellsOf("Fell")[3]).toEqual("↓ 40%");
    expect(cellsOf("Flat")[3]).toEqual("0%");
  });

  it("renders no change where the previous reading does not exist yet", () => {
    const { services } = createMockFirstIntervalCostHistory().data.current!;

    render(<CostServicesTable services={services} />);

    expect(cellsOf("Amazon Elastic Compute Cloud - Compute")).toEqual([
      "Amazon Elastic Compute Cloud - Compute",
      "USD 5.20",
      "65%",
      "—",
    ]);
  });

  it("renders the empty state naming the reason rather than a zero", () => {
    const { current } = createMockNoBreakdownCostHistory().data;
    expect(current!.billedCostAccrued).toBeGreaterThan(0);

    render(<CostServicesTable services={current!.services} />);

    expect(
      screen.getByText("No service breakdown available"),
    ).toBeInTheDocument();
    expect(screen.getByText(/not a report of zero spend/i)).toBeInTheDocument();
    expect(screen.queryByText("USD 0.00")).not.toBeInTheDocument();
  });

  it("leaves out services that cost nothing but keeps those under a cent", () => {
    const [entry] = createMockCostHistory().data.current!.services;

    render(
      <CostServicesTable
        services={[
          entry!,
          {
            service: "AWS Secrets Manager",
            amount: 0.000035,
            shareOfBilledCost: 0,
            changePercent: 17,
          },
          {
            service: "AWS CloudTrail",
            amount: 0,
            shareOfBilledCost: 0,
            changePercent: null,
          },
        ]}
      />,
    );

    expect(cellsOf("AWS Secrets Manager")).toEqual([
      "AWS Secrets Manager",
      "< USD 0.01",
      "< 1%",
      "↑ 17%",
    ]);
    expect(screen.queryByText("AWS CloudTrail")).not.toBeInTheDocument();
    expect(screen.queryByText("USD 0.00")).not.toBeInTheDocument();
    const header = screen.getByText("Top services").closest("h2")!;
    expect(within(header).getByText("(2)")).toBeInTheDocument();
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  colorTextInteractiveDefault,
  colorTextStatusError,
  colorTextStatusWarning,
} from "@cloudscape-design/design-tokens";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";

import { LeaseBudgetTracker } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/LeaseBudgetTracker";
import type { BudgetThreshold } from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const openTracker = async () => {
  const user = userEvent.setup();
  await user.click(screen.getByRole("button", { name: /lease budget/i }));
};

describe("LeaseBudgetTracker", () => {
  it("opens lease budget progress and caller spend details", async () => {
    render(
      <LeaseBudgetTracker
        leaseCurrentSpend={125}
        maxSpend={500}
        callerEstimatedAgentSpend={3.5}
      />,
    );

    expect(screen.queryByText("Lease budget")).not.toBeInTheDocument();

    await openTracker();

    expect(screen.getByText("Lease budget")).toBeVisible();
    expect(
      screen.getByRole("progressbar", { name: "Lease budget used" }),
    ).toHaveValue(25);
    expect(screen.getByText("USD 125.00 of USD 500.00")).toBeVisible();
    expect(
      screen.getByText(
        "Your Sandbox Space has used an estimated USD 3.50 of the lease budget.",
      ),
    ).toBeVisible();
  });

  it("updates the circular indicator using reported lease thresholds", () => {
    const budgetThresholds = [
      { dollarsSpent: 30, action: "FREEZE_ACCOUNT", triggerOn: "PREDICTED" },
      { dollarsSpent: 40, action: "ALERT" },
      { dollarsSpent: 80, action: "FREEZE_ACCOUNT" },
    ] satisfies BudgetThreshold[];
    const { rerender } = render(
      <LeaseBudgetTracker
        leaseCurrentSpend={25}
        maxSpend={100}
        budgetThresholds={budgetThresholds}
      />,
    );

    const initialButton = screen.getByRole("button", {
      name: "Lease budget: 25% used",
    });
    expect(initialButton.querySelector("svg")).toHaveAttribute(
      "color",
      colorTextInteractiveDefault,
    );
    const [track, initialArc] = initialButton.querySelectorAll("circle");
    expect(track).toHaveAttribute("opacity", "0.25");
    const initialLength = Number(
      initialArc?.getAttribute("stroke-dasharray")?.split(" ")[0],
    );

    rerender(
      <LeaseBudgetTracker
        leaseCurrentSpend={50}
        maxSpend={100}
        budgetThresholds={budgetThresholds}
      />,
    );

    const updatedButton = screen.getByRole("button", {
      name: "Lease budget: 50% used",
    });
    expect(updatedButton.querySelector("svg")).toHaveAttribute(
      "color",
      colorTextStatusWarning,
    );
    const updatedArc = updatedButton.querySelectorAll("circle")[1];
    const updatedLength = Number(
      updatedArc?.getAttribute("stroke-dasharray")?.split(" ")[0],
    );
    expect(updatedLength).toBeGreaterThan(initialLength);

    rerender(
      <LeaseBudgetTracker
        leaseCurrentSpend={85}
        maxSpend={100}
        budgetThresholds={budgetThresholds}
      />,
    );

    const errorButton = screen.getByRole("button", {
      name: "Lease budget: 85% used",
    });
    expect(errorButton.querySelector("svg")).toHaveAttribute(
      "color",
      colorTextStatusError,
    );
  });

  it("caps visual progress while retaining the over-budget amount", async () => {
    render(<LeaseBudgetTracker leaseCurrentSpend={125} maxSpend={100} />);

    const trigger = screen.getByRole("button", {
      name: "Lease budget: 100% used",
    });
    expect(trigger.querySelector("svg")).toHaveAttribute(
      "color",
      colorTextStatusError,
    );

    await openTracker();

    expect(
      screen.getByRole("progressbar", { name: "Lease budget used" }),
    ).toHaveValue(100);
    expect(screen.getByText("USD 125.00 of USD 100.00")).toBeVisible();
  });

  it("shows unavailable lease spend without fabricating zero", async () => {
    const { rerender } = render(
      <LeaseBudgetTracker maxSpend={100} isAgentSpendLoading />,
    );

    await openTracker();

    expect(screen.getByText("Lease spend not available")).toBeVisible();
    expect(screen.getByText("Loading Sandbox Spaces spend")).toBeVisible();

    rerender(<LeaseBudgetTracker maxSpend={100} />);

    expect(screen.getByText("Lease spend not available")).toBeVisible();
    expect(
      screen.getByText("Your Sandbox Space spend estimate is not available."),
    ).toBeVisible();
  });

  it("shows current spend when the lease has no maximum", async () => {
    render(<LeaseBudgetTracker leaseCurrentSpend={0.004} />);

    await openTracker();

    expect(screen.getByText("< USD 0.01")).toBeVisible();
    expect(screen.getByText("No max budget")).toBeVisible();
    expect(screen.queryByRole("progressbar")).not.toBeInTheDocument();
  });
});

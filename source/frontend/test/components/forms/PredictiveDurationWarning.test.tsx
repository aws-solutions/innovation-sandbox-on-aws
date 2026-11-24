// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import {
  hoursBetween,
  PredictiveDurationWarning,
} from "@amzn/innovation-sandbox-frontend/components/Forms/PredictiveDurationWarning";

describe("PredictiveDurationWarning", () => {
  it("warns when predictive controls are on and the duration is under 48 hours", () => {
    render(
      <PredictiveDurationWarning
        predictiveBudgetEnabled={true}
        durationHours={30}
        variant="template"
      />,
    );
    expect(
      screen.getByText(/estimated-cost thresholds may never fire/i),
    ).toBeInTheDocument();
  });

  it.each([
    { variant: "lease", text: /may never fire for this lease\./ },
    { variant: "template", text: /may never fire for these leases\./ },
  ] as const)("words the warning for a $variant form", ({ variant, text }) => {
    render(
      <PredictiveDurationWarning
        predictiveBudgetEnabled={true}
        durationHours={30}
        variant={variant}
      />,
    );
    expect(screen.getByText(text)).toBeInTheDocument();
  });

  it("does not warn at 48 hours", () => {
    render(
      <PredictiveDurationWarning
        predictiveBudgetEnabled={true}
        durationHours={48}
        variant="template"
      />,
    );
    expect(
      screen.queryByText(/estimated-cost thresholds may never fire/i),
    ).not.toBeInTheDocument();
  });

  it("does not warn when predictive controls are off or duration is unknown", () => {
    const { rerender } = render(
      <PredictiveDurationWarning
        predictiveBudgetEnabled={false}
        durationHours={12}
        variant="template"
      />,
    );
    expect(
      screen.queryByText(/estimated-cost thresholds may never fire/i),
    ).not.toBeInTheDocument();

    rerender(
      <PredictiveDurationWarning
        predictiveBudgetEnabled={true}
        durationHours={undefined}
        variant="template"
      />,
    );
    expect(
      screen.queryByText(/estimated-cost thresholds may never fire/i),
    ).not.toBeInTheDocument();
  });
});

describe("hoursBetween", () => {
  it("measures hours from start to expiry", () => {
    expect(
      hoursBetween("2026-01-01T00:00:00.000Z", "2026-01-01T12:00:00.000Z"),
    ).toBe(12);
  });

  it("is undefined for missing or unparseable timestamps", () => {
    expect(hoursBetween(undefined, "2026-01-01T00:00:00.000Z")).toBeUndefined();
    expect(hoursBetween("2026-01-01T00:00:00.000Z", undefined)).toBeUndefined();
    expect(
      hoursBetween("not-a-date", "2026-01-01T00:00:00.000Z"),
    ).toBeUndefined();
  });
});

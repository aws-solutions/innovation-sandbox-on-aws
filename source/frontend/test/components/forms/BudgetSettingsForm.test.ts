// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  parseRateLimitFormRows,
  type RateLimitFormRow,
  stripTriggerOn,
  toTemplateBudgetFields,
  tryParseRateLimitFormRows,
} from "@amzn/innovation-sandbox-frontend/components/Forms/BudgetSettingsForm";
import type { RateLimitEntry } from "@amzn/innovation-sandbox-shared/types/lease-template";

describe("parseRateLimitFormRows", () => {
  it("returns undefined when there are no rows", () => {
    expect(parseRateLimitFormRows(undefined)).toBeUndefined();
    expect(parseRateLimitFormRows([])).toBeUndefined();
  });

  it("keeps each row's period, rate and action and nothing else", () => {
    const withFormState = {
      basis: "HOURLY",
      rate: 12,
      action: "FREEZE_ACCOUNT",
      id: "rhf-field-id",
    } as unknown as RateLimitFormRow;
    expect(parseRateLimitFormRows([withFormState])).toEqual([
      { basis: "HOURLY", rate: 12, action: "FREEZE_ACCOUNT" },
    ]);
  });

  it("throws on a row whose rate is still blank rather than saving or dropping it", () => {
    expect(() =>
      parseRateLimitFormRows([
        { basis: "HOURLY", rate: 12, action: "ALERT" },
        { basis: "HOURLY", rate: "", action: "ALERT" },
      ]),
    ).toThrow();
  });
});

describe("tryParseRateLimitFormRows", () => {
  it("returns the rows as saved once every row is complete", () => {
    expect(
      tryParseRateLimitFormRows([
        { basis: "DAILY", rate: 40, action: "ALERT" },
      ]),
    ).toEqual([{ basis: "DAILY", rate: 40, action: "ALERT" }]);
  });

  it("returns undefined, without throwing, while a row's rate is blank", () => {
    expect(
      tryParseRateLimitFormRows([
        { basis: "HOURLY", rate: "", action: "ALERT" },
      ]),
    ).toBeUndefined();
  });
});

describe("stripTriggerOn", () => {
  it("removes triggerOn from every threshold", () => {
    expect(
      stripTriggerOn([
        { dollarsSpent: 50, action: "ALERT", triggerOn: "PREDICTED" },
        { dollarsSpent: 75, action: "FREEZE_ACCOUNT" },
      ]),
    ).toEqual([
      { dollarsSpent: 50, action: "ALERT" },
      { dollarsSpent: 75, action: "FREEZE_ACCOUNT" },
    ]);
  });

  it("passes undefined through", () => {
    expect(stripTriggerOn(undefined)).toBeUndefined();
  });
});

describe("toTemplateBudgetFields", () => {
  const thresholds = [
    {
      dollarsSpent: 50,
      action: "ALERT" as const,
      triggerOn: "PREDICTED" as const,
    },
  ];

  const rows: RateLimitEntry[] = [
    { basis: "HOURLY", rate: 12, action: "ALERT" },
    { basis: "DAILY", rate: 200, action: "FREEZE_ACCOUNT" },
  ];

  it("keeps triggerOn and writes the rows as the rateLimits list when predictive controls are on", () => {
    expect(
      toTemplateBudgetFields({
        maxBudgetEnabled: true,
        budgetThresholds: thresholds,
        predictiveBudgetEnabled: true,
        rateLimits: rows,
      }),
    ).toEqual({
      budgetThresholds: thresholds,
      predictiveBudgetEnabled: true,
      bedrockTokenMonitoringEnabled: false,
      rateLimits: rows,
    });
  });

  it("sends an empty rateLimits list when every row was removed, so the save clears them", () => {
    const fields = toTemplateBudgetFields({
      maxBudgetEnabled: true,
      predictiveBudgetEnabled: true,
      rateLimits: [],
    });
    expect(fields).toMatchObject({ rateLimits: [] });
    expect(fields).not.toHaveProperty("rateLimit");
  });

  it("strips triggerOn and drops the rate limits when predictive controls are off", () => {
    expect(
      toTemplateBudgetFields({
        maxBudgetEnabled: true,
        budgetThresholds: thresholds,
        predictiveBudgetEnabled: false,
        rateLimits: rows,
      }),
    ).toEqual({
      budgetThresholds: [{ dollarsSpent: 50, action: "ALERT" }],
      predictiveBudgetEnabled: false,
      bedrockTokenMonitoringEnabled: false,
      rateLimits: undefined,
    });
  });

  it("treats an absent toggle value as off", () => {
    expect(
      toTemplateBudgetFields({ maxBudgetEnabled: false })
        .predictiveBudgetEnabled,
    ).toBe(false);
    expect(
      toTemplateBudgetFields({ maxBudgetEnabled: false })
        .bedrockTokenMonitoringEnabled,
    ).toBe(false);
  });

  it("saves Bedrock token monitoring as toggled, independently of predictive controls", () => {
    expect(
      toTemplateBudgetFields({
        maxBudgetEnabled: true,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: true,
      }).bedrockTokenMonitoringEnabled,
    ).toBe(true);
  });
});

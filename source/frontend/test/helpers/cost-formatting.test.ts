// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatCostAmount } from "@amzn/innovation-sandbox-frontend/helpers/cost-formatting";

describe("formatCostAmount", () => {
  it.each([
    [0, "USD 0.00"],
    [0.0001616799, "< USD 0.01"],
    [0.004999, "< USD 0.01"],
    [0.005, "USD 0.01"],
    [0.01, "USD 0.01"],
    [12.345, "USD 12.35"],
    [-0.001, "USD 0.00"],
  ])("renders %s as %s", (amount, expected) => {
    expect(formatCostAmount(amount)).toBe(expected);
  });
});

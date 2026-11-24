// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import { formatCostRate } from "@amzn/innovation-sandbox-frontend/domains/leases/components/cost-history-helpers";

describe("formatCostRate", () => {
  it("renders a sub-cent rate as under a cent per period", () => {
    expect(formatCostRate(0.0001, "hour")).toBe("< USD 0.01/hour");
  });

  it("renders a rate of a cent or more as the shared formatter does", () => {
    expect(formatCostRate(52, "day")).toBe("USD 52.00/day");
  });
});

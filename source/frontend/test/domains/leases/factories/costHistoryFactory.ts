// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { CostChartBudget } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostChart";
import {
  BedrockTokenHistoryData,
  BreachEntry,
  BreachHistoryData,
  CostHistoryCurrent,
  CostHistoryData,
  CostHistoryResultRow,
  CostSummaryData,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";

/**
 * A lease's cost data in one fixture: the mock server serves each cost route its
 * own share of it. Every list is newest first.
 */
export type LeaseHistoryFixtureData = {
  /** The cost readings. */
  result: CostHistoryResultRow[];
  tokens: TokenSeriesRow[];
  breaches: BreachEntry[];
  /** The summary's figures, absent where no reading is available. */
  current?: CostHistoryCurrent;
  /** The lease's own budget and thresholds, which no cost route returns. */
  budget: CostChartBudget;
};

export type LeaseHistoryFixture = {
  status: "success";
  data: LeaseHistoryFixtureData;
};

/** The fixture as the cost-summary route returns it. */
export const costSummaryOf = ({
  data,
}: LeaseHistoryFixture): CostSummaryData =>
  data.current === undefined ? {} : { current: data.current };

/** The fixture's cost readings, as a drain of the cost history returns them. */
export const costHistoryOf = (
  { data }: LeaseHistoryFixture,
  nextPageIdentifier: string | null = null,
): CostHistoryData => ({ result: data.result, nextPageIdentifier });

/** The fixture's token rows, as a drain of the token history returns them. */
export const bedrockTokenHistoryOf = (
  { data }: LeaseHistoryFixture,
  nextPageIdentifier: string | null = null,
): BedrockTokenHistoryData => ({ result: data.tokens, nextPageIdentifier });

/** The fixture's breaches, as a drain of the breach history returns them. */
export const breachHistoryOf = (
  { data }: LeaseHistoryFixture,
  nextPageIdentifier: string | null = null,
): BreachHistoryData => ({ result: data.breaches, nextPageIdentifier });

// Absent optional members are omitted, never null: restJson1 drops a null member.

export function createMockCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  return {
    status: "success",
    data: {
      result: [
        {
          timestamp: "2026-08-11T08:00:00.000Z",
          billedCostAccrued: 60,
          predictedCostAtRefresh: 46,
          serviceBreakdown: {
            "Amazon Bedrock": 52.1,
            "Amazon Elastic Compute Cloud - Compute": 6.4,
            "Amazon Simple Storage Service": 1.5,
          },
        },
        {
          timestamp: "2026-08-11T00:00:00.000Z",
          billedCostAccrued: 32,
          predictedCostAtRefresh: 28,
          serviceBreakdown: {
            "Amazon Bedrock": 24.6,
            "Amazon Elastic Compute Cloud - Compute": 6.2,
            "Amazon Simple Storage Service": 1.2,
          },
        },
        {
          timestamp: "2026-08-10T16:00:00.000Z",
          billedCostAccrued: 18,
          serviceBreakdown: {
            "Amazon Bedrock": 11.2,
            "Amazon Elastic Compute Cloud - Compute": 5.9,
            "Amazon Simple Storage Service": 0.9,
          },
        },
        {
          timestamp: "2026-08-10T08:00:00.000Z",
          billedCostAccrued: 8,
          serviceBreakdown: {
            "Amazon Bedrock": 2,
            "Amazon Elastic Compute Cloud - Compute": 5.2,
            "Amazon Simple Storage Service": 0.8,
          },
        },
      ],
      tokens: [],
      breaches: [
        {
          timestamp: "2026-08-11T11:00:00.000Z",
          triggeredBy: "PREDICTED",
          action: "ALERT",
          thresholdDollars: 70,
          billedCostAtFire: 60,
          predictedCostAtFire: 70.5,
          rateAtFire: 3.5,
          rateSourceAtFire: "HOURLY",
          evaluatedBy: "LEASE_MONITORING",
          insight: {
            kind: "CHANGE",
            service: "Amazon Bedrock",
            amount: 52.1,
            changePercent: 112,
          },
        },
      ],
      current: {
        billedCostAccrued: 60,
        predictedCost: 70.5,
        hourlyRate: 3.5,
        dailyRate: 52,
        hourlyRateWindowHours: 8,
        dailyRateWindowHours: 24,
        rateSource: "HOURLY",
        hoursToBudgetExhaustion: 8.4,
        latestPeriodStart: "2026-08-11",
        lastReportedAt: "2026-08-11T08:00:00.000Z",
        lastCheckedAt: "2026-08-11T11:00:00.000Z",
        services: [
          {
            service: "Amazon Bedrock",
            amount: 52.1,
            shareOfBilledCost: 0.87,
            changePercent: 112,
          },
          {
            service: "Amazon Elastic Compute Cloud - Compute",
            amount: 6.4,
            shareOfBilledCost: 0.11,
            changePercent: 3,
          },
          {
            service: "Amazon Simple Storage Service",
            amount: 1.5,
            shareOfBilledCost: 0.02,
            changePercent: 25,
          },
        ],
      },
      budget: {
        maxSpend: 100,
        thresholds: [
          { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
        ],
      },
      ...overrides,
    },
  };
}

export function createMockFirstIntervalCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  return createMockCostHistory({
    result: [
      {
        timestamp: "2026-08-10T08:00:00.000Z",
        billedCostAccrued: 8,
        serviceBreakdown: {
          "Amazon Bedrock": 2,
          "Amazon Elastic Compute Cloud - Compute": 5.2,
          "Amazon Simple Storage Service": 0.8,
        },
      },
    ],
    breaches: [],
    current: {
      billedCostAccrued: 8,
      predictedCost: 8,
      latestPeriodStart: "2026-08-10",
      lastReportedAt: "2026-08-10T08:00:00.000Z",
      lastCheckedAt: "2026-08-10T09:00:00.000Z",
      services: [
        {
          service: "Amazon Elastic Compute Cloud - Compute",
          amount: 5.2,
          shareOfBilledCost: 0.65,
        },
        { service: "Amazon Bedrock", amount: 2, shareOfBilledCost: 0.25 },
        {
          service: "Amazon Simple Storage Service",
          amount: 0.8,
          shareOfBilledCost: 0.1,
        },
      ],
    },
    ...overrides,
  });
}

export function createMockNeverOptedInCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const base = createMockCostHistory().data;
  return createMockCostHistory({
    result: base.result.map(
      ({ predictedCostAtRefresh: _dropped, ...row }) => row,
    ),
    breaches: [
      {
        timestamp: "2026-08-11T08:00:00.000Z",
        triggeredBy: "REPORTED",
        action: "ALERT",
        thresholdDollars: 50,
        billedCostAtFire: 60,
        evaluatedBy: "LEASE_MONITORING",
        insight: {
          kind: "CHANGE",
          service: "Amazon Bedrock",
          amount: 52.1,
          changePercent: 112,
        },
      },
    ],
    current: {
      billedCostAccrued: 60,
      predictedCost: 60,
      latestPeriodStart: "2026-08-11",
      lastReportedAt: "2026-08-11T08:00:00.000Z",
      lastCheckedAt: "2026-08-11T11:00:00.000Z",
      services: [
        { service: "Amazon Bedrock", amount: 52.1, shareOfBilledCost: 0.87 },
        {
          service: "Amazon Elastic Compute Cloud - Compute",
          amount: 6.4,
          shareOfBilledCost: 0.11,
        },
        {
          service: "Amazon Simple Storage Service",
          amount: 1.5,
          shareOfBilledCost: 0.02,
        },
      ],
    },
    budget: {
      maxSpend: 100,
      thresholds: [{ dollarsSpent: 50, action: "ALERT" }],
    },
    ...overrides,
  });
}

export function createMockNoBreakdownCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const base = createMockCostHistory().data;
  return createMockCostHistory({
    result: base.result.map(({ serviceBreakdown: _dropped, ...row }) => row),
    breaches: base.breaches.map(({ insight: _dropped, ...breach }) => breach),
    current: { ...base.current!, services: [] },
    ...overrides,
  });
}

export function createMockRateBreachCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const base = createMockCostHistory().data;
  return createMockCostHistory({
    breaches: [
      ...base.breaches,
      {
        timestamp: "2026-08-11T00:00:00.000Z",
        triggeredBy: "RATE",
        action: "ALERT",
        thresholdRate: 12,
        thresholdRateBasis: "HOURLY",
        billedCostAtFire: 32,
        rateAtFire: 14,
        rateSourceAtFire: "HOURLY",
        evaluatedBy: "LEASE_MONITORING",
      },
    ],
    ...overrides,
  });
}

/**
 * A lease that crossed a duration threshold, then its projected-cost threshold,
 * then reached its end. Both lease-end breaches are measured in time, so neither
 * names a dollar threshold, a projection or a rate.
 */
export function createMockLeaseEndBreachCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const base = createMockCostHistory().data;
  return createMockCostHistory({
    breaches: [
      {
        timestamp: "2026-08-11T12:00:00.000Z",
        triggeredBy: "EXPIRY",
        action: "TERMINATE",
        billedCostAtFire: 60,
        evaluatedBy: "LEASE_MONITORING",
      },
      ...base.breaches,
      {
        timestamp: "2026-08-09T12:00:00.000Z",
        triggeredBy: "DURATION",
        action: "ALERT",
        thresholdHoursRemaining: 48,
        billedCostAtFire: 4,
        evaluatedBy: "LEASE_MONITORING",
      },
    ],
    ...overrides,
  });
}

export function createMockNoCurrentCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const { current: _dropped, ...data } = createMockCostHistory().data;
  return { status: "success", data: { ...data, ...overrides } };
}

const NOVA_PRO = "amazon.nova-pro-v1:0";
const CLAUDE_HAIKU = "anthropic.claude-3-5-haiku-20241022-v1:0";

/**
 * A lease with Bedrock token monitoring on. Each reading repeats every region and
 * model counted so far with its cumulative counts, and the lease-wide
 * monitored token cost
 * repeats on every row of the reading. The 09:00 reading counted a model with no
 * price, so it carries no monitored token cost.
 */
export function createMockBedrockTokenCostHistory(
  overrides?: Partial<LeaseHistoryFixtureData>,
): LeaseHistoryFixture {
  const reading = (
    timestamp: string,
    rows: [string, string, number, number, number, number][],
    monitoredBedrockTokenCost?: number,
  ) =>
    rows.map(([region, modelId, input, output, cacheRead, cacheWrite]) => ({
      timestamp,
      region,
      modelId,
      input,
      output,
      cacheRead,
      cacheWrite,
      ...(monitoredBedrockTokenCost === undefined
        ? {}
        : { monitoredBedrockTokenCost }),
    }));
  return createMockCostHistory({
    tokens: [
      ...reading(
        "2026-08-11T11:00:00.000Z",
        [
          ["us-east-1", NOVA_PRO, 8000, 1600, 0, 0],
          ["us-east-1", CLAUDE_HAIKU, 4000, 800, 10000, 2000],
          ["us-west-2", NOVA_PRO, 2000, 300, 0, 0],
        ],
        4.25,
      ),
      ...reading(
        "2026-08-11T10:00:00.000Z",
        [
          ["us-east-1", NOVA_PRO, 6000, 1200, 0, 0],
          ["us-east-1", CLAUDE_HAIKU, 3000, 600, 8000, 1500],
          ["us-west-2", NOVA_PRO, 1000, 100, 0, 0],
        ],
        3,
      ),
      ...reading("2026-08-11T09:00:00.000Z", [
        ["us-east-1", NOVA_PRO, 4000, 800, 0, 0],
        ["us-east-1", CLAUDE_HAIKU, 2000, 400, 5000, 1000],
        ["us-west-2", NOVA_PRO, 1000, 100, 0, 0],
      ]),
      ...reading(
        "2026-08-11T08:00:00.000Z",
        [
          ["us-east-1", NOVA_PRO, 4000, 800, 0, 0],
          ["us-west-2", NOVA_PRO, 1000, 100, 0, 0],
        ],
        1.5,
      ),
      ...reading(
        "2026-08-11T07:00:00.000Z",
        [["us-east-1", NOVA_PRO, 1000, 200, 0, 0]],
        0.5,
      ),
    ],
    ...overrides,
  });
}

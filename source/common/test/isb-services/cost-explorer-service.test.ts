// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Granularity } from "@aws-sdk/client-cost-explorer";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountsCostReport,
  CostExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

vi.mock("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js", () => {
  return {
    withTemporaryCredentials: vi.fn(
      () => (originalMethod: any) => originalMethod,
    ),
  };
});

const costExplorerService = IsbServices.costExplorer({
  USER_AGENT_EXTRA: "test-agent",
});

afterEach(() => {
  vi.resetAllMocks();
  vi.useRealTimers();
});

const testAccount1 = "123456789012";
const testAccount2 = "111111111111";

describe("CostExplorerService", () => {
  describe("toCostExplorerFormat", () => {
    const testCases = [
      {
        granularity: Granularity.HOURLY,
        input: "2024-01-15T10:30:01.123Z",
        expected: "2024-01-15T10:30:01Z",
      },
      {
        granularity: Granularity.DAILY,
        input: "2024-01-15T10:30:01.123Z",
        expected: "2024-01-15",
      },
      {
        granularity: Granularity.MONTHLY,
        input: "2024-01-15T10:30:01.123Z",
        expected: "2024-01-15",
      },
    ];

    it.each<{ granularity: Granularity; input: string; expected: string }>(
      testCases,
    )(
      "formats dates correctly for" + " granularity $granularity",
      ({ granularity, input, expected }) => {
        const dateTime = DateTime.fromISO(input, { zone: "utc" });
        const result = CostExplorerService.toCostExplorerFormat(
          dateTime,
          granularity,
        );
        expect(result).toBe(expected);
      },
    );
  });

  describe("toStartOfNextPeriod", () => {
    const testCases = [
      {
        granularity: Granularity.HOURLY,
        input: "2023-12-31T10:30:01.123Z",
        expected: "2023-12-31T11:00:00.000Z",
      },
      {
        granularity: Granularity.DAILY,
        input: "2023-12-31T10:30:01.123Z",
        expected: "2024-01-01T00:00:00.000Z",
      },
      {
        granularity: Granularity.MONTHLY,
        input: "2023-11-30T10:30:01.123Z",
        expected: "2023-12-01T00:00:00.000Z",
      },
    ];
    it.each<{ granularity: Granularity; input: string; expected: string }>(
      testCases,
    )(
      "gets next start of next" +
        " period correctly for granularity $granularity",
      ({ granularity, input, expected }) => {
        const dateTime = DateTime.fromISO(input, { zone: "utc" });
        const result = CostExplorerService.toStartOfNextPeriod(
          dateTime,
          granularity,
        );
        expect(result.toISO()).toBe(expected);
      },
    );
  });

  describe("getGetCostAndUsageCommandInput", () => {
    it("creates correct command input", () => {
      const start = DateTime.fromISO("2024-01-01T00:00:00");
      const end = DateTime.fromISO("2024-01-31T23:59:59");
      const accounts = [testAccount1, testAccount2];
      const granularity = Granularity.DAILY;

      const result = costExplorerService["getGetCostAndUsageCommandInput"](
        start,
        end,
        accounts,
        granularity,
      );

      expect(result).toEqual({
        TimePeriod: {
          Start: "2024-01-01",
          End: "2024-01-31",
        },
        Granularity: Granularity.DAILY,
        Metrics: ["UnblendedCost"],
        Filter: {
          And: [
            {
              Dimensions: {
                Key: "LINKED_ACCOUNT",
                Values: accounts,
              },
            },
            {
              Not: {
                Dimensions: {
                  Key: "RECORD_TYPE",
                  Values: ["Credit", "Refund"],
                  MatchOptions: ["EQUALS"],
                },
              },
            },
          ],
        },
        GroupBy: [
          {
            Type: "DIMENSION",
            Key: "LINKED_ACCOUNT",
          },
        ],
      });
    });
  });

  describe("getCostForLeases", () => {
    const getCostResponseBase = {
      ResultsByTime: [
        {
          Groups: [
            {
              Keys: [testAccount1],
              Metrics: {
                UnblendedCost: {
                  Amount: "100.00",
                  Unit: "USD",
                },
              },
            },
            {
              Keys: [testAccount2],
              Metrics: {
                UnblendedCost: {
                  Amount: "50.00",
                  Unit: "USD",
                },
              },
            },
          ],
          TimePeriod: {
            Start: CostExplorerService.toCostExplorerFormat(
              now().minus({ days: 1 }).startOf("day"),
              Granularity.DAILY,
            ),
            End: CostExplorerService.toCostExplorerFormat(
              now().startOf("day"),
              Granularity.DAILY,
            ),
          },
        },
        {
          Groups: [
            {
              Keys: [testAccount1],
              Metrics: {
                UnblendedCost: {
                  Amount: "101.49",
                  Unit: "USD",
                },
              },
            },
            {
              Keys: [testAccount2],
              Metrics: {
                UnblendedCost: {
                  Amount: "51.59",
                  Unit: "USD",
                },
              },
            },
          ],
          TimePeriod: {
            Start: CostExplorerService.toCostExplorerFormat(
              now().minus({ days: 2 }).startOf("day"),
              Granularity.DAILY,
            ),
            End: CostExplorerService.toCostExplorerFormat(
              now().minus({ days: 1 }).startOf("day"),
              Granularity.DAILY,
            ),
          },
        },
      ],
    };

    it("returns costs for accounts all within time period", async () => {
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue(getCostResponseBase);

      const accountsWithStartDates = {
        [testAccount1]: now().minus({ days: 2 }),
        [testAccount2]: now().minus({ days: 3 }),
      };
      const end = now();

      const costCalculated = await costExplorerService.getCostForLeases(
        accountsWithStartDates,
        end,
      );
      const costExpected = new AccountsCostReport();
      costExpected.addCost(testAccount1, 201.49);
      costExpected.addCost(testAccount2, 101.59);

      expect(costExplorerService.costExplorerClient.send).toHaveBeenCalledTimes(
        1,
      );
      expect(costCalculated.costMap).toEqual(costExpected.costMap);
    });

    it("returns costs for accounts some within time period based on daily resolution", async () => {
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue(getCostResponseBase);

      const accountsWithStartDates = {
        [testAccount1]: now().minus({ days: 1 }),
        [testAccount2]: now().minus({ days: 3 }),
      };
      const end = now();

      const costCalculated = await costExplorerService.getCostForLeases(
        accountsWithStartDates,
        end,
      );
      const costExpected = new AccountsCostReport();
      costExpected.addCost(testAccount1, 100);
      costExpected.addCost(testAccount2, 101.59);

      expect(costExplorerService.costExplorerClient.send).toHaveBeenCalledTimes(
        1,
      );
      expect(costCalculated.costMap).toEqual(costExpected.costMap);
    });

    it("returns costs for accounts some within time period based on hourly resolution for the last 24 hours", async () => {
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue(getCostResponseBase);

      const accountsWithStartDates = {
        [testAccount1]: now().minus({ days: 1 }),
        [testAccount2]: now().minus({ days: 3 }),
      };
      const end = now();

      const costCalculated = await costExplorerService.getCostForLeases(
        accountsWithStartDates,
        end,
        "HOURLY",
      );
      const costExpected = new AccountsCostReport();
      costExpected.addCost(testAccount1, 100);
      costExpected.addCost(testAccount2, 101.59);

      expect(costExplorerService.costExplorerClient.send).toHaveBeenCalledTimes(
        2,
      );
      expect(costCalculated.costMap).toEqual(costExpected.costMap);
    });

    it("returns costs for accounts all within time period, with batchSize of 1", async () => {
      const { COST_EXPLORER_CONFIG, CostExplorerService } =
        await import("@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js");
      vi.spyOn(
        COST_EXPLORER_CONFIG,
        "MAX_ACCOUNTS_IN_FILTER",
        "get",
      ).mockReturnValue(1);

      const getCostResponse1 = {
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: [testAccount2],
                Metrics: {
                  UnblendedCost: {
                    Amount: "50.00",
                    Unit: "USD",
                  },
                },
              },
            ],
            TimePeriod: {
              Start: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 1 }).startOf("day"),
                Granularity.DAILY,
              ),
              End: CostExplorerService.toCostExplorerFormat(
                now().startOf("day"),
                Granularity.DAILY,
              ),
            },
          },
          {
            Groups: [
              {
                Keys: [testAccount2],
                Metrics: {
                  UnblendedCost: {
                    Amount: "51.59",
                    Unit: "USD",
                  },
                },
              },
            ],
            TimePeriod: {
              Start: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 2 }).startOf("day"),
                Granularity.DAILY,
              ),
              End: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 1 }).startOf("day"),
                Granularity.DAILY,
              ),
            },
          },
        ],
      };

      const getCostResponse2 = {
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: [testAccount1],
                Metrics: {
                  UnblendedCost: {
                    Amount: "100.00",
                    Unit: "USD",
                  },
                },
              },
            ],
            TimePeriod: {
              Start: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 1 }).startOf("day"),
                Granularity.DAILY,
              ),
              End: CostExplorerService.toCostExplorerFormat(
                now().startOf("day"),
                Granularity.DAILY,
              ),
            },
          },
          {
            Groups: [
              {
                Keys: [testAccount1],
                Metrics: {
                  UnblendedCost: {
                    Amount: "101.49",
                    Unit: "USD",
                  },
                },
              },
            ],
            TimePeriod: {
              Start: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 2 }).startOf("day"),
                Granularity.DAILY,
              ),
              End: CostExplorerService.toCostExplorerFormat(
                now().minus({ days: 1 }).startOf("day"),
                Granularity.DAILY,
              ),
            },
          },
        ],
      };

      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValueOnce(getCostResponse1)
        .mockResolvedValueOnce(getCostResponse2);

      const accountsWithStartDates = {
        [testAccount1]: now().minus({ days: 2 }),
        [testAccount2]: now().minus({ days: 3 }),
      };
      const end = now();

      const costCalculated = await costExplorerService.getCostForLeases(
        accountsWithStartDates,
        end,
      );
      const costExpected = new AccountsCostReport();
      costExpected.addCost(testAccount1, 201.49);
      costExpected.addCost(testAccount2, 101.59);

      expect(costExplorerService.costExplorerClient.send).toHaveBeenCalledTimes(
        2,
      );
      expect(costCalculated.costMap).toEqual(costExpected.costMap);
    });
  });

  describe("getDailyCostsByAccount", () => {
    it("returns daily costs for multiple accounts", async () => {
      const mockResponse = {
        ResultsByTime: [
          {
            TimePeriod: { Start: "2024-01-01", End: "2024-01-02" },
            Groups: [
              {
                Keys: [testAccount1],
                Metrics: { UnblendedCost: { Amount: "10.50", Unit: "USD" } },
              },
              {
                Keys: [testAccount2],
                Metrics: { UnblendedCost: { Amount: "5.25", Unit: "USD" } },
              },
            ],
          },
          {
            TimePeriod: { Start: "2024-01-02", End: "2024-01-03" },
            Groups: [
              {
                Keys: [testAccount1],
                Metrics: { UnblendedCost: { Amount: "12.75", Unit: "USD" } },
              },
            ],
          },
        ],
      };

      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue(mockResponse);

      const start = DateTime.fromISO("2024-01-01");
      const end = DateTime.fromISO("2024-01-03");
      const accountIds = [testAccount1, testAccount2];

      const result = await costExplorerService.getDailyCostsByAccount(
        accountIds,
        start,
        end,
      );

      expect(result).toEqual({
        [testAccount1]: {
          "2024-01-01": 10.5,
          "2024-01-02": 12.75,
        },
        [testAccount2]: {
          "2024-01-01": 5.25,
        },
      });
    });

    it("handles empty response gracefully", async () => {
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue({ ResultsByTime: [] });

      const start = DateTime.fromISO("2024-01-01");
      const end = DateTime.fromISO("2024-01-02");
      const accountIds = [testAccount1];

      const result = await costExplorerService.getDailyCostsByAccount(
        accountIds,
        start,
        end,
      );

      expect(result).toEqual({});
    });
  });
});

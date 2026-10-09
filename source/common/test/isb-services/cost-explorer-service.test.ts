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
import { toCeTagKey } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

vi.mock("@amzn/innovation-sandbox-commons/utils/cross-account-roles.js", () => {
  return {
    withTemporaryCredentials: vi.fn(
      () => (originalMethod: any) => originalMethod,
    ),
  };
});

const NAMESPACE = "myisb";
const costExplorerService = IsbServices.costExplorer({
  ISB_NAMESPACE: NAMESPACE,
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

    it("follows NextPageToken until exhausted and merges account rows when a day spans pages", async () => {
      const day = now().minus({ days: 1 }).startOf("day");
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [testAccount1],
                  Metrics: {
                    UnblendedCost: { Amount: "100.00", Unit: "USD" },
                  },
                },
              ],
              TimePeriod: {
                Start: CostExplorerService.toCostExplorerFormat(
                  day,
                  Granularity.DAILY,
                ),
                End: CostExplorerService.toCostExplorerFormat(
                  day.plus({ days: 1 }),
                  Granularity.DAILY,
                ),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [testAccount2],
                  Metrics: {
                    UnblendedCost: { Amount: "50.00", Unit: "USD" },
                  },
                },
              ],
              TimePeriod: {
                Start: CostExplorerService.toCostExplorerFormat(
                  day,
                  Granularity.DAILY,
                ),
                End: CostExplorerService.toCostExplorerFormat(
                  day.plus({ days: 1 }),
                  Granularity.DAILY,
                ),
              },
            },
          ],
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getCostForLeases(
        {
          [testAccount1]: day,
          [testAccount2]: day,
        },
        day,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[0]![0].input.NextPageToken).toBeUndefined();
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.costMap).toEqual({
        [testAccount1]: 100,
        [testAccount2]: 50,
      });
    });

    it("continues to the next page when a page has no ResultsByTime", async () => {
      const day = now().minus({ days: 1 }).startOf("day");
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [testAccount1],
                  Metrics: {
                    UnblendedCost: { Amount: "25.00", Unit: "USD" },
                  },
                },
              ],
              TimePeriod: {
                Start: CostExplorerService.toCostExplorerFormat(
                  day,
                  Granularity.DAILY,
                ),
                End: CostExplorerService.toCostExplorerFormat(
                  day.plus({ days: 1 }),
                  Granularity.DAILY,
                ),
              },
            },
          ],
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getCostForLeases(
        { [testAccount1]: day },
        day,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.getCost(testAccount1)).toBe(25);
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

  describe("getCostForLeasesByTag", () => {
    const lease1 = "lease-uuid-1";
    const lease2 = "lease-uuid-2";

    it("returns empty report and skips SDK call when no leases provided", async () => {
      const sendSpy = vi.fn();
      costExplorerService.costExplorerClient.send = sendSpy;

      const result = await costExplorerService.getCostForLeasesByTag(
        [],
        now().minus({ days: 1 }),
        now(),
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(result.costMap).toEqual({});
    });

    it("issues a GetCostAndUsage call grouped by the namespaced LeaseId tag with no Tags filter", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      const start = now().minus({ days: 3 });
      const end = now();

      await costExplorerService.getCostForLeasesByTag(
        [lease1, lease2],
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const command = sendSpy.mock.calls[0]![0];
      const input = command.input;

      expect(input.TimePeriod).toEqual({
        Start: CostExplorerService.toCostExplorerFormat(
          start,
          Granularity.DAILY,
        ),
        End: CostExplorerService.toCostExplorerFormat(
          CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
          Granularity.DAILY,
        ),
      });
      expect(input.Granularity).toBe(Granularity.DAILY);
      expect(input.Metrics).toEqual(["UnblendedCost"]);
      expect(input.GroupBy).toEqual([
        { Type: "TAG", Key: toCeTagKey(`ISB-${NAMESPACE}:LeaseId`) },
      ]);
      expect(input.Filter).toEqual({
        Not: {
          Dimensions: {
            Key: "RECORD_TYPE",
            Values: ["Credit", "Refund"],
            MatchOptions: ["EQUALS"],
          },
        },
      });
      expect(input.NextPageToken).toBeUndefined();
    });

    it("follows NextPageToken until exhausted and merges results across pages", async () => {
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                  Metrics: { UnblendedCost: { Amount: "10.00", Unit: "USD" } },
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
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                  Metrics: { UnblendedCost: { Amount: "2.50", Unit: "USD" } },
                },
                {
                  Keys: [`accountTag/ISB-myisb:LeaseId$${lease2}`],
                  Metrics: { UnblendedCost: { Amount: "7.00", Unit: "USD" } },
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
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getCostForLeasesByTag(
        [lease1, lease2],
        now().minus({ days: 3 }),
        now(),
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[0]![0].input.NextPageToken).toBeUndefined();
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.getCost(lease1)).toBeCloseTo(12.5, 2);
      expect(report.getCost(lease2)).toBeCloseTo(7, 2);
    });

    it("accumulates per-day costs keyed by lease UUID parsed from CE TAG group keys", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                Metrics: { UnblendedCost: { Amount: "10.00", Unit: "USD" } },
              },
              {
                Keys: [`accountTag/ISB-myisb:LeaseId$${lease2}`],
                Metrics: { UnblendedCost: { Amount: "5.00", Unit: "USD" } },
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
                Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                Metrics: { UnblendedCost: { Amount: "15.50", Unit: "USD" } },
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
      });

      const report = await costExplorerService.getCostForLeasesByTag(
        [lease1, lease2],
        now().minus({ days: 3 }),
        now(),
      );

      expect(report.getCost(lease1)).toBeCloseTo(25.5, 2);
      expect(report.getCost(lease2)).toBeCloseTo(5, 2);
    });

    it("omits leases whose tag did not match in CE (caller routes them to legacy fallback)", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                Metrics: { UnblendedCost: { Amount: "7.25", Unit: "USD" } },
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
        ],
      });

      const report = await costExplorerService.getCostForLeasesByTag(
        [lease1, lease2],
        now().minus({ days: 2 }),
        now(),
      );

      expect(Object.keys(report.costMap)).toEqual([lease1]);
      expect(report.costMap[lease2]).toBeUndefined();
    });

    it("ignores TAG groups with empty values and unknown lease IDs", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          {
            Groups: [
              {
                Keys: ["accountTag/ISB-myisb:LeaseId$"],
                Metrics: { UnblendedCost: { Amount: "99.99", Unit: "USD" } },
              },
              {
                Keys: ["accountTag/ISB-myisb:LeaseId$some-other-uuid"],
                Metrics: { UnblendedCost: { Amount: "42.00", Unit: "USD" } },
              },
              {
                Keys: [`accountTag/ISB-myisb:LeaseId$${lease1}`],
                Metrics: { UnblendedCost: { Amount: "1.00", Unit: "USD" } },
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
        ],
      });

      const report = await costExplorerService.getCostForLeasesByTag(
        [lease1],
        now().minus({ days: 1 }),
        now(),
      );

      expect(report.costMap).toEqual({ [lease1]: 1 });
    });

    it("returns an empty report when CE returns no ResultsByTime", async () => {
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue({ ResultsByTime: [] });

      const report = await costExplorerService.getCostForLeasesByTag(
        [lease1],
        now().minus({ days: 1 }),
        now(),
      );

      expect(report.costMap).toEqual({});
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

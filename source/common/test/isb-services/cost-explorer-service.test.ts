// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Granularity } from "@aws-sdk/client-cost-explorer";
import { DateTime } from "luxon";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  AccountsCostReport,
  BEDROCK_SERVICE_KEY,
  COST_EXPLORER_CONFIG,
  CostExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
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
  vi.restoreAllMocks();
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

  describe("getDailyCostForLeasesByTag", () => {
    const lease1 = { uuid: "lease-uuid-1", awsAccountId: testAccount1 };
    const lease2 = { uuid: "lease-uuid-2", awsAccountId: testAccount2 };
    const start = DateTime.fromISO("2026-08-09", { zone: "utc" });
    const end = DateTime.fromISO("2026-08-11T10:00:00Z", { zone: "utc" });
    const leaseTagKey = `accountTag/ISB-${NAMESPACE}:LeaseId`;

    const tagGroup = (leaseUuid: string, amount: string, service?: string) => ({
      Keys:
        service === undefined
          ? [`${leaseTagKey}$${leaseUuid}`]
          : [`${leaseTagKey}$${leaseUuid}`, service],
      Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } },
    });
    const dayResult = (day: string, groups: unknown[]) => ({
      TimePeriod: {
        Start: day,
        End: DateTime.fromISO(day, { zone: "utc" })
          .plus({ days: 1 })
          .toFormat("yyyy-MM-dd"),
      },
      Groups: groups,
    });

    it("returns an empty report and skips the SDK call when no leases are given", async () => {
      const sendSpy = vi.fn();
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(report.buckets).toEqual({});
      expect(report.latestPeriodStart).toEqual({});
    });

    it("filters to the leases' accounts and groups by tag and service when the breakdown is on", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getDailyCostForLeasesByTag(
        [lease1, lease2],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const input = sendSpy.mock.calls[0]![0].input;
      expect(input.TimePeriod).toEqual({
        Start: "2026-08-09",
        End: "2026-08-12",
      });
      expect(input.Granularity).toBe(Granularity.DAILY);
      expect(input.Metrics).toEqual(["UnblendedCost"]);
      expect(input.Filter).toEqual({
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: [testAccount1, testAccount2],
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
      });
      expect(input.GroupBy).toEqual([
        { Type: "TAG", Key: toCeTagKey(`ISB-${NAMESPACE}:LeaseId`) },
        { Type: "DIMENSION", Key: "SERVICE" },
      ]);
      expect(input.NextPageToken).toBeUndefined();
    });

    it("sends a single tag GroupBy and no service amounts when the breakdown is off", async () => {
      const sendSpy = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [tagGroup(lease1.uuid, "4.00")]),
        ],
      });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1],
        start,
        end,
        { includeServiceBreakdown: false },
      );

      const input = sendSpy.mock.calls[0]![0].input;
      expect(input.GroupBy).toEqual([
        { Type: "TAG", Key: toCeTagKey(`ISB-${NAMESPACE}:LeaseId`) },
      ]);
      expect(input.Filter.And[0]).toEqual({
        Dimensions: { Key: "LINKED_ACCOUNT", Values: [testAccount1] },
      });
      expect(report.buckets[lease1.uuid]).toEqual({
        "2026-08-10": { amount: 4 },
      });
      expect(report.buckets[lease1.uuid]!["2026-08-10"]).not.toHaveProperty(
        "serviceAmounts",
      );
    });

    it("buckets cost per lease per day and records each lease's newest period start", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-09", [
            tagGroup(lease1.uuid, "10.00", "Amazon Simple Storage Service"),
            tagGroup(lease2.uuid, "5.00", "Amazon Simple Storage Service"),
          ]),
          dayResult("2026-08-10", [
            tagGroup(lease1.uuid, "2.50", "Amazon Simple Storage Service"),
            tagGroup(
              lease1.uuid,
              "1.50",
              "Amazon Elastic Compute Cloud - Compute",
            ),
          ]),
          dayResult("2026-08-11", [
            tagGroup(lease1.uuid, "0.25", "Amazon Simple Storage Service"),
          ]),
        ],
      });

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1, lease2],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(report.buckets[lease1.uuid]).toEqual({
        "2026-08-09": {
          amount: 10,
          serviceAmounts: { "Amazon Simple Storage Service": 10 },
        },
        "2026-08-10": {
          amount: 4,
          serviceAmounts: {
            "Amazon Simple Storage Service": 2.5,
            "Amazon Elastic Compute Cloud - Compute": 1.5,
          },
        },
        "2026-08-11": {
          amount: 0.25,
          serviceAmounts: { "Amazon Simple Storage Service": 0.25 },
        },
      });
      expect(report.buckets[lease2.uuid]).toEqual({
        "2026-08-09": {
          amount: 5,
          serviceAmounts: { "Amazon Simple Storage Service": 5 },
        },
      });
      expect(report.latestPeriodStart).toEqual({
        [lease1.uuid]: "2026-08-11",
        [lease2.uuid]: "2026-08-09",
      });
    });

    it("follows NextPageToken until exhausted and merges pages into the same buckets", async () => {
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            dayResult("2026-08-10", [
              tagGroup(lease1.uuid, "10.00", "Amazon Simple Storage Service"),
            ]),
            dayResult("2026-08-11", [
              tagGroup(lease1.uuid, "0.50", "Amazon Simple Storage Service"),
            ]),
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            // An earlier day arriving on a later page must not win.
            dayResult("2026-08-10", [
              tagGroup(lease1.uuid, "2.50", "AWS Lambda"),
            ]),
            dayResult("2026-08-11", [
              tagGroup(lease2.uuid, "7.00", "AWS Lambda"),
            ]),
          ],
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1, lease2],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[0]![0].input.NextPageToken).toBeUndefined();
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.buckets[lease1.uuid]!["2026-08-10"]).toEqual({
        amount: 12.5,
        serviceAmounts: {
          "Amazon Simple Storage Service": 10,
          "AWS Lambda": 2.5,
        },
      });
      expect(report.buckets[lease2.uuid]!["2026-08-11"]!.amount).toBe(7);
      expect(report.latestPeriodStart).toEqual({
        [lease1.uuid]: "2026-08-11",
        [lease2.uuid]: "2026-08-11",
      });
    });

    it("collapses every Bedrock service line into one Amazon Bedrock key", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            tagGroup(lease1.uuid, "30.00", "Amazon Bedrock"),
            tagGroup(lease1.uuid, "20.00", "Amazon Bedrock Service"),
            tagGroup(lease1.uuid, "2.10", "Amazon Bedrock AgentCore"),
            tagGroup(
              lease1.uuid,
              "4.00",
              "Claude Sonnet 4 (Amazon Bedrock Edition)",
            ),
            tagGroup(
              lease1.uuid,
              "6.40",
              "Amazon Elastic Compute Cloud - Compute",
            ),
          ]),
        ],
      });

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      const bucket = report.buckets[lease1.uuid]!["2026-08-10"]!;
      expect(bucket.serviceAmounts).toEqual({
        [BEDROCK_SERVICE_KEY]: 56.1,
        "Amazon Elastic Compute Cloud - Compute": 6.4,
      });
      expect(bucket.amount).toBeCloseTo(62.5, 6);
    });

    it("chunks the account filter to the Cost Explorer limit and scopes each chunk to its own leases", async () => {
      const chunkSize = COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER;
      const leases = Array.from({ length: chunkSize + 1 }, (_, i) => ({
        uuid: `lease-${i}`,
        awsAccountId: String(100000000000 + i),
      }));
      const firstChunkLease = leases[0]!;
      const secondChunkLease = leases[chunkSize]!;
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          ResultsByTime: [
            dayResult("2026-08-10", [tagGroup(firstChunkLease.uuid, "1.00")]),
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            dayResult("2026-08-10", [
              tagGroup(secondChunkLease.uuid, "2.00"),
              // A lease from another chunk cannot be attributed by this request.
              tagGroup(firstChunkLease.uuid, "99.00"),
            ]),
          ],
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        leases,
        start,
        end,
        { includeServiceBreakdown: false },
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      const accountsOf = (call: number) =>
        sendSpy.mock.calls[call]![0].input.Filter.And[0].Dimensions.Values;
      expect(accountsOf(0)).toHaveLength(chunkSize);
      expect(accountsOf(1)).toEqual([secondChunkLease.awsAccountId]);
      expect(report.buckets[firstChunkLease.uuid]).toEqual({
        "2026-08-10": { amount: 1 },
      });
      expect(report.buckets[secondChunkLease.uuid]).toEqual({
        "2026-08-10": { amount: 2 },
      });
    });

    it("ignores tag groups with empty values and lease IDs that were not asked for", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            tagGroup("", "99.99", "AWS Lambda"),
            tagGroup("some-other-uuid", "42.00", "AWS Lambda"),
            tagGroup(lease1.uuid, "1.00", "AWS Lambda"),
          ]),
        ],
      });

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(Object.keys(report.buckets)).toEqual([lease1.uuid]);
      expect(report.buckets[lease1.uuid]!["2026-08-10"]!.amount).toBe(1);
      expect(report.latestPeriodStart).toEqual({ [lease1.uuid]: "2026-08-10" });
    });

    it("does not warn when a later page is empty but an earlier one carried results", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            dayResult("2026-08-10", [tagGroup(lease1.uuid, "10.00")]),
          ],
        })
        .mockResolvedValueOnce({ ResultsByTime: [] });

      await costExplorerService.getDailyCostForLeasesByTag(
        [lease1],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it("returns an empty report and warns once when Cost Explorer returns no ResultsByTime", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue({ ResultsByTime: [] });

      const report = await costExplorerService.getDailyCostForLeasesByTag(
        [lease1],
        start,
        end,
        { includeServiceBreakdown: true },
      );

      expect(report.buckets).toEqual({});
      expect(report.latestPeriodStart).toEqual({});
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        "No cost data available",
        { start: "2026-08-09", end: "2026-08-12", leaseCount: 1 },
      );
    });
  });

  describe("getBedrockTokenCostByLease", () => {
    const lease1 = { uuid: "lease-uuid-1", awsAccountId: testAccount1 };
    const lease2 = { uuid: "lease-uuid-2", awsAccountId: testAccount2 };
    const start = DateTime.fromISO("2026-08-09", { zone: "utc" });
    const end = DateTime.fromISO("2026-08-11T10:00:00Z", { zone: "utc" });
    const leaseTagKey = `accountTag/ISB-${NAMESPACE}:LeaseId`;

    const usageGroup = (
      leaseUuid: string,
      usageType: string,
      cost: string,
      quantity: string,
      unit: string,
    ) => ({
      Keys: [`${leaseTagKey}$${leaseUuid}`, usageType],
      Metrics: {
        UnblendedCost: { Amount: cost, Unit: "USD" },
        UsageQuantity: { Amount: quantity, Unit: unit },
      },
    });
    const dayResult = (day: string, groups: unknown[]) => ({
      TimePeriod: {
        Start: day,
        End: DateTime.fromISO(day, { zone: "utc" })
          .plus({ days: 1 })
          .toFormat("yyyy-MM-dd"),
      },
      Groups: groups,
    });

    it("treats no token spend as the normal case, with no warning", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValue({ ResultsByTime: [] });

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [lease1],
        start,
        end,
      );

      expect(report.costByDay(lease1.uuid)).toEqual({});
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it("returns an empty report and skips the SDK call when no leases are given", async () => {
      const sendSpy = vi.fn();
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [],
        start,
        end,
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(report.costByDay(lease1.uuid)).toEqual({});
    });

    it("filters to the Bedrock service lines and the leases' accounts, grouped by tag and usage type with both metrics", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getBedrockTokenCostByLease(
        [lease1, lease2],
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const input = sendSpy.mock.calls[0]![0].input;
      expect(input.TimePeriod).toEqual({
        Start: "2026-08-09",
        End: "2026-08-12",
      });
      expect(input.Granularity).toBe(Granularity.DAILY);
      expect(input.Metrics).toEqual(["UnblendedCost", "UsageQuantity"]);
      expect(input.Filter).toEqual({
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: [testAccount1, testAccount2],
            },
          },
          {
            Dimensions: {
              Key: "SERVICE",
              Values: [
                "Amazon Bedrock",
                "Amazon Bedrock Service",
                "Amazon Bedrock AgentCore",
              ],
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
      });
      expect(input.GroupBy).toEqual([
        { Type: "TAG", Key: toCeTagKey(`ISB-${NAMESPACE}:LeaseId`) },
        { Type: "DIMENSION", Key: "USAGE_TYPE" },
      ]);
      expect(input.NextPageToken).toBeUndefined();
    });

    it("classifies token-priced usage on the quantity unit and sums the token lines whichever service line billed them", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            // Nova, billed under Amazon Bedrock
            usageGroup(
              lease1.uuid,
              "USE1-NovaPro-input-tokens",
              "0.0096",
              "12",
              "1K tokens",
            ),
            // Claude, billed under Amazon Bedrock Service
            usageGroup(
              lease1.uuid,
              "USW2-anthropic.claude-opus-5-mantle-output-tokens-global-standard",
              "4.7126",
              "188.504",
              "1K tokens",
            ),
            // Non-token Bedrock charges, whatever their names say
            usageGroup(
              lease1.uuid,
              "USE1-Memory:Consumption-based:LTM-Storage:Built-in-memory",
              "0.009",
              "8928",
              "MemoryStored-Hour",
            ),
            usageGroup(
              lease1.uuid,
              "USE1-NovaCanvas-input-tokens-lookalike",
              "5.00",
              "10",
              "image",
            ),
            usageGroup(
              lease1.uuid,
              "USE1-ProvisionedThroughput",
              "20.00",
              "1",
              "hour",
            ),
          ]),
        ],
      });

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [lease1],
        start,
        end,
      );

      expect(report.costByDay(lease1.uuid)["2026-08-10"]).toBeCloseTo(
        4.7222,
        6,
      );
      expect(report.unclassifiedUsageTypes.size).toBe(0);
    });

    it("names a token line whose unit is missing rather than dropping it", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup(
              lease1.uuid,
              "USE1-NovaPro-input-tokens",
              "1",
              "1",
              "N/A",
            ),
            {
              Keys: [
                `${leaseTagKey}$${lease1.uuid}`,
                "USE1-NovaPro-output-tokens",
              ],
              Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } },
            },
          ]),
        ],
      });

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [lease1],
        start,
        end,
      );

      expect(report.costByDay(lease1.uuid)).toEqual({});
      expect([...report.unclassifiedUsageTypes].sort()).toEqual([
        "USE1-NovaPro-input-tokens",
        "USE1-NovaPro-output-tokens",
      ]);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          LogPatterns.BedrockUsageTypeUnclassified.pattern,
        ),
        {
          usageTypes: expect.arrayContaining([
            "USE1-NovaPro-input-tokens",
            "USE1-NovaPro-output-tokens",
          ]),
        },
      );
    });

    it("sums every token-unit line whatever its name or unit spelling, with no list to maintain", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup(
              lease1.uuid,
              "USE1-NovaPro-input-tokens",
              "1.00",
              "1000",
              "1K tokens",
            ),
            // a unit spelled without a multiplier
            usageGroup(
              lease1.uuid,
              "USE1-NovaPro-output-tokens",
              "2.00",
              "2000",
              "tokens",
            ),
            // a name no parser has seen
            usageGroup(
              lease1.uuid,
              "USE1-SomeNewFamily-tokens-v2",
              "5.00",
              "10",
              "1M tokens",
            ),
          ]),
          dayResult("2026-08-11", [
            usageGroup(
              lease1.uuid,
              "USE1-SomeNewFamily-tokens-v2",
              "6.00",
              "12",
              "1M tokens",
            ),
          ]),
        ],
      });

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [lease1],
        start,
        end,
      );

      expect(report.costByDay(lease1.uuid)).toEqual({
        "2026-08-10": 8,
        "2026-08-11": 6,
      });
      expect(report.unclassifiedUsageTypes.size).toBe(0);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it("fails on a non-numeric amount rather than poisoning the totals", async () => {
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup(
              lease1.uuid,
              "USE1-NovaPro-input-tokens",
              "n/a",
              "1000",
              "1K tokens",
            ),
          ]),
        ],
      });

      await expect(
        costExplorerService.getBedrockTokenCostByLease([lease1], start, end),
      ).rejects.toThrow(
        "Cost Explorer returned a non-numeric amount for USE1-NovaPro-input-tokens on 2026-08-10: n/a",
      );

      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            {
              Keys: [
                `${leaseTagKey}$${lease1.uuid}`,
                "USE1-NovaPro-input-tokens",
              ],
              Metrics: { UsageQuantity: { Amount: "12", Unit: "1K tokens" } },
            },
          ]),
        ],
      });
      await expect(
        costExplorerService.getBedrockTokenCostByLease([lease1], start, end),
      ).rejects.toThrow(
        "Cost Explorer returned a non-numeric amount for USE1-NovaPro-input-tokens on 2026-08-10: undefined",
      );
    });

    it("follows NextPageToken to exhaustion and totals a usage type across days and pages", async () => {
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            dayResult("2026-08-10", [
              usageGroup(
                lease1.uuid,
                "USE1-NovaPro-input-tokens",
                "1.00",
                "1000",
                "1K tokens",
              ),
            ]),
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            dayResult("2026-08-11", [
              usageGroup(
                lease1.uuid,
                "USE1-NovaPro-input-tokens",
                "0.50",
                "500",
                "1K tokens",
              ),
              usageGroup(
                lease2.uuid,
                "USE1-NovaPro-input-tokens",
                "7.00",
                "7000",
                "1K tokens",
              ),
            ]),
          ],
        });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getBedrockTokenCostByLease(
        [lease1, lease2],
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.costByDay(lease1.uuid)).toEqual({
        "2026-08-10": 1,
        "2026-08-11": 0.5,
      });
      expect(report.costByDay(lease2.uuid)).toEqual({ "2026-08-11": 7 });
    });

    it("chunks the account filter to the Cost Explorer limit and ignores leases that were not asked for", async () => {
      const chunkSize = COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER;
      const leases = Array.from({ length: chunkSize + 1 }, (_, i) => ({
        uuid: `lease-${i}`,
        awsAccountId: String(100000000000 + i),
      }));
      const sendSpy = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup("", "USE1-NovaPro-input-tokens", "9", "9", "1K tokens"),
            usageGroup(
              "some-other-uuid",
              "USE1-NovaPro-input-tokens",
              "9",
              "9",
              "1K tokens",
            ),
          ]),
        ],
      });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getBedrockTokenCostByLease(
        leases,
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      const accountsOf = (call: number) =>
        sendSpy.mock.calls[call]![0].input.Filter.And[0].Dimensions.Values;
      expect(accountsOf(0)).toHaveLength(chunkSize);
      expect(accountsOf(1)).toEqual([leases[chunkSize]!.awsAccountId]);
      expect(report.costByDay("some-other-uuid")).toEqual({});
      expect(report.costByDay(leases[0]!.uuid)).toEqual({});
    });
  });

  describe("getBedrockTokenCostByAccount", () => {
    const start = DateTime.fromISO("2026-08-09", { zone: "utc" });
    const end = DateTime.fromISO("2026-08-11T10:00:00Z", { zone: "utc" });

    const usageGroup = (
      accountId: string,
      usageType: string,
      cost: string,
      quantity: string,
      unit: string,
    ) => ({
      Keys: [accountId, usageType],
      Metrics: {
        UnblendedCost: { Amount: cost, Unit: "USD" },
        UsageQuantity: { Amount: quantity, Unit: unit },
      },
    });
    const dayResult = (day: string, groups: unknown[]) => ({
      TimePeriod: {
        Start: day,
        End: DateTime.fromISO(day, { zone: "utc" })
          .plus({ days: 1 })
          .toFormat("yyyy-MM-dd"),
      },
      Groups: groups,
    });

    it("returns an empty report and skips the SDK call when no accounts are given", async () => {
      const sendSpy = vi.fn();
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getBedrockTokenCostByAccount(
        [],
        start,
        end,
      );

      expect(sendSpy).not.toHaveBeenCalled();
      expect(report.costByDay(testAccount1)).toEqual({});
    });

    it("sends the tag query's filters and metrics, grouped by account and usage type, once per account", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getBedrockTokenCostByAccount(
        [testAccount1, testAccount2, testAccount1],
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(1);
      const input = sendSpy.mock.calls[0]![0].input;
      expect(input.TimePeriod).toEqual({
        Start: "2026-08-09",
        End: "2026-08-12",
      });
      expect(input.Granularity).toBe(Granularity.DAILY);
      expect(input.Metrics).toEqual(["UnblendedCost", "UsageQuantity"]);
      expect(input.Filter).toEqual({
        And: [
          {
            Dimensions: {
              Key: "LINKED_ACCOUNT",
              Values: [testAccount1, testAccount2],
            },
          },
          {
            Dimensions: {
              Key: "SERVICE",
              Values: [
                "Amazon Bedrock",
                "Amazon Bedrock Service",
                "Amazon Bedrock AgentCore",
              ],
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
      });
      expect(input.GroupBy).toEqual([
        { Type: "DIMENSION", Key: "LINKED_ACCOUNT" },
        { Type: "DIMENSION", Key: "USAGE_TYPE" },
      ]);
    });

    it("sums the token-unit lines per account and day, ignoring non-token units and accounts that were not asked for", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup(
              testAccount1,
              "USE1-NovaPro-input-tokens",
              "1.00",
              "1000",
              "1K tokens",
            ),
            usageGroup(
              testAccount1,
              "USW2-anthropic.claude-opus-5-mantle-output-tokens-global-standard",
              "2.50",
              "100",
              "1K tokens",
            ),
            usageGroup(
              testAccount1,
              "USE1-ProvisionedThroughput",
              "20.00",
              "1",
              "hour",
            ),
            usageGroup(
              testAccount2,
              "USE1-NovaPro-input-tokens",
              "4.00",
              "4000",
              "1K tokens",
            ),
            usageGroup(
              "999999999999",
              "USE1-NovaPro-input-tokens",
              "9.00",
              "9000",
              "1K tokens",
            ),
          ]),
          dayResult("2026-08-11", [
            usageGroup(
              testAccount1,
              "USE1-NovaPro-output-tokens",
              "0.50",
              "500",
              "tokens",
            ),
          ]),
        ],
      });

      const report = await costExplorerService.getBedrockTokenCostByAccount(
        [testAccount1, testAccount2],
        start,
        end,
      );

      expect(report.costByDay(testAccount1)).toEqual({
        "2026-08-10": 3.5,
        "2026-08-11": 0.5,
      });
      expect(report.costByDay(testAccount2)).toEqual({ "2026-08-10": 4 });
      expect(report.costByDay("999999999999")).toEqual({});
      expect(report.unclassifiedUsageTypes.size).toBe(0);
      expect(Logger.prototype.warn).not.toHaveBeenCalled();
    });

    it("names a line whose unit is missing in one warning rather than dropping it", async () => {
      vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
      costExplorerService.costExplorerClient.send = vi.fn().mockResolvedValue({
        ResultsByTime: [
          dayResult("2026-08-10", [
            usageGroup(
              testAccount1,
              "USE1-NovaPro-input-tokens",
              "1",
              "1",
              "N/A",
            ),
            {
              Keys: [testAccount1, "USE1-NovaPro-output-tokens"],
              Metrics: { UnblendedCost: { Amount: "1", Unit: "USD" } },
            },
          ]),
        ],
      });

      const report = await costExplorerService.getBedrockTokenCostByAccount(
        [testAccount1],
        start,
        end,
      );

      expect(report.costByDay(testAccount1)).toEqual({});
      expect([...report.unclassifiedUsageTypes].sort()).toEqual([
        "USE1-NovaPro-input-tokens",
        "USE1-NovaPro-output-tokens",
      ]);
      expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        expect.stringContaining(
          LogPatterns.BedrockUsageTypeUnclassified.pattern,
        ),
        {
          usageTypes: expect.arrayContaining([
            "USE1-NovaPro-input-tokens",
            "USE1-NovaPro-output-tokens",
          ]),
        },
      );
    });

    it("chunks the account filter to the Cost Explorer limit", async () => {
      const chunkSize = COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER;
      const accountIds = Array.from({ length: chunkSize + 1 }, (_, i) =>
        String(100000000000 + i),
      );
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getBedrockTokenCostByAccount(
        accountIds,
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      const accountsOf = (call: number) =>
        sendSpy.mock.calls[call]![0].input.Filter.And[0].Dimensions.Values;
      expect(accountsOf(0)).toHaveLength(chunkSize);
      expect(accountsOf(1)).toEqual([accountIds[chunkSize]]);
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

  describe("inclusive end dates", () => {
    const startOfMonth = DateTime.fromISO("2026-09-01T00:00:00", {
      zone: "utc",
    });
    const endOfMonth = startOfMonth.endOf("month");
    const periodOf = (sendSpy: ReturnType<typeof vi.fn>) =>
      sendSpy.mock.calls[0]![0].input.TimePeriod;

    it("getCostForRange includes the last day of the range", async () => {
      const sendSpy = vi.fn().mockResolvedValue({
        ResultsByTime: [
          {
            TimePeriod: { Start: "2026-09-30", End: "2026-10-01" },
            Groups: [
              {
                Keys: [testAccount1],
                Metrics: { UnblendedCost: { Amount: "8.68", Unit: "USD" } },
              },
            ],
          },
        ],
      });
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getCostForRange(
        startOfMonth,
        endOfMonth,
        { [testAccount1]: startOfMonth },
      );

      expect(periodOf(sendSpy)).toEqual({
        Start: "2026-09-01",
        End: "2026-10-01",
      });
      expect(report.totalCost()).toBeCloseTo(8.68);
    });

    it("getCostForRange includes the last day when filtering by tag", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getCostForRange(
        startOfMonth,
        endOfMonth,
        { [testAccount1]: startOfMonth },
        { tagName: "aws-solutions:isb-id", tagValues: ["test"] },
      );

      expect(periodOf(sendSpy)).toEqual({
        Start: "2026-09-01",
        End: "2026-10-01",
      });
    });

    it("getDailyCostsByAccount includes the last day of the range", async () => {
      const sendSpy = vi.fn().mockResolvedValue({ ResultsByTime: [] });
      costExplorerService.costExplorerClient.send = sendSpy;

      await costExplorerService.getDailyCostsByAccount(
        [testAccount1],
        startOfMonth,
        endOfMonth,
      );

      expect(periodOf(sendSpy)).toEqual({
        Start: "2026-09-01",
        End: "2026-10-01",
      });
    });
  });

  describe("monthly cost query pagination", () => {
    const start = DateTime.fromISO("2026-09-01T00:00:00", { zone: "utc" });
    const end = start.endOf("month");
    const dayResult = (day: string, accountId: string, amount: string) => ({
      TimePeriod: { Start: day, End: day },
      Groups: [
        {
          Keys: [accountId],
          Metrics: { UnblendedCost: { Amount: amount, Unit: "USD" } },
        },
      ],
    });
    const twoPages = () =>
      vi
        .fn()
        .mockResolvedValueOnce({
          ResultsByTime: [dayResult("2026-09-01", testAccount1, "1.50")],
          NextPageToken: "page-2",
        })
        .mockResolvedValueOnce({
          ResultsByTime: [dayResult("2026-09-30", testAccount2, "2.25")],
        });

    it("getCostForRange follows NextPageToken", async () => {
      const sendSpy = twoPages();
      costExplorerService.costExplorerClient.send = sendSpy;

      const report = await costExplorerService.getCostForRange(start, end, {
        [testAccount1]: start,
        [testAccount2]: start,
      });

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(report.totalCost()).toBeCloseTo(3.75);
    });

    it("getDailyCostsByAccount follows NextPageToken", async () => {
      const sendSpy = twoPages();
      costExplorerService.costExplorerClient.send = sendSpy;

      const result = await costExplorerService.getDailyCostsByAccount(
        [testAccount1, testAccount2],
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(result).toEqual({
        [testAccount1]: { "2026-09-01": 1.5 },
        [testAccount2]: { "2026-09-30": 2.25 },
      });
    });
  });

  describe("getDailyCostsByAccount batch failures", () => {
    it("throws when any account batch fails", async () => {
      const chunkSize = COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER;
      const accountIds = Array.from({ length: chunkSize + 1 }, (_, i) =>
        String(100000000000 + i),
      );
      costExplorerService.costExplorerClient.send = vi
        .fn()
        .mockResolvedValueOnce({ ResultsByTime: [] })
        .mockRejectedValueOnce(new Error("ThrottlingException"));

      await expect(
        costExplorerService.getDailyCostsByAccount(
          accountIds,
          DateTime.fromISO("2026-09-01T00:00:00", { zone: "utc" }),
          DateTime.fromISO("2026-09-30T23:59:59", { zone: "utc" }),
        ),
      ).rejects.toThrow("Failed to get daily costs for 1 of 2 account batches");
    });
  });

  describe("getDailyCostsByAccount rate limiting", () => {
    const start = DateTime.fromISO("2026-09-01T00:00:00", { zone: "utc" });
    const end = start.endOf("month");
    const accountIds = Array.from(
      { length: COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER + 1 },
      (_, i) => String(100000000000 + i),
    );
    // Two pages per account batch, keyed by the batch's first account.
    const pagedSend = () =>
      vi.fn().mockImplementation(async (command) => {
        const first: string = command.input.Filter.And[0].Dimensions.Values[0];
        const page2 = command.input.NextPageToken === `${first}-2`;
        return {
          ResultsByTime: [
            {
              TimePeriod: { Start: page2 ? "2026-09-30" : "2026-09-01" },
              Groups: [
                {
                  Keys: [first],
                  Metrics: {
                    UnblendedCost: { Amount: page2 ? "2" : "1", Unit: "USD" },
                  },
                },
              ],
            },
          ],
          NextPageToken: page2 ? undefined : `${first}-2`,
        };
      });

    afterEach(() => {
      vi.useRealTimers();
    });

    it("follows every page of every account batch", async () => {
      const sendSpy = pagedSend();
      costExplorerService.costExplorerClient.send = sendSpy;

      const result = await costExplorerService.getDailyCostsByAccount(
        accountIds,
        start,
        end,
      );

      expect(sendSpy).toHaveBeenCalledTimes(4);
      const last = accountIds[accountIds.length - 1]!;
      expect(result).toEqual({
        [accountIds[0]!]: { "2026-09-01": 1, "2026-09-30": 2 },
        [last]: { "2026-09-01": 1, "2026-09-30": 2 },
      });
    });

    it("rate-limits page requests, not just batches", async () => {
      vi.useFakeTimers();
      const sendSpy = pagedSend();
      costExplorerService.costExplorerClient.send = sendSpy;

      const request = costExplorerService.getDailyCostsByAccount(
        accountIds,
        start,
        end,
        1,
      );

      await vi.advanceTimersByTimeAsync(0);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(999);
      expect(sendSpy).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(3000);
      expect(sendSpy).toHaveBeenCalledTimes(4);
      await request;
    });
  });
});

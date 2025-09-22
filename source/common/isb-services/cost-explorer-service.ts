// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
  Granularity,
  ResultByTime,
} from "@aws-sdk/client-cost-explorer";
import { DateTime } from "luxon";
import { DateTimeUnit } from "luxon/src/datetime.js";

const logger = new Logger();
export const COST_EXPLORER_CONFIG = {
  MAX_ACCOUNTS_IN_FILTER: 199,
  MAX_DAYS_FOR_HOURLY: 14,
};

export class AccountsCostReport {
  readonly costMap: Record<string, number>;

  constructor() {
    this.costMap = {};
  }
  public addCost(accountId: string, toAdd: number) {
    if (this.costMap[accountId]) {
      this.costMap[accountId] = this.costMap[accountId] + toAdd;
    } else {
      this.costMap[accountId] = toAdd;
    }
  }
  public getCost(accountId: string): number {
    return this.costMap[accountId] ?? 0;
  }
  public merge(accountsCost: AccountsCostReport) {
    for (const [key, value] of Object.entries(accountsCost.costMap)) {
      this.addCost(key, value);
    }
  }

  public totalCost() {
    return Object.entries(this.costMap).reduce((acc, [_, value]) => {
      return acc + value;
    }, 0);
  }
}

function* batch<T>(
  array: T[],
  size: number = COST_EXPLORER_CONFIG.MAX_ACCOUNTS_IN_FILTER,
): Generator<T[]> {
  for (let i = 0; i < array.length; i += size) {
    yield array.slice(i, i + size);
  }
}

export class CostExplorerService {
  readonly costExplorerClient: CostExplorerClient;

  constructor(props: { costExplorerClient: CostExplorerClient }) {
    this.costExplorerClient = props.costExplorerClient;
  }

  static toCostExplorerFormat(dt: DateTime, granularity: Granularity): string {
    switch (granularity) {
      case Granularity.HOURLY:
        return dt.toFormat("yyyy-MM-dd'T'HH:mm:ss'Z'");
      case Granularity.DAILY:
        return dt.toFormat("yyyy-MM-dd");
      case Granularity.MONTHLY:
        return dt.toFormat("yyyy-MM-dd");
    }
  }

  static toStartOfNextPeriod(dt: DateTime, granularity: Granularity): DateTime {
    switch (granularity) {
      case Granularity.HOURLY:
        return dt.plus({ hours: 1 }).startOf("hour");
      case Granularity.DAILY:
        return dt.plus({ days: 1 }).startOf("day");
      case Granularity.MONTHLY:
        return dt.plus({ months: 1 }).startOf("month");
    }
  }

  private getGetCostAndUsageCommandInput(
    start: DateTime,
    end: DateTime,
    accounts: string[],
    granularity: Granularity,
    tag?: { tagName: string; tagValues: string[] },
  ): GetCostAndUsageCommandInput {
    if (tag) {
      return {
        TimePeriod: {
          Start: CostExplorerService.toCostExplorerFormat(start, granularity),
          End: CostExplorerService.toCostExplorerFormat(end, granularity),
        },
        Granularity: granularity,
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
              Dimensions: {
                Key: "RECORD_TYPE",
                Values: ["Usage"],
                MatchOptions: ["EQUALS"],
              },
            },
            {
              Tags: {
                Key: tag.tagName,
                MatchOptions: ["EQUALS"],
                Values: tag.tagValues,
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
      };
    } else {
      return {
        TimePeriod: {
          Start: CostExplorerService.toCostExplorerFormat(start, granularity),
          End: CostExplorerService.toCostExplorerFormat(end, granularity),
        },
        Granularity: granularity,
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
              Dimensions: {
                Key: "RECORD_TYPE",
                Values: ["Usage"],
                MatchOptions: ["EQUALS"],
              },
            },
          ]
        },
        GroupBy: [
          {
            Type: "DIMENSION",
            Key: "LINKED_ACCOUNT",
          },
        ],
      };
    }
  }

  async getCostForLeases(
    accountsWithStartDates: Record<string, DateTime>,
    end: DateTime,
    granularity: "DAILY" | "HOURLY" = Granularity.DAILY,
  ): Promise<AccountsCostReport> {
    const sortedAccountsWithStartDates = Object.entries(
      accountsWithStartDates,
    ).sort((a, b) => (a[1] > b[1] ? 1 : -1));
    const accountsCost = new AccountsCostReport();

    for (const currBatch of batch(sortedAccountsWithStartDates)) {
      const earliestStart = currBatch[0]![1];
      const currentAccountsWithDates = Object.fromEntries(currBatch) as Record<
        string,
        DateTime
      >;
      if (granularity === Granularity.HOURLY) {
        accountsCost.merge(
          await this._getCostForLeasesHourly(
            currentAccountsWithDates,
            earliestStart,
            end,
          ),
        );
      } else {
        accountsCost.merge(
          await this._getCostForLeasesDaily(
            currentAccountsWithDates,
            earliestStart,
            end,
          ),
        );
      }
    }
    return accountsCost;
  }

  private async _getCostForLeasesHourly(
    accountsWithStartDates: Record<string, DateTime>,
    start: DateTime,
    end: DateTime,
  ): Promise<AccountsCostReport> {
    if (end.diff(start, "hours").hours < 24) {
      return this.getCostByGranularityForLeases(
        start,
        CostExplorerService.toStartOfNextPeriod(end, Granularity.HOURLY),
        accountsWithStartDates,
        Granularity.HOURLY,
      );
    }
    const lastDailyDate = end.startOf("day");
    const accountsCost = await this.getCostByGranularityForLeases(
      start,
      lastDailyDate,
      accountsWithStartDates,
      Granularity.DAILY,
    );
    accountsCost.merge(
      await this.getCostByGranularityForLeases(
        lastDailyDate,
        end,
        accountsWithStartDates,
        Granularity.HOURLY,
      ),
    );
    return accountsCost;
  }

  private async _getCostForLeasesDaily(
    accountsWithStartDates: Record<string, DateTime>,
    start: DateTime,
    end: DateTime,
  ): Promise<AccountsCostReport> {
    return this.getCostByGranularityForLeases(
      start,
      CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
      accountsWithStartDates,
      Granularity.DAILY,
    );
  }

  async getCostByGranularityForLeases(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    granularity: Granularity,
  ): Promise<AccountsCostReport> {
    if (
      granularity === Granularity.HOURLY &&
      end.diff(start, "hours").hours >=
        24 * COST_EXPLORER_CONFIG.MAX_DAYS_FOR_HOURLY
    ) {
      throw new Error(
        `Hourly data is only available for the last ${COST_EXPLORER_CONFIG.MAX_DAYS_FOR_HOURLY} days.`,
      );
    }
    const accounts = Object.keys(accountsWithStartDates);
    const params = this.getGetCostAndUsageCommandInput(
      start,
      end,
      accounts,
      granularity,
    );
    const command = new GetCostAndUsageCommand(params);
    const response = await this.costExplorerClient.send(command);

    if (!response.ResultsByTime || response.ResultsByTime.length === 0) {
      logger.warn("No cost data available", {
        start,
        end,
        accounts,
      });
      return new AccountsCostReport();
    }
    return this.calculateTotalCostForLeases(
      response.ResultsByTime,
      accountsWithStartDates,
      granularity,
    );
  }

  private calculateTotalCostForLeases(
    resultByTime: ResultByTime[],
    accountsWithStartDates: Record<string, DateTime>,
    granularity: Granularity,
  ): AccountsCostReport {
    const hourlyFormat = "yyyy-MM-dd'T'HH:mm:ss'Z'";
    const dailyFormat = "yyyy-MM-dd";
    const dateFormat =
      granularity === Granularity.HOURLY ? hourlyFormat : dailyFormat;
    const startOfUnit = granularity === Granularity.HOURLY ? "hour" : "day";
    const accountsCost = new AccountsCostReport();
    for (const result of resultByTime) {
      this.accumulateCostForResult(
        result,
        dateFormat,
        accountsWithStartDates,
        startOfUnit,
        accountsCost,
      );
    }
    return accountsCost;
  }

  private accumulateCostForResult(
    result: ResultByTime,
    dateFormat: string,
    accountsWithStartDates: Record<string, DateTime>,
    startOfUnit: DateTimeUnit,
    accountsCost: AccountsCostReport,
  ) {
    if (result.Groups) {
      const periodStartStr = result.TimePeriod?.Start;
      if (periodStartStr) {
        const periodStart = DateTime.fromFormat(periodStartStr, dateFormat, {
          zone: "utc",
        });
        for (const group of result.Groups) {
          const accountId = group.Keys?.[0];
          if (
            accountId &&
            accountsWithStartDates[accountId]!.startOf(startOfUnit) <=
              periodStart
          ) {
            const cost = parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0",
            );
            accountsCost.addCost(accountId, cost);
          }
        }
      }
    }
  }

  async getCostForRange(
    start: DateTime,
    end: DateTime,
    accountsWithStartDates: Record<string, DateTime>,
    tag?: { tagName: string; tagValues: string[] },
  ): Promise<AccountsCostReport> {
    const accountsCost = new AccountsCostReport();
    for (const currBatch of batch(Object.entries(accountsWithStartDates))) {
      const currentAccountsWithDates = Object.fromEntries(currBatch) as Record<
        string,
        DateTime
      >;
      const currentAccounts = Object.keys(currentAccountsWithDates);
      const params = this.getGetCostAndUsageCommandInput(
        start,
        end,
        currentAccounts,
        Granularity.DAILY,
        tag,
      );
      const command = new GetCostAndUsageCommand(params);
      const response = await this.costExplorerClient.send(command);

      if (!response.ResultsByTime || response.ResultsByTime.length === 0) {
        logger.warn("No cost data available", {
          start,
          end,
          currentAccounts,
        });
      } else {
        accountsCost.merge(
          this.calculateTotalCostForRange(
            response.ResultsByTime,
            currentAccountsWithDates,
          ),
        );
      }
    }
    return accountsCost;
  }

  private calculateTotalCostForRange(
    resultByTime: ResultByTime[],
    accountsWithStartDates: Record<string, DateTime>,
  ): AccountsCostReport {
    const accountsCost = new AccountsCostReport();
    for (const result of resultByTime) {
      this.accumulateCostForRange(result, accountsWithStartDates, accountsCost);
    }
    return accountsCost;
  }

  private accumulateCostForRange(
    result: ResultByTime,
    accountsWithStartDates: Record<string, DateTime>,
    accountsCost: AccountsCostReport,
  ) {
    if (result.Groups) {
      const periodStartStr = result.TimePeriod?.Start;
      if (periodStartStr) {
        const periodStart = DateTime.fromFormat(periodStartStr, "yyyy-MM-dd", {
          zone: "utc",
        });
        for (const group of result.Groups) {
          const accountId = group.Keys?.[0];
          if (
            accountId &&
            accountsWithStartDates[accountId]!.startOf("day") <= periodStart
          ) {
            const cost = parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0",
            );
            accountsCost.addCost(accountId, cost);
          }
        }
      }
    }
  }
}

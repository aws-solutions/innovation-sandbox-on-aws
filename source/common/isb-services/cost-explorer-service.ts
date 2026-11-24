// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CostAllocationTagStatus,
  CostExplorerClient,
  GetCostAndUsageCommand,
  GetCostAndUsageCommandInput,
  GetCostAndUsageCommandOutput,
  Granularity,
  Group,
  GroupDefinition,
  ListCostAllocationTagsCommand,
  ResultByTime,
  UpdateCostAllocationTagsStatusCommand,
} from "@aws-sdk/client-cost-explorer";
import { DateTime, DateTimeUnit } from "luxon";
import pThrottle from "p-throttle";

import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  parseTagGroupValue,
  toCeTagKey,
  toIsbTagKey,
} from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";

const logger = new Logger();
export const COST_EXPLORER_CONFIG = {
  MAX_ACCOUNTS_IN_FILTER: 99,
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

/**
 * Cost Explorer reports Bedrock under more than one service name: its own
 * lines, and one Marketplace line per third-party model. The per-service
 * breakdown sums them under {@link BEDROCK_SERVICE_KEY} so a ranking cannot
 * name a smaller service as the largest.
 */
export const BEDROCK_SERVICE_KEY = "Amazon Bedrock";
export const BEDROCK_SERVICE_LINES: ReadonlySet<string> = new Set([
  BEDROCK_SERVICE_KEY,
  "Amazon Bedrock Service",
  "Amazon Bedrock AgentCore",
]);
export const BEDROCK_MARKETPLACE_SERVICE_SUFFIX = " (Amazon Bedrock Edition)";

export function isBedrockServiceLine(service: string): boolean {
  return (
    BEDROCK_SERVICE_LINES.has(service) ||
    service.endsWith(BEDROCK_MARKETPLACE_SERVICE_SUFFIX)
  );
}

/** The lease identity the tag-grouped daily query needs. */
export interface LeaseCostQueryTarget {
  uuid: string;
  awsAccountId: string;
}

/** One lease's spend for one Cost Explorer day bucket. */
export interface LeaseDailyCostBucket {
  amount: number;
  /** Per-service amounts for the day; present only when the breakdown was requested. */
  serviceAmounts?: Record<string, number>;
}

/**
 * Per-lease, per-day spend from the tag-grouped query, keyed by lease UUID and
 * then by the bucket's `yyyy-MM-dd` start.
 */
export class LeaseDailyCostReport {
  readonly buckets: Record<string, Record<string, LeaseDailyCostBucket>> = {};
  /** `TimePeriod.Start` of the newest bucket returned for each lease. */
  readonly latestPeriodStart: Record<string, string> = {};
  private readonly includeServiceBreakdown: boolean;

  constructor(includeServiceBreakdown: boolean) {
    this.includeServiceBreakdown = includeServiceBreakdown;
  }

  public addCost(
    leaseId: string,
    day: string,
    amount: number,
    service?: string,
  ) {
    const leaseBuckets = (this.buckets[leaseId] ??= {});
    const bucket = (leaseBuckets[day] ??= this.includeServiceBreakdown
      ? { amount: 0, serviceAmounts: {} }
      : { amount: 0 });
    bucket.amount += amount;
    if (service !== undefined && bucket.serviceAmounts) {
      bucket.serviceAmounts[service] =
        (bucket.serviceAmounts[service] ?? 0) + amount;
    }
    // Day strings are fixed-width, so string order is date order.
    const latest = this.latestPeriodStart[leaseId];
    if (latest === undefined || day > latest) {
      this.latestPeriodStart[leaseId] = day;
    }
  }
}

/**
 * Token-priced Bedrock products carry a token unit; the non-token units are a
 * long tail (`hour`, `image`, `Model/month`, `TextUnit`, `Requests`, ...), so
 * the unit classifies a usage type and no name list is kept.
 */
function isTokenUnit(unit: string): boolean {
  return /token/i.test(unit);
}

/** A Cost Explorer amount, which must be a number: a non-finite value poisons every total it enters. */
function parseAmount(amount: string | undefined, line: string): number {
  const parsed = Number.parseFloat(amount ?? "");
  if (!Number.isFinite(parsed)) {
    throw new TypeError(
      `Cost Explorer returned a non-numeric amount for ${line}: ${amount}`,
    );
  }
  return parsed;
}

/**
 * Token-priced Bedrock spend from the usage-type query, per key and day over
 * the whole window: the slice evaluated spend subtracts. The key is the
 * lease UUID where the query grouped by the lease tag and the account ID where
 * it grouped by account. A Bedrock line whose unit is missing cannot be
 * classified, so it is left in the reported total and listed rather than
 * dropped in silence.
 */
export class BedrockTokenCostReport {
  private readonly byKey: Record<string, Record<string, number>> = {};
  /** The usage types that could not be classified, for one warning per query. */
  readonly unclassifiedUsageTypes = new Set<string>();

  public addCost(key: string, day: string, cost: number) {
    const byDay = (this.byKey[key] ??= {});
    byDay[day] = (byDay[day] ?? 0) + cost;
  }

  /** One lease's or account's token-priced cost per day; empty with no token spend, which the writer stores as 0.00. */
  public costByDay(key: string): Record<string, number> {
    return { ...this.byKey[key] };
  }
}

function warnUnclassifiedUsageTypes(report: BedrockTokenCostReport): void {
  if (report.unclassifiedUsageTypes.size > 0) {
    logger.warn(
      `${LogPatterns.BedrockUsageTypeUnclassified.pattern}: Bedrock usage types with no unit were left in the reported total and out of the Bedrock token cost`,
      { usageTypes: [...report.unclassifiedUsageTypes] },
    );
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
  readonly namespace: string;

  constructor(props: {
    costExplorerClient: CostExplorerClient;
    namespace: string;
  }) {
    this.costExplorerClient = props.costExplorerClient;
    this.namespace = props.namespace;
  }

  public async listCostAllocationTags(
    tagKeys: string[],
  ): Promise<Map<string, CostAllocationTagStatus>> {
    const response = await this.costExplorerClient.send(
      new ListCostAllocationTagsCommand({ TagKeys: tagKeys }),
    );

    return new Map<string, CostAllocationTagStatus>(
      (response.CostAllocationTags ?? [])
        .filter((tag) => tag.TagKey && tag.Status)
        .map((tag) => [tag.TagKey!, tag.Status!]),
    );
  }

  public async setCostAllocationTagsStatus(
    tagKeys: string[],
    status: CostAllocationTagStatus,
  ): Promise<void> {
    await this.costExplorerClient.send(
      new UpdateCostAllocationTagsStatusCommand({
        CostAllocationTagsStatus: tagKeys.map((TagKey) => ({
          TagKey,
          Status: status,
        })),
      }),
    );
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
              Not: {
                Dimensions: {
                  Key: "RECORD_TYPE",
                  Values: ["Credit", "Refund"],
                  MatchOptions: ["EQUALS"],
                },
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
      };
    }
  }

  /**
   * Tag-based cost attribution per design §4.2.2. Issues `GetCostAndUsage`
   * grouped by the `ISB-<namespace>:LeaseId` tag and returns a report keyed by
   * lease UUID. Only leases whose tag was active in CE during the queried
   * window (and produced cost) appear in the report — callers detect missing
   * leases via `report.getCost(lease.uuid)` returning 0 and route them to the
   * legacy fallback.
   *
   * Tag-grouping naturally buckets cost: a previous lease on the same account
   * carries a different `LeaseId` value, so it cannot bleed into the current
   * lease's bucket. Untagged cost lands under an empty value
   * (`"ISB-<namespace>:LeaseId$"`) which the parser discards — so no `Tags`
   * filter is needed in the request.
   *
   * Errors propagate. Per design §4.2.3, callers must NOT mask a CE failure by
   * silently routing every lease to the legacy fallback — that would hide bugs
   * in the tag-write path.
   */
  async getCostForLeasesByTag(
    leaseIds: string[],
    start: DateTime,
    end: DateTime,
  ): Promise<AccountsCostReport> {
    const leasesCost = new AccountsCostReport();
    if (leaseIds.length === 0) {
      return leasesCost;
    }

    const queryEnd = CostExplorerService.toStartOfNextPeriod(
      end,
      Granularity.DAILY,
    );
    const baseParams: GetCostAndUsageCommandInput = {
      TimePeriod: {
        Start: CostExplorerService.toCostExplorerFormat(
          start,
          Granularity.DAILY,
        ),
        End: CostExplorerService.toCostExplorerFormat(
          queryEnd,
          Granularity.DAILY,
        ),
      },
      Granularity: Granularity.DAILY,
      Metrics: ["UnblendedCost"],
      Filter: {
        Not: {
          Dimensions: {
            Key: "RECORD_TYPE",
            Values: ["Credit", "Refund"],
            MatchOptions: ["EQUALS"],
          },
        },
      },
      GroupBy: [
        {
          Type: "TAG",
          Key: toCeTagKey(toIsbTagKey(this.namespace, "LeaseId")),
        },
      ],
    };

    const leaseIdSet = new Set(leaseIds);
    let nextPageToken: string | undefined = undefined;

    do {
      const response: GetCostAndUsageCommandOutput =
        await this.costExplorerClient.send(
          new GetCostAndUsageCommand({
            ...baseParams,
            NextPageToken: nextPageToken,
          }),
        );

      if (!response.ResultsByTime || response.ResultsByTime.length === 0) {
        logger.warn("No cost data available", {
          start,
          end: queryEnd,
          leaseCount: leaseIds.length,
        });
      }

      for (const result of response.ResultsByTime ?? []) {
        for (const group of result.Groups ?? []) {
          const leaseId = parseTagGroupValue(group.Keys?.[0]);
          if (!leaseId || !leaseIdSet.has(leaseId)) continue;
          const cost = Number.parseFloat(
            group.Metrics?.UnblendedCost?.Amount ?? "0",
          );
          leasesCost.addCost(leaseId, cost);
        }
      }

      nextPageToken = response.NextPageToken;
    } while (nextPageToken);

    return leasesCost;
  }

  /**
   * Per-lease, per-day spend for the monitored leases, grouped by the
   * namespaced LeaseId tag and, when requested, by service. Filtered to the
   * leases' own accounts so the query is not org-wide, with the account list
   * chunked to Cost Explorer's filter limit. Leases on the legacy
   * {@link getCostForLeases} path never reach this query and so get no
   * per-service figures; that is a choice, not a Cost Explorer limit.
   */
  async getDailyCostForLeasesByTag(
    leases: LeaseCostQueryTarget[],
    start: DateTime,
    end: DateTime,
    options: { includeServiceBreakdown: boolean },
  ): Promise<LeaseDailyCostReport> {
    const report = new LeaseDailyCostReport(options.includeServiceBreakdown);
    if (leases.length === 0) {
      return report;
    }

    const accountIds = [...new Set(leases.map((lease) => lease.awsAccountId))];
    for (const accountBatch of batch(accountIds)) {
      const batchAccounts = new Set(accountBatch);
      const leaseIds = new Set(
        leases
          .filter((lease) => batchAccounts.has(lease.awsAccountId))
          .map((lease) => lease.uuid),
      );
      const input = this.getDailyCostByTagCommandInput(
        accountBatch,
        start,
        end,
        options.includeServiceBreakdown,
      );
      const results = await this.collectResultsByTime(input, (result) =>
        this.accumulateDailyCostByTag(report, leaseIds, result),
      );
      if (results === 0) {
        logger.warn("No cost data available", {
          start: input.TimePeriod?.Start,
          end: input.TimePeriod?.End,
          leaseCount: leaseIds.size,
        });
      }
    }
    return report;
  }

  private getDailyCostByTagCommandInput(
    accounts: string[],
    start: DateTime,
    end: DateTime,
    includeServiceBreakdown: boolean,
  ): GetCostAndUsageCommandInput {
    const groupBy: GroupDefinition[] = [
      {
        Type: "TAG",
        Key: toCeTagKey(toIsbTagKey(this.namespace, "LeaseId")),
      },
    ];
    if (includeServiceBreakdown) {
      groupBy.push({ Type: "DIMENSION", Key: "SERVICE" });
    }
    return {
      TimePeriod: {
        Start: CostExplorerService.toCostExplorerFormat(
          start,
          Granularity.DAILY,
        ),
        End: CostExplorerService.toCostExplorerFormat(
          CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
          Granularity.DAILY,
        ),
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
      GroupBy: groupBy,
    };
  }

  /**
   * Feeds every page's results to `accumulate`; returns how many there were.
   * `send` issues each page request, so a caller can rate-limit every page.
   */
  private async collectResultsByTime(
    baseParams: GetCostAndUsageCommandInput,
    accumulate: (result: ResultByTime) => void,
    send: (
      command: GetCostAndUsageCommand,
    ) => Promise<GetCostAndUsageCommandOutput> = (command) =>
      this.costExplorerClient.send(command),
  ): Promise<number> {
    let results = 0;
    let nextPageToken: string | undefined = undefined;
    do {
      const response: GetCostAndUsageCommandOutput = await send(
        new GetCostAndUsageCommand({
          ...baseParams,
          NextPageToken: nextPageToken,
        }),
      );

      for (const result of response.ResultsByTime ?? []) {
        accumulate(result);
        results++;
      }

      nextPageToken = response.NextPageToken;
    } while (nextPageToken);
    return results;
  }

  private accumulateDailyCostByTag(
    report: LeaseDailyCostReport,
    leaseIds: Set<string>,
    result: ResultByTime,
  ): void {
    const day = result.TimePeriod?.Start;
    if (!day) {
      return;
    }
    for (const group of result.Groups ?? []) {
      const leaseId = parseTagGroupValue(group.Keys?.[0]);
      if (!leaseId || !leaseIds.has(leaseId)) {
        continue;
      }
      const amount = Number.parseFloat(
        group.Metrics?.UnblendedCost?.Amount ?? "0",
      );
      const service = group.Keys?.[1];
      report.addCost(
        leaseId,
        day,
        amount,
        service !== undefined && isBedrockServiceLine(service)
          ? BEDROCK_SERVICE_KEY
          : service,
      );
    }
  }

  /**
   * Token-priced Bedrock spend per lease and per usage type, by day. Grouping
   * by the lease tag and `USAGE_TYPE` spends the two-`GroupBy` budget, so this
   * is a separate call from the main query, filtered to the enumerated Bedrock
   * service lines and the leases' own accounts. `UsageQuantity` is requested
   * beside the cost because its unit classifies a usage type as token-priced.
   *
   * The Marketplace lines (`... (Amazon Bedrock Edition)`) cannot be named in
   * an equality filter and are not queried: a third-party model's token spend
   * stays inside the reported total and is not subtracted.
   */
  async getBedrockTokenCostByLease(
    leases: LeaseCostQueryTarget[],
    start: DateTime,
    end: DateTime,
  ): Promise<BedrockTokenCostReport> {
    const report = new BedrockTokenCostReport();
    if (leases.length === 0) {
      return report;
    }

    const accountIds = [...new Set(leases.map((lease) => lease.awsAccountId))];
    for (const accountBatch of batch(accountIds)) {
      const batchAccounts = new Set(accountBatch);
      const leaseIds = new Set(
        leases
          .filter((lease) => batchAccounts.has(lease.awsAccountId))
          .map((lease) => lease.uuid),
      );
      await this.collectResultsByTime(
        this.getBedrockTokenCostCommandInput(accountBatch, start, end, {
          Type: "TAG",
          Key: toCeTagKey(toIsbTagKey(this.namespace, "LeaseId")),
        }),
        (result) =>
          this.accumulateBedrockTokenCost(
            report,
            leaseIds,
            result,
            parseTagGroupValue,
          ),
      );
    }
    warnUnclassifiedUsageTypes(report);
    return report;
  }

  /**
   * Token-priced Bedrock spend per account and per usage type, by day: the
   * query {@link getBedrockTokenCostByLease} sends, grouped by account instead
   * of by the lease tag. It serves the leases Cost Explorer has not yet
   * attributed to their tag, whose total the legacy account query re-sums, so
   * an account's slice matches the total it is subtracted from. The report
   * carries every day in the window; the caller leaves out the days before a
   * lease started.
   */
  async getBedrockTokenCostByAccount(
    accountIds: string[],
    start: DateTime,
    end: DateTime,
  ): Promise<BedrockTokenCostReport> {
    const report = new BedrockTokenCostReport();
    for (const accountBatch of batch([...new Set(accountIds)])) {
      const accounts = new Set(accountBatch);
      await this.collectResultsByTime(
        this.getBedrockTokenCostCommandInput(accountBatch, start, end, {
          Type: "DIMENSION",
          Key: "LINKED_ACCOUNT",
        }),
        (result) =>
          this.accumulateBedrockTokenCost(
            report,
            accounts,
            result,
            (groupKey) => groupKey,
          ),
      );
    }
    warnUnclassifiedUsageTypes(report);
    return report;
  }

  private getBedrockTokenCostCommandInput(
    accounts: string[],
    start: DateTime,
    end: DateTime,
    groupBy: GroupDefinition,
  ): GetCostAndUsageCommandInput {
    return {
      TimePeriod: {
        Start: CostExplorerService.toCostExplorerFormat(
          start,
          Granularity.DAILY,
        ),
        End: CostExplorerService.toCostExplorerFormat(
          CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
          Granularity.DAILY,
        ),
      },
      Granularity: Granularity.DAILY,
      Metrics: ["UnblendedCost", "UsageQuantity"],
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
              Key: "SERVICE",
              Values: [...BEDROCK_SERVICE_LINES],
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
      GroupBy: [groupBy, { Type: "DIMENSION", Key: "USAGE_TYPE" }],
    };
  }

  /** `keyOf` reads the lease or account a group belongs to from its first key. */
  private accumulateBedrockTokenCost(
    report: BedrockTokenCostReport,
    keys: Set<string>,
    result: ResultByTime,
    keyOf: (groupKey: string | undefined) => string | undefined,
  ): void {
    const day = result.TimePeriod?.Start;
    if (!day) {
      return;
    }
    for (const group of result.Groups ?? []) {
      this.addBedrockTokenLine(report, keys, day, group, keyOf);
    }
  }

  private addBedrockTokenLine(
    report: BedrockTokenCostReport,
    keys: Set<string>,
    day: string,
    group: Group,
    keyOf: (groupKey: string | undefined) => string | undefined,
  ): void {
    const key = keyOf(group.Keys?.[0]);
    const usageType = group.Keys?.[1];
    const unit = group.Metrics?.UsageQuantity?.Unit;
    if (!key || !keys.has(key) || !usageType) {
      return;
    }
    // Classified on the unit, never on the name: a non-token Bedrock charge
    // left in would be subtracted from the reported total as if it were
    // token spend the live count already covers. A line whose unit is
    // missing cannot be classified at all, so it is named rather than
    // dropped.
    if (unit === undefined || unit === "N/A") {
      report.unclassifiedUsageTypes.add(usageType);
      return;
    }
    if (!isTokenUnit(unit)) {
      return;
    }
    report.addCost(
      key,
      day,
      parseAmount(
        group.Metrics?.UnblendedCost?.Amount,
        `${usageType} on ${day}`,
      ),
    );
  }

  /**
   * Legacy pre-account-tagging cost attribution. Used by `lease-monitoring`
   * as the fallback path for leases that did not receive tags — leases
   * created before this feature shipped, or leases whose tag-write failed at
   * approval (`TagResourceFailed` log).
   *
   * @deprecated
   * Do not call from new code. New code should use {@link getCostForLeasesByTag}.
   */
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

  /**
   * Internal helper for the legacy account-level cost fallback.
   * Retain until {@link getCostForLeases} is retired.
   */
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

  /**
   * Internal helper for the legacy account-level cost fallback.
   * Retain until {@link getCostForLeases} is retired.
   */
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

  /**
   * Internal helper for the legacy account-level cost fallback.
   * Retain until {@link getCostForLeases} is retired.
   */
  private async getCostByGranularityForLeases(
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
    const accountsCost = new AccountsCostReport();
    let nextPageToken: string | undefined = undefined;
    let pageCount = 0;
    let resultByTimeCount = 0;
    let rowCount = 0;

    do {
      const response: GetCostAndUsageCommandOutput =
        await this.costExplorerClient.send(
          new GetCostAndUsageCommand({
            ...params,
            NextPageToken: nextPageToken,
          }),
        );
      const resultsByTime = response.ResultsByTime ?? [];

      pageCount++;
      resultByTimeCount += resultsByTime.length;
      rowCount += resultsByTime.reduce(
        (total, result) => total + (result.Groups?.length ?? 0),
        0,
      );
      accountsCost.merge(
        this.calculateTotalCostForLeases(
          resultsByTime,
          accountsWithStartDates,
          granularity,
        ),
      );

      nextPageToken = response.NextPageToken;
    } while (nextPageToken);

    if (resultByTimeCount === 0) {
      logger.warn("No cost data available", {
        start,
        end,
        accounts,
      });
    }

    if (pageCount > 1) {
      logger.info("Processed multi-page Cost Explorer lease query", {
        start: start.toISO(),
        end: end.toISO(),
        granularity,
        accountCount: accounts.length,
        pageCount,
        rowCount,
      });
    }

    return accountsCost;
  }

  /**
   * Internal helper of the legacy {@link getCostForLeases} path.
   * Remove when {@link getCostForLeases} is removed.
   */
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

  /**
   * Internal helper for the legacy account-level cost fallback.
   * Retain until {@link getCostForLeases} is retired.
   */
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
            const cost = Number.parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0",
            );
            accountsCost.addCost(accountId, cost);
          }
        }
      }
    }
  }

  /** `end` is inclusive: costs for the day containing it are included. */
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
        CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
        currentAccounts,
        Granularity.DAILY,
        tag,
      );
      const resultCount = await this.collectResultsByTime(params, (result) =>
        this.accumulateCostForRange(
          result,
          currentAccountsWithDates,
          accountsCost,
        ),
      );

      if (resultCount === 0) {
        logger.warn("No cost data available", {
          start,
          end,
          currentAccounts,
        });
      }
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
            const cost = Number.parseFloat(
              group.Metrics?.UnblendedCost?.Amount ?? "0",
            );
            accountsCost.addCost(accountId, cost);
          }
        }
      }
    }
  }

  /** `end` is inclusive: costs for the day containing it are included. */
  async getDailyCostsByAccount(
    accountIds: string[],
    start: DateTime,
    end: DateTime,
    maxRequestsPerSecond: number = 5,
  ): Promise<Record<string, Record<string, number>>> {
    const dailyCostsByAccount: Record<string, Record<string, number>> = {};
    const batches = Array.from(batch(accountIds));

    // One limiter for every page request across all batches.
    const throttledSend = pThrottle({
      limit: maxRequestsPerSecond,
      interval: 1000,
    })((command: GetCostAndUsageCommand) =>
      this.costExplorerClient.send(command),
    );

    const fetchBatch = async (accountBatch: string[]) => {
      const params = this.getGetCostAndUsageCommandInput(
        start,
        CostExplorerService.toStartOfNextPeriod(end, Granularity.DAILY),
        accountBatch,
        Granularity.DAILY,
      );
      const batchCosts: Record<string, Record<string, number>> = {};
      const resultCount = await this.collectResultsByTime(
        params,
        (result) => this.processTimeResult(result, batchCosts),
        throttledSend,
      );
      if (resultCount === 0) {
        logger.warn("No cost data available", {
          start,
          end,
          accountBatch,
        });
      }
      return batchCosts;
    };

    const results = await Promise.allSettled(batches.map(fetchBatch));
    const failures = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    if (failures.length > 0) {
      // A partial result would understate costs, so fail the whole request.
      throw new AggregateError(
        failures.map((failure) => failure.reason),
        `Failed to get daily costs for ${failures.length} of ${batches.length} account batches`,
      );
    }
    results.forEach((result) => {
      if (result.status === "fulfilled") {
        const batchResult = result.value;
        Object.keys(batchResult).forEach((accountId) => {
          dailyCostsByAccount[accountId] ??= {};
          Object.assign(dailyCostsByAccount[accountId], batchResult[accountId]);
        });
      }
    });

    return dailyCostsByAccount;
  }

  private processTimeResult(
    result: ResultByTime,
    dailyCostsByAccount: Record<string, Record<string, number>>,
  ): void {
    const dateStr = result.TimePeriod?.Start;
    if (!dateStr || !result.Groups) {
      return;
    }

    for (const group of result.Groups) {
      this.processGroupData(group, dateStr, dailyCostsByAccount);
    }
  }

  private processGroupData(
    group: any,
    dateStr: string,
    dailyCostsByAccount: Record<string, Record<string, number>>,
  ): void {
    const accountId = group.Keys?.[0];
    if (!accountId) {
      return;
    }

    const cost = Number.parseFloat(group.Metrics?.UnblendedCost?.Amount ?? "0");

    dailyCostsByAccount[accountId] ??= {};
    dailyCostsByAccount[accountId][dateStr] = cost;
  }
}

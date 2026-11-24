// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { SSMProvider } from "@aws-lambda-powertools/parameters/ssm";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { ListAttachedLinksCommand, OAMClient } from "@aws-sdk/client-oam";
import { STSClient } from "@aws-sdk/client-sts";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { TokenSafeAccountPoolConfig } from "@amzn/innovation-sandbox-commons/data/account-pool-stack-config/account-pool-stack-config.js";
import { DynamoBedrockPriceCache } from "@amzn/innovation-sandbox-commons/data/bedrock-regional-price/dynamo-bedrock-price-cache.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { BEDROCK_TOKEN_SK_PREFIX } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import {
  BedrockTokenRow,
  BreachRecord,
  BreachRecordSchema,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import {
  PersistedMonitoredLease,
  PersistedMonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseUserSandboxSpacesUsageSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import {
  LeaseBudgetExceededAlert,
  LeaseBudgetExceededEventSchema,
} from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import {
  LeaseFreezingEventSchema,
  LeaseFreezingThresholdBreachedAlert,
} from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import {
  discoverFoundationModels,
  discoverInferenceProfiles,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js";
import type {
  LiveModelRates,
  PricingModel,
  RegionModel,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js";
import { fetchPublishedModelRates } from "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js";
import {
  BEDROCK_TOKEN_METRICS,
  BedrockPricingServices,
  BedrockRate,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import { TokenPollEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/token-poll-environment.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  type ServiceBreakdown,
  type TokenCounts,
  type TokenType,
  UNATTRIBUTED_MODEL_ID,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";
import type { LeaseStatus } from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  handler,
  pollBedrockTokenUsage,
} from "@amzn/innovation-sandbox-token-poll/token-poll-handler.js";

// A test hands the handler a rate through this holder rather than through the
// regional prices. With `published` set, the handler's own pricing is used
// instead, and with `lookupFails` set, loading prices fails.
const rateHolder = vi.hoisted(() => ({
  rate: null as BedrockRate | null,
  published: false,
  lookupFails: false,
}));
const loadedPricesHolder = vi.hoisted(() => ({
  models: [] as RegionModel[],
}));
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js")
      >();
    return {
      ...actual,
      // Like the real source, prices only the regions and models passed to
      // loadPrices, and only after it resolves. Pricing before then reads as
      // unpriced.
      createBedrockPricing: (services: BedrockPricingServices) => {
        const published = actual.createBedrockPricing(services);
        return {
          source: (region: string, modelId: string, tokenType: TokenType) => {
            if (rateHolder.published) {
              return published.source(region, modelId, tokenType);
            }
            const loaded = loadedPricesHolder.models.some(
              (model) => model.region === region && model.modelId === modelId,
            );
            return loaded ? rateHolder.rate : null;
          },
          loadPrices: async (models: RegionModel[]) => {
            if (rateHolder.published) {
              return published.loadPrices(models);
            }
            await Promise.resolve();
            loadedPricesHolder.models = rateHolder.lookupFails ? [] : models;
            return !rateHolder.lookupFails;
          },
        };
      },
    };
  },
);

// The `published` source fetches missing or stale prices from Bedrock and the
// Price List, and looks up the models it fetches in Bedrock's model list, so a
// test hands it what those return.
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/discovery.js")
    >()),
    discoverFoundationModels: vi.fn(),
    discoverInferenceProfiles: vi.fn(),
  }),
);
vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/price-fetching.js")
    >()),
    fetchPublishedModelRates: vi.fn(),
  }),
);
/**
 * The rates the next fetch returns, by model. The price-fetching mock reports a
 * complete Price List read with these rates, unless a test says otherwise.
 */
const mockFetchRates =
  vi.fn<
    (
      props: { models: PricingModel[] },
      services: Parameters<typeof fetchPublishedModelRates>[1],
    ) => Promise<Map<string, LiveModelRates>>
  >();

// The worked example's poll: 11:00, three hours after the newest cost row.
const NOW = Date.parse("2026-09-15T11:00:00.000Z");
const LEASE_A = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const LEASE_B = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

const HUB_ACCOUNT_ID = "111111111111";
const LINKED_ACCOUNT_ID = "222222222222";
const UNLINKED_ACCOUNT_ID = "333333333333";
const SINK_IDS = { "us-east-1": "sink-east", "us-west-2": "sink-west" };
const OBSERVABILITY_LINK_MISSING_WARNING = `${LogPatterns.ObservabilityLinkMissing.pattern}: the lease account has no link to the hub sink in this region`;
const OBSERVABILITY_LINK_LIST_UNREADABLE_WARNING = `${LogPatterns.ObservabilityRegionUnreadable.pattern}: skipping the region this run, its linked accounts could not be listed`;
const OBSERVABILITY_TOKEN_METRICS_UNREADABLE_WARNING = `${LogPatterns.ObservabilityRegionUnreadable.pattern}: skipping the region this run, its token metrics could not be read`;

const testEnv = {
  ...generateSchemaData(TokenPollEnvironmentSchema),
  // as the sink custom resource returns it
  OAM_SINK_IDS_JSON: JSON.stringify(
    Object.fromEntries(
      Object.entries(SINK_IDS).map(([region, id]) => [region, { Id: id }]),
    ),
  ),
  // as the schedule runs it; a generated value would move the rate lookups
  TOKEN_POLL_INTERVAL_MINUTES: "10",
};

// The poll derives the sink ARNs from its own function ARN. Its region, the
// hub region, is not a sink region unless a test makes it one, so a test can
// tell the Lambda's own region apart.
const HUB_REGION = "ap-southeast-2";
const pollContext = () => ({
  ...mockContext(testEnv),
  invokedFunctionArn: `arn:aws:lambda:${HUB_REGION}:${HUB_ACCOUNT_ID}:function:ISB-TokenPoll-test`,
});

// The real store, driven through a mocked DynamoDB. Mocking `findByStatus`
// instead would skip the schema validation that drops a malformed row.
const mockDynamoClient = mockClient(DynamoDBDocumentClient);
const oamMock = mockClient(OAMClient);
// The read path assumes no role, so nothing may reach STS.
const stsMock = mockClient(STSClient);
const cloudWatchMock = mockClient(CloudWatchClient);

const counts = (input: number): TokenCounts => ({
  input,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
});

const typeOf = (metricName: string) =>
  (Object.keys(BEDROCK_TOKEN_METRICS) as TokenType[]).find(
    (type) => BEDROCK_TOKEN_METRICS[type] === metricName,
  )!;

/**
 * CloudWatch as the hub sees it in every region: the account-wide series is the
 * sum over the account's models and the per-model series is one model. A region
 * named in `failing` rejects every read.
 */
function mockUsage(
  usage: Record<string, Record<string, TokenCounts>>,
  failing: string[] = [],
) {
  cloudWatchMock.on(ListMetricsCommand).callsFake((input) => ({
    Metrics: Object.keys(usage[input.OwningAccount] ?? {}).map((modelId) => ({
      Namespace: "AWS/Bedrock",
      MetricName: "Invocations",
      Dimensions: [{ Name: "ModelId", Value: modelId }],
    })),
  }));
  cloudWatchMock
    .on(GetMetricDataCommand)
    .callsFake(async (input, getClient: () => CloudWatchClient) => {
      if (failing.includes(await getClient().config.region())) {
        throw awsError("ThrottlingException", "slow down");
      }
      // Usage sits in the newest window only, so a lease whose window the
      // reader splits at the listing lag is not counted once per part.
      const inNewestWindow =
        input.StartTime.getTime() >= Date.parse("2026-09-15T10:00:00.000Z");
      return {
        MetricDataResults: input.MetricDataQueries.map(
          (query: MetricDataQuery) => {
            const models = inNewestWindow
              ? (usage[query.AccountId!] ?? {})
              : {};
            const modelId = query.MetricStat!.Metric!.Dimensions?.[0]?.Value;
            const type = typeOf(query.MetricStat!.Metric!.MetricName!);
            const value =
              modelId === undefined
                ? Object.values(models).reduce((sum, c) => sum + c[type], 0)
                : (models[modelId]?.[type] ?? 0);
            return value === 0
              ? {
                  Id: query.Id,
                  StatusCode: "Complete",
                  Timestamps: [],
                  Values: [],
                }
              : {
                  Id: query.Id,
                  StatusCode: "Complete",
                  Timestamps: [input.StartTime],
                  Values: [value],
                };
          },
        ),
      };
    });
}

const meta = {
  schemaVersion: 1,
  createdTime: "2026-09-15T00:00:00.000Z",
  lastEditTime: "2026-09-15T00:00:00.000Z",
};

const costRow = (
  leaseUuid: string,
  timestamp: string,
  billedCostAccrued: number,
  billedBedrockTokenCost: number | null,
  serviceBreakdown?: ServiceBreakdown,
): CostObservation =>
  ({
    leaseUuid,
    sk: `COST#${timestamp}`,
    billedCostAccrued,
    billedCostDelta: 0,
    predictedCostAtRefresh: null,
    latestPeriodStart: timestamp.slice(0, 10),
    latestPeriodAmount: 0,
    billedBedrockTokenCost,
    serviceBreakdown,
    ttl: 4102444800,
    meta,
  }) as CostObservation;

const tokenRow = (
  leaseUuid: string,
  timestamp: string,
  monitoredBedrockTokenCost: number | null,
  tokens: BedrockTokenRow["tokens"],
): BedrockTokenRow => ({
  leaseUuid,
  sk: `${BEDROCK_TOKEN_SK_PREFIX}${timestamp}`,
  tokens,
  monitoredBedrockTokenCostDelta: null,
  monitoredBedrockTokenCost,
  coveredThrough: { "us-east-1": timestamp, "us-west-2": timestamp },
  ttl: 4102444800,
  meta,
});

const timestampOf = (row: BedrockTokenRow) =>
  row.sk.slice(BEDROCK_TOKEN_SK_PREFIX.length);

/**
 * The cost history table in memory, rows newest first. It refuses a COST write
 * outright: the poll appends token rows and never touches the billed series.
 */
class FakeCostHistoryStore {
  costRows = new Map<string, CostObservation[]>();
  tokenRows = new Map<string, BedrockTokenRow[]>();
  unreadable = new Set<string>();
  /** Leases whose observation series has a row the store cannot parse. */
  unreadableSeries = new Set<string>();
  /** Leases whose earlier token rows cannot be parsed. */
  unreadableBefore = new Set<string>();
  /** Leases whose newest rows cannot be read at all. */
  throwing = new Set<string>();
  appendCostObservation = vi.fn(async () => {
    throw new Error("the poll never writes a COST row");
  });
  /** Breach rows as parsed by the schema the real store parses them through; a row it refuses never lands here. */
  breachRows: BreachRecord[] = [];
  appendBreachRecord = vi.fn(async (row: Record<string, unknown>) => {
    const stored = BreachRecordSchema.parse({
      ...row,
      sk: `BREACH#${new Date().toISOString()}`,
      meta,
    });
    this.breachRows.push(stored);
    return stored;
  });
  listBreachRecords = vi.fn(async (leaseUuid: string) => ({
    result: this.breachRows.filter((row) => row.leaseUuid === leaseUuid),
    droppedRecordCount: 0,
    droppedRecordReason: null,
  }));
  appendBedrockTokenRow = vi.fn(
    async (row: Omit<BedrockTokenRow, "sk" | "meta">) => {
      const stored = {
        ...row,
        sk: `${BEDROCK_TOKEN_SK_PREFIX}${new Date().toISOString()}`,
        meta,
      } as BedrockTokenRow;
      this.tokenRows.set(row.leaseUuid, [
        stored,
        ...(this.tokenRows.get(row.leaseUuid) ?? []),
      ]);
      return stored;
    },
  );

  async getNewestCostObservation(leaseUuid: string) {
    if (this.throwing.has(leaseUuid)) {
      throw new Error("dynamo down");
    }
    if (this.unreadable.has(leaseUuid)) {
      return {
        complete: false as const,
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VALIDATION" as const,
      };
    }
    return {
      complete: true as const,
      result: this.costRows.get(leaseUuid)?.[0],
    };
  }

  async getNewestBedrockTokenRow(leaseUuid: string) {
    return {
      complete: true as const,
      result: this.tokenRows.get(leaseUuid)?.[0],
    };
  }

  async getNewestBedrockTokenRowAtOrBefore(
    leaseUuid: string,
    timestamp: string,
  ) {
    if (this.unreadableBefore.has(leaseUuid)) {
      return {
        complete: false as const,
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VALIDATION" as const,
      };
    }
    return {
      complete: true as const,
      result: (this.tokenRows.get(leaseUuid) ?? []).find(
        (row) => timestampOf(row) <= timestamp,
      ),
    };
  }

  async getRecentCostObservations(
    leaseUuid: string,
    options: { limit: number },
  ) {
    if (this.unreadableSeries.has(leaseUuid)) {
      return {
        complete: false as const,
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VALIDATION" as const,
      };
    }
    return {
      complete: true as const,
      result: (this.costRows.get(leaseUuid) ?? []).slice(0, options.limit),
    };
  }
}

let fakeStore: FakeCostHistoryStore;

/** The scoped lease-record write the poll issued, by attribute placeholder. */
const pollScalarsWritten = () =>
  mockDynamoClient
    .commandCalls(UpdateCommand)
    .map((call) => call.args[0].input)
    .filter((input) => input.UpdateExpression?.includes("lastEvaluatedSpend"))
    .map((input) => input.ExpressionAttributeValues);

/** The figures each run logged for a lease, oldest first. */
const loggedFigures = (leaseUuid: string) =>
  vi
    .mocked(Logger.prototype.debug)
    .mock.calls.filter(
      ([message]) => message === `token poll figures for lease ${leaseUuid}`,
    )
    .map(([, fields]) => fields);

// The handler builds one OAM client per region, so a region-specific answer
// comes from the client the command was sent through.
function perRegion<T>(answer: (region: string) => T) {
  return async (_input: unknown, getClient: () => OAMClient) =>
    answer(await getClient().config.region());
}

const linkFrom = (account: string, region: string) => ({
  LinkArn: `arn:aws:oam:${region}:${account}:link/${account.slice(-4)}`,
  Label: "sandbox-account-name",
});

/** Links attached to the sink of each region, by source account. */
function mockLinks(byRegion: Record<string, string[]>) {
  oamMock.on(ListAttachedLinksCommand).callsFake(
    perRegion((region) => ({
      Items: (byRegion[region] ?? []).map((account) =>
        linkFrom(account, region),
      ),
    })),
  );
}

// The parameter value as the account pool stack writes it: regions comma-joined
// into one string, not a JSON array.
const accountPoolConfig: TokenSafeAccountPoolConfig = {
  organizationId: "o-a1b2c3d4e5",
  sandboxOuId: "ou-sandbox",
  availableOuId: "ou-available",
  activeOuId: "ou-active",
  frozenOuId: "ou-frozen",
  cleanupOuId: "ou-cleanup",
  quarantineOuId: "ou-quarantine",
  entryOuId: "ou-entry",
  exitOuId: "ou-exit",
  solutionVersion: "1.2.16",
  supportedSchemas: "1",
  isbManagedRegions: "us-east-1, us-west-2",
};

/** A context whose managed regions are these, each with a sink the lease account is linked to. */
function pollContextIn(regions: string[]) {
  vi.spyOn(SSMProvider.prototype, "get").mockResolvedValue({
    ...accountPoolConfig,
    isbManagedRegions: regions.join(", "),
  } as any);
  mockLinks(
    Object.fromEntries(regions.map((region) => [region, [LINKED_ACCOUNT_ID]])),
  );
  const sinkIds = regions.map((region) => [region, { Id: `sink-${region}` }]);
  return {
    ...pollContext(),
    env: {
      ...testEnv,
      OAM_SINK_IDS_JSON: JSON.stringify(Object.fromEntries(sinkIds)),
    },
  };
}

/** What one `QueryCommand` call gets back: a page, or the error it raises. */
type ScanPage = Record<string, unknown> | Error;

/** Pages served in order, per status, so a status can page or fail mid-scan. */
function mockLeaseScan(pages: Partial<Record<LeaseStatus, ScanPage[]>>) {
  const served: Partial<Record<LeaseStatus, number>> = {};
  mockDynamoClient.on(QueryCommand).callsFake((input) => {
    const status = input.ExpressionAttributeValues[
      ":leaseStatus"
    ] as LeaseStatus;
    const index = served[status] ?? 0;
    served[status] = index + 1;
    const page = pages[status]?.[index];
    if (page instanceof Error) {
      throw page;
    }
    return page ?? { Items: [] };
  });
}

function awsError(name: string, message: string) {
  const error = new Error(message);
  error.name = name;
  return error;
}

/**
 * A token-monitored lease on a linked account, which the store will accept.
 * `rateLimits` is pinned empty because a generated list could hold duplicate
 * (basis, rate) entries the store rejects, or limits a test did not ask for.
 */
function monitoredLease(
  overrides: Partial<PersistedMonitoredLease>,
): PersistedMonitoredLease {
  return generateSchemaData(PersistedMonitoredLeaseSchema, {
    status: "Active",
    bedrockTokenMonitoringEnabled: true,
    predictiveBudgetEnabled: false,
    awsAccountId: LINKED_ACCOUNT_ID,
    // Nothing to cross unless a test says so, and no figures from a previous
    // run unless a test sets them; the generator would randomize all of these.
    budgetThresholds: [],
    maxSpend: undefined,
    rateLimits: [],
    lastEvaluatedSpend: null,
    lastPredictedSpend: null,
    lastEvaluatedHourlySpendRate: null,
    lastEvaluatedDailySpendRate: null,
    // Inside the listing lag, so a lease with no anchor reads one window.
    startDate: "2026-09-15T10:30:00.000Z",
    expirationDate: "2026-10-15T00:00:00.000Z",
    ...overrides,
  });
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW);
  mockDynamoClient.reset();
  mockDynamoClient.on(UpdateCommand).resolves({});
  oamMock.reset();
  stsMock.reset();
  cloudWatchMock.reset();
  mockUsage({});
  rateHolder.rate = null;
  rateHolder.published = false;
  rateHolder.lookupFails = false;
  loadedPricesHolder.models = [];
  // The lookup fetches through fetchPublishedModelRates, which reports
  // a complete Price List read and returns what mockFetchRates is set up to.
  vi.mocked(fetchPublishedModelRates).mockImplementation(
    async (props, services) => ({
      rates: await mockFetchRates(props, services),
      priceListComplete: true,
    }),
  );
  fakeStore = new FakeCostHistoryStore();
  vi.spyOn(IsbServices, "leaseCostHistoryStore").mockReturnValue(
    fakeStore as any,
  );
  mockLinks({
    "us-east-1": [LINKED_ACCOUNT_ID],
    "us-west-2": [LINKED_ACCOUNT_ID],
  });
  bulkStubEnv(testEnv);
  vi.spyOn(Logger.prototype, "debug").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "info").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
  vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
  vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents").mockResolvedValue(
    undefined as any,
  );
  // `get` is typed as returning a string; the store asks for the JSON
  // transform, which hands back the parsed object.
  vi.spyOn(SSMProvider.prototype, "get").mockResolvedValue(
    accountPoolConfig as any,
  );
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

describe("pollBedrockTokenUsage", () => {
  it("enumerates active and frozen leases across every managed region", async () => {
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({ status: "Active" })] }],
      Frozen: [{ Items: [monitoredLease({ status: "Frozen" })] }],
      PendingApproval: [{ Items: [monitoredLease({ status: "Active" })] }],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    // Two, not three: only the statuses the poll scans are queried at all.
    expect(result).toEqual(
      "polled 2 token-monitored leases in 2 of 2 managed regions, 0 lease-region pairs unlinked, 0 token rows appended, 2 lease records updated",
    );
    const scannedStatuses = mockDynamoClient
      .commandCalls(QueryCommand)
      .map(
        (call) =>
          call.args[0].input.ExpressionAttributeValues?.[":leaseStatus"],
      );
    expect([...new Set(scannedStatuses)].sort()).toEqual(["Active", "Frozen"]);
    // Trimmed region names, so the comma-joined parameter value was split
    // rather than read as a single region or parsed as JSON.
    expect(Logger.prototype.debug).toHaveBeenCalledWith(
      expect.stringContaining("us-east-1, us-west-2"),
    );
  });

  it("polls a lease once when both status scans return it, as most recently edited", async () => {
    // The copies differ in their stored projection, which a run that does not
    // project writes back, so the write shows which copy was polled.
    const active = monitoredLease({
      status: "Active",
      lastPredictedSpend: 10,
      meta: { ...meta, lastEditTime: "2026-09-15T10:00:00.000Z" },
    });
    const frozen = {
      ...active,
      status: "Frozen",
      lastPredictedSpend: 20,
      meta: { ...meta, lastEditTime: "2026-09-15T10:00:01.000Z" },
    };
    mockLeaseScan({
      Active: [{ Items: [active] }],
      Frozen: [{ Items: [frozen] }],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toEqual(
      "polled 1 token-monitored leases in 2 of 2 managed regions, 0 lease-region pairs unlinked, 0 token rows appended, 1 lease records updated",
    );
    expect(pollScalarsWritten()).toEqual([
      expect.objectContaining({ ":lastPredictedSpend": 20 }),
    ]);
  });

  it("follows every page of a status", async () => {
    const lastEvaluatedKey = {
      userEmail: "a@example.com",
      uuid: LEASE_A,
      status: "Active",
      originalLeaseTemplateUuid: "cccccccc-cccc-4ccc-8ccc-cccccccccccc",
    };
    mockLeaseScan({
      Active: [
        {
          Items: [monitoredLease({ status: "Active" })],
          LastEvaluatedKey: lastEvaluatedKey,
        },
        { Items: [monitoredLease({ status: "Active" })] },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/^polled 2 token-monitored leases/);
    // The follow-up query resumed from the key the first page returned, rather
    // than re-reading page one and counting the same leases twice.
    const activeQueries = mockDynamoClient
      .commandCalls(QueryCommand)
      .map((call) => call.args[0].input)
      .filter(
        (input) =>
          input.ExpressionAttributeValues?.[":leaseStatus"] === "Active",
      );
    expect(activeQueries).toHaveLength(2);
    expect(activeQueries[0]!.ExclusiveStartKey).toBeUndefined();
    expect(activeQueries[1]!.ExclusiveStartKey).toEqual(lastEvaluatedKey);
  });

  it("reports the leases the store dropped rather than losing them silently", async () => {
    const { awsAccountId: _omitted, ...withoutAccountId } = monitoredLease({
      status: "Active",
    });
    mockLeaseScan({
      Active: [
        { Items: [withoutAccountId, monitoredLease({ status: "Active" })] },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/^polled 1 token-monitored leases/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
      { status: "Active" },
    );
  });

  it("retries a throttled scan and keeps the leases the retry returns", async () => {
    mockLeaseScan({
      Active: [
        awsError("ThrottlingException", "Throughput exceeded"),
        { Items: [monitoredLease({ status: "Active" })] },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/^polled 1 token-monitored leases/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "Retrying lease scan due to error",
      { error: "Throughput exceeded" },
    );
  });

  it("does not retry an error outside the transient set", async () => {
    mockLeaseScan({
      Active: [
        awsError("AccessDeniedException", "not authorized"),
        { Items: [monitoredLease({ status: "Active" })] },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    // The second page was never served, so the first failure ended that status,
    // and the outcome says so rather than reading as "nobody opted in".
    expect(result).toEqual(
      "no lease to poll; skipped lease status scans: Active",
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.LeaseScanSkipped.pattern),
      { status: "Active", error: "not authorized" },
    );
    expect(Logger.prototype.warn).not.toHaveBeenCalledWith(
      "Retrying lease scan due to error",
      expect.anything(),
    );
  });

  it("keeps the leases from a status that scanned when another fails outright", async () => {
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({ status: "Active" })] }],
      Frozen: [awsError("AccessDeniedException", "not authorized")],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    // One, not zero: a failing status costs its own leases, not the whole run.
    expect(result).toMatch(/^polled 1 token-monitored leases/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.LeaseScanSkipped.pattern),
      { status: "Frozen", error: "not authorized" },
    );
  });

  it("returns before any per-region call when no lease has token monitoring enabled", async () => {
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({ bedrockTokenMonitoringEnabled: false }),
            monitoredLease({ bedrockTokenMonitoringEnabled: undefined }),
          ],
        },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toEqual("no lease has Bedrock token monitoring enabled");
    expect(oamMock.calls()).toHaveLength(0);
    expect(SSMProvider.prototype.get).not.toHaveBeenCalled();
  });

  it("fails the run when every lease status scan fails, rather than reporting nothing to poll", async () => {
    mockLeaseScan({
      Active: [awsError("AccessDeniedException", "not authorized")],
      Frozen: [awsError("AccessDeniedException", "not authorized")],
    });

    await expect(
      pollBedrockTokenUsage({} as any, pollContext()),
    ).rejects.toThrow("no lease status could be scanned this run");
    expect(oamMock.calls()).toHaveLength(0);
  });

  it("lists the linked accounts once per region through a client for that region and assumes no role", async () => {
    const oamFactory = vi.spyOn(IsbClients, "oam");
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({}), monitoredLease({})] }],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // one client per region for the invocation, not one per lease, and
    // nothing beyond env and region, so no credentials are handed in
    expect(oamFactory.mock.calls.map(([, region]) => region).sort()).toEqual([
      "us-east-1",
      "us-west-2",
    ]);
    expect(oamFactory.mock.calls.every((call) => call.length === 2)).toBe(true);
    const calls = oamMock.commandCalls(ListAttachedLinksCommand);
    expect(calls).toHaveLength(2);
    expect(
      calls.map((call) => call.args[0].input.SinkIdentifier).sort(),
    ).toEqual([
      `arn:aws:oam:us-east-1:${HUB_ACCOUNT_ID}:sink/${SINK_IDS["us-east-1"]}`,
      `arn:aws:oam:us-west-2:${HUB_ACCOUNT_ID}:sink/${SINK_IDS["us-west-2"]}`,
    ]);
    expect(calls.every((call) => call.args[0].input.MaxResults === 1000)).toBe(
      true,
    );
    expect(stsMock.calls()).toHaveLength(0);
    expect(Logger.prototype.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.ObservabilityLinkMissing.pattern),
      expect.anything(),
    );
  });

  it("flags a lease whose account has no link in a region and keeps it in the run", async () => {
    const unlinked = monitoredLease({ awsAccountId: UNLINKED_ACCOUNT_ID });
    mockLinks({
      "us-east-1": [LINKED_ACCOUNT_ID, UNLINKED_ACCOUNT_ID],
      "us-west-2": [LINKED_ACCOUNT_ID],
    });
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({}), unlinked] }],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    // Both leases counted; the gap is one lease in one region.
    expect(result).toEqual(
      "polled 2 token-monitored leases in 2 of 2 managed regions, 1 lease-region pairs unlinked, 0 token rows appended, 2 lease records updated",
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      OBSERVABILITY_LINK_MISSING_WARNING,
      {
        leaseId: unlinked.uuid,
        awsAccountId: UNLINKED_ACCOUNT_ID,
        region: "us-west-2",
      },
    );
    expect(Logger.prototype.warn).not.toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.ObservabilityLinkMissing.pattern),
      expect.objectContaining({ region: "us-east-1" }),
    );
  });

  it("counts one unlinked pair per region for a lease linked nowhere", async () => {
    const unlinked = monitoredLease({ awsAccountId: UNLINKED_ACCOUNT_ID });
    mockLeaseScan({ Active: [{ Items: [unlinked] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toEqual(
      "polled 1 token-monitored leases in 2 of 2 managed regions, 2 lease-region pairs unlinked, 0 token rows appended, 1 lease records updated",
    );
    for (const region of ["us-east-1", "us-west-2"]) {
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        OBSERVABILITY_LINK_MISSING_WARNING,
        { leaseId: unlinked.uuid, awsAccountId: UNLINKED_ACCOUNT_ID, region },
      );
    }
  });

  it("skips a region whose links cannot be listed and still evaluates the others", async () => {
    oamMock.on(ListAttachedLinksCommand).callsFake(
      perRegion((region) => {
        if (region === "us-west-2") {
          throw awsError("ThrottlingException", "slow down");
        }
        return { Items: [] };
      }),
    );
    mockLeaseScan({ Active: [{ Items: [monitoredLease({})] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    // One region answered and the lease is unlinked there; the failed region
    // is neither counted nor flagged.
    expect(result).toEqual(
      "polled 1 token-monitored leases in 1 of 2 managed regions, 1 lease-region pairs unlinked, 0 token rows appended, 1 lease records updated",
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      OBSERVABILITY_LINK_LIST_UNREADABLE_WARNING,
      {
        region: "us-west-2",
        leasesAffected: 1,
        errorName: "ThrottlingException",
        error: "slow down",
      },
    );
  });

  it("fails the run when no region could be listed, rather than reporting a clean poll", async () => {
    oamMock
      .on(ListAttachedLinksCommand)
      .rejects(awsError("AccessDeniedException", "not authorized"));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({})] }] });

    await expect(
      pollBedrockTokenUsage({} as any, pollContext()),
    ).rejects.toThrow(
      "no managed region could be read this run (us-east-1, us-west-2)",
    );
    for (const region of ["us-east-1", "us-west-2"]) {
      expect(Logger.prototype.warn).toHaveBeenCalledWith(
        OBSERVABILITY_LINK_LIST_UNREADABLE_WARNING,
        expect.objectContaining({
          region,
          errorName: "AccessDeniedException",
        }),
      );
    }
  });

  it("skips a managed region that has no sink in the map", async () => {
    mockLeaseScan({ Active: [{ Items: [monitoredLease({})] }] });

    const result = await pollBedrockTokenUsage({} as any, {
      ...pollContext(),
      env: {
        ...testEnv,
        OAM_SINK_IDS_JSON: JSON.stringify({
          "us-east-1": { Id: SINK_IDS["us-east-1"] },
        }),
      },
    });

    expect(result).toMatch(/in 1 of 2 managed regions/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      OBSERVABILITY_LINK_LIST_UNREADABLE_WARNING,
      {
        region: "us-west-2",
        leasesAffected: 1,
        errorName: "MissingSinkError",
        error:
          "no sink for us-west-2: redeploy the Compute stack after changing the managed regions",
      },
    );
    expect(oamMock.commandCalls(ListAttachedLinksCommand)).toHaveLength(1);
  });

  it("fails the run before any scan when the sink map itself is unusable", async () => {
    mockLeaseScan({ Active: [{ Items: [monitoredLease({})] }] });

    await expect(
      pollBedrockTokenUsage({} as any, {
        ...pollContext(),
        env: { ...testEnv, OAM_SINK_IDS_JSON: "not json" },
      }),
    ).rejects.toThrow(SyntaxError);
    expect(mockDynamoClient.calls()).toHaveLength(0);
    expect(oamMock.calls()).toHaveLength(0);
  });

  // Through the exported handler, so the middleware chain is what runs: the
  // config read has to sit in it for the row TTL to come from global config.
  it("reads global config through the middleware before the scan", async () => {
    mockAppConfigMiddleware(mockGlobalConfig());
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({ status: "Active" })] }],
    });

    const result = await handler({} as any, pollContext());

    expect(result).toEqual(
      "polled 1 token-monitored leases in 2 of 2 managed regions, 0 lease-region pairs unlinked, 0 token rows appended, 1 lease records updated",
    );
    expect(DynamoConfigStore.prototype.getAllSections).toHaveBeenCalledTimes(1);
  });
});

describe("recording token rows and the lease record", () => {
  const anchorRow = (leaseUuid: string) => [
    costRow(leaseUuid, "2026-09-15T08:00:00.000Z", 60, 20),
    costRow(leaseUuid, "2026-09-15T00:00:00.000Z", 32, 8),
  ];
  // Billed before any Bedrock reached the bill, so a monitored cost below
  // the 20.00 slice above still shows in evaluated spend.
  const unbilledBedrockRow = (leaseUuid: string) => [
    costRow(leaseUuid, "2026-09-15T08:00:00.000Z", 60, 0),
  ];

  it("appends a row with the counts read in every region, priced, and substitutes it", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({ uuid: LEASE_A });
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toEqual(
      "polled 1 token-monitored leases in 2 of 2 managed regions, 0 lease-region pairs unlinked, 1 token rows appended, 1 lease records updated",
    );
    expect(fakeStore.appendBedrockTokenRow).toHaveBeenCalledTimes(1);
    const row = fakeStore.appendBedrockTokenRow.mock.calls[0]![0];
    expect(row).toMatchObject({
      leaseUuid: LEASE_A,
      tokens: {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) },
        "us-west-2": { "amazon.nova-pro-v1:0": counts(1000) },
      },
      // the newest complete five-minute bucket, ten minutes behind the run
      coveredThrough: {
        "us-east-1": "2026-09-15T10:45:00.000Z",
        "us-west-2": "2026-09-15T10:45:00.000Z",
      },
      // 1,000 tokens in each region at $1 per thousand
      monitoredBedrockTokenCost: 2,
      monitoredBedrockTokenCostDelta: 2,
    });
    // retention from global config, counted from the lease's expiry
    expect(row.ttl).toBe(
      Math.floor(
        DateTime.fromISO("2026-10-15T00:00:00.000Z", { zone: "utc" })
          .plus({ days: mockGlobalConfig().leases.ttl })
          .toSeconds(),
      ),
    );
    // 60.00 billed, none of it Bedrock yet, plus the 2.00 monitored cost,
    // and a lease without predictive budget controls gets no projection or rates.
    expect(pollScalarsWritten()).toEqual([
      {
        ":lastEvaluatedSpend": 62,
        ":lastPredictedSpend": null,
        ":lastEvaluatedHourlySpendRate": null,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": expect.any(String),
      },
    ]);
  });

  it("records counts priced at $0 as a monitored token cost of 0 and substitutes it, rather than as unpriced", async () => {
    rateHolder.rate = { ratePerUnit: 0, unitDivisor: 1_000_000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 0,
      monitoredBedrockTokenCostDelta: 0,
    });
    // The monitored 0 replaces the billed slice rather than being left out
    // as unpriced, though 60 - 20 + 0 is below the bill, so the billed 60 stands.
    expect(loggedFigures(LEASE_A)[0]).toMatchObject({
      monitoredBedrockTokenCost: 0,
      evaluatedSpend: 60,
    });
  });

  it("writes no row when no count moved and recomputes the lease record from stored rows: the worked example", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
      tokenRow(LEASE_A, "2026-09-15T09:40:00.000Z", 20, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(20000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/0 token rows appended, 1 lease records updated$/);
    expect(fakeStore.appendBedrockTokenRow).not.toHaveBeenCalled();
    // evaluated spend is 60 - 20 + 26; remainder (40 - 24) / 8h = 2.00/h carried 3h;
    // Bedrock (26 - 20) over the hour = 6.00/h on top for the caps only.
    expect(pollScalarsWritten()).toEqual([
      {
        ":lastEvaluatedSpend": 66,
        ":lastPredictedSpend": 72,
        ":lastEvaluatedHourlySpendRate": 8,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": expect.any(String),
      },
    ]);
  });

  it("appends nothing for an idle lease whose row has no cost, even once a rate exists", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/0 token rows appended, 1 lease records updated$/);
    expect(fakeStore.appendBedrockTokenRow).not.toHaveBeenCalled();
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(60);
  });

  it("appends nothing for an idle lease whose row is already priced, even where today's rate would price it differently", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    // priced at half today's rate
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 13, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/0 token rows appended, 1 lease records updated$/);
    expect(fakeStore.appendBedrockTokenRow).not.toHaveBeenCalled();
    // the stored 13.00 stands: 60.00 + 13.00
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(73);
  });

  it("prices only the counts added since the previous row, so a price change never reprices earlier tokens", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({ uuid: LEASE_A });
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    // 1,000 tokens priced when the rate was half today's
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 0.5, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(2000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 2,000 more tokens in us-east-1 and 2,000 in us-west-2 at $1 per thousand,
    // added to the $0.50 the first 1,000 cost
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      tokens: {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(3000) },
        "us-west-2": { "amazon.nova-pro-v1:0": counts(2000) },
      },
      monitoredBedrockTokenCost: 4.5,
      monitoredBedrockTokenCostDelta: 4,
    });
    // 60.00 + 4.50
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(64.5);
  });

  it("adds nothing for counts with no rate, carrying the previous row's cost over and logging them", async () => {
    rateHolder.rate = null;
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 1, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(2000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 1,
      monitoredBedrockTokenCostDelta: 0,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.BedrockTokensUnpriced.pattern),
      expect.objectContaining({ leaseId: LEASE_A }),
    );
    // 60.00 + 1.00
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(61);
  });

  it("adds on from a previous row with no cost as from 0", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(2000) },
      }),
      // 1,000 tokens priced when the rate was three times today's
      tokenRow(LEASE_A, "2026-09-15T10:30:00.000Z", 3, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // only the 2,000 tokens counted this run, at $1 per thousand
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 2,
      monitoredBedrockTokenCostDelta: 2,
    });
    // 60.00 + 2.00
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(62);
  });

  it("carries a priced row's cost over unchanged where only unattributed counts moved", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, unbilledBedrockRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 1, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { [UNATTRIBUTED_MODEL_ID]: counts(500) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 1,
      monitoredBedrockTokenCostDelta: 0,
    });
    // 60.00 + 1.00
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(61);
  });

  it("never writes a COST row, totalCostAccrued, or a whole lease item", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.appendCostObservation).not.toHaveBeenCalled();
    expect(mockDynamoClient.commandCalls(PutCommand)).toHaveLength(0);
    const updates = mockDynamoClient.commandCalls(UpdateCommand);
    expect(updates).toHaveLength(1);
    expect(updates[0]!.args[0].input.UpdateExpression).not.toContain(
      "totalCostAccrued",
    );
  });

  it("measures the Bedrock rate over the hour, fed six ten-minute rows, not over the adjacent pair", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(
      LEASE_A,
      [
        ["10:50", 30],
        ["10:40", 26],
        ["10:30", 24],
        ["10:20", 22],
        ["10:10", 21],
        ["10:00", 20],
      ].map(([time, dollars]) =>
        tokenRow(LEASE_A, `2026-09-15T${time}:00.000Z`, dollars as number, {
          "us-east-1": {
            "amazon.nova-pro-v1:0": counts((dollars as number) * 1000),
          },
        }),
      ),
    );
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // $30.00 now against $20.00 at 10:00: $10.00 an hour on top of the $2.00
    // remainder, where the adjacent pair would have read $4.00.
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 70,
      ":lastEvaluatedHourlySpendRate": 12,
    });
  });

  // The store keys a row when it is written, just after its run's `now`, so
  // the run at 10:00 keyed its row at 10:00:00.400.
  it("measures no Bedrock in the hour where the newest row is the one the run an hour before wrote", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-14T00:00:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(
      LEASE_A,
      [
        ["2026-09-15T10:00:00.400Z", 30],
        ["2026-09-15T08:30:00.400Z", 20],
      ].map(([timestamp, dollars]) =>
        tokenRow(LEASE_A, timestamp as string, dollars as number, {
          "us-east-1": {
            "amazon.nova-pro-v1:0": counts((dollars as number) * 1000),
          },
        }),
      ),
    );
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // The $10.00 the 10:00 run added was counted before the hour began, so
    // only the $2.00 remainder is left.
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 70,
      ":lastEvaluatedHourlySpendRate": 2,
    });
  });

  it("looks the earlier row up half the configured poll interval past the window start", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-14T00:00:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(
      LEASE_A,
      [
        ["10:50", 30],
        ["10:15", 27],
        ["10:07", 25],
        ["09:50", 20],
      ].map(([time, dollars]) =>
        tokenRow(LEASE_A, `2026-09-15T${time}:00.400Z`, dollars as number, {
          "us-east-1": {
            "amazon.nova-pro-v1:0": counts((dollars as number) * 1000),
          },
        }),
      ),
    );
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, {
      ...pollContext(),
      env: { ...testEnv, TOKEN_POLL_INTERVAL_MINUTES: "20" },
    });

    // A 20-minute interval looks up at 10:10, so the 10:07 row: $5.00 on top
    // of the $2.00 remainder. A full interval would read 10:15, a fixed five
    // minutes 09:50.
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": 7,
    });
  });

  it("measures no Bedrock in the day where the newest row is the one the run a day before wrote", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-14T00:00:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, [
      ...anchorRow(LEASE_A),
      costRow(LEASE_A, "2026-09-14T08:00:00.000Z", 16, 6),
    ]);
    fakeStore.tokenRows.set(
      LEASE_A,
      [
        ["2026-09-14T11:00:00.400Z", 30],
        ["2026-09-14T06:00:00.400Z", 20],
      ].map(([timestamp, dollars]) =>
        tokenRow(LEASE_A, timestamp as string, dollars as number, {
          "us-east-1": {
            "amazon.nova-pro-v1:0": counts((dollars as number) * 1000),
          },
        }),
      ),
    );
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // The $10.00 the run a day before added was counted before the day began,
    // so only the $30.00 a day remainder is left.
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": 2,
      ":lastEvaluatedDailySpendRate": 30,
    });
  });

  it("measures the Bedrock rate from the stored costs, not from the counts that moved priced at today's rate", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    // The 6,000 tokens counted in the hour were priced at twice today's rate.
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 32, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
      tokenRow(LEASE_A, "2026-09-15T09:40:00.000Z", 20, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(20000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 12.00 of Bedrock in the hour on top of the 2.00 remainder, not the 6.00
    // the counts would price at today
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 72,
      ":lastEvaluatedHourlySpendRate": 14,
    });
  });

  it("measures a first hour of use against the zero the lease started from, in both windows", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-14T00:00:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, [
      ...anchorRow(LEASE_A),
      costRow(LEASE_A, "2026-09-14T08:00:00.000Z", 16, 6),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(2550) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // $5.10 across both regions since a zero at lease start, on top of the
    // $2.00 an hour and $30.00 a day remainder.
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": 7.1,
      ":lastEvaluatedDailySpendRate": 35.1,
    });
  });

  it("leaves the Bedrock rate unmeasured for a lease younger than the window", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    // started at 10:30, inside the hour the rate would span
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(15000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 60 - 20 + 30,
      ":lastEvaluatedHourlySpendRate": null,
      ":lastEvaluatedDailySpendRate": null,
    });
  });

  it("leaves the Bedrock rate unmeasured for a lease that started inside the window but before the earlier row's lookup", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    // started at 10:03: inside the hour, before the 10:05 the earlier row is
    // looked up at
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-15T10:03:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(15000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": null,
      ":lastEvaluatedDailySpendRate": null,
    });
  });

  it("writes an evaluated spend below the stored one, so a fall in the figure re-arms the reported thresholds", async () => {
    const lease = monitoredLease({ uuid: LEASE_A, lastEvaluatedSpend: 66 });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    // 60.00 billed less its 20.00 slice plus 22.00 monitored cost: the
    // counts were repriced lower than the 26.00 that stood behind the 66.00
    // written last run.
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 22, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(22000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // A monitored term was substituted, so the figure is written as it is: only an
    // unavailable term holds the previous figure.
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(62);
  });

  it("never writes an evaluated spend below the billed total, so Bedrock use the monitored count missed still reaches the thresholds", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      startDate: "2026-06-17T00:00:00.000Z",
      budgetThresholds: [
        { dollarsSpent: 1000, action: "ALERT", triggerOn: "REPORTED" },
      ],
    });
    // Monitoring was switched on for a lease whose 1,000.00 of older Bedrock use
    // is past CloudWatch's retention: the bill's 1,100.00 is all Bedrock, but
    // only the 100.00 used since is counted monitored.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 1100, 1100),
    ]);
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 100, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(100_000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 1,100.00 - 1,100.00 + 100.00 would be 100.00; the billed 1,100.00 stands.
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(1100);
    expect(loggedFigures(LEASE_A)[0]).toMatchObject({
      monitoredBedrockTokenCost: 100,
      evaluatedSpend: 1100,
    });
    expect(fakeStore.breachRows.map((row) => row.thresholdDollars)).toEqual([
      1000,
    ]);
  });

  it("holds a stored projection above this run's while the monitored term is unavailable", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      lastEvaluatedSpend: 66,
      lastPredictedSpend: 80,
    });
    // The newest row has no Bedrock slice, so the priced 26.00 cannot be
    // substituted and the projection is the billed 60.00 carried at 3.50 an
    // hour: 70.50, with no spend having fallen.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 32, 8),
    ]);
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 66,
      ":lastPredictedSpend": 80,
    });
  });

  it("holds a stored figure only above this run's figure while the monitored term is unavailable", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      lastEvaluatedSpend: 55,
      lastPredictedSpend: 68,
    });
    // As above, but the stored figures are below this run's billed 60.00 and
    // its 70.50 projection, so this run's figures are written.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 32, 8),
    ]);
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 60,
      ":lastPredictedSpend": 70.5,
    });
  });

  it("writes a current projection below the stored one, so a fall in the projection re-arms the predicted thresholds", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      lastPredictedSpend: 80,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
      tokenRow(LEASE_A, "2026-09-15T09:40:00.000Z", 20, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(20000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // The worked example's 72.00, written although 80.00 stood before it.
    expect(pollScalarsWritten()[0]![":lastPredictedSpend"]).toBe(72);
  });

  it("measures an unpriced monitored term as an unmonitored lease: billed total, billed rate, nothing added", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // A row with no cost gives no monitored value: the billed Bedrock accrual is
    // still carried forward at 3.50 an hour rather than dropped.
    expect(pollScalarsWritten()).toEqual([
      {
        ":lastEvaluatedSpend": 60,
        ":lastPredictedSpend": 70.5,
        ":lastEvaluatedHourlySpendRate": 3.5,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": expect.any(String),
      },
    ]);
  });

  it("lets a projection with no monitored value behind it fall below the stored one", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      lastPredictedSpend: 80,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // With no monitored value, the billed projection is written as measured, not
    // held at the stored 80.00.
    expect(pollScalarsWritten()[0]![":lastPredictedSpend"]).toBe(70.5);
  });

  it("measures no rate over a hole when an earlier token row is unreadable, keeping the standing projection while still comparing evaluated spend", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      budgetThresholds: [
        { dollarsSpent: 55, action: "ALERT", triggerOn: "REPORTED" },
        { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
      ],
      lastEvaluatedSpend: 50,
      lastPredictedSpend: 72,
      lastEvaluatedHourlySpendRate: 8,
      lastEvaluatedDailySpendRate: 35.1,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.unreadableBefore.add(LEASE_A);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 lease records updated$/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("earlier bedrock token row is unreadable"),
      expect.objectContaining({ leaseId: LEASE_A }),
    );
    // The reported crossing needs no rate and fires; the projection was
    // crossed too but is not re-evaluated, and its figures are not rewritten.
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "REPORTED",
      evaluatedSpendAtFire: 60,
      predictedCostAtFire: null,
      rateAtFire: null,
    });
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 60,
      ":lastPredictedSpend": 72,
      ":lastEvaluatedHourlySpendRate": 8,
      ":lastEvaluatedDailySpendRate": 35.1,
    });
  });

  it("skips a lease whose newest rows cannot be read at all and records the others", async () => {
    fakeStore.throwing.add(LEASE_A);
    fakeStore.costRows.set(LEASE_B, anchorRow(LEASE_B));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({ uuid: LEASE_A }),
            monitoredLease({ uuid: LEASE_B }),
          ],
        },
      ],
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 lease records updated$/);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("rows could not be read"),
      { leaseId: LEASE_A, error: "dynamo down" },
    );
  });

  it("compares evaluated spend and appends the row when the rate inputs cannot be read at all", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    vi.spyOn(fakeStore, "getRecentCostObservations").mockRejectedValue(
      new Error("dynamo down"),
    );
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      budgetThresholds: [
        { dollarsSpent: 55, action: "FREEZE_ACCOUNT", triggerOn: "REPORTED" },
      ],
      lastEvaluatedSpend: 50,
      lastPredictedSpend: 72,
      lastEvaluatedHourlySpendRate: 8,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    // 20,000 tokens at $1 per thousand, the same 20.00 as the billed slice
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(10000) },
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 token rows appended, 1 lease records updated$/);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "REPORTED",
      action: "FREEZE_ACCOUNT",
      evaluatedSpendAtFire: 60,
    });
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 60,
      ":lastPredictedSpend": 72,
      ":lastEvaluatedHourlySpendRate": 8,
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("rate inputs for lease"),
      expect.objectContaining({ leaseId: LEASE_A, error: "dynamo down" }),
    );
  });

  it("keeps the standing projection when the observation series is unreadable, writing only evaluated spend", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      lastPredictedSpend: 72,
      lastEvaluatedHourlySpendRate: 8,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.unreadableSeries.add(LEASE_A);
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    // 20,000 tokens at $1 per thousand, the same 20.00 as the billed slice
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(10000) },
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 token rows appended, 1 lease records updated$/);
    expect(pollScalarsWritten()).toEqual([
      {
        ":lastEvaluatedSpend": 60,
        ":lastPredictedSpend": 72,
        ":lastEvaluatedHourlySpendRate": 8,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": expect.any(String),
      },
    ]);
  });

  it("differences the remainder on the billed total when the newest observation has no Bedrock slice", async () => {
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
    });
    // The newest row was served by account, so its slice is unknown: the
    // series behaves as an unmonitored lease's, 3.50 an hour, and the
    // monitored term cannot replace a slice that is not there.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 32, 8),
    ]);
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 60,
      ":lastPredictedSpend": 70.5,
    });
  });

  it("places the row it just appended on the token series before measuring the Bedrock rate", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      startDate: "2026-09-14T00:00:00.000Z",
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:00:00.000Z", 20, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(10000) },
        "us-west-2": { "amazon.nova-pro-v1:0": counts(10000) },
      }),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(3000) },
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // The new row is $26.00 at 11:00; against the $20.00 row an hour back the
    // Bedrock rate is $6.00 an hour, on top of the $2.00 remainder.
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 26,
      monitoredBedrockTokenCostDelta: 6,
    });
    expect(pollScalarsWritten()).toEqual([
      {
        ":lastEvaluatedSpend": 66,
        ":lastPredictedSpend": 72,
        ":lastEvaluatedHourlySpendRate": 8,
        ":lastEvaluatedDailySpendRate": null,
        ":lastEditTime": expect.any(String),
      },
    ]);
  });

  it("skips a lease whose newest cost history row is unreadable and records the others", async () => {
    fakeStore.unreadable.add(LEASE_A);
    fakeStore.costRows.set(LEASE_B, anchorRow(LEASE_B));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({ uuid: LEASE_A }),
            monitoredLease({ uuid: LEASE_B }),
          ],
        },
      ],
    });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 token rows appended, 1 lease records updated$/);
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0].leaseUuid).toBe(
      LEASE_B,
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("newest cost history row is unreadable"),
      expect.objectContaining({ leaseId: LEASE_A, costRowReadable: false }),
    );
  });

  it("holds a region whose metrics cannot be read and records the other region's counts", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage(
      { [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) } },
      ["us-west-2"],
    );

    await pollBedrockTokenUsage({} as any, pollContext());

    // only the region that answered enters the row, so its anchor alone advances
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      tokens: { "us-east-1": { "amazon.nova-pro-v1:0": counts(1000) } },
      coveredThrough: { "us-east-1": "2026-09-15T10:45:00.000Z" },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      OBSERVABILITY_TOKEN_METRICS_UNREADABLE_WARNING,
      expect.objectContaining({ region: "us-west-2", error: "slow down" }),
    );
  });

  it("fails the run when no region's metrics can be read, rather than reporting a clean poll", async () => {
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({}, ["us-east-1", "us-west-2"]);

    await expect(
      pollBedrockTokenUsage({} as any, pollContext()),
    ).rejects.toThrow("no region's token metrics could be read this run");
  });

  it("lets one lease's failure cost that lease alone", async () => {
    fakeStore.appendBedrockTokenRow.mockImplementation(async (row) => {
      if (row.leaseUuid === LEASE_A) {
        throw new Error("write failed");
      }
      return {
        ...row,
        sk: `${BEDROCK_TOKEN_SK_PREFIX}x`,
        meta,
      } as BedrockTokenRow;
    });
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({ uuid: LEASE_A }),
            monitoredLease({ uuid: LEASE_B }),
          ],
        },
      ],
    });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(result).toMatch(/1 token rows appended/);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining(`token poll failed for lease ${LEASE_A}`),
      expect.anything(),
    );
  });
});

describe("threshold evaluation", () => {
  // Lambda rose by the most dollars, so it is the change the insight names.
  const anchorRow = (leaseUuid: string) => [
    costRow(leaseUuid, "2026-09-15T08:00:00.000Z", 60, 20, {
      "Amazon Bedrock": 20,
      "AWS Lambda": 40,
    }),
    costRow(leaseUuid, "2026-09-15T00:00:00.000Z", 32, 8, {
      "Amazon Bedrock": 8,
      "AWS Lambda": 24,
    }),
  ];
  const liveRows = (leaseUuid: string) => [
    tokenRow(leaseUuid, "2026-09-15T10:40:00.000Z", 26, {
      "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
    }),
    tokenRow(leaseUuid, "2026-09-15T09:40:00.000Z", 20, {
      "us-east-1": { "amazon.nova-pro-v1:0": counts(20000) },
    }),
  ];
  const sentEvents = () =>
    vi
      .mocked(IsbEventBridgeClient.prototype.sendIsbEvents)
      .mock.calls.flatMap(([, ...events]) => events);
  /** The structured fields of every info record of `logDetailType`, in order. */
  const loggedFields = (logDetailType: string) =>
    vi
      .mocked(Logger.prototype.info)
      .mock.calls.map(([, fields]) => fields as unknown)
      .filter(
        (fields): fields is Record<string, unknown> =>
          typeof fields === "object" &&
          fields !== null &&
          (fields as Record<string, unknown>).logDetailType === logDetailType,
      );

  it("fires a reported threshold on evaluated spend exactly once, records it as the poll's and alerts", async () => {
    const threshold = {
      dollarsSpent: 65,
      action: "ALERT" as const,
      triggerOn: "REPORTED" as const,
    };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    // 60.00 stood after the previous run; evaluated spend is now 66.00
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [threshold],
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      leaseUuid: LEASE_A,
      triggeredBy: "REPORTED",
      action: "ALERT",
      thresholdDollars: 65,
      evaluatedBy: "TOKEN_POLL",
      evaluatedSpendAtFire: 66,
      monitoredBedrockTokenCostAtFire: 26,
      // Cost Explorer's own total, never the estimate, under the billed name
      billedCostAtFire: 60,
      // the same insight Lease Monitoring would draw from these two rows
      insight: {
        kind: "CHANGE",
        service: "AWS Lambda",
        amount: 40,
        changePercent: expect.closeTo(66.67, 1),
      },
    });
    expect(sentEvents()).toHaveLength(1);
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({
      totalSpend: 60,
      lastReportedAt: "2026-09-15T08:00:00.000Z",
      insight: expect.objectContaining({ service: "AWS Lambda" }),
    });
    // The log record mirrors the row: the billed total under the billed name.
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("REPORTED threshold crossed"),
      expect.objectContaining({
        logDetailType: "BudgetThresholdFired",
        thresholdDollars: 65,
        evaluatedBy: "TOKEN_POLL",
        spendAtFire: 66,
        billedCostAtFire: 60,
        hoursSinceLastRefresh: 3,
      }),
    );

    // The next run finds the figure it wrote, so the same crossing is past.
    mockDynamoClient.resetHistory();
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [threshold],
              lastEvaluatedSpend: 66,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(sentEvents()).toHaveLength(1);
  });

  it("takes over from Lease Monitoring's figure after monitoring is switched on, so a threshold it fired does not fire again", async () => {
    const leaseMonitoringFired = {
      dollarsSpent: 58,
      action: "ALERT" as const,
    };
    const notYetCrossed = { dollarsSpent: 65, action: "ALERT" as const };
    const lease = (lastEvaluatedSpend: number) =>
      monitoredLease({
        uuid: LEASE_A,
        budgetThresholds: [leaseMonitoringFired, notYetCrossed],
        lastEvaluatedSpend,
      });
    // Lease Monitoring compared and stored the 60.00 bill while monitoring was
    // off, so its newest row carries no billed Bedrock slice yet.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
    ]);
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease(60)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // Without the slice the bill alone is compared, so nothing has moved.
    expect(fakeStore.breachRows).toHaveLength(0);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(60);

    // Lease Monitoring's next row carries the slice: 60 - 20 + 26 = 66.
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease(60)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows.map((row) => row.thresholdDollars)).toEqual([
      65,
    ]);
  });

  it("raises a rate cap against the summed rate once across consecutive polls, not once per poll", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = (previousHourlyRate: number | null) =>
      monitoredLease({
        uuid: LEASE_A,
        predictiveBudgetEnabled: true,
        rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
        lastEvaluatedSpend: 66,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: previousHourlyRate,
      });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease(null)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 2.00 remainder plus 6.00 monitored Bedrock exceeds the 5.00 cap
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "RATE",
      thresholdRate: 5,
      thresholdRateBasis: "HOURLY",
      rateAtFire: 8,
      rateSourceAtFire: "HOURLY",
    });
    expect(pollScalarsWritten()[0]![":lastEvaluatedHourlySpendRate"]).toBe(8);

    for (let poll = 0; poll < 5; poll++) {
      mockDynamoClient.resetHistory();
      mockLeaseScan({ Active: [{ Items: [lease(8)] }] });
      await pollBedrockTokenUsage({} as any, pollContext());
    }

    expect(fakeStore.breachRows).toHaveLength(1);
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(LeaseSpendRateThresholdBreachedAlert);
    const alert = events[0] as LeaseSpendRateThresholdBreachedAlert;
    expect(alert.DetailType).toBe("LeaseSpendRateThresholdAlert");
    expect(alert.Detail).toMatchObject({
      rateBasis: "HOURLY",
      thresholdRate: 5,
      measuredRate: 8,
      totalSpend: 60,
    });
    expect(alert.Detail).not.toHaveProperty("triggeredBy");
  });

  it("records the billed, evaluated and projected figures on a rate cap breach's row", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
              lastEvaluatedSpend: 66,
              lastPredictedSpend: 72,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "RATE",
      rateAtFire: 8,
      billedCostAtFire: 60,
      evaluatedSpendAtFire: 66,
      predictedCostAtFire: 72,
    });
  });

  it("alerts on a crossed rate limit with its measured rate beside the countdown rate, the unbilled Bedrock usage and the breach row's insight, and no Sandbox Spaces estimated token cost", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              maxSpend: 100,
              budgetThresholds: [],
              rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
              lastEvaluatedSpend: 66,
              lastPredictedSpend: 72,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "RATE",
      evaluatedBy: "TOKEN_POLL",
    });
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(LeaseSpendRateThresholdBreachedAlert);
    const alert = events[0] as LeaseSpendRateThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({
      rateBasis: "HOURLY",
      thresholdRate: 5,
      // 2.00 remainder plus 6.00 monitored Bedrock
      measuredRate: 8,
      totalSpend: 60,
      predictedCost: 72,
      // the remaining 28.00 burns at the same summed 8.00 an hour
      countdownRate: 8,
      countdownRateSource: "HOURLY",
      hoursToBudgetExhaustion: 3.5,
      // the monitored 26.00 less the 20.00 billed slice it replaced
      unbilledBedrockTokenCost: 6,
    });
    expect(alert.Detail.insight).toEqual(fakeStore.breachRows[0]!.insight);
    for (const key of [
      "triggeredBy",
      "actionRequested",
      "rate",
      "rateSource",
    ]) {
      expect(alert.Detail).not.toHaveProperty(key);
    }
  });

  /** Polls LEASE_A over a 2.00 remainder plus 6.00 monitored Bedrock an hour. */
  const pollRateLease = async (overrides: Partial<PersistedMonitoredLease>) => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              ...overrides,
            }),
          ],
        },
      ],
    });
    await pollBedrockTokenUsage({} as any, pollContext());
  };

  it("records every rate limit the summed rate crosses but raises one freeze and the alert it does not suppress", async () => {
    await pollRateLease({
      rateLimits: [
        { basis: "HOURLY", rate: 5, action: "FREEZE_ACCOUNT" },
        { basis: "HOURLY", rate: 6, action: "FREEZE_ACCOUNT" },
        { basis: "HOURLY", rate: 7, action: "ALERT" },
      ],
      lastEvaluatedSpend: 66,
      lastPredictedSpend: 72,
    });

    const crossed = [
      { thresholdRate: 5, action: "FREEZE_ACCOUNT" },
      { thresholdRate: 6, action: "FREEZE_ACCOUNT" },
      { thresholdRate: 7, action: "ALERT" },
    ];
    expect(
      fakeStore.breachRows.map(({ thresholdRate, action }) => ({
        thresholdRate,
        action,
      })),
    ).toEqual(crossed);
    // One record per crossed limit, the FREEZE limit at 5 whose event the
    // higher freeze replaced included.
    const firedLogs = loggedFields("SpendRateThresholdFired");
    expect(
      firedLogs.map(({ rateBasis, thresholdRate, measuredRate, action }) => ({
        rateBasis,
        thresholdRate,
        measuredRate,
        action,
      })),
    ).toEqual(
      crossed.map((limit) => ({
        rateBasis: "HOURLY",
        measuredRate: 8,
        ...limit,
      })),
    );
    for (const record of firedLogs) {
      expect(record).not.toHaveProperty("thresholdDollars");
      expect(record).not.toHaveProperty("triggeredBy");
      if (record.action === "FREEZE_ACCOUNT") {
        expect(record).toHaveProperty("costAtFreezeDecision");
      } else {
        expect(record).not.toHaveProperty("costAtFreezeDecision");
      }
    }
    expect(loggedFields("BudgetThresholdFired")).toEqual([]);
    const events = sentEvents();
    expect(events).toHaveLength(2);
    const freezes = events.filter(
      (event) => event instanceof LeaseFreezingThresholdBreachedAlert,
    ) as LeaseFreezingThresholdBreachedAlert[];
    expect(freezes).toHaveLength(1);
    expect(freezes[0]!.Detail.reason).toEqual({
      type: "SpendRateExceeded",
      rateBasis: "HOURLY",
      thresholdRate: 6,
      measuredRate: 8,
      totalSpend: 60,
    });
    const alerts = events.filter(
      (event) => event instanceof LeaseSpendRateThresholdBreachedAlert,
    ) as LeaseSpendRateThresholdBreachedAlert[];
    expect(alerts.map((alert) => alert.Detail)).toEqual([
      expect.objectContaining({
        rateBasis: "HOURLY",
        thresholdRate: 7,
        measuredRate: 8,
      }),
    ]);
  });

  it("logs a dollar crossing as BudgetThresholdFired and a crossed rate limit as SpendRateThresholdFired, raising one alert", async () => {
    await pollRateLease({
      // Evaluated spend was 60.00 before and is 66.00 now, crossing the line at 65.
      budgetThresholds: [{ dollarsSpent: 65, action: "ALERT" }],
      rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
      lastEvaluatedSpend: 60,
      lastPredictedSpend: 60,
    });

    const dollarFired = loggedFields("BudgetThresholdFired");
    expect(dollarFired).toHaveLength(1);
    expect(dollarFired[0]).toMatchObject({
      thresholdDollars: 65,
      triggeredBy: "REPORTED",
      action: "ALERT",
    });
    expect(dollarFired[0]).not.toHaveProperty("thresholdRate");
    expect(dollarFired[0]).not.toHaveProperty("thresholdRateBasis");
    expect(loggedFields("SpendRateThresholdFired")).toEqual([
      expect.objectContaining({
        rateBasis: "HOURLY",
        thresholdRate: 5,
        measuredRate: 8,
        action: "ALERT",
      }),
    ]);
    // The dollar alert outranks the rate alert, which selection suppresses.
    const events = sentEvents();
    expect(events).toHaveLength(1);
    expect(events[0]).toBeInstanceOf(LeaseBudgetThresholdBreachedAlert);
    expect(
      (events[0] as LeaseBudgetThresholdBreachedAlert).Detail,
    ).toMatchObject({ triggeredBy: "REPORTED", budgetThresholdTriggered: 65 });
  });

  it("raises only the maxSpend termination on a poll that also crosses a freezing rate limit", async () => {
    await pollRateLease({
      maxSpend: 65,
      rateLimits: [{ basis: "HOURLY", rate: 5, action: "FREEZE_ACCOUNT" }],
      lastEvaluatedSpend: 60,
      lastPredictedSpend: 60,
    });

    expect(sentEvents()).toHaveLength(1);
    expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
    expect(fakeStore.breachRows).toEqual([
      expect.objectContaining({
        triggeredBy: "MAX_SPEND",
        action: "TERMINATE",
        thresholdDollars: 65,
        thresholdRate: null,
        thresholdRateBasis: null,
      }),
    ]);
  });

  it("raises only the maxSpend termination on a later poll still over maxSpend that crosses a freezing rate limit", async () => {
    await pollRateLease({
      maxSpend: 65,
      rateLimits: [{ basis: "HOURLY", rate: 5, action: "FREEZE_ACCOUNT" }],
      // the last check already compared 66.00, past the budget
      lastEvaluatedSpend: 66,
      lastPredictedSpend: 72,
    });

    expect(sentEvents()).toHaveLength(1);
    expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
    expect(
      fakeStore.breachRows.map((row) => [
        row.triggeredBy,
        row.thresholdDollars,
      ]),
    ).toEqual([["MAX_SPEND", 65]]);
  });

  it("saves no token row and keeps the stored projection and rates where prices fail to load, so the next run raises nothing again", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    rateHolder.lookupFails = true;
    // the previous run already raised both: 8.00 an hour is over the 5.00 cap
    // and 72.00 projected is over 70
    const lease = monitoredLease({
      uuid: LEASE_A,
      predictiveBudgetEnabled: true,
      rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
      budgetThresholds: [
        { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
      ],
      lastEvaluatedSpend: 66,
      lastPredictedSpend: 72,
      lastEvaluatedHourlySpendRate: 8,
    });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // no monitored value is substituted, so the billed 60.00 is compared and the
    // 66.00 already compared is held
    expect(fakeStore.appendBedrockTokenRow).not.toHaveBeenCalled();
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 66,
      ":lastPredictedSpend": 72,
      ":lastEvaluatedHourlySpendRate": 8,
    });

    rateHolder.lookupFails = false;
    mockDynamoClient.resetHistory();
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    await pollBedrockTokenUsage({} as any, pollContext());

    // the counts the failed run left are recorded now
    expect(fakeStore.appendBedrockTokenRow).toHaveBeenCalledTimes(1);
    expect(fakeStore.breachRows).toEqual([]);
    expect(sentEvents()).toEqual([]);
  });

  it("compares a newer bill alone where prices fail to load, so a crossing already raised does not fire again", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    rateHolder.lookupFails = true;
    // the previous run evaluated 66.00, past the line at 60
    const lease = (lastEvaluatedSpend: number) =>
      monitoredLease({
        uuid: LEASE_A,
        budgetThresholds: [
          { dollarsSpent: 60, action: "ALERT", triggerOn: "REPORTED" },
        ],
        lastEvaluatedSpend,
      });
    // The newer bill's 40.00 Bedrock slice is past the 26.00 the stored
    // counts price at, since the counts read since are not saved.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T10:00:00.000Z", 70, 40),
      ...anchorRow(LEASE_A),
    ]);
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(10000) },
    });
    mockLeaseScan({ Active: [{ Items: [lease(66)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // No monitored term is substituted, so the newer bill's 70.00 is
    // compared alone.
    expect(fakeStore.appendBedrockTokenRow).not.toHaveBeenCalled();
    const written = pollScalarsWritten()[0]![":lastEvaluatedSpend"] as number;
    expect(written).toBe(70);
    expect(loggedFigures(LEASE_A)[0]).toMatchObject({
      monitoredBedrockTokenCost: null,
    });

    // Prices load again and the 46,000 tokens price at 46.00: evaluated spend
    // is 76.00, above the line, as was the figure stored before it.
    rateHolder.lookupFails = false;
    mockDynamoClient.resetHistory();
    mockLeaseScan({ Active: [{ Items: [lease(written)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.appendBedrockTokenRow).toHaveBeenCalledTimes(1);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(76);
    expect(fakeStore.breachRows).toEqual([]);
    expect(sentEvents()).toEqual([]);
  });

  it("records a null monitored term on the breach row where the counts were unpriced", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
    ]);
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                { dollarsSpent: 55, action: "ALERT", triggerOn: "REPORTED" },
              ],
              lastEvaluatedSpend: 50,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // No monitored cost was swapped in, so the evaluated figure is the
    // billed total.
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      evaluatedBy: "TOKEN_POLL",
      evaluatedSpendAtFire: 60,
      monitoredBedrockTokenCostAtFire: null,
      billedCostAtFire: 60,
    });
    expect(sentEvents()).toHaveLength(1);
  });

  it("fires a predicted threshold on the projection, recording the remainder rate that carried it, and alerts with that rate and with the summed rate its countdown burns at", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              maxSpend: 100,
              budgetThresholds: [
                { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
              ],
              lastEvaluatedSpend: 66,
              lastPredictedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 66.00 carried three hours at the 2.00 remainder rate is 72.00
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "PREDICTED",
      thresholdDollars: 70,
      predictedCostAtFire: 72,
      rateAtFire: 2,
      rateSourceAtFire: "HOURLY",
      billedCostAtFire: 60,
      evaluatedSpendAtFire: 66,
    });
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({
      triggeredBy: "PREDICTED",
      totalSpend: 60,
      predictedCost: 72,
      rate: 2,
      rateSource: "HOURLY",
      // the remaining 28.00 burns at 2.00 remainder plus 6.00 monitored Bedrock
      countdownRate: 8,
      countdownRateSource: "HOURLY",
      hoursToBudgetExhaustion: 3.5,
      // the monitored 26.00 less the 20.00 billed slice it replaced
      unbilledBedrockTokenCost: 6,
    });
  });

  it("alerts with the summed daily rate, per day, as the countdown's where its hourly share outruns the summed hourly rate, beside the hourly remainder rate", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    // 2.00 an hour over the last eight hours, 40.00 a day over the last 24
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 56, 0),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 40, 0),
      costRow(LEASE_A, "2026-09-14T08:00:00.000Z", 16, 0),
    ]);
    // no tokens in the last hour, 24,000 in the last day
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
      tokenRow(LEASE_A, "2026-09-15T09:40:00.000Z", 26, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
      }),
      tokenRow(LEASE_A, "2026-09-14T10:00:00.000Z", 2, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(2000) },
      }),
    ]);
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              maxSpend: 200,
              startDate: "2026-09-14T00:00:00.000Z",
              budgetThresholds: [
                { dollarsSpent: 85, action: "ALERT", triggerOn: "PREDICTED" },
              ],
              lastEvaluatedSpend: 82,
              lastPredictedSpend: 80,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 56.00 billed plus 26.00 monitored cost, carried three hours at the
    // 2.00 remainder rate to 88.00
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "PREDICTED",
      predictedCostAtFire: 88,
      rateAtFire: 2,
      rateSourceAtFire: "HOURLY",
    });
    // summed: 2.00 an hour, against 40.00 plus 24.00 a day, 2.67 an hour
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({ rate: 2, rateSource: "HOURLY" });
    expect(alert.Detail.countdownRateSource).toBe("DAILY");
    expect(alert.Detail.countdownRate).toBeCloseTo(64, 9);
    expect(alert.Detail.hoursToBudgetExhaustion).toBeCloseTo(
      (200 - 88) / (64 / 24),
      9,
    );
  });

  it("names the unbilled Bedrock usage as the largest service on the breach row and the alert alike when it outweighs every billed one", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    // A bill with no Bedrock in it yet, and Lambda up fivefold since the row
    // before, which would otherwise be the change named.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 10, 0, {
        "AWS Lambda": 10,
      }),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 2, 0, { "AWS Lambda": 2 }),
    ]);
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              maxSpend: 100,
              budgetThresholds: [
                { dollarsSpent: 38, action: "ALERT", triggerOn: "PREDICTED" },
              ],
              lastEvaluatedSpend: 30,
              lastPredictedSpend: 30,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // 10.00 billed plus 26.00 monitored cost is 36.00, carried three
    // hours at the 1.00 remainder rate to 39.00.
    const insight = {
      kind: "COMPOSITION",
      service: "Amazon Bedrock token usage not yet billed",
      amount: 26,
      shareOfComparedSpend: 26 / (10 + 26),
    };
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "PREDICTED",
      predictedCostAtFire: 39,
      rateAtFire: 1,
      rateSourceAtFire: "HOURLY",
      insight,
    });
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({
      totalSpend: 10,
      rate: 1,
      rateSource: "HOURLY",
      // 1.00 remainder plus 6.00 monitored Bedrock, the rate the countdown uses
      countdownRate: 7,
      countdownRateSource: "HOURLY",
      hoursToBudgetExhaustion: (100 - 39) / 7,
      unbilledBedrockTokenCost: 26,
    });
    expect(alert.Detail.insight).toEqual(fakeStore.breachRows[0]!.insight);
  });

  it("compares the first check against zero, so thresholds below the first figures fire", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              // Nothing was compared before, so evaluated spend goes from
              // 0.00 to 66.00 and the projection from 0.00 to 72.00, each
              // above its line.
              budgetThresholds: [
                { dollarsSpent: 15, action: "ALERT", triggerOn: "REPORTED" },
                { dollarsSpent: 18, action: "ALERT", triggerOn: "PREDICTED" },
              ],
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(
      fakeStore.breachRows.map((row) => [
        row.triggeredBy,
        row.thresholdDollars,
      ]),
    ).toEqual([
      ["REPORTED", 15],
      ["PREDICTED", 18],
    ]);
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 66,
      ":lastPredictedSpend": 72,
    });
  });

  const budgetExceeded = () =>
    sentEvents().filter((event) => event instanceof LeaseBudgetExceededAlert);

  it("sends one LeaseBudgetExceededAlert in place of the threshold events on the run that reaches maxSpend, and advances the stored figures", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              userEmail: "user@example.com",
              maxSpend: 65,
              // Evaluated spend of 66.00 is past both the threshold and budget
              budgetThresholds: [
                {
                  dollarsSpent: 62,
                  action: "FREEZE_ACCOUNT",
                  triggerOn: "REPORTED",
                },
              ],
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(sentEvents()).toHaveLength(1);
    const exceeded = sentEvents()[0] as LeaseBudgetExceededAlert;
    expect(exceeded).toBeInstanceOf(LeaseBudgetExceededAlert);
    // the lifecycle manager's parse, which a rejected detail would never reach
    expect(() =>
      LeaseBudgetExceededEventSchema.parse(exceeded.Detail),
    ).not.toThrow();
    expect(exceeded.Detail).toEqual({
      leaseId: { userEmail: "user@example.com", uuid: LEASE_A },
      accountId: LINKED_ACCOUNT_ID,
      budget: 65,
      totalSpend: 66,
      detectedBy: "TOKEN_POLL",
    });
    // One MAX_SPEND row and none for the threshold crossed with it: the
    // billed total, and the figure compared, with the monitored Bedrock term
    // inside it
    expect(fakeStore.breachRows).toEqual([
      expect.objectContaining({
        leaseUuid: LEASE_A,
        triggeredBy: "MAX_SPEND",
        action: "TERMINATE",
        thresholdDollars: 65,
        thresholdRate: null,
        thresholdRateBasis: null,
        billedCostAtFire: 60,
        predictedCostAtFire: null,
        evaluatedBy: "TOKEN_POLL",
        evaluatedSpendAtFire: 66,
        monitoredBedrockTokenCostAtFire: 26,
        rateAtFire: null,
        rateSourceAtFire: null,
        insight: null,
        ttl: Math.floor(
          DateTime.fromISO("2026-10-15T00:00:00.000Z", { zone: "utc" })
            .plus({ days: mockGlobalConfig().leases.ttl })
            .toSeconds(),
        ),
      }),
    ]);
    // the row is written before the termination is sent
    expect(
      fakeStore.appendBreachRecord.mock.invocationCallOrder[0],
    ).toBeLessThan(
      vi.mocked(IsbEventBridgeClient.prototype.sendIsbEvents).mock
        .invocationCallOrder[0]!,
    );
    expect(Logger.prototype.info).not.toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ logDetailType: "BudgetThresholdFired" }),
    );
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      `Lease (${LEASE_A}) budget exceeded, sending message to ISB bus`,
      expect.objectContaining({ leaseId: LEASE_A }),
    );
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
  });

  it("writes no MAX_SPEND row where Lease Monitoring already recorded one at this cap, and still sends", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    const recorded = BreachRecordSchema.parse({
      leaseUuid: LEASE_A,
      sk: "BREACH#2026-09-15T10:00:00.000Z",
      triggeredBy: "MAX_SPEND",
      action: "TERMINATE",
      thresholdDollars: 65,
      thresholdRate: null,
      thresholdRateBasis: null,
      billedCostAtFire: 65,
      predictedCostAtFire: null,
      evaluatedBy: "LEASE_MONITORING",
      evaluatedSpendAtFire: null,
      monitoredBedrockTokenCostAtFire: null,
      rateAtFire: null,
      rateSourceAtFire: null,
      insight: null,
      ttl: Math.floor(
        DateTime.fromISO("2026-10-15T00:00:00.000Z", { zone: "utc" })
          .plus({ days: mockGlobalConfig().leases.ttl })
          .toSeconds(),
      ),
      meta,
    });
    fakeStore.breachRows.push(recorded);
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              maxSpend: 65,
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(1);
    expect(fakeStore.appendBreachRecord).not.toHaveBeenCalled();
    expect(fakeStore.breachRows).toEqual([recorded]);
  });

  it("sends the LeaseBudgetExceededAlert where its breach row cannot be written", async () => {
    fakeStore.appendBreachRecord.mockRejectedValue(new Error("write failed"));
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              maxSpend: 65,
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(1);
    expect(fakeStore.appendBreachRecord).toHaveBeenCalledWith(
      expect.objectContaining({
        triggeredBy: "MAX_SPEND",
        thresholdDollars: 65,
      }),
    );
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      `breach record write failed for lease ${LEASE_A}; publishing without an audit row`,
      expect.objectContaining({ leaseId: LEASE_A }),
    );
  });

  it.each([
    ["at", 65],
    ["above", 70],
  ])(
    "sends it again while the stored figure is already %s maxSpend, with no second MAX_SPEND row",
    async (_case, lastEvaluatedSpend) => {
      fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
      fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
      const lease = monitoredLease({
        uuid: LEASE_A,
        maxSpend: 65,
        lastEvaluatedSpend: 60,
      });
      mockLeaseScan({ Active: [{ Items: [lease] }] });

      await pollBedrockTokenUsage({} as any, pollContext());

      mockDynamoClient.resetHistory();
      mockLeaseScan({
        Active: [{ Items: [{ ...lease, lastEvaluatedSpend }] }],
      });

      await pollBedrockTokenUsage({} as any, pollContext());

      // 66.00 is still past the budget, so a termination that has not landed
      // is sent again; the row the first run wrote at this cap stands alone
      expect(budgetExceeded()).toHaveLength(2);
      expect(budgetExceeded()[1]!.Detail).toMatchObject({
        budget: 65,
        totalSpend: 66,
      });
      expect(
        fakeStore.breachRows.map((row) => [
          row.triggeredBy,
          row.thresholdDollars,
        ]),
      ).toEqual([["MAX_SPEND", 65]]);
      expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
    },
  );

  it("sends it where maxSpend is lowered below the stored figure, recording a MAX_SPEND row at the new cap", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            // The last check compared 66.00 under a higher budget, and spend
            // has not moved since, so no run crosses the lowered one
            monitoredLease({
              uuid: LEASE_A,
              maxSpend: 60,
              lastEvaluatedSpend: 66,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(sentEvents()).toHaveLength(1);
    expect(budgetExceeded()[0]!.Detail).toMatchObject({
      budget: 60,
      totalSpend: 66,
      detectedBy: "TOKEN_POLL",
    });
    expect(
      fakeStore.breachRows.map((row) => [
        row.triggeredBy,
        row.thresholdDollars,
      ]),
    ).toEqual([["MAX_SPEND", 60]]);
  });

  it("sends it on a lease's first check where it is already past maxSpend", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({ uuid: LEASE_A, maxSpend: 65 })] }],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(1);
    expect(budgetExceeded()[0]!.Detail).toMatchObject({
      budget: 65,
      totalSpend: 66,
    });
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
  });

  it("sends it where the compared figure lands exactly on maxSpend", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              maxSpend: 66,
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // Evaluated spend of 66.00 is the budget exactly
    expect(budgetExceeded()).toHaveLength(1);
    expect(budgetExceeded()[0]!.Detail).toMatchObject({
      budget: 66,
      totalSpend: 66,
    });
  });

  it("checks a frozen lease's maxSpend too", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Frozen: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              status: "Frozen",
              maxSpend: 65,
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(1);
    expect(budgetExceeded()[0]!.Detail).toMatchObject({
      budget: 65,
      totalSpend: 66,
    });
  });

  it("sends no LeaseBudgetExceededAlert where only the projection reaches maxSpend, raising the predicted threshold instead", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            // Evaluated spend of 66.00 stays under the budget while the 72.00
            // projection passes it
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              maxSpend: 70,
              budgetThresholds: [
                { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
              ],
              lastEvaluatedSpend: 66,
              lastPredictedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toEqual([]);
    expect(sentEvents()).toHaveLength(1);
    expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetThresholdBreachedAlert);
    expect(
      fakeStore.breachRows.map((row) => [
        row.triggeredBy,
        row.thresholdDollars,
      ]),
    ).toEqual([["PREDICTED", 70]]);
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedSpend": 66,
      ":lastPredictedSpend": 72,
    });
  });

  it("writes no figures where the LeaseBudgetExceededAlert cannot be sent, and the next run still over maxSpend sends it again", async () => {
    vi.mocked(
      IsbEventBridgeClient.prototype.sendIsbEvents,
    ).mockRejectedValueOnce(new Error("bus down"));
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    const lease = monitoredLease({
      uuid: LEASE_A,
      maxSpend: 65,
      lastEvaluatedSpend: 60,
    });
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    const result = await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(1);
    expect(pollScalarsWritten()).toEqual([]);
    expect(result).toMatch(/0 lease records updated$/);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      `token poll failed for lease ${LEASE_A}; continuing with the others`,
      expect.anything(),
    );

    mockDynamoClient.resetHistory();
    mockLeaseScan({ Active: [{ Items: [lease] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(budgetExceeded()).toHaveLength(2);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
  });

  /** Bedrock lists the given foundation models. */
  const bedrockLists = (...modelIds: string[]) =>
    vi.mocked(discoverFoundationModels).mockResolvedValue(
      modelIds.map((modelId) => ({
        modelId,
        displayName: modelId,
        provider: "Amazon",
        availability: "AVAILABLE",
        modelType: "foundation-model" as const,
        foundationModelId: modelId,
        foundationModelName: modelId,
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        inferenceTypesSupported: ["ON_DEMAND"],
      })),
    );

  const regionalPrice = (
    region: string,
    modelId: string,
    inputPricePer1KTokens: number,
    pricingRefreshedAt: string,
  ) => ({
    region,
    modelId,
    inputPricePer1KTokens,
    outputPricePer1KTokens: inputPricePer1KTokens * 4,
    cacheReadPricePer1KTokens: inputPricePer1KTokens / 4,
    cacheWritePricePer1KTokens: inputPricePer1KTokens * 1.25,
    pricingSource: "price-list" as const,
    pricingRefreshedAt,
  });

  it("prices usage in this Lambda's own region from the regional prices, refreshing only a stale model and leaving the model pricing table alone", async () => {
    rateHolder.published = true;
    bedrockLists("amazon.nova-pro-v1:0", "amazon.titan-text-express-v1");
    const getAgentModels = vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModels",
    );
    const getRegionalPrices = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "getPrices")
      .mockResolvedValue([
        regionalPrice(
          HUB_REGION,
          "amazon.nova-pro-v1:0",
          0.0008,
          "2026-09-15T10:00:00.000Z",
        ),
        // over a day old, so refreshed, and priced at what the fetch returns
        regionalPrice(
          HUB_REGION,
          "amazon.titan-text-express-v1",
          0.0002,
          "2026-09-13T10:00:00.000Z",
        ),
      ]);
    const putRegionalPrice = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "putPrices")
      .mockResolvedValue();
    const putModelRow = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");
    vi.mocked(mockFetchRates).mockResolvedValue(
      new Map([
        [
          "amazon.titan-text-express-v1",
          {
            input: 0.0003,
            output: 0.0012,
            cacheRead: 0.000075,
            cacheWrite: 0.000375,
            pricingSource: "price-list",
          },
        ],
      ]),
    );
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: {
        "amazon.nova-pro-v1:0": counts(1000),
        "amazon.titan-text-express-v1": counts(1000),
      },
    });

    await pollBedrockTokenUsage({} as any, pollContextIn([HUB_REGION]));

    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [
        {
          models: [
            expect.objectContaining({
              modelId: "amazon.titan-text-express-v1",
              displayName: "amazon.titan-text-express-v1",
            }),
          ],
        },
        expect.objectContaining({ region: HUB_REGION }),
      ],
    ]);
    expect(discoverFoundationModels).toHaveBeenCalledTimes(1);
    expect(getRegionalPrices).toHaveBeenCalledTimes(1);
    expect(putRegionalPrice.mock.calls).toEqual([
      [
        [
          {
            region: HUB_REGION,
            modelId: "amazon.titan-text-express-v1",
            inputPricePer1KTokens: 0.0003,
            outputPricePer1KTokens: 0.0012,
            cacheReadPricePer1KTokens: 0.000075,
            cacheWritePricePer1KTokens: 0.000375,
            pricingSource: "price-list",
            pricingRefreshedAt: "2026-09-15T11:00:00.000Z",
          },
        ],
      ],
    ]);
    expect(getAgentModels).not.toHaveBeenCalled();
    expect(putModelRow).not.toHaveBeenCalled();
    // 1,000 input tokens of each model, the stale model at its fetched price
    expect(
      fakeStore.appendBedrockTokenRow.mock.calls[0]![0]
        .monitoredBedrockTokenCost,
    ).toBeCloseTo(0.0008 + 0.0003, 12);
  });

  it("lists each region's models through a Bedrock client in that region, pricing a profile only that region lists", async () => {
    rateHolder.published = true;
    const euProfile = "eu.anthropic.claude-haiku-4-5-20251001-v1:0";
    const haiku = "anthropic.claude-haiku-4-5-20251001-v1:0";
    // Only eu-west-1's own listing has the EU profile.
    vi.mocked(discoverFoundationModels).mockResolvedValue([
      {
        modelId: haiku,
        displayName: "Claude Haiku 4.5",
        provider: "Anthropic",
        availability: "global",
        modelType: "foundation-model" as const,
        foundationModelId: haiku,
        foundationModelName: "Claude Haiku 4.5",
        inputModalities: ["TEXT"],
        outputModalities: ["TEXT"],
        responseStreamingSupported: true,
        // Not on-demand: only reachable through profiles, so it is not listed
        // as a model to price directly.
        inferenceTypesSupported: ["INFERENCE_PROFILE"],
      },
    ]);
    vi.mocked(discoverInferenceProfiles).mockImplementation(async (client) =>
      (await client.config.region()) === "eu-west-1"
        ? [
            {
              modelId: euProfile,
              displayName: "EU Anthropic Claude Haiku 4.5",
              provider: "Anthropic",
              availability: "eu",
              modelType: "inference-profile" as const,
              foundationModelId: haiku,
              foundationModelName: "Claude Haiku 4.5",
              status: "ACTIVE",
              profileType: "SYSTEM_DEFINED",
              routedModelIds: [haiku],
            },
          ]
        : [],
    );
    vi.spyOn(DynamoBedrockPriceCache.prototype, "getPrices").mockResolvedValue(
      [],
    );
    const putRegionalPrice = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "putPrices")
      .mockResolvedValue();
    vi.mocked(mockFetchRates).mockResolvedValue(
      new Map([
        [
          euProfile,
          {
            input: 0.0011,
            output: 0.0055,
            cacheRead: 0.00011,
            cacheWrite: 0.001375,
            pricingSource: "agreement-offers",
          },
        ],
      ]),
    );
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({ [LINKED_ACCOUNT_ID]: { [euProfile]: counts(1000) } });

    await pollBedrockTokenUsage(
      {} as any,
      pollContextIn([HUB_REGION, "eu-west-1"]),
    );

    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [
        { models: [expect.objectContaining({ modelId: euProfile })] },
        expect.objectContaining({ region: "eu-west-1" }),
      ],
    ]);
    expect(putRegionalPrice.mock.calls).toEqual([
      [[expect.objectContaining({ region: "eu-west-1", modelId: euProfile })]],
    ]);
    // eu-west-1's 1,000 input tokens at its price; the hub region does not
    // list the profile, so its tokens add nothing
    expect(
      fakeStore.appendBedrockTokenRow.mock.calls[0]![0]
        .monitoredBedrockTokenCost,
    ).toBeCloseTo(0.0011, 12);
  });

  it("prices usage in another region at that region's own price, listed and fetched for that region and saved to the regional prices", async () => {
    rateHolder.published = true;
    bedrockLists("amazon.nova-pro-v1:0");
    const regionalBedrock = vi.spyOn(IsbClients, "regionalBedrock");
    const getAgentModels = vi.spyOn(
      DynamoConfigStore.prototype,
      "getAgentModels",
    );
    const putModelRow = vi.spyOn(DynamoConfigStore.prototype, "putModelRow");
    const getRegionalPrices = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "getPrices")
      .mockResolvedValue([
        regionalPrice(
          HUB_REGION,
          "amazon.nova-pro-v1:0",
          0.0008,
          "2026-09-15T10:00:00.000Z",
        ),
      ]);
    const putRegionalPrice = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "putPrices")
      .mockResolvedValue();
    const singapore = {
      input: 0.00108,
      output: 0.00432,
      cacheRead: 0.00027,
      cacheWrite: 0.00135,
      pricingSource: "price-list" as const,
    };
    vi.mocked(mockFetchRates).mockResolvedValue(
      new Map([["amazon.nova-pro-v1:0", singapore]]),
    );
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    await pollBedrockTokenUsage(
      {} as any,
      pollContextIn([HUB_REGION, "ap-southeast-1"]),
    );

    // the hub region's price is fresh, so only the other region is listed,
    // through a Bedrock client in that region, and fetched
    expect(regionalBedrock.mock.calls.map(([, region]) => region)).toEqual([
      "ap-southeast-1",
    ]);
    expect(vi.mocked(mockFetchRates).mock.calls).toEqual([
      [
        {
          models: [
            expect.objectContaining({ modelId: "amazon.nova-pro-v1:0" }),
          ],
        },
        expect.objectContaining({ region: "ap-southeast-1" }),
      ],
    ]);
    expect(getRegionalPrices).toHaveBeenCalledTimes(1);
    expect(putRegionalPrice.mock.calls).toEqual([
      [
        [
          {
            region: "ap-southeast-1",
            modelId: "amazon.nova-pro-v1:0",
            inputPricePer1KTokens: 0.00108,
            outputPricePer1KTokens: 0.00432,
            cacheReadPricePer1KTokens: 0.00027,
            cacheWritePricePer1KTokens: 0.00135,
            pricingSource: "price-list",
            pricingRefreshedAt: "2026-09-15T11:00:00.000Z",
          },
        ],
      ],
    ]);
    // the model pricing table is neither read nor written
    expect(getAgentModels).not.toHaveBeenCalled();
    expect(putModelRow).not.toHaveBeenCalled();
    // 1,000 input tokens in each region, each at its own region's price
    expect(
      fakeStore.appendBedrockTokenRow.mock.calls[0]![0]
        .monitoredBedrockTokenCost,
    ).toBeCloseTo(0.0008 + 0.00108, 12);
  });

  it("counts a model with no price as $0, adding the priced models' cost, and never prices its tokens on a later run", async () => {
    rateHolder.published = true;
    // Bedrock does not list Titan, so it gets no price this run
    bedrockLists("amazon.nova-pro-v1:0");
    const getRegionalPrices = vi
      .spyOn(DynamoBedrockPriceCache.prototype, "getPrices")
      .mockResolvedValue([
        regionalPrice(
          HUB_REGION,
          "amazon.nova-pro-v1:0",
          0.0008,
          "2026-09-15T10:00:00.000Z",
        ),
      ]);
    vi.spyOn(
      DynamoBedrockPriceCache.prototype,
      "putPrices",
    ).mockResolvedValue();
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    const lease = monitoredLease({ uuid: LEASE_A });
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: {
        "amazon.nova-pro-v1:0": counts(1000),
        "amazon.titan-text-express-v1": counts(1000),
      },
    });

    await pollBedrockTokenUsage({} as any, pollContextIn([HUB_REGION]));

    // Nova's 1,000 input tokens alone; Titan's add nothing
    expect(
      fakeStore.appendBedrockTokenRow.mock.calls[0]![0]
        .monitoredBedrockTokenCost,
    ).toBeCloseTo(0.0008, 12);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.BedrockTokensUnpriced.pattern),
      {
        leaseId: LEASE_A,
        unpriced: [
          {
            region: HUB_REGION,
            modelId: "amazon.titan-text-express-v1",
            tokenType: "input",
            count: 1000,
          },
        ],
      },
    );

    // Titan has a price now, but only Nova is used again: the run prices only
    // the counts it adds, so Titan's earlier tokens stay at $0.
    getRegionalPrices.mockResolvedValue([
      regionalPrice(
        HUB_REGION,
        "amazon.nova-pro-v1:0",
        0.0008,
        "2026-09-15T10:00:00.000Z",
      ),
      regionalPrice(
        HUB_REGION,
        "amazon.titan-text-express-v1",
        0.0002,
        "2026-09-15T10:00:00.000Z",
      ),
    ]);
    vi.setSystemTime(NOW + 10 * 60 * 1000);
    mockDynamoClient.resetHistory();
    mockLeaseScan({ Active: [{ Items: [lease] }] });
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    await pollBedrockTokenUsage({} as any, pollContextIn([HUB_REGION]));

    expect(getRegionalPrices.mock.calls[1]![0]).toEqual([
      { modelId: "amazon.nova-pro-v1:0", region: HUB_REGION },
    ]);
    expect(fakeStore.appendBedrockTokenRow.mock.calls[1]![0]).toMatchObject({
      monitoredBedrockTokenCost: expect.closeTo(0.0016, 12),
      monitoredBedrockTokenCostDelta: expect.closeTo(0.0008, 12),
    });
  });

  it("loads prices once each for every region and model this run's readings counted, and none for a model only in the stored running token totals", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, [
      tokenRow(LEASE_A, "2026-09-15T10:40:00.000Z", null, {
        "us-east-1": { "amazon.nova-pro-v1:0": counts(26000) },
        // invoked last week, idle in this run's window
        "eu-west-1": {
          "anthropic.claude-sonnet-4": counts(500),
          // tokens that could not be attributed to a model have no model to
          // price
          unattributed: counts(40),
        },
      }),
    ]);
    // nova was used again and a new model appeared, in both linked regions
    mockUsage({
      [LINKED_ACCOUNT_ID]: {
        "amazon.nova-pro-v1:0": counts(1000),
        "amazon.titan-text-express-v1": counts(10),
      },
    });
    mockLeaseScan({
      Active: [{ Items: [monitoredLease({ uuid: LEASE_A })] }],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(loadedPricesHolder.models).toHaveLength(4);
    expect(loadedPricesHolder.models).toEqual(
      expect.arrayContaining([
        { region: "us-east-1", modelId: "amazon.nova-pro-v1:0" },
        { region: "us-east-1", modelId: "amazon.titan-text-express-v1" },
        { region: "us-west-2", modelId: "amazon.nova-pro-v1:0" },
        { region: "us-west-2", modelId: "amazon.titan-text-express-v1" },
      ]),
    );
  });

  it("fires before the first COST row on the monitored value alone, with nothing billed to report", async () => {
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                { dollarsSpent: 25, action: "ALERT", triggerOn: "REPORTED" },
              ],
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "REPORTED",
      billedCostAtFire: 0,
      evaluatedSpendAtFire: 26,
      monitoredBedrockTokenCostAtFire: 26,
      insight: null,
    });
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail.totalSpend).toBe(0);
    expect(alert.Detail.lastReportedAt).toBeUndefined();
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("REPORTED threshold crossed"),
      expect.objectContaining({
        logDetailType: "BudgetThresholdFired",
        billedCostAtFire: 0,
        hoursSinceLastRefresh: null,
      }),
    );
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(26);
  });

  it("holds the previous daily rate while an hourly rate is measured and no daily one can be, and clears both where nothing is", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = (overrides: Partial<PersistedMonitoredLease>) =>
      monitoredLease({
        uuid: LEASE_A,
        predictiveBudgetEnabled: true,
        lastEvaluatedHourlySpendRate: 5,
        lastEvaluatedDailySpendRate: 35.1,
        ...overrides,
      });
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease({})] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    // eight hours of series and a lease that started an hour ago: no day to
    // measure over, so the daily cap keeps comparing against 35.10
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": 8,
      ":lastEvaluatedDailySpendRate": 35.1,
    });

    // one observation and no token rows: no rate of any kind this run
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A).slice(0, 1));
    fakeStore.tokenRows.delete(LEASE_A);
    mockLeaseScan({
      Active: [{ Items: [lease({ lastEvaluatedHourlySpendRate: 8 })] }],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastEvaluatedHourlySpendRate": null,
      ":lastEvaluatedDailySpendRate": null,
    });
  });

  it("keeps a frozen lease's predicted crossings and caps quiet while still advancing its figures", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Frozen: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              status: "Frozen",
              predictiveBudgetEnabled: true,
              budgetThresholds: [
                { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
                { dollarsSpent: 65, action: "ALERT", triggerOn: "REPORTED" },
              ],
              rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
              lastEvaluatedSpend: 60,
              lastPredictedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // Only the reported crossing, carrying the projection as context: the
    // projection and the cap were crossed too, and their figures move on so
    // they do not fire on unfreeze.
    expect(fakeStore.breachRows).toHaveLength(1);
    expect(fakeStore.breachRows[0]).toMatchObject({
      triggeredBy: "REPORTED",
      predictedCostAtFire: 72,
      rateAtFire: 2,
      rateSourceAtFire: "HOURLY",
    });
    // the alert carries the summed rate its countdown burns at beside it
    const alert = sentEvents()[0] as LeaseBudgetThresholdBreachedAlert;
    expect(alert.Detail).toMatchObject({
      triggeredBy: "REPORTED",
      rate: 2,
      rateSource: "HOURLY",
      countdownRate: 8,
      countdownRateSource: "HOURLY",
    });
    expect(pollScalarsWritten()[0]).toMatchObject({
      ":lastPredictedSpend": 72,
      ":lastEvaluatedHourlySpendRate": 8,
    });

    // Unfrozen with the figures the frozen run wrote: the projection and the
    // cap are still crossed, and neither fires.
    mockDynamoClient.resetHistory();
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              predictiveBudgetEnabled: true,
              budgetThresholds: [
                { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
                { dollarsSpent: 65, action: "ALERT", triggerOn: "REPORTED" },
              ],
              rateLimits: [{ basis: "HOURLY", rate: 5, action: "ALERT" }],
              lastEvaluatedSpend: 66,
              lastPredictedSpend: 72,
              lastEvaluatedHourlySpendRate: 8,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(sentEvents()).toHaveLength(1);
  });

  it("requests a freeze for a crossed FREEZE_ACCOUNT threshold", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                {
                  dollarsSpent: 65,
                  action: "FREEZE_ACCOUNT",
                  triggerOn: "REPORTED",
                },
              ],
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(sentEvents()).toHaveLength(1);
    const freeze = sentEvents()[0] as LeaseFreezingThresholdBreachedAlert;
    expect(freeze).toBeInstanceOf(LeaseFreezingThresholdBreachedAlert);
    // the lifecycle manager's parse, which a rejected detail would never reach
    expect(() => LeaseFreezingEventSchema.parse(freeze.Detail)).not.toThrow();
    expect(freeze.Detail.reason).toMatchObject({
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 65,
      totalSpend: 60,
      triggeredBy: "REPORTED",
    });
    expect(freeze.Detail.reason).not.toHaveProperty("rateSource");
    // The overrun split needs the evaluated spend the freeze was decided on.
    expect(Logger.prototype.info).toHaveBeenCalledWith(
      expect.stringContaining("FREEZE_ACCOUNT"),
      expect.objectContaining({
        logDetailType: "BudgetThresholdFired",
        action: "FREEZE_ACCOUNT",
        billedCostAtFire: 60,
        costAtFreezeDecision: 66,
      }),
    );
  });

  it("sends no freeze for a lease that is already Frozen, and the freeze does not suppress the alert below it", async () => {
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Frozen: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              status: "Frozen",
              budgetThresholds: [
                { dollarsSpent: 55, action: "ALERT", triggerOn: "REPORTED" },
                {
                  dollarsSpent: 65,
                  action: "FREEZE_ACCOUNT",
                  triggerOn: "REPORTED",
                },
              ],
              lastEvaluatedSpend: 50,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // Only an Active lease can be frozen, so the alert at 55 is sent instead.
    expect(sentEvents()).toHaveLength(1);
    expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetThresholdBreachedAlert);
    expect(
      (sentEvents()[0] as LeaseBudgetThresholdBreachedAlert).Detail
        .budgetThresholdTriggered,
    ).toBe(55);
    // Both crossings are still recorded without reading breach history.
    expect(
      fakeStore.breachRows.map((row) => [row.thresholdDollars, row.action]),
    ).toEqual([
      [55, "ALERT"],
      [65, "FREEZE_ACCOUNT"],
    ]);
    expect(fakeStore.listBreachRecords).not.toHaveBeenCalled();
  });

  it("records no monitored term where the newest billed row has no Bedrock slice for it to replace", async () => {
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 32, 8),
    ]);
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                { dollarsSpent: 55, action: "ALERT", triggerOn: "REPORTED" },
              ],
              lastEvaluatedSpend: 50,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // The priced 26.00 exists but was not substituted, so the row says so.
    expect(fakeStore.breachRows[0]).toMatchObject({
      evaluatedSpendAtFire: 60,
      monitoredBedrockTokenCostAtFire: null,
      billedCostAtFire: 60,
    });
  });

  it("does not re-fire a reported crossing when the monitored term drops out and returns", async () => {
    const thresholds = [
      {
        dollarsSpent: 10,
        action: "ALERT" as const,
        triggerOn: "REPORTED" as const,
      },
      {
        dollarsSpent: 20,
        action: "ALERT" as const,
        triggerOn: "REPORTED" as const,
      },
    ];
    const lease = (lastEvaluatedSpend: number | null) =>
      monitoredLease({
        uuid: LEASE_A,
        budgetThresholds: thresholds,
        lastEvaluatedSpend,
      });
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease(null)] }] });

    // Nothing billed yet: the monitored 26.00 alone crosses both lines.
    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(2);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(26);

    // Cost Explorer's first row for the lease was served by account and has
    // no Bedrock slice, so no monitored cost is substituted and the figure would
    // read 3.00; the 26.00 already compared is held instead.
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T10:00:00.000Z", 3, null),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease(26)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(2);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(26);

    // The tagged row lands and the monitored term is substituted again: 31.00,
    // above both lines already reported, so neither fires a second time.
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T10:30:00.000Z", 30, 25),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease(26)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(2);
    expect(sentEvents()).toHaveLength(1);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(31);
  });

  it("does not re-fire a predicted crossing when the monitored term drops out and returns", async () => {
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const lease = (scalars: {
      lastEvaluatedSpend: number;
      lastPredictedSpend: number;
    }) =>
      monitoredLease({
        uuid: LEASE_A,
        predictiveBudgetEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 71, action: "ALERT", triggerOn: "PREDICTED" },
        ],
        ...scalars,
      });
    // The next run starts from the figures this one wrote.
    const written = () => {
      const scalars = pollScalarsWritten()[0]!;
      return {
        lastEvaluatedSpend: scalars[":lastEvaluatedSpend"] as number,
        lastPredictedSpend: scalars[":lastPredictedSpend"] as number,
      };
    };
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({
      Active: [
        { Items: [lease({ lastEvaluatedSpend: 66, lastPredictedSpend: 60 })] },
      ],
    });

    // 66.00 carried three hours at 2.00 is 72.00, across the line.
    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(written().lastPredictedSpend).toBe(72);

    // The newest billed row has no Bedrock slice, so the monitored term drops out
    // and the projection would read 70.50, back under the line; the 72.00
    // already compared is held instead.
    const afterCrossing = written();
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 60, null),
      costRow(LEASE_A, "2026-09-15T00:00:00.000Z", 32, 8),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease(afterCrossing)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(written().lastPredictedSpend).toBe(72);

    // The slice returns and the projection is 72.00 again, which is not a
    // new crossing.
    const whileDropped = written();
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    mockLeaseScan({ Active: [{ Items: [lease(whileDropped)] }] });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(fakeStore.breachRows).toHaveLength(1);
    expect(sentEvents()).toHaveLength(1);
    expect(written().lastPredictedSpend).toBe(72);
  });

  it("counts one agent turn once, before and after Cost Explorer bills it, so a threshold or maxSpend just above it never fires", async () => {
    // The agent's inference runs in the lease's own account, so its turn is
    // Bedrock usage like any other: read live from CloudWatch, then billed.
    // One region at $1 per thousand prices the turn's 1,000 tokens at 1.00.
    rateHolder.rate = { ratePerUnit: 1, unitDivisor: 1000 };
    const context = pollContextIn(["us-east-1"]);
    // The Agent Worker banks the same 1.00 in Sandbox Spaces usage for both polls.
    const sandboxSpacesUsage = generateSchemaData(
      LeaseUserSandboxSpacesUsageSchema,
      {
        leaseId: LEASE_A,
        sandboxSpacesEstimatedTokenCostAccrued: 1,
      },
    );
    vi.spyOn(IsbServices, "sandboxSpacesUsageStore").mockReturnValue({
      listLeaseUserUsage: async () => ({ usage: [sandboxSpacesUsage] }),
      getLeaseUserUsage: async () => sandboxSpacesUsage,
    } as any);
    const lease = (lastEvaluatedSpend: number) =>
      monitoredLease({
        uuid: LEASE_A,
        sandboxSpacesEnabled: true,
        maxSpend: 11.5,
        budgetThresholds: [
          { dollarsSpent: 11.5, action: "ALERT", triggerOn: "REPORTED" },
        ],
        lastEvaluatedSpend,
      });
    const figuresLogged = () =>
      vi
        .mocked(Logger.prototype.debug)
        .mock.calls.filter(
          ([message]) => message === `token poll figures for lease ${LEASE_A}`,
        )
        .map(([, fields]) => fields);
    // The turn's tokens stay in CloudWatch for both polls.
    mockUsage({
      [LINKED_ACCOUNT_ID]: { "amazon.nova-pro-v1:0": counts(1000) },
    });

    // Cost Explorer has not billed the turn yet.
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 10, 0),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease(10)] }] });

    await pollBedrockTokenUsage({} as any, context);

    expect(fakeStore.appendBedrockTokenRow).toHaveBeenCalledTimes(1);
    expect(fakeStore.appendBedrockTokenRow.mock.calls[0]![0]).toMatchObject({
      monitoredBedrockTokenCost: 1,
      monitoredBedrockTokenCostDelta: 1,
    });
    // 10.00 billed less its 0.00 slice plus the 1.00 live, not 12.00
    expect(figuresLogged()).toEqual([
      expect.objectContaining({
        evaluatedSpend: 11,
        monitoredBedrockTokenCost: 1,
      }),
    ]);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(11);
    expect(fakeStore.breachRows).toEqual([]);
    expect(sentEvents()).toEqual([]);

    // Cost Explorer has billed the turn, so its Bedrock slice holds the 1.00.
    const afterFirstPoll = pollScalarsWritten()[0]![
      ":lastEvaluatedSpend"
    ] as number;
    mockDynamoClient.resetHistory();
    fakeStore.costRows.set(LEASE_A, [
      costRow(LEASE_A, "2026-09-15T10:55:00.000Z", 11, 1),
      costRow(LEASE_A, "2026-09-15T08:00:00.000Z", 10, 0),
    ]);
    mockLeaseScan({ Active: [{ Items: [lease(afterFirstPoll)] }] });

    await pollBedrockTokenUsage({} as any, context);

    // The turn's tokens sit behind the stored anchor, so no second row.
    expect(fakeStore.appendBedrockTokenRow).toHaveBeenCalledTimes(1);
    // 11.00 billed less its 1.00 slice plus the same 1.00 live
    expect(figuresLogged()[1]).toMatchObject({
      evaluatedSpend: 11,
      monitoredBedrockTokenCost: 1,
    });
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(11);
    expect(fakeStore.breachRows).toEqual([]);
    expect(sentEvents()).toEqual([]);
    // A failed read compared as zero would hide a figure counted twice.
    expect(Logger.prototype.error).not.toHaveBeenCalled();
  });

  it("raises the breach without a comparison insight when the earlier observation cannot be read", async () => {
    vi.spyOn(fakeStore, "getRecentCostObservations").mockRejectedValue(
      new Error("dynamo down"),
    );
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                {
                  dollarsSpent: 65,
                  action: "FREEZE_ACCOUNT",
                  triggerOn: "REPORTED",
                },
              ],
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    // the largest service still names itself; only the comparison is lost
    expect(fakeStore.breachRows[0]).toMatchObject({
      insight: { kind: "COMPOSITION", service: "AWS Lambda", amount: 40 },
    });
    expect(sentEvents()).toHaveLength(1);
    expect(sentEvents()[0]).toBeInstanceOf(LeaseFreezingThresholdBreachedAlert);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        "raising the breach without a comparison insight",
      ),
      expect.objectContaining({ leaseId: LEASE_A, error: "dynamo down" }),
    );
  });

  it("publishes the event and advances the figures even when the audit row cannot be written", async () => {
    fakeStore.appendBreachRecord.mockRejectedValue(new Error("write failed"));
    fakeStore.costRows.set(LEASE_A, anchorRow(LEASE_A));
    fakeStore.tokenRows.set(LEASE_A, liveRows(LEASE_A));
    mockLeaseScan({
      Active: [
        {
          Items: [
            monitoredLease({
              uuid: LEASE_A,
              budgetThresholds: [
                { dollarsSpent: 65, action: "ALERT", triggerOn: "REPORTED" },
              ],
              lastEvaluatedSpend: 60,
            }),
          ],
        },
      ],
    });

    await pollBedrockTokenUsage({} as any, pollContext());

    expect(sentEvents()).toHaveLength(1);
    expect(pollScalarsWritten()[0]![":lastEvaluatedSpend"]).toBe(66);
    expect(Logger.prototype.error).toHaveBeenCalledWith(
      expect.stringContaining("breach record write failed"),
      expect.anything(),
    );
  });
});

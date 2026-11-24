// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  CloudWatchClient,
  GetMetricDataCommand,
  ListMetricsCommand,
  MetricDataQuery,
} from "@aws-sdk/client-cloudwatch";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BEDROCK_METRIC_PERIOD_SECONDS,
  BEDROCK_TOKEN_METRICS,
  MAX_CONCURRENT_WINDOW_READS,
  MAX_QUERIES_PER_CALL,
  readRegionTokenUsage,
  TokenUsageLease,
} from "@amzn/innovation-sandbox-commons/isb-services/bedrock-token-cost/index.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  TokenCounts,
  TokenType,
  UNATTRIBUTED_MODEL_ID,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

const cloudWatchMock = mockClient(CloudWatchClient);
const logger = new Logger({ serviceName: "test" });
const REGION = "us-east-1";
const PERIOD_MS = BEDROCK_METRIC_PERIOD_SECONDS * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

// Buckets closed less than ten minutes before "now" may still be receiving
// late data points, so 11:55 is the exclusive end and 11:50 the newest
// complete bucket. Buckets younger than an hour may hold a model list-metrics
// has not listed yet, so windows reaching further back are split at 11:05.
const NOW = Date.parse("2026-09-15T12:07:30.000Z");
const END = "2026-09-15T11:55:00.000Z";
const NEWEST_COMPLETE = "2026-09-15T11:50:00.000Z";
const LISTING_SETTLED = Date.parse("2026-09-15T11:05:00.000Z");
const ANCHOR = "2026-09-15T11:30:00.000Z";

// `aws cloudwatch list-metrics --namespace AWS/Bedrock`, 2026-09-15, an account
// with token usage: these metric names, with dimension sets () and (ModelId).
// The names are pinned against it because a wrong name returns an empty
// series, which reads as no usage. On the same day a GetMetricData read of the
// dimensionless series equalled the sum of the per-ModelId series for all four
// token metrics over 72 hours, which is what lets the probe stand in for the
// fan-out.
const LIVE_METRIC_NAMES = [
  "CacheReadInputTokenCount",
  "CacheWriteInputTokenCount",
  "EstimatedTPMQuotaUsage",
  "InputTokenCount",
  "InvocationClientErrors",
  "InvocationLatency",
  "InvocationServerErrors",
  "Invocations",
  "OutputTokenCount",
  "TimeToFirstToken",
];

const counts = (
  input: number,
  output = 0,
  cacheRead = 0,
  cacheWrite = 0,
): TokenCounts => ({ input, output, cacheRead, cacheWrite });

type Usage = Record<string, Record<string, TokenCounts>>;
/** Usage may differ by window, so a model can be old news or brand new. */
type UsageByWindow = Usage | ((startMs: number) => Usage);

const typeOf = (metricName: string) =>
  (Object.keys(BEDROCK_TOKEN_METRICS) as TokenType[]).find(
    (type) => BEDROCK_TOKEN_METRICS[type] === metricName,
  )!;

const listMetricsPage = (modelIds: string[]) => ({
  Metrics: modelIds.map((modelId) => ({
    Namespace: "AWS/Bedrock",
    MetricName: "Invocations",
    Dimensions: [{ Name: "ModelId", Value: modelId }],
  })),
});

/**
 * CloudWatch as the hub sees it: the dimensionless series is the sum over the
 * account's models, the ModelId series is one model, and a series with no data
 * is a Complete result with no values. `listed` overrides which models
 * list-metrics reports, which is what lets a test fall behind the data.
 */
function mockUsage(usage: UsageByWindow, listed?: Record<string, string[]>) {
  const usageIn = typeof usage === "function" ? usage : () => usage;
  const listedModels =
    listed ??
    Object.fromEntries(
      Object.entries(usageIn(NOW)).map(([account, models]) => [
        account,
        Object.keys(models),
      ]),
    );
  cloudWatchMock
    .on(ListMetricsCommand)
    .callsFake((input) =>
      listMetricsPage(listedModels[input.OwningAccount] ?? []),
    );
  cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
    MetricDataResults: input.MetricDataQueries.map((query: MetricDataQuery) => {
      const models = usageIn(input.StartTime.getTime())[query.AccountId!] ?? {};
      const modelId = query.MetricStat!.Metric!.Dimensions?.[0]?.Value;
      const type = typeOf(query.MetricStat!.Metric!.MetricName!);
      const value =
        modelId === undefined
          ? Object.values(models).reduce((total, c) => total + c[type], 0)
          : (models[modelId]?.[type] ?? 0);
      return value === 0
        ? { Id: query.Id, StatusCode: "Complete", Timestamps: [], Values: [] }
        : {
            Id: query.Id,
            StatusCode: "Complete",
            Timestamps: [input.StartTime],
            Values: [value],
          };
    }),
  }));
}

const lease = (
  leaseId: string,
  awsAccountId: string,
  overrides: Partial<TokenUsageLease> = {},
): TokenUsageLease => ({
  leaseId,
  awsAccountId,
  startDate: "2026-09-01T00:00:00.000Z",
  coveredThrough: { [REGION]: ANCHOR },
  ...overrides,
});

const read = (leases: TokenUsageLease[], nowMs = NOW) =>
  readRegionTokenUsage({
    cloudWatch: new CloudWatchClient({ region: REGION }),
    leases,
    nowMs,
    logger,
  });

const metricDataInputs = () =>
  cloudWatchMock
    .commandCalls(GetMetricDataCommand)
    .map((call) => call.args[0].input);

beforeEach(() => {
  cloudWatchMock.reset();
  vi.spyOn(Logger.prototype, "warn").mockImplementation(() => {});
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("readRegionTokenUsage", () => {
  it("pins the four token metric names to what list-metrics reports and the period to five minutes", () => {
    for (const name of Object.values(BEDROCK_TOKEN_METRICS)) {
      expect(LIVE_METRIC_NAMES).toContain(name);
    }
    expect(Object.keys(BEDROCK_TOKEN_METRICS).sort()).toEqual([
      "cacheRead",
      "cacheWrite",
      "input",
      "output",
    ]);
    expect(BEDROCK_METRIC_PERIOD_SECONDS).toBe(300);
    expect(MAX_QUERIES_PER_CALL).toBe(500);
  });

  it("probes the account-wide series and fans out to models only for the leases whose probe moved", async () => {
    mockUsage({
      "222222222222": {
        "amazon.nova-pro-v1:0": counts(1000, 200, 30, 4),
        "anthropic.claude-haiku-4-5-20251001-v1:0": counts(50),
        "amazon.nova-micro-v1:0": counts(0),
      },
      "333333333333": {},
    });

    const usage = await read([
      lease("spending", "222222222222"),
      lease("idle", "333333333333"),
    ]);

    // One probe call for the shared window, then one fan-out call over the
    // same window.
    const [probe, fanOut, ...rest] = metricDataInputs();
    expect(rest).toEqual([]);
    expect(probe!.MetricDataQueries).toHaveLength(8);
    for (const query of probe!.MetricDataQueries!) {
      // AccountId is a field beside MetricStat, never a dimension.
      expect(query.AccountId).toMatch(/^(222222222222|333333333333)$/);
      expect(query.MetricStat!.Metric!.Dimensions).toBeUndefined();
      expect(query.MetricStat!.Metric!.Namespace).toBe("AWS/Bedrock");
      expect(query.MetricStat!.Period).toBe(300);
      expect(query.MetricStat!.Stat).toBe("Sum");
    }
    const listCalls = cloudWatchMock.commandCalls(ListMetricsCommand);
    expect(listCalls).toHaveLength(1);
    expect(listCalls[0]!.args[0].input).toEqual({
      Namespace: "AWS/Bedrock",
      Dimensions: [{ Name: "ModelId" }],
      IncludeLinkedAccounts: true,
      OwningAccount: "222222222222",
      NextToken: undefined,
    });
    expect(fanOut!.MetricDataQueries).toHaveLength(12);
    expect(fanOut!.StartTime).toEqual(probe!.StartTime);
    expect(fanOut!.EndTime).toEqual(probe!.EndTime);
    for (const query of fanOut!.MetricDataQueries!) {
      expect(query.AccountId).toBe("222222222222");
      expect(query.MetricStat!.Metric!.Dimensions).toEqual([
        { Name: "ModelId", Value: expect.any(String) },
      ]);
    }
    // The idle lease is absent, and so is the model with no usage.
    expect(usage).toEqual({
      region: REGION,
      leases: {
        spending: {
          tokens: {
            "amazon.nova-pro-v1:0": counts(1000, 200, 30, 4),
            "anthropic.claude-haiku-4-5-20251001-v1:0": counts(50),
          },
          coveredThrough: NEWEST_COMPLETE,
        },
      },
    });
  });

  it("starts a window one period after the anchor, never at the anchor, and from the lease start where there is none", async () => {
    mockUsage({});

    const usage = await read([
      lease("anchored", "222222222222"),
      lease("also-anchored", "333333333333"),
      lease("fresh", "444444444444", {
        startDate: "2026-09-15T11:12:17.000Z",
        coveredThrough: {},
      }),
      // Anchored on the newest complete bucket: nothing complete to read yet.
      lease("caught-up", "555555555555", {
        coveredThrough: { [REGION]: NEWEST_COMPLETE },
      }),
    ]);

    const inputs = metricDataInputs();
    expect(inputs).toHaveLength(2);
    const byStart = new Map(
      inputs.map((input) => [input.StartTime!.toISOString(), input]),
    );
    const anchored = byStart.get("2026-09-15T11:35:00.000Z")!;
    expect(anchored.StartTime!.getTime()).toBe(Date.parse(ANCHOR) + PERIOD_MS);
    expect(anchored.StartTime!.getTime()).not.toBe(Date.parse(ANCHOR));
    expect(anchored.MetricDataQueries).toHaveLength(8);
    // Aligned down to the bucket holding the lease start.
    const fresh = byStart.get("2026-09-15T11:10:00.000Z")!;
    expect(fresh.MetricDataQueries).toHaveLength(4);
    expect(fresh.MetricDataQueries![0]!.AccountId).toBe("444444444444");
    for (const input of inputs) {
      expect(input.EndTime!.toISOString()).toBe(END);
      // Buckets closed less than ten minutes ago are left to settle.
      expect(NOW - input.EndTime!.getTime()).toBeGreaterThanOrEqual(
        2 * PERIOD_MS,
      );
    }
    expect(
      inputs.flatMap((input) => input.MetricDataQueries!),
    ).not.toContainEqual(
      expect.objectContaining({ AccountId: "555555555555" }),
    );
    expect(usage).toEqual({ region: REGION, leases: {} });
  });

  it("resumes from its own anchor with no gap and no overlap", async () => {
    mockUsage({ "222222222222": { m: counts(1) } });
    const first = await read([lease("l", "222222222222")]);
    const firstEnd = metricDataInputs()[0]!.EndTime!;
    cloudWatchMock.resetHistory();

    await read(
      [
        lease("l", "222222222222", {
          coveredThrough: { [first.region]: first.leases.l!.coveredThrough },
        }),
      ],
      NOW + 10 * 60 * 1000,
    );

    expect(metricDataInputs()[0]!.StartTime).toEqual(firstEnd);
  });

  it("requests four metrics per lease on the probe and four per model on the fan-out, and nothing for idle leases", async () => {
    mockUsage(
      {
        "222222222222": { m1: counts(1), m2: counts(2), m3: counts(3) },
        "333333333333": {},
        "444444444444": {},
      },
      // Idle accounts have models on record; the fan-out must still skip them.
      {
        "222222222222": ["m1", "m2", "m3"],
        "333333333333": ["m1"],
        "444444444444": ["m1"],
      },
    );

    await read([
      lease("spending", "222222222222"),
      lease("idle-1", "333333333333"),
      lease("idle-2", "444444444444"),
    ]);

    const [probe, fanOut, ...rest] = metricDataInputs();
    expect(rest).toEqual([]);
    expect(probe!.MetricDataQueries).toHaveLength(4 * 3);
    expect(fanOut!.MetricDataQueries).toHaveLength(4 * 3);
  });

  it("lists an account's models once however many of its leases are spending", async () => {
    mockUsage({ "222222222222": { m: counts(1) } });

    const usage = await read([
      lease("first", "222222222222"),
      lease("second", "222222222222"),
    ]);

    expect(cloudWatchMock.commandCalls(ListMetricsCommand)).toHaveLength(1);
    expect(Object.keys(usage.leases).sort()).toEqual(["first", "second"]);
    expect(usage.leases.first!.tokens).toEqual({ m: counts(1) });
  });

  it("lists an account's models once even when its leases fall in batches read at the same time", async () => {
    mockUsage({ "222222222222": { m: counts(1) } });

    const usage = await read([
      lease("first", "222222222222"),
      lease("second", "222222222222", {
        coveredThrough: { [REGION]: "2026-09-15T11:20:00.000Z" },
      }),
    ]);

    expect(cloudWatchMock.commandCalls(ListMetricsCommand)).toHaveLength(1);
    expect(usage.leases.first!.tokens).toEqual({ m: counts(1) });
    expect(usage.leases.second!.tokens).toEqual({ m: counts(1) });
  });

  it("reads window batches a few at a time, so a fleet of idle leases on drifting anchors still fits the run", async () => {
    // Every lease on its own anchor: one batch each, all inside the listing lag.
    const leases = Array.from({ length: 7 }, (_, i) =>
      lease(`idle-${i}`, `2222222222${String(i).padStart(2, "0")}`, {
        coveredThrough: {
          [REGION]: new Date(Date.parse(ANCHOR) - i * PERIOD_MS).toISOString(),
        },
      }),
    );
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let inFlight = 0;
    let peak = 0;
    cloudWatchMock.on(GetMetricDataCommand).callsFake(async (input) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await gate;
      inFlight -= 1;
      return {
        MetricDataResults: input.MetricDataQueries.map(
          (query: MetricDataQuery) => ({
            Id: query.Id,
            StatusCode: "Complete",
            Timestamps: [],
            Values: [],
          }),
        ),
      };
    });

    const reading = read(leases);

    // The bound fills, then nothing more is sent until a read completes.
    await vi.waitFor(() => expect(inFlight).toBe(MAX_CONCURRENT_WINDOW_READS));
    expect(metricDataInputs()).toHaveLength(MAX_CONCURRENT_WINDOW_READS);
    release();
    await reading;
    expect(peak).toBe(MAX_CONCURRENT_WINDOW_READS);
    expect(metricDataInputs()).toHaveLength(leases.length);
  });

  it("splits more than 500 queries across calls and joins every result back to its own lease and model", async () => {
    const leases = Array.from({ length: 126 }, (_, i) =>
      lease(`lease-${i}`, String(100000000000 + i)),
    );
    // Each account's usage is its own numbers, so a misattributed result shows.
    const own = (l: TokenUsageLease) => Number(l.awsAccountId.slice(-3));
    mockUsage(
      Object.fromEntries(
        leases.map((l) => [
          l.awsAccountId,
          { a: counts(own(l) + 1), b: counts(0, own(l) + 2) },
        ]),
      ),
    );

    const usage = await read(leases);

    // 126 leases x 4 metrics = 504 probe queries; 126 x 2 models x 4 on the fan-out.
    const inputs = metricDataInputs();
    expect(inputs.map((input) => input.MetricDataQueries!.length)).toEqual([
      500, 4, 500, 500, 8,
    ]);
    for (const input of inputs) {
      const ids = input.MetricDataQueries!.map((query) => query.Id!);
      expect(new Set(ids).size).toBe(ids.length);
      for (const id of ids) {
        expect(id).toMatch(/^[a-z][A-Za-z0-9_]*$/);
        expect(id.length).toBeLessThanOrEqual(255);
      }
    }
    for (const l of leases) {
      expect(usage.leases[l.leaseId]).toEqual({
        tokens: { a: counts(own(l) + 1), b: counts(0, own(l) + 2) },
        coveredThrough: NEWEST_COMPLETE,
      });
    }
  });

  it("follows NextToken to exhaustion with the same queries and window, summing the pages", async () => {
    cloudWatchMock.on(ListMetricsCommand).resolves(listMetricsPage(["m"]));
    // Captured as each call is made: the paginator carries one input object
    // across its pages, so the recorded calls all show the final token.
    const calls: {
      token: string | undefined;
      queries: string;
      window: string;
    }[] = [];
    cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => {
      calls.push({
        token: input.NextToken,
        queries: JSON.stringify(input.MetricDataQueries),
        window: `${input.StartTime.toISOString()}/${input.EndTime.toISOString()}`,
      });
      return {
        MetricDataResults: input.MetricDataQueries.map(
          (query: MetricDataQuery) => ({
            Id: query.Id,
            StatusCode: input.NextToken ? "Complete" : "PartialData",
            Timestamps: [input.StartTime],
            Values:
              typeOf(query.MetricStat!.Metric!.MetricName!) === "input"
                ? [input.NextToken ? 50 : 100]
                : [],
          }),
        ),
        NextToken: input.NextToken ? undefined : "page-2",
      };
    });

    const usage = await read([lease("paged", "222222222222")]);

    expect(calls.map((call) => call.token)).toEqual([
      undefined,
      "page-2",
      undefined,
      "page-2",
    ]);
    const [probe, probePage2] = calls;
    expect(probePage2!.queries).toEqual(probe!.queries);
    expect(probePage2!.window).toEqual(probe!.window);
    expect(usage.leases.paged!.tokens).toEqual({ m: counts(150) });
  });

  it("follows every page of list-metrics before fanning out", async () => {
    mockUsage({ "222222222222": { a: counts(1), b: counts(2) } });
    const tokens: (string | undefined)[] = [];
    cloudWatchMock.on(ListMetricsCommand).callsFake((input) => {
      tokens.push(input.NextToken);
      return input.NextToken
        ? listMetricsPage(["b"])
        : { ...listMetricsPage(["a"]), NextToken: "models-2" };
    });

    const usage = await read([lease("l", "222222222222")]);

    expect(tokens).toEqual([undefined, "models-2"]);
    expect(usage.leases.l!.tokens).toEqual({ a: counts(1), b: counts(2) });
  });

  it("holds a lease's anchor when a model is newer than list-metrics has caught up with", async () => {
    mockUsage(
      {
        "222222222222": { known: counts(100), unlisted: counts(5) },
        "333333333333": { m: counts(7) },
      },
      { "222222222222": ["known"], "333333333333": ["m"] },
    );

    const usage = await read([
      lease("lagging", "222222222222"),
      lease("fine", "333333333333"),
    ]);

    expect(usage).toEqual({
      region: REGION,
      leases: {
        fine: { tokens: { m: counts(7) }, coveredThrough: NEWEST_COMPLETE },
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(LogPatterns.BedrockTokensUnattributed.pattern),
      {
        leaseId: "lagging",
        region: REGION,
        shortfall: counts(5),
        modelIds: ["known"],
      },
    );
  });

  it("holds a lease's anchor when no model is listed at all, and records per-model counts that exceed the probe", async () => {
    cloudWatchMock
      .on(ListMetricsCommand)
      .callsFake((input) =>
        listMetricsPage(input.OwningAccount === "222222222222" ? ["m"] : []),
      );
    cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
      MetricDataResults: input.MetricDataQueries.map(
        (query: MetricDataQuery) => ({
          Id: query.Id,
          StatusCode: "Complete",
          Timestamps: [input.StartTime],
          Values: [query.MetricStat!.Metric!.Dimensions ? 15 : 10],
        }),
      ),
    }));

    const usage = await read([
      lease("over", "222222222222"),
      lease("unlisted", "333333333333"),
    ]);

    // Waiting cannot shrink an over-count, so the more specific figure stands.
    expect(usage.leases).toEqual({
      over: {
        tokens: { m: counts(15, 15, 15, 15) },
        coveredThrough: NEWEST_COMPLETE,
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("exceed the account-wide counts"),
      expect.objectContaining({
        leaseId: "over",
        shortfall: counts(-5, -5, -5, -5),
      }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("holding the lease's anchor"),
      expect.objectContaining({
        leaseId: "unlisted",
        shortfall: counts(10, 10, 10, 10),
        modelIds: [],
      }),
    );
  });

  it("reads a window reaching past the listing lag in two parts, so a stale shortfall is recorded while a fresh one only trails", async () => {
    const forgottenThenFresh = (startMs: number): Usage =>
      startMs < LISTING_SETTLED
        ? { "222222222222": { known: counts(100), forgotten: counts(5, 1) } }
        : { "222222222222": { known: counts(10), fresh: counts(3) } };
    const lateOptIn = lease("late-opt-in", "222222222222", {
      startDate: new Date(NOW - 20 * DAY_MS).toISOString(),
      coveredThrough: {},
    });

    // Only the old part falls short: recorded unattributed, anchor advances.
    mockUsage(forgottenThenFresh, { "222222222222": ["known", "fresh"] });
    const recorded = await read([lateOptIn]);

    const [oldPart, , freshPart] = metricDataInputs();
    expect(oldPart!.StartTime!.getTime()).toBe(
      Math.floor((NOW - 20 * DAY_MS) / PERIOD_MS) * PERIOD_MS,
    );
    expect(oldPart!.EndTime!.getTime()).toBe(LISTING_SETTLED);
    expect(freshPart!.StartTime!.getTime()).toBe(LISTING_SETTLED);
    expect(freshPart!.EndTime!.toISOString()).toBe(END);
    expect(recorded).toEqual({
      region: REGION,
      leases: {
        "late-opt-in": {
          tokens: {
            known: counts(110),
            fresh: counts(3),
            [UNATTRIBUTED_MODEL_ID]: counts(5, 1),
          },
          coveredThrough: NEWEST_COMPLETE,
        },
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining(
        `recording the shortfall as ${UNATTRIBUTED_MODEL_ID}`,
      ),
      {
        leaseId: "late-opt-in",
        region: REGION,
        shortfall: counts(5, 1),
        modelIds: ["known"],
      },
    );

    // The fresh part falls short too: the old part is recorded and the anchor
    // trails at the end of it, so a recurring shortfall delays the lease by
    // the listing lag rather than freezing it.
    cloudWatchMock.reset();
    vi.mocked(Logger.prototype.warn).mockClear();
    mockUsage(forgottenThenFresh, { "222222222222": ["known"] });
    const trailing = await read([lateOptIn]);

    expect(trailing.leases).toEqual({
      "late-opt-in": {
        tokens: { known: counts(100), [UNATTRIBUTED_MODEL_ID]: counts(5, 1) },
        coveredThrough: new Date(LISTING_SETTLED - PERIOD_MS).toISOString(),
      },
    });
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("holding the lease's anchor"),
      expect.objectContaining({ leaseId: "late-opt-in", shortfall: counts(3) }),
    );
  });

  it("holds a lease entirely when its whole window is younger than the listing lag and falls short", async () => {
    mockUsage(
      { "222222222222": { known: counts(1), unlisted: counts(1) } },
      { "222222222222": ["known"] },
    );

    const usage = await read([lease("young", "222222222222")]);

    expect(usage.leases).toEqual({});
  });

  it("skips a lease whose anchor is not a date and still reads the others", async () => {
    mockUsage({ "333333333333": { m: counts(7) } });

    const usage = await read([
      lease("broken", "222222222222", {
        coveredThrough: { [REGION]: "not-a-date" },
      }),
      lease("fine", "333333333333"),
    ]);

    expect(Object.keys(usage.leases)).toEqual(["fine"]);
    expect(
      metricDataInputs().flatMap((input) => input.MetricDataQueries!),
    ).not.toContainEqual(
      expect.objectContaining({ AccountId: "222222222222" }),
    );
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("is not a date"),
      {
        leaseId: "broken",
        region: REGION,
        anchor: "not-a-date",
        startDate: "2026-09-01T00:00:00.000Z",
      },
    );
  });

  it("skips a lease whose anchor is in the future and says so", async () => {
    mockUsage({});
    const future = new Date(NOW + DAY_MS).toISOString();

    const usage = await read([
      lease("ahead", "222222222222", { coveredThrough: { [REGION]: future } }),
    ]);

    expect(usage.leases).toEqual({});
    expect(metricDataInputs()).toEqual([]);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("is in the future"),
      expect.objectContaining({ leaseId: "ahead", anchor: future }),
    );
  });

  it("quietly waits for a lease that started inside the settling window", async () => {
    mockUsage({});

    const usage = await read([
      lease("brand-new", "222222222222", {
        startDate: new Date(NOW - 5 * 60 * 1000).toISOString(),
        coveredThrough: {},
      }),
    ]);

    // No bucket has closed for it yet; nothing is wrong, so nothing is said.
    expect(usage.leases).toEqual({});
    expect(metricDataInputs()).toEqual([]);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();
  });

  it("starts no earlier than CloudWatch retention, and says what was lost only behind an anchor", async () => {
    mockUsage({});
    const oldestReadable =
      Math.floor((NOW - 63 * DAY_MS) / PERIOD_MS) * PERIOD_MS;

    await read([
      lease("never-spent", "222222222222", {
        startDate: new Date(NOW - 90 * DAY_MS).toISOString(),
        coveredThrough: {},
      }),
    ]);
    expect(metricDataInputs()[0]!.StartTime!.getTime()).toBe(oldestReadable);
    expect(Logger.prototype.warn).not.toHaveBeenCalled();

    cloudWatchMock.resetHistory();
    await read([
      lease("stalled", "333333333333", {
        coveredThrough: { [REGION]: "2026-06-17T12:00:00.000Z" },
      }),
    ]);
    expect(metricDataInputs()[0]!.StartTime!.getTime()).toBe(oldestReadable);
    expect(Logger.prototype.warn).toHaveBeenCalledTimes(1);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      expect.stringContaining("before CloudWatch retention are lost"),
      {
        leaseId: "stalled",
        region: REGION,
        from: "2026-06-17T12:05:00.000Z",
      },
    );
  });

  it.each(["InternalError", "Forbidden"])(
    "fails the region on a %s result rather than reading it as no usage",
    async (statusCode) => {
      cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
        MetricDataResults: input.MetricDataQueries.map(
          (query: MetricDataQuery) => ({
            Id: query.Id,
            StatusCode: statusCode,
            Messages: [{ Code: statusCode, Value: "try again" }],
          }),
        ),
      }));

      await expect(read([lease("l", "222222222222")])).rejects.toThrow(
        `GetMetricData failed for query q0: ${statusCode} try again`,
      );
    },
  );

  it("fails the region on partial data with no next page", async () => {
    cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
      MetricDataResults: input.MetricDataQueries.map(
        (query: MetricDataQuery) => ({
          Id: query.Id,
          StatusCode: "PartialData",
          Timestamps: [],
          Values: [],
        }),
      ),
    }));

    await expect(read([lease("l", "222222222222")])).rejects.toThrow(
      "GetMetricData failed for query q0: PartialData",
    );
  });

  it("fails the region when a result is missing or unknown rather than guessing at a join", async () => {
    cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
      MetricDataResults: input.MetricDataQueries.slice(1).map(
        (query: MetricDataQuery) => ({
          Id: query.Id,
          StatusCode: "Complete",
          Timestamps: [],
          Values: [],
        }),
      ),
    }));
    await expect(read([lease("l", "222222222222")])).rejects.toThrow(
      "GetMetricData returned no result for query q0",
    );

    cloudWatchMock.on(GetMetricDataCommand).resolves({
      MetricDataResults: [
        { Id: "zz", StatusCode: "Complete", Timestamps: [], Values: [] },
      ],
    });
    await expect(read([lease("l", "222222222222")])).rejects.toThrow(
      "GetMetricData returned a result for an unknown query id: zz",
    );
  });

  it("propagates an SDK failure and surfaces operation-level messages", async () => {
    cloudWatchMock.on(GetMetricDataCommand).rejects(new Error("throttled"));
    await expect(read([lease("l", "222222222222")])).rejects.toThrow(
      "throttled",
    );

    cloudWatchMock.on(GetMetricDataCommand).callsFake((input) => ({
      Messages: [{ Code: "MaxMetricsExceeded", Value: "too many" }],
      MetricDataResults: input.MetricDataQueries.map(
        (query: MetricDataQuery) => ({
          Id: query.Id,
          StatusCode: "Complete",
          Timestamps: [],
          Values: [],
        }),
      ),
    }));
    await read([lease("l", "222222222222")]);
    expect(Logger.prototype.warn).toHaveBeenCalledWith(
      "GetMetricData returned messages",
      { messages: [{ Code: "MaxMetricsExceeded", Value: "too many" }] },
    );
  });
});

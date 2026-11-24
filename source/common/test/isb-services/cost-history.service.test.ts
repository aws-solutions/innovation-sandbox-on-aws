// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, it, vi } from "vitest";

import { NewestRecordResult } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  calculateCostHistoryTtl,
  CostObservation,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import {
  bedrockTokenQueryWindowStart,
  buildCostObservation,
  CostHistoryServices,
  costQueryWindowStart,
  getRecentObservations,
  NewCostObservation,
  recordCostObservation,
  RecordCostObservationInput,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { MonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";

const lease = {
  uuid: "750e8400-e29b-41d4-a716-446655440002",
  startDate: "2026-08-09T00:00:00.000Z",
  expirationDate: "2026-09-08T00:00:00.000Z",
  leaseDurationInHours: 720,
} as MonitoredLease;

const RETENTION_DAYS = 30;

function storedRow(overrides: Partial<CostObservation> = {}): CostObservation {
  return {
    leaseUuid: lease.uuid,
    sk: "COST#2026-08-11T00:00:00.000Z",
    billedCostAccrued: 60,
    billedCostDelta: 28,
    predictedCostAtRefresh: null,
    latestPeriodStart: "2026-08-11",
    latestPeriodAmount: 5,
    billedBedrockTokenCost: null,
    ttl: futureTtl(),
    meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    ...overrides,
  };
}

const noHistory: NewestRecordResult<CostObservation> = {
  complete: true,
  result: undefined,
};

function anchored(row: CostObservation): NewestRecordResult<CostObservation> {
  return { complete: true, result: row };
}

const emptyPage = { result: [], nextPageIdentifier: null };

function inputWith(
  overrides: Partial<RecordCostObservationInput> = {},
): RecordCostObservationInput {
  return {
    lease,
    anchor: noHistory,
    source: { kind: "TAG", buckets: {} },
    predictedCostAtRefresh: null,
    bedrockTokens: null,
    retentionDays: RETENTION_DAYS,
    ...overrides,
  };
}

function services(): CostHistoryServices & {
  appended: NewCostObservation[];
  warn: ReturnType<typeof vi.fn>;
} {
  const appended: NewCostObservation[] = [];
  const logger = new Logger({ serviceName: "test" });
  const warn = vi.spyOn(logger, "warn").mockImplementation(() => undefined);
  return {
    appended,
    warn,
    logger,
    costHistoryStore: {
      appendCostObservation: async (row) => {
        appended.push(row);
      },
      getNewestCostObservation: async () => noHistory,
      getRecentCostObservations: async () => ({ complete: true, result: [] }),
      getNewestBedrockTokenRow: async () => ({
        complete: true,
        result: undefined,
      }),
      listCostObservations: async () => ({
        complete: true,
        result: [],
        nextPageIdentifier: null,
      }),
      listBreachRecordPage: async () => emptyPage,
      listBedrockTokenRows: async () => emptyPage,
    },
  };
}

describe("buildCostObservation", () => {
  describe("anchoring on the newest stored observation", () => {
    it("sums only the lease's own buckets from its anchor day, not from the fleet window start", () => {
      const anchor = storedRow({
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              // The window opened earlier for another lease; these days are
              // already inside the anchor's cumulative.
              "2026-08-09": { amount: 20 },
              "2026-08-10": { amount: 35 },
              "2026-08-11": { amount: 5 },
              "2026-08-12": { amount: 10 },
            },
          },
        }),
        anchor,
      );

      expect(row?.billedCostAccrued).toBe(70);
      expect(row?.billedCostDelta).toBe(10);
      expect(row?.latestPeriodStart).toBe("2026-08-12");
      expect(row?.latestPeriodAmount).toBe(10);
    });

    it("picks up the anchor day filling from $5.00 to $30.00 as exactly $25.00 without double counting earlier days", () => {
      const anchor = storedRow({
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-10": { amount: 35 },
              "2026-08-11": { amount: 30 },
            },
          },
        }),
        anchor,
      );

      expect(row?.billedCostAccrued).toBe(85);
      expect(row?.billedCostDelta).toBe(25);
      expect(row?.latestPeriodStart).toBe("2026-08-11");
      expect(row?.latestPeriodAmount).toBe(30);
    });

    it("moves only the growing service's breakdown entry when the anchor day fills in one service", () => {
      const anchor = storedRow({
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
        serviceBreakdown: { "Amazon Bedrock": 52, "AWS Lambda": 8 },
        latestPeriodServiceAmounts: { "Amazon Bedrock": 4, "AWS Lambda": 1 },
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-11": {
                amount: 30,
                serviceAmounts: { "Amazon Bedrock": 29, "AWS Lambda": 1 },
              },
            },
          },
        }),
        anchor,
      );

      expect(row?.billedCostAccrued).toBe(85);
      expect(row?.serviceBreakdown).toEqual({
        "Amazon Bedrock": 77,
        "AWS Lambda": 8,
      });
      expect(row?.latestPeriodServiceAmounts).toEqual({
        "Amazon Bedrock": 29,
        "AWS Lambda": 1,
      });
      expect(row).not.toHaveProperty("breakdownCoversFrom");
    });

    it("keeps the breakdown summing to the cumulative when the anchor carries one", () => {
      const anchor = storedRow({
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
        serviceBreakdown: { "Amazon Bedrock": 52, "AWS Lambda": 8 },
        latestPeriodServiceAmounts: { "Amazon Bedrock": 4, "AWS Lambda": 1 },
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-11": {
                amount: 7.5,
                serviceAmounts: { "Amazon Bedrock": 6, "AWS Lambda": 1.5 },
              },
              "2026-08-12": {
                amount: 3.25,
                serviceAmounts: { "Amazon Simple Storage Service": 3.25 },
              },
            },
          },
        }),
        anchor,
      );

      const breakdownTotal = Object.values(row!.serviceBreakdown!).reduce(
        (sum, amount) => sum + amount,
        0,
      );
      expect(breakdownTotal).toBeCloseTo(row!.billedCostAccrued, 9);
      expect(row?.billedCostAccrued).toBeCloseTo(65.75, 9);
    });

    it("sums every bucket for a lease with no stored observation", () => {
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              // Deliberately out of order: the newest day comes from the
              // dates, not from insertion order.
              "2026-08-11": { amount: 5 },
              "2026-08-09": { amount: 20 },
              "2026-08-10": { amount: 35 },
            },
          },
        }),
        undefined,
      );

      expect(row?.billedCostAccrued).toBe(60);
      expect(row?.billedCostDelta).toBe(60);
      expect(row?.latestPeriodStart).toBe("2026-08-11");
      expect(row?.latestPeriodAmount).toBe(5);
      expect(row).not.toHaveProperty("serviceBreakdown");
      expect(row).not.toHaveProperty("breakdownCoversFrom");
    });

    it("returns null when the source has no bucket on or after the anchor day", () => {
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: { "2026-08-10": { amount: 35 } },
          },
        }),
        storedRow({ latestPeriodStart: "2026-08-11" }),
      );

      expect(row).toBeNull();
    });
  });

  describe("turning the breakdown on or off mid-history", () => {
    it("starts the breakdown at the anchor day and stamps breakdownCoversFrom when the anchor has none", () => {
      const anchor = storedRow({
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-11": {
                amount: 30,
                serviceAmounts: { "Amazon Bedrock": 29, "AWS Lambda": 1 },
              },
              "2026-08-12": {
                amount: 10,
                serviceAmounts: { "Amazon Bedrock": 10 },
              },
            },
          },
        }),
        anchor,
      );

      expect(row?.billedCostAccrued).toBe(95);
      expect(row?.serviceBreakdown).toEqual({
        "Amazon Bedrock": 39,
        "AWS Lambda": 1,
      });
      expect(row?.latestPeriodServiceAmounts).toEqual({ "Amazon Bedrock": 10 });
      expect(row?.breakdownCoversFrom).toBe("2026-08-11");
    });

    it("stamps no boundary when the anchor is the lease's first billed day, since the breakdown covers everything", () => {
      const firstDayAnchor = storedRow({
        billedCostAccrued: 5,
        latestPeriodStart: "2026-08-11",
        latestPeriodAmount: 5,
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-11": { amount: 7, serviceAmounts: { "AWS Lambda": 7 } },
            },
          },
        }),
        firstDayAnchor,
      );

      expect(row?.billedCostAccrued).toBe(7);
      expect(row?.serviceBreakdown).toEqual({ "AWS Lambda": 7 });
      expect(row).not.toHaveProperty("breakdownCoversFrom");
    });

    it("carries breakdownCoversFrom forward once the anchor has a breakdown", () => {
      const anchor = storedRow({
        billedCostAccrued: 95,
        latestPeriodStart: "2026-08-12",
        latestPeriodAmount: 10,
        serviceBreakdown: { "Amazon Bedrock": 39, "AWS Lambda": 1 },
        latestPeriodServiceAmounts: { "Amazon Bedrock": 10 },
        breakdownCoversFrom: "2026-08-11",
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-12": {
                amount: 12,
                serviceAmounts: { "Amazon Bedrock": 12 },
              },
            },
          },
        }),
        anchor,
      );

      expect(row?.serviceBreakdown).toEqual({
        "Amazon Bedrock": 41,
        "AWS Lambda": 1,
      });
      expect(row?.breakdownCoversFrom).toBe("2026-08-11");
    });

    it("stores no breakdown once collection is turned off, even when the anchor has one", () => {
      const anchor = storedRow({
        serviceBreakdown: { "Amazon Bedrock": 52, "AWS Lambda": 8 },
        latestPeriodServiceAmounts: { "Amazon Bedrock": 4, "AWS Lambda": 1 },
      });
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: { "2026-08-11": { amount: 30 } },
          },
        }),
        anchor,
      );

      expect(row).not.toHaveProperty("serviceBreakdown");
      expect(row).not.toHaveProperty("latestPeriodServiceAmounts");
      expect(row).not.toHaveProperty("breakdownCoversFrom");
    });
  });

  describe("a lease served by the legacy account fallback", () => {
    it("stores the whole total as the still-filling amount from the start day", () => {
      const row = buildCostObservation(
        inputWith({ source: { kind: "FALLBACK", billedCostAccrued: 42.5 } }),
        storedRow({ billedCostAccrued: 40 }),
      );

      expect(row).toMatchObject({
        billedCostAccrued: 42.5,
        billedCostDelta: 2.5,
        latestPeriodStart: "2026-08-09",
        latestPeriodAmount: 42.5,
      });
      expect(row).not.toHaveProperty("serviceBreakdown");
    });

    it("is re-summed in full, not double counted, when a later run is tag-served", () => {
      const fallbackRow = buildCostObservation(
        inputWith({ source: { kind: "FALLBACK", billedCostAccrued: 60 } }),
        undefined,
      )!;
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-09": { amount: 20 },
              "2026-08-10": { amount: 35 },
              "2026-08-11": { amount: 5 },
            },
          },
        }),
        storedRow(fallbackRow),
      );

      expect(row?.billedCostAccrued).toBe(60);
      expect(row?.billedCostDelta).toBe(0);
      expect(row?.latestPeriodStart).toBe("2026-08-11");
      expect(row?.latestPeriodAmount).toBe(5);
    });

    it("gets a complete breakdown with no boundary when the breakdown is on at the tag-served run", () => {
      const fallbackRow = buildCostObservation(
        inputWith({ source: { kind: "FALLBACK", billedCostAccrued: 60 } }),
        undefined,
      )!;
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-09": {
                amount: 20,
                serviceAmounts: { "AWS Lambda": 20 },
              },
              "2026-08-10": {
                amount: 35,
                serviceAmounts: { "Amazon Bedrock": 35 },
              },
              "2026-08-11": { amount: 5, serviceAmounts: { "AWS Lambda": 5 } },
            },
          },
        }),
        storedRow(fallbackRow),
      );

      expect(row?.serviceBreakdown).toEqual({
        "AWS Lambda": 25,
        "Amazon Bedrock": 35,
      });
      expect(row?.latestPeriodServiceAmounts).toEqual({ "AWS Lambda": 5 });
      expect(row).not.toHaveProperty("breakdownCoversFrom");
    });
  });

  describe("the token-priced Bedrock slice", () => {
    const window = {
      kind: "TAG" as const,
      buckets: {
        "2026-08-10": { amount: 20 },
        "2026-08-11": { amount: 30 },
        "2026-08-12": { amount: 10 },
      },
    };

    it("stores null when monitoring is off and 0.00, not absent, when a monitored lease has no token spend", () => {
      const off = buildCostObservation(
        inputWith({ source: window }),
        undefined,
      );
      expect(off?.billedBedrockTokenCost).toBeNull();
      expect(off).not.toHaveProperty("latestPeriodBedrockTokenAmount");

      const idle = buildCostObservation(
        inputWith({ source: window, bedrockTokens: { costByDay: {} } }),
        undefined,
      );
      expect(idle?.billedBedrockTokenCost).toBe(0);
      expect(idle?.latestPeriodBedrockTokenAmount).toBe(0);
    });

    it("sums the window from the lease start when there is no anchor", () => {
      const row = buildCostObservation(
        inputWith({
          source: window,
          bedrockTokens: {
            costByDay: { "2026-08-10": 4, "2026-08-11": 6, "2026-08-12": 2.5 },
          },
        }),
        undefined,
      );

      expect(row?.billedBedrockTokenCost).toBe(12.5);
      // The main query's newest day is the anchor day, whatever token spend it holds.
      expect(row?.latestPeriodBedrockTokenAmount).toBe(2.5);
    });

    it("anchors like the total: the anchor's figure less its own day, plus the re-read window", () => {
      const anchor = storedRow({
        latestPeriodStart: "2026-08-11",
        billedBedrockTokenCost: 8,
        latestPeriodBedrockTokenAmount: 3,
      });
      const row = buildCostObservation(
        inputWith({
          source: window,
          bedrockTokens: {
            // The day before the anchor is already inside the carried figure.
            costByDay: { "2026-08-10": 99, "2026-08-11": 5, "2026-08-12": 2 },
          },
        }),
        anchor,
      );

      expect(row?.billedBedrockTokenCost).toBe(8 - 3 + 5 + 2);
      expect(row?.latestPeriodBedrockTokenAmount).toBe(2);
    });

    // The lease starts on 08-09; 08-08 is outside it.
    const sliceFromBeforeTheAnchorDay = {
      costByDay: {
        "2026-08-08": 99,
        "2026-08-09": 1,
        "2026-08-10": 4,
        "2026-08-11": 5,
        "2026-08-12": 2,
      },
    };

    it("re-sums from the lease's start day when the anchor was written with monitoring off", () => {
      const row = buildCostObservation(
        inputWith({
          source: window,
          bedrockTokens: sliceFromBeforeTheAnchorDay,
        }),
        storedRow({
          latestPeriodStart: "2026-08-11",
          billedBedrockTokenCost: null,
        }),
      );

      // The token poll counts from the lease start too, so token spend
      // before the anchor day is not left in both terms.
      expect(row?.billedBedrockTokenCost).toBe(1 + 4 + 5 + 2);
      expect(row?.latestPeriodBedrockTokenAmount).toBe(2);
    });

    it("re-sums from the lease's start day when the anchor carries a figure but no anchor-day amount", () => {
      const row = buildCostObservation(
        inputWith({
          source: window,
          bedrockTokens: sliceFromBeforeTheAnchorDay,
        }),
        storedRow({
          latestPeriodStart: "2026-08-11",
          billedBedrockTokenCost: 8,
        }),
      );

      // Nothing to subtract, so nothing is carried: the slice is re-based.
      expect(row?.billedBedrockTokenCost).toBe(1 + 4 + 5 + 2);
    });

    it("re-sums a fallback-served lease's slice from its start day, as its total is, leaving out a previous tenant's days", () => {
      const row = buildCostObservation(
        inputWith({
          source: { kind: "FALLBACK", billedCostAccrued: 40 },
          bedrockTokens: {
            // The account's slice by day; 08-08 predates the lease.
            costByDay: { "2026-08-08": 99, "2026-08-09": 4, "2026-08-10": 6.5 },
          },
        }),
        storedRow({
          latestPeriodStart: "2026-08-11",
          billedBedrockTokenCost: 8,
          latestPeriodBedrockTokenAmount: 3,
        }),
      );

      // Nothing is carried from the anchor: the whole slice is re-read.
      expect(row?.latestPeriodStart).toBe("2026-08-09");
      expect(row?.billedBedrockTokenCost).toBe(10.5);
      expect(row?.latestPeriodBedrockTokenAmount).toBe(10.5);
    });

    it("stores 0.00, not null, for a fallback-served monitored lease with no Bedrock billed yet", () => {
      const row = buildCostObservation(
        inputWith({
          source: { kind: "FALLBACK", billedCostAccrued: 40 },
          bedrockTokens: { costByDay: {} },
        }),
        undefined,
      );

      expect(row?.billedBedrockTokenCost).toBe(0);
      expect(row?.latestPeriodBedrockTokenAmount).toBe(0);
    });

    it("stores null for a fallback-served lease with monitoring off", () => {
      const row = buildCostObservation(
        inputWith({ source: { kind: "FALLBACK", billedCostAccrued: 40 } }),
        undefined,
      );

      expect(row?.billedBedrockTokenCost).toBeNull();
      expect(row).not.toHaveProperty("latestPeriodBedrockTokenAmount");
    });

    it("hands a fallback-served slice over to the tag path with nothing dropped or counted twice", () => {
      const fallbackRow = buildCostObservation(
        inputWith({
          source: { kind: "FALLBACK", billedCostAccrued: 60 },
          bedrockTokens: { costByDay: { "2026-08-09": 4, "2026-08-10": 6 } },
        }),
        undefined,
      )!;
      const row = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-09": { amount: 20 },
              "2026-08-10": { amount: 35 },
              "2026-08-11": { amount: 5 },
            },
          },
          bedrockTokens: {
            costByDay: { "2026-08-09": 4, "2026-08-10": 6, "2026-08-11": 1 },
          },
        }),
        storedRow(fallbackRow),
      );

      // The fallback row's slice is all anchor-day amount, so none is carried
      // and the tag-served run re-sums every day from the start day.
      expect(row?.billedBedrockTokenCost).toBe(4 + 6 + 1);
      expect(row?.latestPeriodBedrockTokenAmount).toBe(1);
    });

    it("leaves a token day newer than the anchor day for the next run rather than counting it twice", () => {
      const first = buildCostObservation(
        inputWith({
          source: window,
          // The token query ran after a Cost Explorer refresh the main query
          // did not see, so it carries a day the main query does not.
          bedrockTokens: {
            costByDay: { "2026-08-11": 5, "2026-08-12": 2, "2026-08-13": 9 },
          },
        }),
        storedRow({
          latestPeriodStart: "2026-08-11",
          billedBedrockTokenCost: 8,
          latestPeriodBedrockTokenAmount: 3,
        }),
      );
      expect(first?.latestPeriodStart).toBe("2026-08-12");
      expect(first?.billedBedrockTokenCost).toBe(8 - 3 + 5 + 2);

      const next = buildCostObservation(
        inputWith({
          source: {
            kind: "TAG",
            buckets: {
              "2026-08-12": { amount: 10 },
              "2026-08-13": { amount: 4 },
            },
          },
          bedrockTokens: { costByDay: { "2026-08-12": 2, "2026-08-13": 9 } },
        }),
        storedRow({
          ...first!,
          sk: "COST#2026-08-12T00:00:00.000Z",
          meta: { schemaVersion: LeaseCostHistorySchemaVersion },
        }),
      );
      // 08-13 enters exactly once, on the run whose anchor day reaches it.
      expect(next?.billedBedrockTokenCost).toBe(8 - 3 + 5 + 2 + 9);
    });
  });

  describe("row fields that come from the caller", () => {
    it.each([null, 46])(
      "passes predictedCostAtRefresh %s through unchanged",
      (predictedCostAtRefresh) => {
        const row = buildCostObservation(
          inputWith({
            source: { kind: "TAG", buckets: { "2026-08-11": { amount: 1 } } },
            predictedCostAtRefresh,
          }),
          undefined,
        );

        expect(row?.predictedCostAtRefresh).toBe(predictedCostAtRefresh);
      },
    );

    it("stamps the ttl from the lease end plus the retention window", () => {
      const row = buildCostObservation(
        inputWith({
          source: { kind: "TAG", buckets: { "2026-08-11": { amount: 1 } } },
        }),
        undefined,
      );

      expect(row?.ttl).toBe(
        calculateCostHistoryTtl({
          retentionDays: RETENTION_DAYS,
          expirationDate: lease.expirationDate,
          startDate: lease.startDate,
          leaseDurationInHours: lease.leaseDurationInHours,
        }),
      );
    });
  });
});

describe("recordCostObservation", () => {
  it("appends the row when the cumulative moved and returns that same row", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(storedRow()),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 30 } } },
      }),
      svc,
    );

    expect(svc.appended).toHaveLength(1);
    expect(result).toEqual({
      status: "APPENDED",
      observation: svc.appended[0],
    });
    expect(svc.appended[0]).toMatchObject({
      leaseUuid: lease.uuid,
      billedCostAccrued: 85,
      billedCostDelta: 25,
    });
  });

  it("appends nothing when the re-read total is unchanged and reports the stored figure", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(storedRow()),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 5 } } },
      }),
      svc,
    );

    expect(result).toEqual({ status: "UNCHANGED", billedCostAccrued: 60 });
    expect(svc.appended).toHaveLength(0);
  });

  it("treats floating-point noise on an identical re-read as unchanged and reports the stored figure", async () => {
    // 77.2 - 9.46 + 9.46 evaluates to 77.20000000000002 in IEEE-754.
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(
          storedRow({ billedCostAccrued: 77.2, latestPeriodAmount: 9.46 }),
        ),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 9.46 } } },
      }),
      svc,
    );

    expect(result).toEqual({ status: "UNCHANGED", billedCostAccrued: 77.2 });
    expect(svc.appended).toHaveLength(0);
  });

  it("appends the first reading with a token slice even when the total is unchanged", async () => {
    // Monitoring was switched on after the stored row, and the bill is flat.
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(storedRow()),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 5 } } },
        bedrockTokens: { costByDay: { "2026-08-11": 2 } },
      }),
      svc,
    );

    expect(result.status).toBe("APPENDED");
    expect(svc.appended).toEqual([
      expect.objectContaining({
        billedCostAccrued: 60,
        billedCostDelta: 0,
        billedBedrockTokenCost: 2,
        latestPeriodBedrockTokenAmount: 2,
      }),
    ]);
  });

  it("appends nothing for an unchanged total once the stored row carries the slice", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(
          storedRow({
            billedBedrockTokenCost: 2,
            latestPeriodBedrockTokenAmount: 2,
          }),
        ),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 5 } } },
        bedrockTokens: { costByDay: { "2026-08-11": 2 } },
      }),
      svc,
    );

    expect(result).toEqual({ status: "UNCHANGED", billedCostAccrued: 60 });
    expect(svc.appended).toHaveLength(0);
  });

  it("appends a first observation for a lease with no history", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 5 } } },
      }),
      svc,
    );

    expect(result).toEqual({
      status: "APPENDED",
      observation: svc.appended[0],
    });
    expect(svc.appended[0]).toMatchObject({
      billedCostAccrued: 5,
      billedCostDelta: 5,
    });
  });

  it.each([
    ["TAG", { kind: "TAG", buckets: { "2026-08-11": { amount: 0 } } }, null],
    ["FALLBACK", { kind: "FALLBACK", billedCostAccrued: 0 }, null],
    [
      "monitored TAG",
      { kind: "TAG", buckets: { "2026-08-11": { amount: 0 } } },
      { costByDay: {} },
    ],
  ] as const)(
    "writes no row for a first %s reading of $0.00",
    async (_kind, source, bedrockTokens) => {
      const svc = services();

      const result = await recordCostObservation(
        inputWith({ source, bedrockTokens }),
        svc,
      );

      expect(result).toEqual({ status: "UNCHANGED", billedCostAccrued: 0 });
      expect(svc.appended).toHaveLength(0);
    },
  );

  it("reports NO_DATA with the anchor's figure when the source has no bucket on or after the anchor day", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(storedRow({ billedCostAccrued: 60 })),
        source: { kind: "TAG", buckets: { "2026-08-10": { amount: 5 } } },
      }),
      svc,
    );

    expect(result).toEqual({ status: "NO_DATA", billedCostAccrued: 60 });
    expect(svc.appended).toHaveLength(0);
  });

  it("reports NO_DATA with no figure when a lease with no history is absent from the report", async () => {
    const svc = services();

    const result = await recordCostObservation(inputWith(), svc);

    expect(result).toEqual({ status: "NO_DATA", billedCostAccrued: undefined });
    expect(svc.appended).toHaveLength(0);
  });

  it("appends a sub-cent real movement rather than treating it as noise", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: anchored(storedRow()),
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 5.001 } } },
      }),
      svc,
    );

    expect(result.status).toBe("APPENDED");
    expect(svc.appended[0]?.billedCostAccrued).toBeCloseTo(60.001, 9);
  });

  it("does not treat an unreadable anchor as no history: appends nothing and warns", async () => {
    const svc = services();

    const result = await recordCostObservation(
      inputWith({
        anchor: {
          complete: false,
          droppedRecordCount: 1,
          droppedRecordReason: "SCHEMA_VALIDATION",
        },
        source: { kind: "TAG", buckets: { "2026-08-11": { amount: 30 } } },
      }),
      svc,
    );

    expect(result).toEqual({
      status: "ANCHOR_UNREADABLE",
      droppedRecordReason: "SCHEMA_VALIDATION",
    });
    expect(svc.appended).toHaveLength(0);
    expect(svc.warn).toHaveBeenCalledWith(
      expect.stringContaining("unreadable"),
      expect.objectContaining({
        leaseUuid: lease.uuid,
        droppedRecordReason: "SCHEMA_VALIDATION",
      }),
    );
  });
});

describe("costQueryWindowStart", () => {
  it("returns the earliest resume day across leases, using startDate where a lease has no observation", () => {
    const start = costQueryWindowStart([
      { startDate: "2026-08-01T10:00:00.000Z", newest: undefined },
      {
        startDate: "2026-07-01T00:00:00.000Z",
        newest: storedRow({ latestPeriodStart: "2026-08-10" }),
      },
      {
        startDate: "2026-07-15T00:00:00.000Z",
        newest: storedRow({ latestPeriodStart: "2026-08-05" }),
      },
    ]);

    expect(start?.toISODate()).toBe("2026-08-01");
  });

  it("resumes from the anchor day itself, so the still-filling day is re-read", () => {
    const start = costQueryWindowStart([
      {
        startDate: "2026-07-01T00:00:00.000Z",
        newest: storedRow({ latestPeriodStart: "2026-08-10" }),
      },
    ]);

    expect(start?.toISODate()).toBe("2026-08-10");
  });

  it("never narrows the window for a lease whose newest row came from the fallback", () => {
    const fallbackRow = buildCostObservation(
      inputWith({ source: { kind: "FALLBACK", billedCostAccrued: 60 } }),
      undefined,
    )!;

    const start = costQueryWindowStart([
      { startDate: lease.startDate, newest: storedRow(fallbackRow) },
    ]);

    expect(start?.toISODate()).toBe("2026-08-09");
  });

  it("returns undefined for no leases", () => {
    expect(costQueryWindowStart([])).toBeUndefined();
  });

  it("throws on an unparseable resume date rather than widening the window silently", () => {
    expect(() =>
      costQueryWindowStart([{ startDate: "not-a-date", newest: undefined }]),
    ).toThrow(/Unparseable resume date/);
  });
});

describe("bedrockTokenQueryWindowStart", () => {
  it("resumes from the anchor day where the anchor carries a slice, and from the start date where it does not", () => {
    const withSlice = {
      startDate: "2026-07-01T00:00:00.000Z",
      newest: storedRow({
        latestPeriodStart: "2026-08-10",
        billedBedrockTokenCost: 8,
        latestPeriodBedrockTokenAmount: 3,
      }),
    };
    const withoutSlice = {
      startDate: "2026-08-03T10:00:00.000Z",
      newest: storedRow({
        latestPeriodStart: "2026-08-11",
        billedBedrockTokenCost: null,
      }),
    };

    expect(bedrockTokenQueryWindowStart([withSlice])?.toISODate()).toBe(
      "2026-08-10",
    );
    expect(
      bedrockTokenQueryWindowStart([withSlice, withoutSlice])?.toISODate(),
    ).toBe("2026-08-03");
  });
});

describe("getRecentObservations", () => {
  const rows = [
    storedRow({ sk: "COST#2026-08-11T08:00:00.000Z", billedCostAccrued: 60 }),
    storedRow({ sk: "COST#2026-08-11T00:00:00.000Z", billedCostAccrued: 32 }),
    storedRow({ sk: "COST#2026-08-10T08:00:00.000Z", billedCostAccrued: 8 }),
    storedRow({ sk: "COST#2026-08-05T08:00:00.000Z", billedCostAccrued: 1 }),
  ];

  function servicesReturning(
    result: Awaited<
      ReturnType<
        CostHistoryServices["costHistoryStore"]["getRecentCostObservations"]
      >
    >,
  ) {
    const svc = services();
    const getRecent = vi.fn().mockResolvedValue(result);
    svc.costHistoryStore.getRecentCostObservations = getRecent;
    return { ...svc, getRecent };
  }

  it("maps rows to timestamped points and drops those older than hoursBack from the newest", async () => {
    const svc = servicesReturning({ complete: true, result: rows });

    const { points } = await getRecentObservations(
      { leaseUuid: lease.uuid, hoursBack: 48 },
      svc,
    );

    expect(points).toEqual([
      {
        timestamp: "2026-08-11T08:00:00.000Z",
        billedCostAccrued: 60,
        latestPeriodStart: "2026-08-11",
        billedBedrockTokenCost: null,
      },
      {
        timestamp: "2026-08-11T00:00:00.000Z",
        billedCostAccrued: 32,
        latestPeriodStart: "2026-08-11",
        billedBedrockTokenCost: null,
      },
      {
        timestamp: "2026-08-10T08:00:00.000Z",
        billedCostAccrued: 8,
        latestPeriodStart: "2026-08-11",
        billedBedrockTokenCost: null,
      },
    ]);
    expect(svc.getRecent).toHaveBeenCalledWith(lease.uuid, { limit: 50 });
  });

  it("carries each row's service breakdown on its point", async () => {
    const svc = servicesReturning({
      complete: true,
      result: [
        storedRow({
          sk: "COST#2026-08-11T08:00:00.000Z",
          serviceBreakdown: { "Amazon Bedrock": 52, "AWS Lambda": 8 },
          latestPeriodServiceAmounts: { "Amazon Bedrock": 4 },
        }),
        rows[1]!,
      ],
    });

    const { points } = await getRecentObservations(
      { leaseUuid: lease.uuid, hoursBack: 48 },
      svc,
    );

    expect(points[0]?.serviceBreakdown).toEqual({
      "Amazon Bedrock": 52,
      "AWS Lambda": 8,
    });
    expect(points[1]).not.toHaveProperty("serviceBreakdown", expect.anything());
  });

  it("always keeps the two newest observations however old the second is", async () => {
    const svc = servicesReturning({
      complete: true,
      result: [rows[0]!, rows[3]!],
    });

    const { points } = await getRecentObservations(
      { leaseUuid: lease.uuid, hoursBack: 48 },
      svc,
    );

    expect(points).toHaveLength(2);
    expect(points[1]?.timestamp).toBe("2026-08-05T08:00:00.000Z");
  });

  it("returns an empty series carrying the drop, and warns, when the stored series is unreadable", async () => {
    const svc = servicesReturning({
      complete: false,
      droppedRecordCount: 1,
      droppedRecordReason: "SCHEMA_VERSION_UNSUPPORTED",
    });

    const observations = await getRecentObservations(
      { leaseUuid: lease.uuid, hoursBack: 48 },
      svc,
    );

    expect(observations).toEqual({
      points: [],
      droppedRecordCount: 1,
      droppedRecordReason: "SCHEMA_VERSION_UNSUPPORTED",
    });
    expect(svc.warn).toHaveBeenCalledWith(
      expect.stringContaining("unreadable"),
      expect.objectContaining({
        leaseUuid: lease.uuid,
        droppedRecordReason: "SCHEMA_VERSION_UNSUPPORTED",
      }),
    );
  });

  it("returns an empty series for a lease with no observations", async () => {
    const svc = servicesReturning({ complete: true, result: [] });

    await expect(
      getRecentObservations({ leaseUuid: lease.uuid, hoursBack: 48 }, svc),
    ).resolves.toEqual({ points: [] });
  });
});

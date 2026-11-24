// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  LeaseView,
  SharedLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  buildPredictedSegments,
  COST_HISTORY_MAX_PAGES,
  COST_HISTORY_MAX_READINGS,
  COST_HISTORY_MAX_RESULTS,
  COST_HISTORY_MAX_TOKEN_ROWS,
  LeaseService,
} from "@amzn/innovation-sandbox-frontend/domains/leases/service";
import { SmithyLeaseApi } from "@amzn/innovation-sandbox-frontend/domains/leases/smithy-client";
import {
  BreachEntry,
  CostHistoryCurrent,
  CostHistoryPageOptions,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  createMockBedrockTokenCostHistory,
  createMockCostHistory,
  createMockLeaseEndBreachCostHistory,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";

function stubApi(overrides: Partial<SmithyLeaseApi> = {}): SmithyLeaseApi {
  return {
    listLeases: vi.fn(),
    getLease: vi.fn(),
    requestLease: vi.fn(),
    updateLease: vi.fn(),
    reviewLease: vi.fn(),
    terminateLease: vi.fn(),
    freezeLease: vi.fn(),
    unfreezeLease: vi.fn(),
    getAssignments: vi.fn(),
    updateAssignments: vi.fn(),
    listSharedLeases: vi.fn(),
    getLeaseCostSummary: vi.fn(),
    getLeaseCostHistory: vi.fn(),
    getLeaseBedrockTokenHistory: vi.fn(),
    getLeaseBreachHistory: vi.fn(),
    ...overrides,
  };
}

const lease = (leaseId: string): LeaseView =>
  ({
    leaseId,
    userEmail: "owner@example.com",
    status: "Active",
  }) as unknown as LeaseView;

const shared = (leaseId: string): SharedLeaseView =>
  ({
    leaseId,
    userEmail: "owner@example.com",
    uuid: `uuid-${leaseId}`,
    status: "Active",
    accessType: "direct",
  }) as unknown as SharedLeaseView;

describe("LeaseService", () => {
  describe("getLeases", () => {
    it("follows the continuation token across pages", async () => {
      const listLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [lease("lease-1")],
          nextPageIdentifier: "page-2",
        })
        .mockResolvedValueOnce({
          result: [lease("lease-2")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listLeases }));

      const leases = await service.getLeases();

      expect(leases.map((l) => l.leaseId)).toEqual(["lease-1", "lease-2"]);
      // pageIdentifier is undefined on the first call, then the returned cursor.
      expect(listLeases).toHaveBeenNthCalledWith(1, undefined, undefined);
      expect(listLeases).toHaveBeenNthCalledWith(2, "page-2", undefined);
    });

    it("forwards the userEmail filter on every page", async () => {
      const listLeases = vi.fn().mockResolvedValue({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listLeases }));

      await service.getLeases("user@example.com");

      expect(listLeases).toHaveBeenCalledWith(undefined, "user@example.com");
    });
  });

  describe("delegation", () => {
    it("delegates single-target methods to the adapter", async () => {
      const api = stubApi();
      const service = new LeaseService(api);

      await service.getLeaseById("lease-1");
      await service.requestNewLease({ leaseTemplateUuid: "tmpl-1" });
      await service.updateLease({ leaseId: "lease-1", maxSpend: 10 });
      await service.reviewLease("lease-1", true);
      await service.terminateLease("lease-1");
      await service.freezeLease("lease-1");
      await service.unfreezeLease("lease-1");
      await service.getAssignments("lease-1");
      await service.updateAssignments("lease-1", [
        { principalId: "p1", principalType: "USER" },
      ]);

      expect(api.getLease).toHaveBeenCalledWith("lease-1");
      expect(api.requestLease).toHaveBeenCalledWith({
        leaseTemplateUuid: "tmpl-1",
      });
      expect(api.updateLease).toHaveBeenCalledWith({
        leaseId: "lease-1",
        maxSpend: 10,
      });
      expect(api.reviewLease).toHaveBeenCalledWith("lease-1", true);
      expect(api.terminateLease).toHaveBeenCalledWith("lease-1");
      expect(api.freezeLease).toHaveBeenCalledWith("lease-1");
      expect(api.unfreezeLease).toHaveBeenCalledWith("lease-1");
      expect(api.getAssignments).toHaveBeenCalledWith("lease-1");
      expect(api.updateAssignments).toHaveBeenCalledWith("lease-1", [
        { principalId: "p1", principalType: "USER" },
      ]);
    });
  });

  describe("getSharedLeases", () => {
    it("should fetch all pages exhaustively and return combined results", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("lease-1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [shared("lease-2")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(2);
      expect(result.result[0]!.leaseId).toBe("lease-1");
      expect(result.result[1]!.leaseId).toBe("lease-2");
      expect(result.nextPageIdentifier).toBeNull();

      expect(listSharedLeases).toHaveBeenCalledTimes(2);
      // userId, accessType, maxResults=100, then the returned cursor.
      expect(listSharedLeases).toHaveBeenNthCalledWith(
        1,
        "user-id-1",
        "direct",
        100,
        undefined,
      );
      expect(listSharedLeases).toHaveBeenNthCalledWith(
        2,
        "user-id-1",
        "direct",
        100,
        "cursor-2",
      );
    });

    it("should return single page when nextPageIdentifier is null on first call", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [shared("lease-1")],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "group");

      expect(result.result).toHaveLength(1);
      expect(result.nextPageIdentifier).toBeNull();
      expect(listSharedLeases).toHaveBeenCalledTimes(1);
    });

    it("should return empty result when no shared leases exist", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(0);
      expect(result.nextPageIdentifier).toBeNull();
    });

    it("should pass accessType=group when specified", async () => {
      const listSharedLeases = vi.fn().mockResolvedValueOnce({
        result: [],
        nextPageIdentifier: null,
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      await service.getSharedLeases("user-id-1", "group");

      expect(listSharedLeases).toHaveBeenCalledWith(
        "user-id-1",
        "group",
        100,
        undefined,
      );
    });

    it("should handle three pages of results", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockResolvedValueOnce({
          result: [shared("2")],
          nextPageIdentifier: "cursor-3",
        })
        .mockResolvedValueOnce({
          result: [shared("3")],
          nextPageIdentifier: null,
        });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      expect(result.result).toHaveLength(3);
      expect(listSharedLeases).toHaveBeenCalledTimes(3);
    });

    it("should propagate errors that occur mid-pagination", async () => {
      const listSharedLeases = vi
        .fn()
        .mockResolvedValueOnce({
          result: [shared("1")],
          nextPageIdentifier: "cursor-2",
        })
        .mockRejectedValueOnce(new Error("Network error on page 2"));
      const service = new LeaseService(stubApi({ listSharedLeases }));

      await expect(
        service.getSharedLeases("user-id-1", "direct"),
      ).rejects.toThrow("Network error on page 2");
    });

    it("should stop at MAX_PAGES to prevent infinite loops", async () => {
      // Always return a non-null cursor (simulates a broken backend).
      const listSharedLeases = vi.fn().mockResolvedValue({
        result: [shared("item")],
        nextPageIdentifier: "always-more",
      });
      const service = new LeaseService(stubApi({ listSharedLeases }));

      const result = await service.getSharedLeases("user-id-1", "direct");

      // Should stop at 50 pages (MAX_PAGES).
      expect(listSharedLeases).toHaveBeenCalledTimes(50);
      expect(result.result).toHaveLength(50);
      // Preserves nextPageIdentifier to indicate truncation.
      expect(result.nextPageIdentifier).toBe("always-more");
    });
  });
});

describe("LeaseService complete cost history", () => {
  it("passes the cost summary through", async () => {
    const summary = { current: createMockCostHistory().data.current };
    const getLeaseCostSummary = vi.fn().mockResolvedValue(summary);
    const service = new LeaseService(stubApi({ getLeaseCostSummary }));

    await expect(service.getLeaseCostSummary("lease-1")).resolves.toBe(summary);
    expect(getLeaseCostSummary).toHaveBeenCalledWith("lease-1");
  });

  it("stops at the page cap and leaves the cursor on to say so", async () => {
    // A server that never ends the sequence: the repeated-cursor guard only catches
    // one that repeats itself, so the cap is what bounds this. Pages without cost
    // readings never reach the readings cap, so the page cap is the one that fires.
    const getLeaseCostHistory = vi.fn(async () => ({
      result: [],
      nextPageIdentifier: `page-${getLeaseCostHistory.mock.calls.length}`,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseCostHistory }));

    const result = await service.getMergedLeaseCostHistory("lease-1");

    expect(getLeaseCostHistory).toHaveBeenCalledTimes(COST_HISTORY_MAX_PAGES);
    expect(result.nextPageIdentifier).toBe(`page-${COST_HISTORY_MAX_PAGES}`);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("stops once it holds the readings cap, however few pages that took", async () => {
    const base = createMockCostHistory().data;
    const fullPage = Array.from(
      { length: COST_HISTORY_MAX_RESULTS },
      () => base.result[0]!,
    );
    const getLeaseCostHistory = vi.fn(async () => ({
      result: fullPage,
      nextPageIdentifier: `page-${getLeaseCostHistory.mock.calls.length}`,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseCostHistory }));

    const result = await service.getMergedLeaseCostHistory("lease-1");

    const pages = COST_HISTORY_MAX_READINGS / COST_HISTORY_MAX_RESULTS;
    expect(getLeaseCostHistory).toHaveBeenCalledTimes(pages);
    expect(result.result).toHaveLength(COST_HISTORY_MAX_READINGS);
    expect(result.nextPageIdentifier).toBe(`page-${pages}`);
    warn.mockRestore();
  });

  it("asks for no more than the readings cap leaves room for after a short page", async () => {
    const base = createMockCostHistory().data;
    const rows = (count: number) =>
      Array.from({ length: count }, () => base.result[0]!);
    const getLeaseCostHistory = vi.fn(
      async (_leaseId: string, options: { maxResults?: number }) => {
        // A short page first, then full pages of whatever was asked for.
        const served = getLeaseCostHistory.mock.calls.length;
        return {
          result: rows(served === 1 ? 40 : (options.maxResults ?? 0)),
          nextPageIdentifier: `page-${served}`,
        };
      },
    );
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseCostHistory }));

    const result = await service.getMergedLeaseCostHistory("lease-1");

    expect(result.result).toHaveLength(COST_HISTORY_MAX_READINGS);
    expect(getLeaseCostHistory.mock.calls.at(-1)?.[1]).toMatchObject({
      maxResults: 60,
    });
    warn.mockRestore();
  });

  it("drains past the readings cap's page count where cost pages come back short", async () => {
    const base = createMockCostHistory().data;
    const pageCount = COST_HISTORY_MAX_READINGS / COST_HISTORY_MAX_RESULTS + 10;
    const getLeaseCostHistory = vi.fn(async () => {
      const served = getLeaseCostHistory.mock.calls.length;
      return {
        result: [base.result[0]!],
        nextPageIdentifier: served < pageCount ? `page-${served}` : null,
      };
    });
    const service = new LeaseService(stubApi({ getLeaseCostHistory }));

    const result = await service.getMergedLeaseCostHistory("lease-1");

    expect(getLeaseCostHistory).toHaveBeenCalledTimes(pageCount);
    expect(result.nextPageIdentifier).toBeNull();
  });

  it("drains every cost page through its cursor, joining their readings alone", async () => {
    const base = createMockCostHistory().data;
    const getLeaseCostHistory = vi
      .fn()
      .mockResolvedValueOnce({
        result: [base.result[0]!],
        nextPageIdentifier: "page-2",
      })
      .mockResolvedValueOnce({
        result: [base.result[1]!],
        nextPageIdentifier: null,
      });
    const service = new LeaseService(stubApi({ getLeaseCostHistory }));

    const result = await service.getMergedLeaseCostHistory("lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
    });

    expect(getLeaseCostHistory).toHaveBeenNthCalledWith(1, "lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
      maxResults: 100,
    });
    expect(getLeaseCostHistory).toHaveBeenNthCalledWith(2, "lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
      maxResults: 100,
      pageIdentifier: "page-2",
    });
    expect(result).toEqual({
      result: [base.result[0], base.result[1]],
      nextPageIdentifier: null,
    });
  });

  it("stops a token drain once it holds the token rows cap, asking for full pages throughout", async () => {
    const row = createMockBedrockTokenCostHistory().data.tokens[0]!;
    const pages = 20;
    const tokens = Array.from(
      { length: COST_HISTORY_MAX_TOKEN_ROWS / pages },
      () => row,
    );
    const getLeaseBedrockTokenHistory = vi.fn(async () => ({
      result: tokens,
      nextPageIdentifier: `page-${getLeaseBedrockTokenHistory.mock.calls.length}`,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseBedrockTokenHistory }));

    const result = await service.getMergedLeaseBedrockTokenHistory("lease-1");

    expect(getLeaseBedrockTokenHistory).toHaveBeenCalledTimes(pages);
    for (const [, options] of getLeaseBedrockTokenHistory.mock
      .calls as unknown as [string, CostHistoryPageOptions][]) {
      expect(options).toMatchObject({ maxResults: COST_HISTORY_MAX_RESULTS });
    }
    expect(result.result).toHaveLength(COST_HISTORY_MAX_TOKEN_ROWS);
    expect(result.nextPageIdentifier).toBe(`page-${pages}`);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  it("drains a lease's token readings to the end where they stay under the token rows cap", async () => {
    const { tokens } = createMockBedrockTokenCostHistory().data;
    const pageCount = 5;
    const getLeaseBedrockTokenHistory = vi.fn(async () => {
      const served = getLeaseBedrockTokenHistory.mock.calls.length;
      return {
        result: tokens,
        nextPageIdentifier: served < pageCount ? `page-${served}` : null,
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseBedrockTokenHistory }));

    const result = await service.getMergedLeaseBedrockTokenHistory("lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
    });

    expect(getLeaseBedrockTokenHistory).toHaveBeenCalledTimes(pageCount);
    expect(getLeaseBedrockTokenHistory).toHaveBeenNthCalledWith(2, "lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
      maxResults: COST_HISTORY_MAX_RESULTS,
      pageIdentifier: "page-1",
    });
    expect(result.result).toHaveLength(pageCount * tokens.length);
    expect(result.nextPageIdentifier).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("drains every breach page in full pages, joining their breaches", async () => {
    const { breaches } = createMockCostHistory().data;
    const pageCount = 3;
    const getLeaseBreachHistory = vi.fn(async () => {
      const served = getLeaseBreachHistory.mock.calls.length;
      return {
        result: breaches,
        nextPageIdentifier: served < pageCount ? `page-${served}` : null,
      };
    });
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseBreachHistory }));

    const result = await service.getMergedLeaseBreachHistory("lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
    });

    expect(getLeaseBreachHistory).toHaveBeenCalledTimes(pageCount);
    expect(getLeaseBreachHistory).toHaveBeenNthCalledWith(1, "lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
      maxResults: COST_HISTORY_MAX_RESULTS,
    });
    expect(getLeaseBreachHistory).toHaveBeenNthCalledWith(3, "lease-1", {
      afterTimestamp: "2026-08-10T00:00:00.000Z",
      maxResults: COST_HISTORY_MAX_RESULTS,
      pageIdentifier: "page-2",
    });
    expect(result.result).toEqual(
      Array.from({ length: pageCount }, () => breaches).flat(),
    );
    expect(result.nextPageIdentifier).toBeNull();
    expect(warn).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it("joins duration and expiry breaches across breach pages with their fields intact", async () => {
    const { breaches } = createMockLeaseEndBreachCostHistory().data;
    const getLeaseBreachHistory = vi
      .fn()
      .mockResolvedValueOnce({
        result: breaches.slice(0, 2),
        nextPageIdentifier: "page-2",
      })
      .mockResolvedValueOnce({
        result: breaches.slice(2),
        nextPageIdentifier: null,
      });
    const service = new LeaseService(stubApi({ getLeaseBreachHistory }));

    const result = await service.getMergedLeaseBreachHistory("lease-1");

    expect(result.result).toEqual(breaches);
  });

  it("stops a breach drain only at the page cap, leaving the cursor on to say so", async () => {
    const [breach] = createMockCostHistory().data.breaches;
    const fullPage: BreachEntry[] = Array.from(
      { length: COST_HISTORY_MAX_RESULTS },
      () => breach!,
    );
    const getLeaseBreachHistory = vi.fn(async () => ({
      result: fullPage,
      nextPageIdentifier: `page-${getLeaseBreachHistory.mock.calls.length}`,
    }));
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const service = new LeaseService(stubApi({ getLeaseBreachHistory }));

    const result = await service.getMergedLeaseBreachHistory("lease-1");

    expect(getLeaseBreachHistory).toHaveBeenCalledTimes(COST_HISTORY_MAX_PAGES);
    expect(getLeaseBreachHistory).toHaveBeenLastCalledWith(
      "lease-1",
      expect.objectContaining({ maxResults: COST_HISTORY_MAX_RESULTS }),
    );
    expect(result.result).toHaveLength(
      COST_HISTORY_MAX_PAGES * COST_HISTORY_MAX_RESULTS,
    );
    expect(result.nextPageIdentifier).toBe(`page-${COST_HISTORY_MAX_PAGES}`);
    expect(warn).toHaveBeenCalledOnce();
    warn.mockRestore();
  });

  const drains = [
    ["cost", "getLeaseCostHistory", "getMergedLeaseCostHistory"],
    [
      "Bedrock token",
      "getLeaseBedrockTokenHistory",
      "getMergedLeaseBedrockTokenHistory",
    ],
    ["breach", "getLeaseBreachHistory", "getMergedLeaseBreachHistory"],
  ] as const;

  it.each(drains)(
    "fails a %s drain instead of exposing a partial result when a cursor repeats",
    async (_history, read, drain) => {
      const page = vi
        .fn()
        .mockResolvedValue({ result: [], nextPageIdentifier: "repeated" });
      const service = new LeaseService(stubApi({ [read]: page }));

      await expect(service[drain]("lease-1")).rejects.toThrow(
        "repeated page cursor",
      );
      expect(page).toHaveBeenCalledTimes(2);
    },
  );

  it.each(drains)(
    "clamps a %s page's maxResults to what the endpoint takes",
    async (_history, read) => {
      const page = vi.fn().mockResolvedValue({ result: [] });
      const service = new LeaseService(stubApi({ [read]: page }));

      await service[read]("lease-1", { maxResults: 5000 });
      await service[read]("lease-1", { maxResults: 0 });

      expect(page).toHaveBeenNthCalledWith(1, "lease-1", {
        maxResults: COST_HISTORY_MAX_RESULTS,
      });
      expect(page).toHaveBeenNthCalledWith(2, "lease-1", { maxResults: 1 });
    },
  );
});

describe("buildPredictedSegments", () => {
  const { result, current } = createMockCostHistory().data;
  const [newest, overnight, afternoon, oldest] = result;

  // What each pair of the fixture's readings projected, newest first.
  const historical = [
    {
      fromTimestamp: overnight!.timestamp,
      toTimestamp: newest!.timestamp,
      startCost: 32,
      endCost: 46,
      rate: 1.75,
      rateSource: null,
    },
    {
      fromTimestamp: afternoon!.timestamp,
      toTimestamp: overnight!.timestamp,
      startCost: 18,
      endCost: 28,
      rate: 1.25,
      rateSource: null,
    },
  ];

  // From the newest reading to the last check, at the slope of the segment.
  const live = {
    fromTimestamp: "2026-08-11T08:00:00.000Z",
    toTimestamp: "2026-08-11T11:00:00.000Z",
    startCost: 60,
    endCost: 70.5,
    rate: 3.5,
    rateSource: "HOURLY",
  };

  it("pairs each reading with the one before it, the live segment first", () => {
    expect(buildPredictedSegments(result, current, undefined)).toEqual([
      live,
      ...historical,
    ]);
  });

  it("pairs the readings either side of what was a page boundary", async () => {
    // Drained a reading a page, so every pair spans two pages.
    const getLeaseCostHistory = vi.fn(
      async (_leaseId: string, options: CostHistoryPageOptions) => {
        const index = Number(options.pageIdentifier ?? 0);
        return {
          result: [result[index]!],
          nextPageIdentifier:
            index + 1 < result.length ? String(index + 1) : null,
        };
      },
    );
    const drained = await new LeaseService(
      stubApi({ getLeaseCostHistory }),
    ).getMergedLeaseCostHistory("lease-1");

    expect(buildPredictedSegments(drained.result, null, undefined)).toEqual(
      historical,
    );
  });

  it("skips a reading that projected nothing, and a span that is not positive", () => {
    const rows = [
      { ...newest!, predictedCostAtRefresh: null },
      overnight!,
      // Stamped at the same instant as the reading after it, so the span between
      // the two is zero.
      {
        ...afternoon!,
        timestamp: overnight!.timestamp,
        predictedCostAtRefresh: 20,
      },
      oldest!,
    ];

    expect(buildPredictedSegments(rows, null, undefined)).toEqual([
      {
        fromTimestamp: oldest!.timestamp,
        toTimestamp: overnight!.timestamp,
        startCost: 8,
        endCost: 20,
        rate: 0.75,
        rateSource: null,
      },
    ]);
  });

  const withCurrent = (changes: Partial<CostHistoryCurrent>) =>
    buildPredictedSegments([], { ...current!, ...changes }, undefined);

  it("draws no live segment without a rate, or where the last check is not after the reading", () => {
    expect(withCurrent({ rateSource: undefined })).toEqual([]);
    expect(withCurrent({ lastCheckedAt: current!.lastReportedAt })).toEqual([]);
  });

  it("draws no live segment where either instant does not parse", () => {
    expect(withCurrent({ lastCheckedAt: "not a date" })).toEqual([]);
    expect(withCurrent({ lastReportedAt: "not a date" })).toEqual([]);
  });

  const rangeCases = [
    ["no range", undefined, true],
    [
      "a lower bound at the reading",
      { afterTimestamp: live.fromTimestamp },
      true,
    ],
    [
      "a lower bound after the reading",
      { afterTimestamp: "2026-08-11T08:00:00.001Z" },
      false,
    ],
    [
      "an upper bound just after the reading",
      {
        afterTimestamp: "2026-08-11T00:00:00.000Z",
        beforeTimestamp: "2026-08-11T08:00:00.001Z",
      },
      true,
    ],
    [
      "an upper bound at the reading",
      {
        afterTimestamp: "2026-08-11T00:00:00.000Z",
        beforeTimestamp: "2026-08-11T08:00:00.000Z",
      },
      false,
    ],
  ] as const;

  it.each(rangeCases)(
    "draws the live segment with %s only where the range holds the reading",
    (_case, range, shown) => {
      expect(buildPredictedSegments([], current, range)).toEqual(
        shown ? [live] : [],
      );
    },
  );
});

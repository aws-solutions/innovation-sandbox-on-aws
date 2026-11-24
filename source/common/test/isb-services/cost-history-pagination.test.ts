// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { describe, expect, it, vi } from "vitest";

import { base64DecodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  CostHistoryPageIdentifierSchema,
  CostHistoryPageOptions,
  CostHistoryWindow,
  encodeCostHistoryPageIdentifier,
  InvalidCostHistoryPageIdentifierError,
  PagedQueryResult,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-store.js";
import {
  BedrockTokenRow,
  BreachRecord,
  CostObservation,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import {
  buildBedrockTokenHistoryData,
  buildBreachHistoryData,
  buildCostHistoryData,
  buildCostSummaryData,
  CostHistoryServices,
  LeaseHistoryPageRequest,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { futureTtl } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { MonitoredLease } from "@amzn/innovation-sandbox-shared/types/lease.js";

const LEASE_UUID = "750e8400-e29b-41d4-a716-446655440002";
const lease = {
  uuid: LEASE_UUID,
  startDate: "2026-08-09T00:00:00.000Z",
  lastCheckedDate: "2026-08-11T23:00:00.000Z",
  maxSpend: 100,
} as MonitoredLease;
const meta = { schemaVersion: LeaseCostHistorySchemaVersion };

/** Token rows the fake store reads before it stops short, in place of a byte budget. */
const TOKEN_ROWS_PER_READ = 3;

const at = (hour: number) =>
  `2026-08-11T${String(hour).padStart(2, "0")}:00:00.000Z`;

const costRow = (timestamp: string): CostObservation => ({
  leaseUuid: LEASE_UUID,
  sk: `COST#${timestamp}`,
  billedCostAccrued: 10,
  billedCostDelta: 1,
  predictedCostAtRefresh: 11,
  latestPeriodStart: "2026-08-11",
  latestPeriodAmount: 1,
  billedBedrockTokenCost: null,
  ttl: futureTtl(),
  meta,
});

const tokenRow = (timestamp: string): BedrockTokenRow => ({
  leaseUuid: LEASE_UUID,
  sk: `BEDROCK_TOKEN#${timestamp}`,
  tokens: {
    "us-east-1": {
      "amazon.nova-pro-v1:0": {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
  },
  monitoredBedrockTokenCostDelta: null,
  monitoredBedrockTokenCost: null,
  coveredThrough: { "us-east-1": timestamp },
  ttl: futureTtl(),
  meta,
});

const breachRow = (timestamp: string) =>
  ({ leaseUuid: LEASE_UUID, sk: `BREACH#${timestamp}` }) as BreachRecord;

const newestFirst = <T extends { sk: string }>(rows: T[]) =>
  [...rows].sort((a, b) => b.sk.localeCompare(a.sk));

const inWindow =
  (prefix: string, window: CostHistoryWindow) =>
  ({ sk }: { sk: string }) =>
    sk >= `${prefix}${window.from}` && sk <= `${prefix}${window.to}`;

/**
 * An in-memory store with the Dynamo store's paging rules: each type pages by
 * count over its own prefix, resumes strictly below the cursor's key and refuses
 * a cursor the real store would, and a token page stops after
 * {@link TOKEN_ROWS_PER_READ} rows.
 */
function services(table: {
  costs: CostObservation[];
  tokens: BedrockTokenRow[];
  breaches: BreachRecord[];
}): CostHistoryServices {
  return {
    logger: new Logger({ serviceName: "test" }),
    costHistoryStore: {
      appendCostObservation: vi.fn(),
      getNewestCostObservation: vi.fn(),
      getRecentCostObservations: async () => ({
        complete: true,
        result: newestFirst(table.costs),
      }),
      getNewestBedrockTokenRow: vi.fn(),
      listCostObservations: async (leaseUuid, options) =>
        pageOf(table.costs, "COST#", leaseUuid, options, options.pageSize),
      listBreachRecordPage: async (leaseUuid, options) =>
        pageOf(table.breaches, "BREACH#", leaseUuid, options, options.pageSize),
      listBedrockTokenRows: async (leaseUuid, options) =>
        pageOf(
          table.tokens,
          "BEDROCK_TOKEN#",
          leaseUuid,
          options,
          Math.min(options.pageSize, TOKEN_ROWS_PER_READ),
        ),
    },
  };
}

function pageOf<T extends { sk: string }>(
  rows: T[],
  prefix: string,
  leaseUuid: string,
  options: CostHistoryPageOptions,
  rowsPerPage: number,
): PagedQueryResult<T> {
  const below = cursorKeyWithin(
    leaseUuid,
    prefix,
    options.pageIdentifier,
    options.window,
  );
  const candidates = newestFirst(rows).filter(
    (row) =>
      (below === undefined || row.sk < below) &&
      (options.window === undefined || inWindow(prefix, options.window)(row)),
  );
  const read = candidates.slice(0, rowsPerPage);
  return {
    result: read,
    nextPageIdentifier:
      candidates.length > read.length
        ? encodeCostHistoryPageIdentifier(
            { leaseUuid: LEASE_UUID, sk: read.at(-1)!.sk },
            options.window ?? null,
          )
        : null,
  };
}

/** The cursor's key, after the checks the Dynamo store makes before it queries. */
function cursorKeyWithin(
  leaseUuid: string,
  prefix: string,
  pageIdentifier: string | undefined,
  window: CostHistoryWindow | undefined,
): string | undefined {
  if (pageIdentifier === undefined) {
    return undefined;
  }
  const cursor = CostHistoryPageIdentifierSchema.parse(
    base64DecodeCompositeKey(pageIdentifier),
  );
  const timestamp = cursor.key.sk.slice(prefix.length);
  if (
    cursor.key.leaseUuid !== leaseUuid ||
    !cursor.key.sk.startsWith(prefix) ||
    JSON.stringify(cursor.window) !== JSON.stringify(window ?? null) ||
    (window !== undefined && (timestamp < window.from || timestamp > window.to))
  ) {
    throw new InvalidCostHistoryPageIdentifierError();
  }
  return cursor.key.sk;
}

type HistoryPage = { nextPageIdentifier?: string | null };

async function drain<Page extends HistoryPage>(
  svc: CostHistoryServices,
  build: (
    input: LeaseHistoryPageRequest,
    services: CostHistoryServices,
  ) => Promise<Page>,
  range?: CostHistoryWindow,
  maxResults = 2,
): Promise<Page[]> {
  const pages: Page[] = [];
  let pageIdentifier: string | undefined;
  do {
    const page = await build(
      {
        lease,
        maxResults,
        ...(pageIdentifier === undefined ? {} : { pageIdentifier }),
        ...(range === undefined ? {} : { range }),
      },
      svc,
    );
    pages.push(page);
    pageIdentifier = page.nextPageIdentifier ?? undefined;
  } while (pageIdentifier !== undefined && pages.length < 100);
  return pages;
}

const timestampsOf = (rows: { timestamp: string }[]) =>
  rows.map((row) => row.timestamp);

// Observations a few times a day, token rows every hour between them.
const table = {
  costs: [at(2), at(12), at(20)].map(costRow),
  tokens: Array.from({ length: 22 }, (_, hour) => tokenRow(at(hour + 1))),
  breaches: [at(3), at(8), "2026-08-11T07:59:59.999Z"].map(breachRow),
};
const range = { from: at(5), to: at(15) };

/** Each history read and the store read behind it. */
const historyReads = [
  ["buildCostHistoryData", buildCostHistoryData, "listCostObservations"],
  [
    "buildBedrockTokenHistoryData",
    buildBedrockTokenHistoryData,
    "listBedrockTokenRows",
  ],
  ["buildBreachHistoryData", buildBreachHistoryData, "listBreachRecordPage"],
] as const;

describe("each lease history read pages its own row type", () => {
  it.each(historyReads)(
    "%s returns its rows and cursor only",
    async (_name, build) => {
      for (const window of [undefined, range]) {
        const pages = await drain<HistoryPage & { result: unknown[] }>(
          services(table),
          build,
          window,
        );

        expect(pages[0]!.result).not.toEqual([]);
        for (const page of pages) {
          expect(Object.keys(page).sort()).toEqual([
            "nextPageIdentifier",
            "result",
          ]);
        }
      }
    },
  );

  it.each(historyReads)(
    "%s makes none of the reads behind the cost summary",
    async (_name, build) => {
      const svc = services(table);
      const getRecentCostObservations = vi.spyOn(
        svc.costHistoryStore,
        "getRecentCostObservations",
      );

      await build(
        {
          lease: { ...lease, bedrockTokenMonitoringEnabled: true },
          maxResults: 100,
        },
        svc,
      );

      expect(getRecentCostObservations).not.toHaveBeenCalled();
      expect(
        svc.costHistoryStore.getNewestBedrockTokenRow,
      ).not.toHaveBeenCalled();
    },
  );

  it("returns every row of each type exactly once across the pages", async () => {
    const svc = services(table);

    const costPages = await drain(svc, buildCostHistoryData);
    const tokenPages = await drain(svc, buildBedrockTokenHistoryData);
    const breachPages = await drain(svc, buildBreachHistoryData);

    expect(costPages.flatMap((page) => timestampsOf(page.result))).toEqual([
      at(20),
      at(12),
      at(2),
    ]);
    expect(tokenPages.flatMap((page) => timestampsOf(page.result))).toEqual(
      newestFirst(table.tokens).map((row) => row.sk.slice(14)),
    );
    expect(breachPages.flatMap((page) => timestampsOf(page.result))).toEqual(
      newestFirst(table.breaches).map((row) => row.sk.slice(7)),
    );
  });

  it("keeps every page of a ranged read inside the range", async () => {
    const svc = services(table);

    const costPages = await drain(svc, buildCostHistoryData, range);
    const tokenPages = await drain(svc, buildBedrockTokenHistoryData, range);
    const breachPages = await drain(svc, buildBreachHistoryData, range);

    expect(costPages.flatMap((page) => timestampsOf(page.result))).toEqual([
      at(12),
    ]);
    expect(tokenPages.flatMap((page) => timestampsOf(page.result))).toEqual(
      Array.from({ length: 11 }, (_, index) => at(15 - index)),
    );
    expect(breachPages.flatMap((page) => timestampsOf(page.result))).toEqual(
      newestFirst(table.breaches.slice(1)).map((row) => row.sk.slice(7)),
    );
  });

  it("hands on a cursor from a token page that stops short of maxResults", async () => {
    const pages = await drain(
      services(table),
      buildBedrockTokenHistoryData,
      range,
      TOKEN_ROWS_PER_READ + 2,
    );

    expect(pages.map((page) => page.result.length)).toEqual([3, 3, 3, 2]);
    expect(pages.flatMap((page) => timestampsOf(page.result))).toEqual(
      Array.from({ length: 11 }, (_, index) => at(15 - index)),
    );
  });

  it.each(historyReads)(
    "%s returns only its rows and cursor where the store dropped rows",
    async (_name, build, read) => {
      const svc = services(table);
      // A page that lost every row it read still hands on its cursor, which is
      // what tells an unreadable reading from no reading.
      svc.costHistoryStore[read] = async () => ({
        result: [],
        nextPageIdentifier: "next-page",
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VALIDATION",
      });

      const page = await build({ lease, maxResults: 2 }, svc);

      expect(page).toEqual({ result: [], nextPageIdentifier: "next-page" });
    },
  );

  it.each(
    historyReads.flatMap(([name, build]) =>
      historyReads
        .filter(([other]) => other !== name)
        .map(
          ([other, otherBuild]) => [name, other, build, otherBuild] as const,
        ),
    ),
  )("%s refuses a cursor from %s", async (_name, _other, build, otherBuild) => {
    const svc = services(table);
    const { nextPageIdentifier } = await otherBuild(
      { lease, maxResults: 1 },
      svc,
    );
    expect(nextPageIdentifier).toEqual(expect.any(String));

    await expect(
      build({ lease, maxResults: 1, pageIdentifier: nextPageIdentifier! }, svc),
    ).rejects.toThrow(InvalidCostHistoryPageIdentifierError);
  });
});

describe("buildCostSummaryData", () => {
  it("returns current only, from the newest reading, and reads no page", async () => {
    const svc = services(table);
    const listCostObservations = vi.spyOn(
      svc.costHistoryStore,
      "listCostObservations",
    );

    const summary = await buildCostSummaryData({ lease }, svc);

    expect(Object.keys(summary)).toEqual(["current"]);
    expect(summary.current?.lastReportedAt).toBe(at(20));
    expect(summary.current?.lastCheckedAt).toBe(lease.lastCheckedDate);
    expect(listCostObservations).not.toHaveBeenCalled();
  });

  it("returns a null current for a lease with no reading yet", async () => {
    const summary = await buildCostSummaryData(
      { lease },
      services({ costs: [], tokens: [], breaches: [] }),
    );

    expect(summary).toEqual({ current: null });
  });
});

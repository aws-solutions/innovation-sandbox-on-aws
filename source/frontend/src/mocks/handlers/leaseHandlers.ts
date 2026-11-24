// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { http, HttpResponse } from "msw";

import {
  LeaseView,
  MonitoredLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  BedrockTokenHistoryResponse,
  BreachHistoryResponse,
  CostHistoryResponse,
  CostSummaryResponse,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";
import { mockLeaseApi } from "@amzn/innovation-sandbox-frontend/mocks/mockApi";
import {
  costSummaryOf,
  createMockCostHistory,
  LeaseHistoryFixture,
} from "@amzn/innovation-sandbox-frontend-test/domains/leases/factories/costHistoryFactory";
import { IDENTITY_HEADER } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export const mockLease: MonitoredLeaseView = createActiveLease();
mockLeaseApi.returns([mockLease]);

/**
 * Projects a persisted lease into the shape the API returns it as — what a hook
 * receives after the generated client deserializes a read-path response. The
 * restJson1 serializer/deserializer omits, at EVERY level (nested objects and
 * array items), what is not on the wire:
 *   - `meta.schemaVersion` (not modeled — no consumer reads it);
 *   - persistence-only `defaultPermissionSetArn` and
 *     `allowedPermissionSetArns` (hydrated references are modeled instead);
 *   - members that are `null` (e.g. a cleared `blueprintId`) or `undefined` (unset
 *     optionals — e.g. `costReportGroup`, a desired-assignment's `displayName`);
 *   - a structure left with no present members (e.g. a `meta` whose only field was
 *     the dropped `schemaVersion`).
 * A persisted `Lease` (from the store/factory) always carries a required
 * `schemaVersion` and, from `generateSchemaData`, optionals that vary run to run,
 * so it can never equal the API shape directly — read-path tests compare the hook
 * result against `mockApiLease`, not `mockLease`.
 */
export function toApiLease(lease: LeaseView): Record<string, unknown> {
  return stripUnmodeled(lease) as Record<string, unknown>;
}

const unmodeledLeaseResponseMembers = new Set([
  "schemaVersion",
  "defaultPermissionSetArn",
  "allowedPermissionSetArns",
  "lifecycleDispatch",
]);

// Recursive worker: walks arbitrary nested wire values (hence `unknown`), dropping
// what `toApiLease` documents. Only the public entry above is lease-typed.
function stripUnmodeled(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripUnmodeled);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [key, member] of Object.entries(value)) {
      // Present-but-unmodeled members are dropped whatever their value; the
      // null/undefined/empty rules below cover everything else.
      if (
        unmodeledLeaseResponseMembers.has(key) ||
        member === null ||
        member === undefined
      ) {
        continue;
      }
      const projected = stripUnmodeled(member);
      if (
        projected !== null &&
        typeof projected === "object" &&
        !Array.isArray(projected) &&
        Object.keys(projected).length === 0
      ) {
        continue;
      }
      out[key] = projected;
    }
    return out;
  }
  return value;
}

/** `mockLease` as the API returns it (see `toApiLease`). */
export const mockApiLease = toApiLease(mockLease);

// The base64url composite key, not the persisted `uuid` on `mockLease`.
export const mockCostHistoryLeaseId = "bW9jay1jb3N0LWhpc3RvcnktbGVhc2U";

export const mockForbiddenCostHistoryLeaseId = "Zm9yYmlkZGVuLWxlYXNl";

// Restated rather than imported from the service, so this module stays clear of
// the domain graph that a test has to be able to mock the transport of.
const COST_HISTORY_MAX_RESULTS = 100;

type HistoryQuery = {
  after: string | null;
  before: string | null;
  maxResults: number | undefined;
  pageIdentifier: string | null;
};

// The range filter, inclusive of `after` and exclusive of `before`, applied
// before paging as the API applies it before its page query.
const inRange = ({ after, before }: HistoryQuery, timestamp: string) =>
  (after === null || timestamp >= after) &&
  (before === null || timestamp < before);

// `pageIdentifier` is the offset into the paged array.
function pageOf<T>(
  rows: T[],
  { maxResults, pageIdentifier }: HistoryQuery,
): { rows: T[]; nextPageIdentifier?: string } {
  const start = pageIdentifier === null ? 0 : Number(pageIdentifier);
  const end = maxResults === undefined ? rows.length : start + maxResults;
  return {
    rows: rows.slice(start, end),
    ...(end < rows.length ? { nextPageIdentifier: String(end) } : {}),
  };
}

/**
 * One lease cost route over the fixture, refusing what the API refuses: an
 * unsigned request, a lease the caller cannot read or that does not exist, a page
 * size outside the model's range, and a range that does not end after it starts.
 */
const leaseHistoryGetHandler = (
  route: string,
  respond: (query: HistoryQuery) => object,
) =>
  http.get(
    `${getConfig().ApiUrl}/leases/:leaseId/${route}`,
    ({ request, params }) => {
      const authHeader = request.headers.get("Authorization");
      if (
        !authHeader?.startsWith("AWS4-HMAC-SHA256") ||
        !request.headers.get(IDENTITY_HEADER)
      ) {
        return new HttpResponse(null, { status: 401 });
      }
      if (params.leaseId === mockForbiddenCostHistoryLeaseId) {
        return new HttpResponse(null, { status: 403 });
      }
      if (params.leaseId !== mockCostHistoryLeaseId) {
        return new HttpResponse(null, { status: 404 });
      }
      const query = new URL(request.url).searchParams;
      const maxResultsParam = query.get("maxResults");
      const maxResults =
        maxResultsParam === null ? undefined : Number(maxResultsParam);
      if (
        maxResults !== undefined &&
        (!Number.isInteger(maxResults) ||
          maxResults < 1 ||
          maxResults > COST_HISTORY_MAX_RESULTS)
      ) {
        return new HttpResponse(null, { status: 400 });
      }
      const after = query.get("afterTimestamp");
      const before = query.get("beforeTimestamp");
      if (after !== null && before !== null && after >= before) {
        return new HttpResponse(null, { status: 400 });
      }
      return HttpResponse.json(
        respond({
          after,
          before,
          maxResults,
          pageIdentifier: query.get("pageIdentifier"),
        }),
      );
    },
  );

/**
 * The fixture's newest figures. The route takes no query, so whatever range is
 * being browsed, the headline reports the newest reading.
 */
export const leaseCostSummaryGetHandler = (
  fixture: LeaseHistoryFixture = createMockCostHistory(),
) =>
  leaseHistoryGetHandler("costSummary", (): CostSummaryResponse => ({
    status: "success",
    data: costSummaryOf(fixture),
  }));

/** The fixture's cost readings, paged. */
export const leaseCostHistoryGetHandler = (
  fixture: LeaseHistoryFixture = createMockCostHistory(),
) =>
  leaseHistoryGetHandler("costHistory", (query): CostHistoryResponse => {
    const { rows, ...cursor } = pageOf(
      fixture.data.result.filter((row) => inRange(query, row.timestamp)),
      query,
    );
    return { status: "success", data: { result: rows, ...cursor } };
  });

// A reading is the rows sharing a timestamp, one per region and model. The rows
// are newest first, so a reading's rows sit together.
const readingsOf = (rows: TokenSeriesRow[]): TokenSeriesRow[][] =>
  rows.reduce<TokenSeriesRow[][]>((readings, row) => {
    const last = readings.at(-1);
    if (last?.[0]?.timestamp === row.timestamp) {
      last.push(row);
    } else {
      readings.push([row]);
    }
    return readings;
  }, []);

/** The fixture's token rows, paged by reading as the API pages them. */
export const leaseBedrockTokenHistoryGetHandler = (
  fixture: LeaseHistoryFixture = createMockCostHistory(),
) =>
  leaseHistoryGetHandler(
    "bedrockTokenHistory",
    (query): BedrockTokenHistoryResponse => {
      const { rows, ...cursor } = pageOf(
        readingsOf(
          fixture.data.tokens.filter((row) => inRange(query, row.timestamp)),
        ),
        query,
      );
      return {
        status: "success",
        data: { result: rows.flat(), ...cursor },
      };
    },
  );

/** The fixture's breaches, paged. */
export const leaseBreachHistoryGetHandler = (
  fixture: LeaseHistoryFixture = createMockCostHistory(),
) =>
  leaseHistoryGetHandler("breachHistory", (query): BreachHistoryResponse => {
    const { rows, ...cursor } = pageOf(
      fixture.data.breaches.filter((breach) =>
        inRange(query, breach.timestamp),
      ),
      query,
    );
    return { status: "success", data: { result: rows, ...cursor } };
  });

export const leaseHandlers = [
  mockLeaseApi.getHandler(),
  mockLeaseApi.getHandler("/:id"),
  mockLeaseApi.patchHandler("/:id"),
  mockLeaseApi.postHandler("/request"),
  mockLeaseApi.reviewHandler("/review"),
  leaseCostSummaryGetHandler(),
  leaseCostHistoryGetHandler(),
  leaseBedrockTokenHistoryGetHandler(),
  leaseBreachHistoryGetHandler(),
];

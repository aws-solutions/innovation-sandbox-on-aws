// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  BEDROCK_TOKEN_SK_PREFIX,
  BREACH_SK_PREFIX,
  COST_SK_PREFIX,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history-keys.js";
import type {
  BedrockTokenRow,
  BreachRecord,
  CostObservation,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import type {
  BreachEntry,
  CostHistoryResultRow,
  TokenSeriesRow,
} from "@amzn/innovation-sandbox-shared/types/cost-history.js";

/**
 * Stored row to contract row. The handler pattern spreads a store result straight
 * into the response body (leases-handler.ts:265), which would serialize `sk`,
 * `leaseUuid`, `ttl`, `meta` and both anchor-day snapshots, so the projection
 * lives beside the contract rather than in the handler.
 */
export function toCostHistoryResultRow(
  row: CostObservation,
): CostHistoryResultRow {
  return {
    timestamp: row.sk.slice(COST_SK_PREFIX.length),
    billedCostAccrued: row.billedCostAccrued,
    predictedCostAtRefresh: row.predictedCostAtRefresh,
    ...(row.serviceBreakdown === undefined
      ? {}
      : { serviceBreakdown: row.serviceBreakdown }),
  };
}

/**
 * The same reason as above, for the breach window. `BreachEntry` deliberately
 * keeps `evaluatedBy` and the two evaluated spend figures -- the response shows them -- so
 * what this strips is `leaseUuid`, `ttl`, `meta` and the raw `sk`.
 */
export function toBreachEntry(row: BreachRecord): BreachEntry {
  return {
    timestamp: row.sk.slice(BREACH_SK_PREFIX.length),
    triggeredBy: row.triggeredBy,
    action: row.action,
    thresholdDollars: row.thresholdDollars,
    thresholdRate: row.thresholdRate,
    thresholdRateBasis: row.thresholdRateBasis,
    thresholdHoursRemaining: row.thresholdHoursRemaining,
    billedCostAtFire: row.billedCostAtFire,
    predictedCostAtFire: row.predictedCostAtFire,
    rateAtFire: row.rateAtFire,
    rateSourceAtFire: row.rateSourceAtFire,
    evaluatedBy: row.evaluatedBy,
    evaluatedSpendAtFire: row.evaluatedSpendAtFire,
    monitoredBedrockTokenCostAtFire: row.monitoredBedrockTokenCostAtFire,
    insight: row.insight,
  };
}

/**
 * One stored token row to its flattened series rows, region then model.
 *
 * Drops `coveredThrough` in particular -- an internal per-region poll anchor --
 * along with `monitoredBedrockTokenCostDelta`, `leaseUuid`, `ttl` and
 * `meta`. `monitoredBedrockTokenCost` is lease-wide as of the timestamp, so
 * it repeats rather than being divided between rows.
 */
export function toTokenSeriesRows(row: BedrockTokenRow): TokenSeriesRow[] {
  const timestamp = row.sk.slice(BEDROCK_TOKEN_SK_PREFIX.length);
  const rows: TokenSeriesRow[] = [];
  for (const [region, models] of Object.entries(row.tokens)) {
    for (const [modelId, quad] of Object.entries(models)) {
      rows.push({
        timestamp,
        region,
        modelId,
        input: quad.input,
        output: quad.output,
        cacheRead: quad.cacheRead,
        cacheWrite: quad.cacheWrite,
        ...(row.monitoredBedrockTokenCost === null
          ? {}
          : {
              monitoredBedrockTokenCost: row.monitoredBedrockTokenCost,
            }),
      });
    }
  }
  return rows;
}

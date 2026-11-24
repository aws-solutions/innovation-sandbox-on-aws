// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Keys for the lease cost history table. One table, three record types for a
 * lease, discriminated by sort-key prefix so they live together but stay separable
 * by `begins_with`:
 *
 *   Partition key: leaseUuid  (the value in the `ISB:LeaseId` tag)
 *   Sort key:      COST#<iso8601> | BREACH#<iso8601> | BEDROCK_TOKEN#<iso8601>
 *
 * The prefixes sort `BEDROCK_TOKEN# < BREACH# < COST#`, each block internally
 * chronological.
 *
 * Timestamps use the fixed-width ISO millisecond form from the Luxon UTC clock
 * (`nowAsIsoDatetimeString()`, or an equivalent `datetimeAsString(now())`).
 * Fixed width is what makes lexicographic sort agree with chronological order --
 * a seconds-only or offset-bearing value sorts wrong silently, so every sort key
 * is regex-pinned.
 */

// Sort key prefixes. Ordered here as they sort.
export const BEDROCK_TOKEN_SK_PREFIX = "BEDROCK_TOKEN#";
export const BREACH_SK_PREFIX = "BREACH#";
export const COST_SK_PREFIX = "COST#";

/**
 * Encapsulates sort-key construction so callers never assemble a
 * `<PREFIX><timestamp>` by hand. Timestamps are used unmodified, so a malformed one
 * fails the schema regex at write time rather than being coerced into a shape that
 * sorts wrong.
 */
export class LeaseCostHistoryKey {
  public readonly leaseUuid: string;

  constructor(leaseUuid: string) {
    this.leaseUuid = leaseUuid;
  }

  /** Sort key for a reported cost observation: `COST#<timestamp>`. */
  public generateCostSk(timestamp: string): string {
    return `${COST_SK_PREFIX}${timestamp}`;
  }

  /** Sort key for a threshold breach record: `BREACH#<timestamp>`. */
  public generateBreachSk(timestamp: string): string {
    return `${BREACH_SK_PREFIX}${timestamp}`;
  }

  /** Sort key for a Bedrock token row: `BEDROCK_TOKEN#<timestamp>`. */
  public generateBedrockTokenSk(timestamp: string): string {
    return `${BEDROCK_TOKEN_SK_PREFIX}${timestamp}`;
  }

  toString(): string {
    return `LeaseCostHistoryKey(${this.leaseUuid})`;
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DynamoDBDocumentClient,
  GetCommand,
  paginateQuery,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  LEASE_USER_USAGE_SK_PREFIX,
  leaseUsagePk,
  LeaseUserSandboxSpacesUsage,
  LeaseUserSandboxSpacesUsageSchema,
  leaseUserUsageSk,
  MalformedSandboxSpacesUsageRecordError,
  RecordTurnUsageProps,
  roundSpend,
  SandboxSpacesUsageStore,
  userUsagePk,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import { parseResults } from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  calculateTtlInEpochSeconds,
  nowAsIsoDatetimeString,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

/** The four token counters recorded with ADDs on each lease-scoped item. */
const TOKEN_FIELDS = [
  "inputTokens",
  "outputTokens",
  "cacheReadTokens",
  "cacheWriteTokens",
] as const;

export class DynamoSandboxSpacesUsageStore implements SandboxSpacesUsageStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;
  /**
   * Retention window in days, sourced from `globalConfig.leases.ttl`.
   * When set, every monthly rollup write stamps a rolling `ttl` attribute.
   * Omit in tests or contexts where `globalConfig` is unavailable.
   */
  private readonly ttlDays?: number;

  constructor(props: {
    client: DynamoDBDocumentClient;
    tableName: string;
    ttlDays?: number;
  }) {
    this.client = props.client;
    this.tableName = props.tableName;
    this.ttlDays = props.ttlDays;
  }

  // ─── Lease-scoped Sandbox Spaces usage ─────────────────────────────────────

  async recordTurnUsage(props: RecordTurnUsageProps): Promise<void> {
    // All counters are top-level ADDs, which create a missing item, so the
    // first turn on a lease needs no initialization. Errors surface to SQS.
    await this.client.send(this.buildRecordTransaction(props));
  }

  async getLeaseUserUsage(
    leaseId: string,
    userId: string,
  ): Promise<LeaseUserSandboxSpacesUsage | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: leaseUsagePk(leaseId), sk: leaseUserUsageSk(userId) },
        ConsistentRead: true,
      }),
    );
    if (!result.Item) return null;

    const parsed = LeaseUserSandboxSpacesUsageSchema.safeParse(result.Item);
    if (!parsed.success) {
      throw new MalformedSandboxSpacesUsageRecordError(
        `Sandbox Spaces usage for user ${userId} on lease ${leaseId} could not be parsed: ${parsed.error.message}`,
      );
    }
    return parsed.data;
  }

  async listLeaseUserUsage(
    leaseId: string,
  ): Promise<{ usage: LeaseUserSandboxSpacesUsage[]; error?: string }> {
    const allItems = await this.queryAllPages({
      KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :prefix)",
      ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
      ExpressionAttributeValues: {
        ":pk": leaseUsagePk(leaseId),
        ":prefix": LEASE_USER_USAGE_SK_PREFIX,
      },
    });

    // Per-user usage is attribution only — exclude corrupt rows rather than
    // failing the whole read and hiding every other user's usage. The caller
    // surfaces `error` when present.
    const { result: usage, error } = parseResults(
      allItems,
      LeaseUserSandboxSpacesUsageSchema,
    );
    return { usage, error };
  }

  /**
   * Stamps `ttl` on every lease-scoped usage item. Call at lease termination.
   */
  async stampLeaseTtl(leaseId: string, ttlEpochSeconds: number): Promise<void> {
    const allItems = (
      await this.queryAllPages({
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": leaseUsagePk(leaseId) },
        ProjectionExpression: "pk, sk",
      })
    ).map((item) => ({ pk: item["pk"] as string, sk: item["sk"] as string }));

    await Promise.all(
      allItems.map(({ pk, sk }) =>
        this.client.send(
          new UpdateCommand({
            TableName: this.tableName,
            Key: { pk, sk },
            UpdateExpression: "SET #ttl = :ttl",
            ExpressionAttributeNames: { "#ttl": "ttl" },
            ExpressionAttributeValues: { ":ttl": ttlEpochSeconds },
          }),
        ),
      ),
    );
  }

  /**
   * Builds the optional SET clause for the monthly-rollup leg of
   * `buildRecordTransaction`.
   * Returns the clause string, and the name/value entries to spread into the
   * parent expression maps.
   */
  private buildOptionalSetClause(args: {
    sessionId?: string;
    ttlEpochSeconds?: number;
    userEmail?: string;
  }): {
    clause: string;
    names: Record<string, string>;
    values: Record<string, unknown>;
  } {
    const { sessionId, ttlEpochSeconds, userEmail } = args;
    const setClauses: string[] = [];
    const names: Record<string, string> = {};
    const values: Record<string, unknown> = {};

    if (sessionId) {
      setClauses.push("#lastSessionId = :lastSessionId");
      names["#lastSessionId"] = "lastSessionId";
      values[":lastSessionId"] = sessionId;
    }
    if (userEmail) {
      setClauses.push("#userEmail = :userEmail");
      names["#userEmail"] = "userEmail";
      values[":userEmail"] = userEmail;
    }
    if (ttlEpochSeconds !== undefined) {
      setClauses.push("#ttl = :ttl");
      names["#ttl"] = "ttl";
      values[":ttl"] = ttlEpochSeconds;
    }

    return { clause: setClauses.join(", "), names, values };
  }

  /** Paginates a Query on this table until all items are returned.
   *
   * No page cap is applied. Both callers query a single `LEASE#{leaseId}`
   * partition whose item count is bounded by users-per-lease (a small number
   * in practice).
   */
  private async queryAllPages(
    queryInput: Omit<
      NonNullable<ConstructorParameters<typeof QueryCommand>[0]>,
      "TableName" | "ExclusiveStartKey"
    >,
  ): Promise<Record<string, unknown>[]> {
    const allItems: Record<string, unknown>[] = [];
    const paginator = paginateQuery(
      { client: this.client },
      { TableName: this.tableName, ...queryInput },
    );
    for await (const page of paginator) {
      allItems.push(...(page.Items ?? []));
    }
    return allItems;
  }

  /**
   * Builds the record transaction: two atomic counter ADDs —
   * SANDBOX_SPACES_USAGE#USER#{userId} and USER#/MONTH#.
   */
  private buildRecordTransaction(
    props: RecordTurnUsageProps,
  ): TransactWriteCommand {
    const { leaseId, userId, userEmail, month, tokens, sessionId } = props;
    const now = nowAsIsoDatetimeString();
    const sandboxSpacesEstimatedTokenCostAccrued = roundSpend(
      props.sandboxSpacesEstimatedTokenCostAccrued,
    );
    const ttlEpochSeconds = this.ttlDays
      ? calculateTtlInEpochSeconds(this.ttlDays)
      : undefined;
    const totalTokens =
      tokens.inputTokens +
      tokens.outputTokens +
      tokens.cacheReadTokens +
      tokens.cacheWriteTokens;

    return new TransactWriteCommand({
      TransactItems: [
        this.leaseCounterAction({
          leaseId,
          // Carried as a top-level attribute so the deferred per-user dashboard
          // index can be added later without parsing the sort key.
          userId,
          userEmail,
          tokens,
          sandboxSpacesEstimatedTokenCostAccrued,
          now,
        }),
        this.monthlyRollupAction({
          userId,
          userEmail,
          month,
          tokens,
          totalTokens,
          sandboxSpacesEstimatedTokenCostAccrued,
          sessionId,
          ttlEpochSeconds,
        }),
      ],
    });
  }

  /**
   * The second TransactItems action: increments the USER#/MONTH# rollup.
   * Measurement only — never an enforcement input.
   */
  private monthlyRollupAction(args: {
    userId: string;
    userEmail: string;
    month: string;
    tokens: RecordTurnUsageProps["tokens"];
    totalTokens: number;
    sandboxSpacesEstimatedTokenCostAccrued: number;
    sessionId?: string;
    ttlEpochSeconds?: number;
  }) {
    const {
      userId,
      userEmail,
      month,
      tokens,
      totalTokens,
      sandboxSpacesEstimatedTokenCostAccrued,
      sessionId,
      ttlEpochSeconds,
    } = args;
    const {
      clause: setClause,
      names: setNames,
      values: setValues,
    } = this.buildOptionalSetClause({
      sessionId,
      ttlEpochSeconds,
      userEmail,
    });
    return {
      Update: {
        TableName: this.tableName,
        Key: { pk: userUsagePk(userId), sk: month },
        UpdateExpression:
          "ADD #inputTokens :inputTokens, #outputTokens :outputTokens, " +
          "#cacheReadTokens :cacheReadTokens, #cacheWriteTokens :cacheWriteTokens, " +
          "#totalTokens :totalTokens, #invocationCount :one, " +
          "#sandboxSpacesEstimatedTokenCostAccrued :sandboxSpacesEstimatedTokenCostAccrued" +
          (setClause ? ` SET ${setClause}` : ""),
        ExpressionAttributeNames: {
          "#inputTokens": "inputTokens",
          "#outputTokens": "outputTokens",
          "#cacheReadTokens": "cacheReadTokens",
          "#cacheWriteTokens": "cacheWriteTokens",
          "#totalTokens": "totalTokens",
          "#invocationCount": "invocationCount",
          "#sandboxSpacesEstimatedTokenCostAccrued":
            "sandboxSpacesEstimatedTokenCostAccrued",
          ...setNames,
        },
        ExpressionAttributeValues: {
          ":inputTokens": tokens.inputTokens,
          ":outputTokens": tokens.outputTokens,
          ":cacheReadTokens": tokens.cacheReadTokens,
          ":cacheWriteTokens": tokens.cacheWriteTokens,
          ":totalTokens": totalTokens,
          ":one": 1,
          ":sandboxSpacesEstimatedTokenCostAccrued":
            sandboxSpacesEstimatedTokenCostAccrued,
          ...setValues,
        },
      },
    };
  }

  /** The per-user lease counter increment (`SANDBOX_SPACES_USAGE#USER#{userId}`). */
  private leaseCounterAction(args: {
    leaseId: string;
    userId: string;
    userEmail: string;
    tokens: RecordTurnUsageProps["tokens"];
    sandboxSpacesEstimatedTokenCostAccrued: number;
    now: string;
  }) {
    const {
      leaseId,
      userId,
      userEmail,
      tokens,
      sandboxSpacesEstimatedTokenCostAccrued,
      now,
    } = args;

    const setClauses = [
      "#leaseId = :leaseId",
      "#lastSeenAt = :now",
      "#firstSeenAt = if_not_exists(#firstSeenAt, :now)",
      "#userId = :userId",
      ...(userEmail ? ["#userEmail = :userEmail"] : []),
    ];
    const addClauses = [
      "#sandboxSpacesEstimatedTokenCostAccrued :sandboxSpacesEstimatedTokenCostAccrued",
      "#invocationCount :one",
      ...TOKEN_FIELDS.map((field) => `#${field} :${field}`),
    ];

    return {
      Update: {
        TableName: this.tableName,
        Key: { pk: leaseUsagePk(leaseId), sk: leaseUserUsageSk(userId) },
        UpdateExpression: `SET ${setClauses.join(", ")} ADD ${addClauses.join(", ")}`,
        ExpressionAttributeNames: {
          "#leaseId": "leaseId",
          "#lastSeenAt": "lastSeenAt",
          "#firstSeenAt": "firstSeenAt",
          "#sandboxSpacesEstimatedTokenCostAccrued":
            "sandboxSpacesEstimatedTokenCostAccrued",
          "#invocationCount": "invocationCount",
          ...Object.fromEntries(
            TOKEN_FIELDS.map((field) => [`#${field}`, field]),
          ),
          "#userId": "userId",
          ...(userEmail ? { "#userEmail": "userEmail" } : {}),
        },
        ExpressionAttributeValues: {
          ":leaseId": leaseId,
          ":now": now,
          ":one": 1,
          ":sandboxSpacesEstimatedTokenCostAccrued":
            sandboxSpacesEstimatedTokenCostAccrued,
          ...Object.fromEntries(
            TOKEN_FIELDS.map((field) => [`:${field}`, tokens[field]]),
          ),
          ":userId": userId,
          ...(userEmail ? { ":userEmail": userEmail } : {}),
        },
      },
    };
  }
}

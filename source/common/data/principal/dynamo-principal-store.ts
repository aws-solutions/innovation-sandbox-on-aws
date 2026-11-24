// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Logger } from "@aws-lambda-powertools/logger";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  paginateQuery,
  paginateScan,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";
import pMap from "p-map";

import {
  OptionalItem,
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64EncodeCompositeKey,
  decodePageIdentifier,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ItemAlreadyExists,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { withUpdatedMetadata } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import type { PersistedPermissionSetCacheItem } from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import {
  PERMISSION_SET_CACHE_PK,
  permissionSetCacheSk,
  PermissionSetSchemaVersion,
  PersistedPermissionSetCacheItemSchema,
} from "@amzn/innovation-sandbox-commons/data/permission-set/permission-set.js";
import {
  GROUP_MEMBERSHIP_SK,
  groupPk,
  LEASE_SK_PREFIX,
  leaseSk,
  parseAssignmentSk,
  principalPk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";

import type {
  DeleteAssignmentProps,
  DeleteAssignmentsByLeasePrincipalProps,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  PersistedAssignment,
  PersistedAssignmentLeaseIndexKeySchema,
  PersistedAssignmentSchema,
  PersistedGroupAssignment,
  PersistedGroupAssignmentSchema,
  PersistedGroupIndexProjectionSchema,
  PersistedGroupMembershipCache,
  PersistedGroupMembershipCacheSchema,
  PersistedPrincipalCacheItem,
  PersistedPrincipalCacheItemSchema,
  PersistedUserAssignment,
  PersistedUserAssignmentKeySchema,
  PersistedUserAssignmentSchema,
  PRINCIPAL_CACHE_GROUP_SK_PREFIX,
  PRINCIPAL_CACHE_PK,
  PRINCIPAL_CACHE_USER_SK_PREFIX,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import {
  batchWriteWithRetry,
  chunk,
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

const logger = new Logger({ serviceName: "DynamoPrincipalStore" });

export class DynamoPrincipalStore extends PrincipalStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    principalTableName: string;
  }) {
    super();
    this.tableName = props.principalTableName;
    this.ddbClient = props.client;
  }

  @validateItem(PersistedUserAssignmentSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async createUserAssignment(
    assignment: PersistedUserAssignment,
  ): Promise<PersistedUserAssignment> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(assignment),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return assignment;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("User assignment already exists.");
      }
      throw error;
    }
  }

  @validateItem(PersistedGroupAssignmentSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async createGroupAssignment(
    assignment: PersistedGroupAssignment,
  ): Promise<PersistedGroupAssignment> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(assignment),
          ConditionExpression:
            "attribute_not_exists(pk) AND attribute_not_exists(sk)",
        }),
      );
      return assignment;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("Group assignment already exists.");
      }
      throw error;
    }
  }

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link findAssignment} or {@link getAssignmentsForPrincipalAndLease}.
   */
  public override async getUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedUserAssignment>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: userPk(userId), sk: leaseSk(leaseId) },
      }),
    );
    return parseSingleItemResult(result.Item, PersistedUserAssignmentSchema);
  }

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link findAssignment} or {@link getAssignmentsForPrincipalAndLease}.
   */
  public override async getGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<SingleItemResult<PersistedGroupAssignment>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: groupPk(groupId), sk: leaseSk(leaseId) },
      }),
    );
    return parseSingleItemResult(result.Item, PersistedGroupAssignmentSchema);
  }

  /**
   * Returns every legacy and tuple-keyed assignment for one principal and lease.
   */
  public override async getAssignmentsForPrincipalAndLease(props: {
    principalId: string;
    principalType: PrincipalType;
    leaseId: string;
  }): Promise<PersistedAssignment[]> {
    const items: Record<string, unknown>[] = [];
    const paginator = paginateQuery(
      { client: this.ddbClient },
      {
        TableName: this.tableName,
        ConsistentRead: true,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": principalPk(props),
          ":skPrefix": leaseSk(props.leaseId),
        },
      },
    );
    for await (const page of paginator) {
      items.push(...(page.Items ?? []));
    }

    const { result } = parseResults(items, PersistedAssignmentSchema);
    return result;
  }

  /**
   * Finds an assignment by permission-set ARN, with explicit handling for a
   * suffix-less legacy record representing the immutable built-in permission
   * set rather than the lease's configurable default.
   */
  public override async findAssignment(props: {
    principalId: string;
    principalType: PrincipalType;
    leaseId: string;
    permissionSetArn?: string;
    builtInPermissionSetArn?: string;
  }): Promise<PersistedAssignment | undefined> {
    const records = await this.getAssignmentsForPrincipalAndLease(props);
    return this.matchByPermissionSet(
      records,
      props.permissionSetArn,
      props.builtInPermissionSetArn,
    )[0];
  }

  private matchByPermissionSet(
    records: PersistedAssignment[],
    permissionSetArn?: string,
    builtInPermissionSetArn?: string,
  ): PersistedAssignment[] {
    if (permissionSetArn === undefined) {
      return records;
    }

    const exactMatches = records.filter(
      (record) => record.permissionSetArn === permissionSetArn,
    );

    if (
      builtInPermissionSetArn === undefined ||
      permissionSetArn !== builtInPermissionSetArn
    ) {
      return exactMatches;
    }

    const legacyDefaultMatches = records.filter(
      (record) =>
        record.permissionSetArn === undefined &&
        parseAssignmentSk(record.sk)?.permissionSetId === undefined,
    );
    return [...exactMatches, ...legacyDefaultMatches];
  }

  public override async getAssignmentsForLease(props: {
    leaseId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>> {
    const { leaseId, pageIdentifier, pageSize } = props;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "LeaseIndex",
        KeyConditionExpression: "#leaseId = :leaseId",
        ExpressionAttributeNames: { "#leaseId": "leaseId" },
        ExpressionAttributeValues: { ":leaseId": leaseId },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedAssignmentLeaseIndexKeySchema.refine(
            (cursor) => cursor.leaseId === leaseId,
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, PersistedAssignmentSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async getDirectAssignmentsForUser(props: {
    userId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedUserAssignment>> {
    const { userId, pageIdentifier, pageSize } = props;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: { "#pk": "pk", "#sk": "sk" },
        ExpressionAttributeValues: {
          ":pk": userPk(userId),
          ":skPrefix": LEASE_SK_PREFIX,
        },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedUserAssignmentKeySchema.refine(
            (cursor) => cursor.pk === userPk(userId),
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, PersistedUserAssignmentSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async getGroupMembershipCache(
    userId: string,
  ): Promise<SingleItemResult<PersistedGroupMembershipCache>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk: userPk(userId), sk: GROUP_MEMBERSHIP_SK },
      }),
    );
    return parseSingleItemResult(
      result.Item,
      PersistedGroupMembershipCacheSchema,
    );
  }

  @validateItem(PersistedGroupMembershipCacheSchema)
  @withMetadata(PrincipalSchemaVersion)
  public override async putGroupMembershipCache(
    cache: PersistedGroupMembershipCache,
  ): Promise<void> {
    await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: removeNullFieldsForDynamoDB(cache),
      }),
    );
  }

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link deleteAssignmentsByLeasePrincipal}; omit `permissionSetArn` to delete every
   * assignment for the principal and lease.
   */
  public override async deleteUserAssignment(
    userId: string,
    leaseId: string,
  ): Promise<OptionalItem> {
    return this.deleteAssignmentByKey(userPk(userId), leaseSk(leaseId));
  }

  /**
   * @deprecated Assignment identity now includes the permission set. Use
   * {@link deleteAssignmentsByLeasePrincipal}; omit `permissionSetArn` to delete every
   * assignment for the principal and lease.
   */
  public override async deleteGroupAssignment(
    groupId: string,
    leaseId: string,
  ): Promise<OptionalItem> {
    return this.deleteAssignmentByKey(groupPk(groupId), leaseSk(leaseId));
  }

  /**
   * Deletes one assignment record by its real principal-table key.
   */
  public override async deleteAssignment(
    props: DeleteAssignmentProps,
  ): Promise<boolean> {
    if (parseAssignmentSk(props.sk) === undefined) {
      throw new Error(`Invalid assignment sort key: ${props.sk}`);
    }

    const expected =
      "expectedLastEditTime" in props
        ? { lastEditTime: props.expectedLastEditTime }
        : undefined;
    const deleted = await this.deleteAssignmentByKey(
      principalPk(props),
      props.sk,
      expected,
    );
    return deleted !== undefined;
  }

  /**
   * Deletes assignments matching a principal and lease, optionally narrowed to
   * a permission set. Omitting the permission-set ARN deletes every assignment
   * for the principal and lease.
   */
  public override async deleteAssignmentsByLeasePrincipal(
    props: DeleteAssignmentsByLeasePrincipalProps,
  ): Promise<number> {
    const records = await this.getAssignmentsForPrincipalAndLease(props);
    const targets = this.matchByPermissionSet(
      records,
      props.permissionSetArn,
      props.builtInPermissionSetArn,
    );

    let deletedCount = 0;
    for (const target of targets) {
      try {
        const deleted = await this.deleteAssignment({
          principalId: props.principalId,
          principalType: props.principalType,
          sk: target.sk,
          expectedLastEditTime: target.meta?.lastEditTime,
        });
        if (deleted) {
          deletedCount++;
        }
      } catch (error: unknown) {
        if (!(error instanceof ConditionalCheckFailedException)) {
          throw error;
        }
      }
    }

    return deletedCount;
  }

  private async deleteAssignmentByKey(
    pk: string,
    sk: string,
    expected?: { lastEditTime?: string },
  ): Promise<OptionalItem> {
    const unchangedCondition =
      expected === undefined
        ? {}
        : {
            ConditionExpression:
              expected.lastEditTime === undefined
                ? "attribute_not_exists(#meta.#lastEditTime)"
                : "#meta.#lastEditTime = :expectedLastEditTime",
            ExpressionAttributeNames: {
              "#meta": "meta",
              "#lastEditTime": "lastEditTime",
            },
            ...(expected.lastEditTime === undefined
              ? {}
              : {
                  ExpressionAttributeValues: {
                    ":expectedLastEditTime": expected.lastEditTime,
                  },
                }),
          };

    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ReturnValues: "ALL_OLD",
        ...unchangedCondition,
      }),
    );
    return result.Attributes;
  }

  /**
   * Writes up to 25 assignment records in a single BatchWrite call with retry.
   *
   * **Important:** BatchWriteItem does not support condition expressions, so this
   * method will silently overwrite existing records.
   */
  public override async batchPutAssignments(
    assignments: PersistedAssignment[],
  ): Promise<void> {
    if (assignments.length === 0) return;
    if (assignments.length > 25) {
      throw new Error(
        `batchPutAssignments accepts at most 25 items, received ${assignments.length}`,
      );
    }

    const enrichedAssignments = assignments.map((assignment) => {
      PersistedAssignmentSchema.parse(assignment);
      return withUpdatedMetadata(assignment, PrincipalSchemaVersion);
    });

    await batchWriteWithRetry({
      client: this.ddbClient,
      tableName: this.tableName,
      batches: [
        enrichedAssignments.map((assignment) => ({
          PutRequest: {
            Item: removeNullFieldsForDynamoDB(assignment),
          },
        })),
      ],
      concurrency: 1,
      numOfAttempts: 4,
      startingDelay: 100,
    });
  }

  /**
   * Scans the group index and returns each assignment's parsed lease ID and
   * verbatim sort key so tuple suffixes are preserved.
   */
  public override async getAllGroupAssignmentKeys(): Promise<
    { groupId: string; leaseId: string; sk: string }[]
  > {
    const allRawItems: Record<string, unknown>[] = [];
    const paginator = paginateScan(
      { client: this.ddbClient },
      { TableName: this.tableName, IndexName: "GroupIndex" },
    );
    for await (const page of paginator) {
      allRawItems.push(...(page.Items ?? []));
    }

    const { result: validProjections } = parseResults(
      allRawItems,
      PersistedGroupIndexProjectionSchema,
    );

    return validProjections.flatMap((projection) => {
      const parsed = parseAssignmentSk(projection.sk);
      return parsed
        ? [
            {
              groupId: projection.groupId,
              leaseId: parsed.leaseId,
              sk: projection.sk,
            },
          ]
        : [];
    });
  }

  /**
   * Retrieves group assignments using their exact stored sort keys, retrying
   * any unprocessed BatchGet keys.
   */
  public override async batchGetGroupAssignments(
    keys: { groupId: string; sk: string }[],
  ): Promise<PersistedGroupAssignment[]> {
    if (keys.length === 0) return [];

    // Dedupe input keys (BatchGetItem rejects duplicates). Tuple-stable
    // composite key avoids any chance of separator collision.
    const uniqueKeys = Array.from(
      new Map(
        keys.map((k) => [JSON.stringify([k.groupId, k.sk]), k] as const),
      ).values(),
    );

    const batches = chunk(uniqueKeys, 100);
    const allRawItems: Record<string, unknown>[] = [];

    await pMap(
      batches,
      async (batch) => {
        let pendingKeys = batch.map(({ groupId, sk }) => ({
          pk: groupPk(groupId),
          sk,
        }));

        await backOff(
          async () => {
            const result = await this.ddbClient.send(
              new BatchGetCommand({
                RequestItems: {
                  [this.tableName]: { Keys: pendingKeys },
                },
              }),
            );

            allRawItems.push(...(result.Responses?.[this.tableName] ?? []));

            const unprocessed =
              result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
            if (unprocessed.length > 0) {
              pendingKeys = unprocessed as typeof pendingKeys;
              throw new BatchUnprocessedItemsError(unprocessed.length);
            }
          },
          {
            numOfAttempts: 4,
            startingDelay: 100,
            jitter: "full",
            retry: (error: unknown) =>
              error instanceof BatchUnprocessedItemsError,
          },
        );
      },
      { concurrency: 5 },
    );

    const { result } = parseResults(
      allRawItems,
      PersistedGroupAssignmentSchema,
    );
    return result;
  }

  /**
   * Writes cached principal items to DynamoDB in batches of 25 with retry on unprocessed items.
   * Validates each item against the schema and enriches with metadata before writing.
   * Batches are written in parallel with a concurrency limit of 2.
   */
  public override async batchPutCacheItems(
    items: PersistedPrincipalCacheItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    const enrichedItems = Array.from(
      new Map(
        items.map((item) => {
          const parsed = PersistedPrincipalCacheItemSchema.parse(item);
          return [
            parsed.sk,
            withUpdatedMetadata(parsed, PrincipalSchemaVersion),
          ] as const;
        }),
      ).values(),
    );

    await batchWriteWithRetry({
      client: this.ddbClient,
      tableName: this.tableName,
      batches: chunk(enrichedItems, 25).map((batch) =>
        batch.map((item) => ({
          PutRequest: { Item: removeNullFieldsForDynamoDB(item) },
        })),
      ),
    });
  }

  /**
   * Queries all cached principals from the `principalCache` partition.
   * Optionally filters by type using `begins_with(sk, "user#"|"group#")`.
   * Paginates internally and validates each item against the schema.
   * Invalid items are excluded from results and reported via the error field.
   */
  public override async getCacheItems(props: {
    type?: PrincipalType;
  }): Promise<PersistedPrincipalCacheItem[]> {
    const allRawItems: Record<string, unknown>[] = [];
    let exclusiveStartKey: Record<string, unknown> | undefined;

    do {
      let keyCondition: string;
      const expressionNames: Record<string, string> = { "#pk": "pk" };
      const expressionValues: Record<string, unknown> = {
        ":pk": PRINCIPAL_CACHE_PK,
      };

      if (props.type === "USER") {
        keyCondition = "#pk = :pk AND begins_with(#sk, :skPrefix)";
        expressionNames["#sk"] = "sk";
        expressionValues[":skPrefix"] = PRINCIPAL_CACHE_USER_SK_PREFIX;
      } else if (props.type === "GROUP") {
        keyCondition = "#pk = :pk AND begins_with(#sk, :skPrefix)";
        expressionNames["#sk"] = "sk";
        expressionValues[":skPrefix"] = PRINCIPAL_CACHE_GROUP_SK_PREFIX;
      } else {
        keyCondition = "#pk = :pk";
      }

      const result = await this.ddbClient.send(
        new QueryCommand({
          TableName: this.tableName,
          KeyConditionExpression: keyCondition,
          ExpressionAttributeNames: expressionNames,
          ExpressionAttributeValues: expressionValues,
          ExclusiveStartKey: exclusiveStartKey,
        }),
      );

      allRawItems.push(...(result.Items ?? []));
      exclusiveStartKey = result.LastEvaluatedKey;
    } while (exclusiveStartKey);

    const { result } = parseResults(
      allRawItems,
      PersistedPrincipalCacheItemSchema,
    );
    return result;
  }

  /**
   * Retrieves multiple cached principals in a single BatchGetItem call.
   * Returns only items that exist in the cache; missing items are silently omitted.
   * Retries unprocessed keys with exponential backoff.
   */
  public override async batchGetCacheItems(
    keys: { principalId: string; principalType: PrincipalType }[],
  ): Promise<PersistedPrincipalCacheItem[]> {
    if (keys.length === 0) return [];

    let dynamoKeys = keys.map(({ principalId, principalType }) => {
      const skPrefix =
        principalType === "USER"
          ? PRINCIPAL_CACHE_USER_SK_PREFIX
          : PRINCIPAL_CACHE_GROUP_SK_PREFIX;
      return { pk: PRINCIPAL_CACHE_PK, sk: `${skPrefix}${principalId}` };
    });

    const allRawItems: Record<string, unknown>[] = [];

    await backOff(
      async () => {
        const result = await this.ddbClient.send(
          new BatchGetCommand({
            RequestItems: {
              [this.tableName]: { Keys: dynamoKeys },
            },
          }),
        );

        allRawItems.push(...(result.Responses?.[this.tableName] ?? []));

        const unprocessed =
          result.UnprocessedKeys?.[this.tableName]?.Keys ?? [];
        if (unprocessed.length > 0) {
          dynamoKeys = unprocessed as typeof dynamoKeys;
          throw new BatchUnprocessedItemsError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) => error instanceof BatchUnprocessedItemsError,
      },
    );

    const { result } = parseResults(
      allRawItems,
      PersistedPrincipalCacheItemSchema,
    );
    return result;
  }

  /**
   * Deletes cached principal items by sort key in batches of 25 with retry on unprocessed items.
   * Batches are deleted in parallel with a concurrency limit of 2.
   * Used to remove stale records that no longer exist in Identity Store.
   */
  public override async batchDeleteCacheItemsBySk(
    sks: string[],
  ): Promise<void> {
    if (sks.length === 0) return;

    const uniqueSks = Array.from(new Set(sks));
    await batchWriteWithRetry({
      client: this.ddbClient,
      tableName: this.tableName,
      batches: chunk(uniqueSks, 25).map((batch) =>
        batch.map((sk) => ({
          DeleteRequest: { Key: { pk: PRINCIPAL_CACHE_PK, sk } },
        })),
      ),
    });
  }

  /**
   * Upserts permission-set cache items in batches, refreshing their metadata
   * and retrying unprocessed writes.
   */
  public override async batchPutPermissionSetCacheItems(
    items: PersistedPermissionSetCacheItem[],
  ): Promise<void> {
    if (items.length === 0) return;

    const enrichedItems = Array.from(
      new Map(
        items.map((item) => {
          const parsed = PersistedPermissionSetCacheItemSchema.parse(item);
          return [
            parsed.sk,
            withUpdatedMetadata(parsed, PermissionSetSchemaVersion),
          ] as const;
        }),
      ).values(),
    );

    await batchWriteWithRetry({
      client: this.ddbClient,
      tableName: this.tableName,
      batches: chunk(enrichedItems, 25).map((batch) =>
        batch.map((item) => ({
          PutRequest: { Item: removeNullFieldsForDynamoDB(item) },
        })),
      ),
    });
  }

  /**
   * Returns valid records from the permission-set cache partition. Invalid
   * records are dropped and logged so one corrupt row does not block catalog
   * reads or cache reconciliation.
   */
  public override async getPermissionSetCacheItem(
    permissionSetId: string,
  ): Promise<PersistedPermissionSetCacheItem | undefined> {
    const { Item } = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          pk: PERMISSION_SET_CACHE_PK,
          sk: permissionSetCacheSk(permissionSetId),
        },
        ConsistentRead: true,
      }),
    );
    if (!Item) return undefined;
    const parsed = PersistedPermissionSetCacheItemSchema.safeParse(Item);
    if (!parsed.success) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: ignoring invalid permission-set registration metadata`,
      );
      return undefined;
    }
    return parsed.data;
  }

  public override async getPermissionSetCacheItems(props?: {
    consistentRead?: boolean;
  }): Promise<PersistedPermissionSetCacheItem[]> {
    const allRawItems: Record<string, unknown>[] = [];
    const paginator = paginateQuery(
      { client: this.ddbClient },
      {
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk",
        ExpressionAttributeNames: { "#pk": "pk" },
        ExpressionAttributeValues: { ":pk": PERMISSION_SET_CACHE_PK },
        ...(props?.consistentRead ? { ConsistentRead: true } : {}),
      },
    );
    for await (const page of paginator) {
      allRawItems.push(...(page.Items ?? []));
    }

    const { result, error } = parseResults(
      allRawItems,
      PersistedPermissionSetCacheItemSchema,
    );
    if (error !== undefined) {
      const invalidCount = allRawItems.length - result.length;
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: dropping permission-set cache records that failed schema validation`,
        {
          invalidRecordCount: invalidCount,
          error,
        },
      );
    }
    return result;
  }

  /**
   * Deletes permission-set cache items by sort key in retried batches.
   */
  public override async batchDeletePermissionSetCacheItemsBySk(
    sks: string[],
  ): Promise<void> {
    if (sks.length === 0) return;

    const uniqueSks = Array.from(new Set(sks));
    await batchWriteWithRetry({
      client: this.ddbClient,
      tableName: this.tableName,
      batches: chunk(uniqueSks, 25).map((batch) =>
        batch.map((sk) => ({
          DeleteRequest: { Key: { pk: PERMISSION_SET_CACHE_PK, sk } },
        })),
      ),
    });
  }

  /**
   * Scans the LeaseIndex GSI and returns assignment records with pagination.
   * A full scan is required because the GSI PK is `leaseId` — there is no
   * single partition to query for cross-lease data.
   */
  public override async listAllAssignments(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedAssignment>> {
    const { pageIdentifier, pageSize = 100 } = props;

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        IndexName: "LeaseIndex",
        Select: "ALL_PROJECTED_ATTRIBUTES",
        Limit: pageSize,
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedAssignmentLeaseIndexKeySchema.parse(decoded),
        ),
      }),
    );

    const { result: parsed } = parseResults(
      result.Items ?? [],
      PersistedAssignmentSchema,
    );

    return {
      result: parsed,
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}

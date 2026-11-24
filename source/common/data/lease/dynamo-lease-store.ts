// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  BatchGetCommand,
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
  UpdateCommand,
  type PutCommandInput,
} from "@aws-sdk/lib-dynamodb";
import { marshall } from "@aws-sdk/util-dynamodb";
import { backOff } from "exponential-backoff";
import { isDeepStrictEqual } from "node:util";
import pMap from "p-map";

import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64EncodeCompositeKey,
  decodePageIdentifier,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  BatchUnprocessedItemsError,
  ConcurrentDataModificationException,
  ItemAlreadyExists,
  ResourceLockConflictError,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  getLeaseAssignmentWriteSnapshot,
  LeaseAcquireLockProps,
  LeaseAcquireLockWithDesiredAssignmentsProps,
  LeaseAssignmentWriteSnapshot,
  LeaseRecordLifecycleDispatchProps,
  LeaseReleaseLockProps,
  LeaseStore,
  LeaseUpdateMonitoringCostFieldsProps,
  LeaseUpdateMonitoringOwnedFieldsProps,
  LeaseUpdateTokenPollOwnedFieldsProps,
  MonitoringCostFieldsSchema,
  MonitoringOwnedFieldsSchema,
  MonitoringProjectionFieldsSchema,
  TokenPollOwnedFieldsSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  LeaseSchemaVersion,
  PersistedLease,
  PersistedLeaseSchema,
  PersistedLeaseStatusIndexKeySchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  buildExpectedFieldsCondition,
  chunk,
  matchesExpectedFields,
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import {
  BlockingLockIntents,
  DesiredAssignmentWithDisplaySchema,
  ExpiredLeaseStatus,
  LeaseKey,
  LeaseKeySchema,
  LeaseLifecycleDispatchSchema,
  LeaseLockIntent,
  LeaseResourceLock,
  LeaseResourceLockSchema,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export class DynamoLeaseStore extends LeaseStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    leaseTableName: string;
  }) {
    super();
    this.tableName = props.leaseTableName;
    this.ddbClient = props.client;
  }

  /**
   * Builds the lock-acquisition ConditionExpression and its intent-related
   * attribute values.
   *
   * Precedence comes from BlockingLockIntents. The rule is expressed in the
   * condition rather than a read-then-write to avoid a TOCTOU race, and is
   * shared by both acquire paths so they cannot drift apart.
   */
  private buildLockAcquisitionCondition(props: {
    ownerId: string;
    acquiredAt: string;
    intent: LeaseLockIntent | undefined;
  }): {
    conditionExpression: string;
    expressionAttributeValues: Record<string, unknown>;
  } {
    const { ownerId, acquiredAt, intent } = props;

    const blockingIntents =
      intent !== undefined && intent in BlockingLockIntents
        ? BlockingLockIntents[intent as keyof typeof BlockingLockIntents]
        : undefined;

    const placeholderFor = (blocked: string) => `:${blocked.toLowerCase()}`;

    const conditionExpression = [
      "attribute_exists(userEmail) AND (",
      "attribute_not_exists(resourceLock)",
      "OR resourceLock.ownerId = :ownerId",
      "OR resourceLock.expiresAt < :acquiredAt",
      // Guard attribute_not_exists first: a lock written without meta must
      // still be preemptible by a critical intent.
      ...(blockingIntents
        ? [
            `OR (attribute_not_exists(resourceLock.meta.intent) OR NOT resourceLock.meta.intent IN (${blockingIntents
              .map(placeholderFor)
              .join(", ")}))`,
          ]
        : []),
      ")",
    ].join(" ");

    return {
      conditionExpression,
      expressionAttributeValues: {
        ":ownerId": ownerId,
        ":acquiredAt": acquiredAt,
        // Only declare placeholders the expression references; DynamoDB rejects
        // unused ExpressionAttributeValues.
        ...Object.fromEntries(
          (blockingIntents ?? []).map((blocked) => [
            placeholderFor(blocked),
            blocked,
          ]),
        ),
      },
    };
  }

  public override async acquireLock(
    props: LeaseAcquireLockProps,
  ): Promise<LeaseResourceLock> {
    const { leaseId, userEmail, ownerId, timeoutSeconds, meta } = props;
    const acquiredAt = nowAsIsoDatetimeString();
    const expiresAt = parseDatetime(acquiredAt)
      .plus({ seconds: timeoutSeconds })
      .toISO();

    const parseResult = LeaseResourceLockSchema.safeParse({
      ownerId,
      acquiredAt,
      expiresAt,
      meta,
    });

    if (!parseResult.success) {
      throw new Error(
        `Invalid lock data for lease ${leaseId}: ${parseResult.error.message}`,
      );
    }

    const lock = parseResult.data;

    const { conditionExpression, expressionAttributeValues } =
      this.buildLockAcquisitionCondition({
        ownerId,
        acquiredAt,
        intent: meta?.intent,
      });

    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression: "SET resourceLock = :lock",
          ConditionExpression: conditionExpression,
          ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ":lock": lock,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ResourceLockConflictError(
          `Lock conflict on lease ${leaseId}: held by another owner and not expired`,
        );
      }
      throw error;
    }

    return lock;
  }

  public override async acquireLockWithDesiredAssignments(
    props: LeaseAcquireLockWithDesiredAssignmentsProps,
  ): Promise<LeaseResourceLock> {
    const {
      leaseId,
      userEmail,
      ownerId,
      timeoutSeconds,
      meta,
      desiredAssignments,
      expectedLease,
    } = props;
    const acquiredAt = nowAsIsoDatetimeString();
    const expiresAt = parseDatetime(acquiredAt)
      .plus({ seconds: timeoutSeconds })
      .toISO();

    const parseResult = LeaseResourceLockSchema.safeParse({
      ownerId,
      acquiredAt,
      expiresAt,
      meta,
    });

    if (!parseResult.success) {
      throw new Error(
        `Invalid lock data for lease ${leaseId}: ${parseResult.error.message}`,
      );
    }

    const lock = parseResult.data;

    // Validate desiredAssignments against schema
    const parsedDesired = desiredAssignments.map((a) =>
      DesiredAssignmentWithDisplaySchema.parse(a),
    );

    const { conditionExpression, expressionAttributeValues } =
      this.buildLockAcquisitionCondition({
        ownerId,
        acquiredAt,
        intent: meta?.intent,
      });

    // Compare the state used for assignment validation. Monitoring metadata
    // does not participate, so scoped monitoring writes cannot invalidate it.
    const validatedState = expectedLease
      ? getLeaseAssignmentWriteSnapshot(expectedLease)
      : undefined;
    const validationCondition = validatedState
      ? buildExpectedFieldsCondition(validatedState)
      : undefined;

    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression:
            "SET resourceLock = :lock, desiredAssignments = :desiredAssignments",
          ReturnValuesOnConditionCheckFailure: validatedState
            ? "ALL_OLD"
            : undefined,
          ConditionExpression: validationCondition
            ? `(${conditionExpression}) AND ${validationCondition.conditionExpression}`
            : conditionExpression,
          ExpressionAttributeNames:
            validationCondition?.expressionAttributeNames,
          ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ...validationCondition?.expressionAttributeValues,
            ":lock": lock,
            ":desiredAssignments": parsedDesired,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        // A retry can fail after its first attempt committed. Recover only if
        // this exact lock and desired set are stored and validation still holds.
        if (
          validatedState &&
          matchesExpectedFields(error.Item, {
            ...validatedState,
            resourceLock: lock,
            desiredAssignments: parsedDesired,
          })
        ) {
          return lock;
        }
        throw this.getAssignmentWriteConflict(leaseId, validatedState, error);
      }
      throw error;
    }

    return lock;
  }

  private getAssignmentWriteConflict(
    leaseId: string,
    validatedState: LeaseAssignmentWriteSnapshot | undefined,
    error: ConditionalCheckFailedException,
  ): Error {
    if (validatedState) {
      // Diagnose the rejected write from its own item image. Reading again
      // could observe a later change and misidentify the failed guard.
      const storedFields = error.Item;
      if (!storedFields) {
        return new UnknownItem(`Lease ${leaseId} no longer exists.`);
      }
      const expectedFields = marshall(validatedState, {
        removeUndefinedValues: true,
      });
      const changedFields = Object.keys(validatedState).filter(
        (field) =>
          !isDeepStrictEqual(expectedFields[field], storedFields[field]),
      );
      if (changedFields.length > 0) {
        return new ConcurrentDataModificationException(
          `Assignment validation conflict on lease ${leaseId}: ${changedFields.join(", ")} changed after validation`,
        );
      }
    }
    return new ResourceLockConflictError(
      `Lock conflict on lease ${leaseId}: resource lock is unavailable`,
    );
  }

  public override async releaseLock(
    props: LeaseReleaseLockProps,
  ): Promise<void> {
    const { leaseId, userEmail, ownerId } = props;
    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression: "REMOVE resourceLock",
          ConditionExpression:
            "attribute_exists(userEmail) AND (attribute_not_exists(resourceLock) OR resourceLock.ownerId = :ownerId)",
          ExpressionAttributeValues: {
            ":ownerId": ownerId,
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        // No-op: lock doesn't exist, already released, or owned by someone else
        // (e.g., a critical override took ownership). This makes releaseLock safe
        // for defensive cleanup in catch blocks and overridden Step Functions.
        return;
      }
      throw error;
    }
  }

  public override async updateTokenPollOwnedFields(
    props: LeaseUpdateTokenPollOwnedFieldsProps,
  ): Promise<void> {
    const { leaseId, userEmail, ...scalars } = props;
    const {
      lastEvaluatedSpend,
      lastPredictedSpend,
      lastEvaluatedHourlySpendRate,
      lastEvaluatedDailySpendRate,
    } = TokenPollOwnedFieldsSchema.parse(scalars);
    await this.updateOwnedFields({
      leaseId,
      userEmail,
      setClauses:
        "lastEvaluatedSpend = :lastEvaluatedSpend, lastPredictedSpend = :lastPredictedSpend, lastEvaluatedHourlySpendRate = :lastEvaluatedHourlySpendRate, lastEvaluatedDailySpendRate = :lastEvaluatedDailySpendRate",
      expressionAttributeValues: {
        ":lastEvaluatedSpend": lastEvaluatedSpend,
        ":lastPredictedSpend": lastPredictedSpend,
        ":lastEvaluatedHourlySpendRate": lastEvaluatedHourlySpendRate,
        ":lastEvaluatedDailySpendRate": lastEvaluatedDailySpendRate,
      },
    });
  }

  public override async updateMonitoringCostFields(
    props: LeaseUpdateMonitoringCostFieldsProps,
  ): Promise<void> {
    const { leaseId, userEmail, ...scalars } = props;
    const { totalCostAccrued, lastCheckedDate } =
      MonitoringCostFieldsSchema.parse(scalars);
    await this.updateOwnedFields({
      leaseId,
      userEmail,
      setClauses:
        "totalCostAccrued = :totalCostAccrued, lastCheckedDate = :lastCheckedDate",
      expressionAttributeValues: {
        ":totalCostAccrued": totalCostAccrued,
        ":lastCheckedDate": lastCheckedDate,
      },
    });
  }

  public override async recordLifecycleDispatch(
    props: LeaseRecordLifecycleDispatchProps,
  ): Promise<void> {
    const { leaseId, userEmail, intent } = props;
    await this.updateOwnedFields({
      leaseId,
      userEmail,
      setClauses: "lifecycleDispatch = :lifecycleDispatch",
      expressionAttributeValues: {
        ":lifecycleDispatch": LeaseLifecycleDispatchSchema.parse({
          intent,
          dispatchedAt: nowAsIsoDatetimeString(),
        }),
      },
    });
  }

  public override async updateMonitoringOwnedFields(
    props: LeaseUpdateMonitoringOwnedFieldsProps,
  ): Promise<void> {
    const { leaseId, userEmail, projection, ...scalars } = props;
    const { totalCostAccrued, lastCheckedDate, lastEvaluatedSpend } =
      MonitoringOwnedFieldsSchema.parse(scalars);
    const rates =
      projection === undefined
        ? undefined
        : MonitoringProjectionFieldsSchema.parse(projection);
    await this.updateOwnedFields({
      leaseId,
      userEmail,
      setClauses: [
        "totalCostAccrued = :totalCostAccrued, lastCheckedDate = :lastCheckedDate, lastEvaluatedSpend = :lastEvaluatedSpend",
        ...(rates === undefined
          ? []
          : [
              "lastPredictedSpend = :lastPredictedSpend, lastEvaluatedHourlySpendRate = :lastEvaluatedHourlySpendRate, lastEvaluatedDailySpendRate = :lastEvaluatedDailySpendRate",
            ]),
      ].join(", "),
      expressionAttributeValues: {
        ":totalCostAccrued": totalCostAccrued,
        ":lastCheckedDate": lastCheckedDate,
        ":lastEvaluatedSpend": lastEvaluatedSpend,
        ...(rates === undefined
          ? {}
          : {
              ":lastPredictedSpend": rates.lastPredictedSpend,
              ":lastEvaluatedHourlySpendRate":
                rates.lastEvaluatedHourlySpendRate,
              ":lastEvaluatedDailySpendRate": rates.lastEvaluatedDailySpendRate,
            }),
      },
    });
  }

  /**
   * Attribute-scoped write for fields a single writer owns (the cost scalars,
   * the lifecycle dispatch marker). Appends the meta.lastEditTime stamp to
   * the caller's SET clauses, requires the lease to exist, and maps a failed
   * existence check to UnknownItem. Unlike a full-item update, it never
   * overwrites fields other writers hold, such as the resource lock.
   */
  private async updateOwnedFields(props: {
    leaseId: string;
    userEmail: string;
    setClauses: string;
    expressionAttributeValues: Record<string, unknown>;
  }): Promise<void> {
    const { leaseId, userEmail, setClauses, expressionAttributeValues } = props;
    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { userEmail, uuid: leaseId },
          UpdateExpression: `SET ${setClauses}, meta.lastEditTime = :lastEditTime`,
          ConditionExpression: "attribute_exists(userEmail)",
          ExpressionAttributeValues: {
            ...expressionAttributeValues,
            ":lastEditTime": nowAsIsoDatetimeString(),
          },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new UnknownItem("Unknown Lease.");
      }
      throw error;
    }
  }

  @validateItem(PersistedLeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async update<T extends PersistedLease>(
    lease: T,
    expected?: T,
  ): Promise<PutResult<T>> {
    const item = removeNullFieldsForDynamoDB(lease);
    const input: PutCommandInput = {
      TableName: this.tableName,
      Item: item,
      ReturnValues: "ALL_OLD",
      ConditionExpression: "attribute_exists(userEmail)",
    };

    if (expected) {
      // Lock/assignment writes intentionally do not advance lastEditTime.
      // Checking only that token lets a stale PATCH erase an accepted desired
      // set, even after its processing lock has already been released.
      // Whole-item writes strip null locks; stored NULL and absence both mean
      // no lock. Other fields retain exact comparison semantics.
      const assignmentCondition = buildExpectedFieldsCondition(
        {
          desiredAssignments: expected.desiredAssignments,
          resourceLock: expected.resourceLock,
        },
        { nullMatchesMissing: ["resourceLock"] },
      );
      input.ConditionExpression += ` AND meta.lastEditTime = :expectedTime AND ${assignmentCondition.conditionExpression}`;
      input.ExpressionAttributeNames =
        assignmentCondition.expressionAttributeNames;
      input.ExpressionAttributeValues = {
        ":expectedTime": expected.meta?.lastEditTime,
        ...assignmentCondition.expressionAttributeValues,
      };
      input.ReturnValuesOnConditionCheckFailure = "ALL_OLD";
    }

    return this.ddbClient
      .send(new PutCommand(input))
      .then((result) => ({
        oldItem: result.Attributes,
        newItem: lease,
      }))
      .catch((error: unknown) => {
        if (error instanceof ConditionalCheckFailedException) {
          if (!expected) {
            throw new UnknownItem("Unknown Lease.");
          }
          // A committed retry must match the entire replacement, including its
          // generated metadata. The lost response's old image is unavailable;
          // retain the caller's original snapshot as the change baseline.
          if (matchesExpectedFields(error.Item, item, { exact: true })) {
            return { oldItem: expected, newItem: lease };
          }
          throw new ConcurrentDataModificationException(
            "The lease has been modified from the expected value.",
          );
        }
        throw error;
      });
  }

  @validateItem(PersistedLeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async create<T extends PersistedLease>(lease: T): Promise<T> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(lease),
          ConditionExpression: "attribute_not_exists(userEmail)", //PK -- ensures item does not exist
        }),
      );
      return lease;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("Lease already exists.");
      }
      throw error; // Re-throw other errors
    }
  }

  public override async get(
    key: LeaseKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<PersistedLease>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
        ...(options?.consistentRead && { ConsistentRead: true }),
      }),
    );

    return parseSingleItemResult(result.Item, PersistedLeaseSchema);
  }

  public override async batchGet(keys: LeaseKey[]): Promise<PersistedLease[]> {
    if (keys.length === 0) return [];

    // Deduplicate input keys (BatchGetItem rejects duplicates). Tuple-stable
    // composite key avoids any chance of separator collision.
    const uniqueKeys = Array.from(
      new Map(
        keys.map((k) => [JSON.stringify([k.userEmail, k.uuid]), k] as const),
      ).values(),
    );

    const batches = chunk(uniqueKeys, 100);
    const allRawItems: Record<string, unknown>[] = [];

    await pMap(
      batches,
      async (batch) => {
        let pendingKeys: LeaseKey[] = batch;

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
              pendingKeys = unprocessed as LeaseKey[];
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

    const { result } = parseResults(allRawItems, PersistedLeaseSchema);
    return result;
  }

  public override async delete(key: LeaseKey): Promise<OptionalItem> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: key,
        ReturnValues: "ALL_OLD",
      }),
    );

    return result.Attributes;
  }

  public override async findAll(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>> {
    const { pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          LeaseKeySchema.parse(decoded),
        ),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, PersistedLeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>> {
    const { status, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#leaseStatus = :leaseStatus",
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
        },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedLeaseStatusIndexKeySchema.refine(
            (cursor) => cursor.status === status,
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, PersistedLeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus; //types that include awsAccountId
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>> {
    const { status, awsAccountId, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression: "#leaseStatus = :leaseStatus",
        FilterExpression: `#awsAccountId = :awsAccountId`,
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
          "#awsAccountId": "awsAccountId",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
          ":awsAccountId": awsAccountId,
        },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedLeaseStatusIndexKeySchema.refine(
            (cursor) => cursor.status === status,
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, PersistedLeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByUserEmail(props: {
    userEmail: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>> {
    const { userEmail, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#userEmail = :userEmail",
        ExpressionAttributeNames: {
          "#userEmail": "userEmail",
        },
        ExpressionAttributeValues: {
          ":userEmail": userEmail,
        },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          LeaseKeySchema.refine(
            (cursor) => cursor.userEmail === userEmail,
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, PersistedLeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>> {
    const { status, uuid, pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "StatusIndex",
        KeyConditionExpression:
          "#leaseStatus = :leaseStatus AND #leaseTemplateKey = :templateUuid",
        ExpressionAttributeNames: {
          "#leaseStatus": "status",
          "#leaseTemplateKey": "originalLeaseTemplateUuid",
        },
        ExpressionAttributeValues: {
          ":leaseStatus": status,
          ":templateUuid": uuid,
        },
        ExclusiveStartKey: decodePageIdentifier(pageIdentifier, (decoded) =>
          PersistedLeaseStatusIndexKeySchema.refine(
            (cursor) =>
              cursor.status === status &&
              cursor.originalLeaseTemplateUuid === uuid,
          ).parse(decoded),
        ),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, PersistedLeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}

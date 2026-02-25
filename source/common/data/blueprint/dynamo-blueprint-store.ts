// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { StackSetOperationStatus } from "@aws-sdk/client-cloudformation";
import {
  DynamoDBDocumentClient,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
} from "@aws-sdk/lib-dynamodb";
import { DateTime } from "luxon";

import {
  BLUEPRINT_SK,
  DEPLOYMENT_SK_PREFIX,
  STACKSET_SK_PREFIX,
  generateBlueprintPK,
  generateDeploymentSK,
  generateStackSetSK,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-dynamodb-keys.js";
import {
  BlueprintKey,
  BlueprintStore,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import {
  BlueprintItem,
  BlueprintItemSchema,
  BlueprintSchemaVersion,
  BlueprintWithStackSets,
  BlueprintWithStackSetsSchema,
  DeploymentHistoryItem,
  DeploymentHistoryItemSchema,
  StackSetItem,
} from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import {
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  ConcurrentDataModificationException,
  ItemAlreadyExists,
  UnknownItem,
} from "@amzn/innovation-sandbox-commons/data/errors.js";
import { withUpdatedMetadata } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export class DynamoBlueprintStore extends BlueprintStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    blueprintTableName: string;
    client: DynamoDBDocumentClient;
  }) {
    super();
    this.tableName = props.blueprintTableName;
    this.ddbClient = props.client;
  }

  private generateTTLFor90DaysFromNow(): number {
    return DateTime.utc().plus({ days: 90 }).toUnixInteger();
  }

  public async createBlueprintWithStackSet(
    blueprint: BlueprintItem,
    stackSet: StackSetItem,
  ): Promise<BlueprintWithStackSets> {
    const blueprintWithMeta = withUpdatedMetadata(
      blueprint,
      BlueprintSchemaVersion,
    );
    const stackSetWithMeta = withUpdatedMetadata(
      stackSet,
      BlueprintSchemaVersion,
    );

    try {
      await this.ddbClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: removeNullFieldsForDynamoDB(blueprintWithMeta),
                ConditionExpression: "attribute_not_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: removeNullFieldsForDynamoDB(stackSetWithMeta),
                ConditionExpression:
                  "attribute_not_exists(PK) AND attribute_not_exists(SK)",
              },
            },
          ],
        }),
      );

      return {
        blueprint: blueprintWithMeta,
        stackSets: [stackSetWithMeta],
      };
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("Blueprint already exists.");
      }
      throw error;
    }
  }

  /**
   * Update blueprint metadata (mutable fields only)
   */
  @validateItem(BlueprintItemSchema)
  @withMetadata(BlueprintSchemaVersion)
  public async update<T extends BlueprintItem>(
    blueprint: T,
    expected?: T,
  ): Promise<PutResult<T>> {
    try {
      if (expected) {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(blueprint),
            ReturnValues: "ALL_OLD",
            ConditionExpression:
              "attribute_exists(PK) and meta.lastEditTime = :expectedTime",
            ExpressionAttributeValues: {
              ":expectedTime": expected.meta?.lastEditTime,
            },
          }),
        );
        return {
          oldItem: result.Attributes as T,
          newItem: blueprint,
        };
      } else {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(blueprint),
            ReturnValues: "ALL_OLD",
            ConditionExpression: "attribute_exists(PK)",
          }),
        );
        return {
          oldItem: result.Attributes as T,
          newItem: blueprint,
        };
      }
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        if (expected) {
          throw new ConcurrentDataModificationException(
            "Blueprint was modified by another process.",
          );
        }
        throw new UnknownItem("Blueprint not found.");
      }
      throw error;
    }
  }

  /**
   * Update blueprint and stackSet together atomically.
   * Used when updating fields that span both BlueprintItem and StackSetItem.
   */
  public async updateBlueprintWithStackSet(
    blueprint: BlueprintItem,
    stackSet: StackSetItem,
  ): Promise<BlueprintWithStackSets> {
    const blueprintWithMeta = withUpdatedMetadata(
      blueprint,
      BlueprintSchemaVersion,
    );
    const stackSetWithMeta = withUpdatedMetadata(
      stackSet,
      BlueprintSchemaVersion,
    );

    try {
      await this.ddbClient.send(
        new TransactWriteCommand({
          TransactItems: [
            {
              Put: {
                TableName: this.tableName,
                Item: removeNullFieldsForDynamoDB(blueprintWithMeta),
                ConditionExpression: "attribute_exists(PK)",
              },
            },
            {
              Put: {
                TableName: this.tableName,
                Item: removeNullFieldsForDynamoDB(stackSetWithMeta),
                ConditionExpression:
                  "attribute_exists(PK) AND attribute_exists(SK)",
              },
            },
          ],
        }),
      );

      return {
        blueprint: blueprintWithMeta,
        stackSets: [stackSetWithMeta],
      };
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new UnknownItem("Blueprint or StackSet not found.");
      }
      throw error;
    }
  }

  /**
   * Delete blueprint core items (blueprint + stacksets)
   * Deployment history is automatically cleaned up by TTL after 90 days (free, no WRU cost)
   */
  public async delete(
    key: BlueprintKey,
  ): Promise<Record<string, any> | undefined> {
    const pk = generateBlueprintPK(key.blueprintId);

    // Query 1: Get blueprint item
    const blueprintResult = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":sk": BLUEPRINT_SK,
        },
      }),
    );

    // Query 2: Get all stackset items
    const stackSetResult = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": STACKSET_SK_PREFIX,
        },
      }),
    );

    const blueprintItems = blueprintResult.Items || [];
    const stackSetItems = stackSetResult.Items || [];
    const allItems = [...blueprintItems, ...stackSetItems];

    if (allItems.length === 0) {
      return undefined;
    }

    const blueprintItem = blueprintItems[0];

    // Delete all core items atomically (blueprint + stacksets)
    await this.ddbClient.send(
      new TransactWriteCommand({
        TransactItems: allItems.map((item) => ({
          Delete: {
            TableName: this.tableName,
            Key: {
              PK: item.PK,
              SK: item.SK,
            },
          },
        })),
      }),
    );

    return blueprintItem;
  }

  public async listBlueprints(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<BlueprintWithStackSets>> {
    const { pageSize, pageIdentifier } = props ?? {};

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "itemType-blueprintId-index",
        KeyConditionExpression: "itemType = :itemType",
        ExpressionAttributeValues: {
          ":itemType": "BLUEPRINT",
        },
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    const blueprintItems = parseResults(
      result.Items,
      BlueprintItemSchema,
    ).result;

    // Fetch recent deployments for each blueprint (last 10)
    const blueprintsWithDeployments = await Promise.all(
      blueprintItems.map(async (blueprint) => {
        const pk = generateBlueprintPK(blueprint.blueprintId);

        // Query recent deployments (last 10)
        const deploymentsResult = await this.ddbClient.send(
          new QueryCommand({
            TableName: this.tableName,
            KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
            ExpressionAttributeValues: {
              ":pk": pk,
              ":skPrefix": DEPLOYMENT_SK_PREFIX,
            },
            ScanIndexForward: false, // Reverse chronological
            Limit: 10,
          }),
        );

        const recentDeployments = parseResults(
          deploymentsResult.Items,
          DeploymentHistoryItemSchema,
        ).result;

        // For list view, we don't need stackSets, just blueprint + deployments
        return {
          blueprint,
          stackSets: [], // Empty for list view (only needed in detail view)
          recentDeployments,
        };
      }),
    );

    return {
      result: blueprintsWithDeployments,
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  /**
   * Get complete blueprint with stacksets and recent deployments
   */
  public async get(
    blueprintId: string,
  ): Promise<SingleItemResult<BlueprintWithStackSets>> {
    const pk = generateBlueprintPK(blueprintId);

    // Query 1: Get blueprint item
    const blueprintResult = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND SK = :sk",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":sk": BLUEPRINT_SK,
        },
      }),
    );

    const blueprintItems = blueprintResult.Items || [];
    if (blueprintItems.length === 0) {
      return { result: undefined };
    }

    const blueprint = blueprintItems[0] as BlueprintItem;

    // Query 2: Get all stackset items
    const stackSetResult = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": STACKSET_SK_PREFIX,
        },
      }),
    );

    const stackSets =
      stackSetResult.Items?.map((item) => item as StackSetItem) || [];

    // Query 3: Get recent deployments in reverse chronological order
    const deploymentsResult = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": DEPLOYMENT_SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: 10,
      }),
    );

    const deployments =
      deploymentsResult.Items?.map((item) => item as DeploymentHistoryItem) ||
      [];

    const blueprintWithStackSets: BlueprintWithStackSets = {
      blueprint,
      stackSets,
      recentDeployments: deployments,
    };

    return parseSingleItemResult(
      blueprintWithStackSets,
      BlueprintWithStackSetsSchema,
    );
  }

  /**
   * Record deployment start with generated PK/SK/TTL
   */
  public async recordDeploymentStart(props: {
    blueprintId: string;
    stackSetId: string;
    leaseId: string;
    accountId: string;
    operationId: string;
    deploymentStartedAt: string;
  }): Promise<DeploymentHistoryItem> {
    const {
      blueprintId,
      stackSetId,
      leaseId,
      accountId,
      operationId,
      deploymentStartedAt,
    } = props;

    const pk = generateBlueprintPK(blueprintId);
    const sk = generateDeploymentSK(deploymentStartedAt, operationId);
    const now = nowAsIsoDatetimeString();

    const deploymentItem: DeploymentHistoryItem = {
      PK: pk,
      SK: sk,
      itemType: "DEPLOYMENT",
      stackSetId,
      leaseId,
      accountId,
      status: StackSetOperationStatus.RUNNING,
      operationId,
      deploymentStartedAt,
      ttl: this.generateTTLFor90DaysFromNow(),
      meta: {
        schemaVersion: BlueprintSchemaVersion,
        createdTime: now,
        lastEditTime: now,
      },
    };

    await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: deploymentItem,
      }),
    );

    return deploymentItem;
  }

  /**
   * Get deployment history for a blueprint (paginated, reverse chronological)
   */
  public async getDeploymentHistory(
    blueprintId: string,
    props?: {
      pageIdentifier?: string;
      pageSize?: number;
    },
  ): Promise<PaginatedQueryResult<DeploymentHistoryItem>> {
    const { pageSize = 20, pageIdentifier } = props ?? {};
    const pk = generateBlueprintPK(blueprintId);

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "PK = :pk AND begins_with(SK, :skPrefix)",
        ExpressionAttributeValues: {
          ":pk": pk,
          ":skPrefix": DEPLOYMENT_SK_PREFIX,
        },
        ScanIndexForward: false, // Reverse chronological order
        Limit: pageSize,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
      }),
    );

    return {
      ...parseResults(result.Items, DeploymentHistoryItemSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async updateDeploymentStatusAndMetrics(props: {
    blueprintId: string;
    stackSetId: string;
    deploymentSK: string;
    status: "SUCCEEDED" | "FAILED";
    duration: number;
    deploymentTimestamp: string;
    errorType?: string;
    errorMessage?: string;
  }): Promise<void> {
    const {
      blueprintId,
      stackSetId,
      deploymentSK,
      status,
      duration,
      deploymentTimestamp,
      errorType,
      errorMessage,
    } = props;

    const pk = generateBlueprintPK(blueprintId);
    const stackSetSK = generateStackSetSK(stackSetId);
    const timestamp = nowAsIsoDatetimeString();
    const success = status === "SUCCEEDED";

    const deploymentUpdateParts: string[] = [
      "#status = :status",
      "deploymentCompletedAt = :completedAt",
      "#duration = :duration",
      "meta.lastEditTime = :editTime",
    ];
    const deploymentAttributeNames: Record<string, string> = {
      "#status": "status",
      "#duration": "duration",
    };
    const deploymentAttributeValues: Record<string, any> = {
      ":status": status,
      ":completedAt": timestamp,
      ":duration": duration,
      ":editTime": timestamp,
    };

    if (errorType !== undefined) {
      deploymentUpdateParts.push("errorType = :errorType");
      deploymentAttributeValues[":errorType"] = errorType;
    }

    if (errorMessage !== undefined) {
      deploymentUpdateParts.push("errorMessage = :errorMessage");
      deploymentAttributeValues[":errorMessage"] = errorMessage;
    }

    await this.ddbClient.send(
      new TransactWriteCommand({
        TransactItems: [
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: pk, SK: deploymentSK },
              UpdateExpression: `SET ${deploymentUpdateParts.join(", ")}`,
              ExpressionAttributeNames: deploymentAttributeNames,
              ExpressionAttributeValues: deploymentAttributeValues,
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: pk, SK: BLUEPRINT_SK },
              UpdateExpression: success
                ? "ADD totalHealthMetrics.totalDeploymentCount :one, totalHealthMetrics.totalSuccessfulCount :one SET totalHealthMetrics.lastDeploymentAt = :timestamp, meta.lastEditTime = :editTime"
                : "ADD totalHealthMetrics.totalDeploymentCount :one SET totalHealthMetrics.lastDeploymentAt = :timestamp, meta.lastEditTime = :editTime",
              ExpressionAttributeValues: {
                ":one": 1,
                ":timestamp": deploymentTimestamp,
                ":editTime": timestamp,
              },
            },
          },
          {
            Update: {
              TableName: this.tableName,
              Key: { PK: pk, SK: stackSetSK },
              UpdateExpression: success
                ? "ADD healthMetrics.deploymentCount :one, healthMetrics.successfulDeploymentCount :one SET healthMetrics.lastSuccessAt = :timestamp, healthMetrics.consecutiveFailures = :zero, meta.lastEditTime = :editTime"
                : "ADD healthMetrics.deploymentCount :one, healthMetrics.consecutiveFailures :one SET healthMetrics.lastFailureAt = :timestamp, meta.lastEditTime = :editTime",
              ExpressionAttributeValues: success
                ? {
                    ":one": 1,
                    ":zero": 0,
                    ":timestamp": deploymentTimestamp,
                    ":editTime": timestamp,
                  }
                : {
                    ":one": 1,
                    ":timestamp": deploymentTimestamp,
                    ":editTime": timestamp,
                  },
            },
          },
        ],
      }),
    );
  }
}

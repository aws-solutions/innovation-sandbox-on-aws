// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

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
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import {
  LeaseTemplate,
  LeaseTemplateSchema,
  LeaseTemplateSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import {
  parseResults,
  parseSingleItemResult,
  removeNullFieldsForDynamoDB,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

export class DynamoLeaseTemplateStore extends LeaseTemplateStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    leaseTemplateTableName: string;
    client: DynamoDBDocumentClient;
  }) {
    super();
    this.tableName = props.leaseTemplateTableName;
    this.ddbClient = props.client;
  }

  @validateItem(LeaseTemplateSchema)
  @withMetadata(LeaseTemplateSchemaVersion)
  public async create(leaseTemplate: LeaseTemplate): Promise<LeaseTemplate> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: removeNullFieldsForDynamoDB(leaseTemplate),
          ReturnValues: "ALL_OLD",
          ConditionExpression: "attribute_not_exists(#uid)", //PK -- ensures item does not exist
          ExpressionAttributeNames: {
            "#uid": "uuid",
          },
        }),
      );
      return leaseTemplate;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ItemAlreadyExists("LeaseTemplate already exists.");
      }
      throw error; // Re-throw other errors
    }
  }

  @validateItem(LeaseTemplateSchema)
  @withMetadata(LeaseTemplateSchemaVersion)
  public async update(
    leaseTemplate: LeaseTemplate,
    expected?: LeaseTemplate,
  ): Promise<PutResult<LeaseTemplate>> {
    if (expected) {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(leaseTemplate),
            ReturnValues: "ALL_OLD",
            ConditionExpression: `attribute_exists(#uid) and meta.lastEditTime = :expectedTime`,
            ExpressionAttributeValues: {
              ":expectedTime": expected.meta?.lastEditTime,
            },
            ExpressionAttributeNames: {
              "#uid": "uuid",
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: leaseTemplate,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ConcurrentDataModificationException(
            "The lease template has been modified from the expected value.",
          );
        }
        throw error; // Re-throw other errors
      }
    } else {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: removeNullFieldsForDynamoDB(leaseTemplate),
            ReturnValues: "ALL_OLD",
            ConditionExpression: "attribute_exists(#uid)", //PK -- ensures item exists
            ExpressionAttributeNames: {
              "#uid": "uuid",
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: leaseTemplate,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new UnknownItem("Unknown LeaseTemplate.");
        }
        throw error; // Re-throw other errors
      }
    }
  }

  public async delete(uuid: string): Promise<Record<string, any> | undefined> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        ReturnValues: "ALL_OLD",
        Key: {
          uuid,
        },
      }),
    );

    return result.Attributes;
  }

  public async findAll(props?: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<LeaseTemplate>> {
    const { pageSize, pageIdentifier } = props ?? {};

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseTemplateSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async findByManager(props: {
    manager: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<LeaseTemplate>> {
    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: "#creator = :manager",
        ExpressionAttributeNames: {
          "#creator": "createdBy",
        },
        ExpressionAttributeValues: {
          ":manager": props.manager,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(props.pageIdentifier),
        Limit: props.pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseTemplateSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async get(uuid: string): Promise<SingleItemResult<LeaseTemplate>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { uuid },
      }),
    );

    return parseSingleItemResult(result.Item, LeaseTemplateSchema);
  }

  /**
   * Finds lease templates that reference a specific blueprint.
   *
   * Returns only key fields (uuid, blueprintId) because the blueprintId-index GSI
   * is configured with KEYS_ONLY projection. No schema validation is performed
   * since partial items would fail validation against LeaseTemplateSchema.
   */
  public async findByBlueprintId(
    blueprintId: string,
  ): Promise<{ uuid: string; blueprintId: string }[]> {
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        IndexName: "blueprintId-index",
        KeyConditionExpression: "blueprintId = :blueprintId",
        ExpressionAttributeValues: {
          ":blueprintId": blueprintId,
        },
      }),
    );

    return (result.Items || []).map((item) => ({
      uuid: item.uuid as string,
      blueprintId: item.blueprintId as string,
    }));
  }
}

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
  type EmailAddress,
  OptionalItem,
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
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  ExpiredLeaseStatus,
  Lease,
  LeaseKey,
  LeaseSchema,
  LeaseSchemaVersion,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  parseResults,
  parseSingleItemResult,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
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

  @validateItem(LeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async update<T extends Lease>(
    lease: T,
    expected?: T,
  ): Promise<PutResult<T>> {
    if (expected) {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: lease,
            ReturnValues: "ALL_OLD",
            ConditionExpression: `attribute_exists(userEmail) and meta.lastEditTime = :expectedTime`,
            ExpressionAttributeValues: {
              ":expectedTime": expected.meta?.lastEditTime,
            },
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: lease,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new ConcurrentDataModificationException(
            "The lease has been modified from the expected value.",
          );
        }
        throw error; // Re-throw other errors
      }
    } else {
      try {
        const result = await this.ddbClient.send(
          new PutCommand({
            TableName: this.tableName,
            Item: lease,
            ReturnValues: "ALL_OLD",
            ConditionExpression: "attribute_exists(userEmail)", //PK -- ensures item exists
          }),
        );
        return {
          oldItem: result.Attributes,
          newItem: lease,
        };
      } catch (error: unknown) {
        if (error instanceof ConditionalCheckFailedException) {
          throw new UnknownItem("Unknown Lease.");
        }
        throw error; // Re-throw other errors
      }
    }
  }

  @validateItem(LeaseSchema)
  @withMetadata(LeaseSchemaVersion)
  public override async create<T extends Lease>(lease: T): Promise<T> {
    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: lease,
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

  public override async get(key: LeaseKey): Promise<SingleItemResult<Lease>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: key,
      }),
    );

    return parseSingleItemResult(result.Item, LeaseSchema);
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
  }): Promise<PaginatedQueryResult<Lease>> {
    const { pageIdentifier, pageSize } = props;

    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
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
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus; //types that include awsAccountId
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
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
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByUserEmail(props: {
    userEmail: EmailAddress;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
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
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public override async findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<Lease>> {
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
        ExclusiveStartKey: base64DecodeCompositeKey(pageIdentifier),
        Limit: pageSize,
      }),
    );
    return {
      ...parseResults(result.Items, LeaseSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}

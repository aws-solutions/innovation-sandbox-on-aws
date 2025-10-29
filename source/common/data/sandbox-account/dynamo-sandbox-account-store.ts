// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  AwsAccountId,
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  SandboxAccount,
  SandboxAccountSchema,
  SandboxAccountSchemaVersion,
  SandboxAccountStatus,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  parseResults,
  parseSingleItemResult,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";

export class DynamoSandboxAccountStore extends SandboxAccountStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    accountTableName: string;
  }) {
    super();
    this.tableName = props.accountTableName;
    this.ddbClient = props.client;
  }

  @validateItem(SandboxAccountSchema)
  @withMetadata(SandboxAccountSchemaVersion)
  public async put(
    account: SandboxAccount,
  ): Promise<PutResult<SandboxAccount>> {
    const result = await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: account,
        ReturnValues: "ALL_OLD",
      }),
    );

    return {
      oldItem: result.Attributes,
      newItem: account,
    };
  }

  public async delete(accountId: AwsAccountId): Promise<OptionalItem> {
    const result = await this.ddbClient.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: {
          awsAccountId: accountId,
        },
        ReturnValues: "ALL_OLD",
      }),
    );

    return result.Attributes;
  }

  public async findByStatus(args: {
    status: SandboxAccountStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<SandboxAccount>> {
    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        FilterExpression: `#status = :status`,
        ExpressionAttributeNames: {
          "#status": "status",
        },
        ExpressionAttributeValues: {
          ":status": args.status,
        },
        ExclusiveStartKey: base64DecodeCompositeKey(args.pageIdentifier),
        Limit: args.pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, SandboxAccountSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async findAll(args: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<SandboxAccount>> {
    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: base64DecodeCompositeKey(args.pageIdentifier),
        Limit: args.pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, SandboxAccountSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async get(
    accountId: AwsAccountId,
  ): Promise<SingleItemResult<SandboxAccount>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          awsAccountId: accountId,
        },
      }),
    );

    return parseSingleItemResult(result.Item, SandboxAccountSchema);
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  ScanCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

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
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  PersistedSandboxAccount,
  PersistedSandboxAccountKeySchema,
  PersistedSandboxAccountSchema,
  SandboxAccountSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  parseResults,
  parseSingleItemResult,
  validateItem,
  withMetadata,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import {
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { ResourceLock } from "@amzn/innovation-sandbox-shared/types/resource-lock.js";
import { SandboxAccountStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";
import { ConditionalCheckFailedException } from "@aws-sdk/client-dynamodb";

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

  @validateItem(PersistedSandboxAccountSchema)
  @withMetadata(SandboxAccountSchemaVersion)
  public async put(
    account: PersistedSandboxAccount,
  ): Promise<PutResult<PersistedSandboxAccount>> {
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

  public async delete(accountId: string): Promise<OptionalItem> {
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
  }): Promise<PaginatedQueryResult<PersistedSandboxAccount>> {
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
        ExclusiveStartKey: decodePageIdentifier(
          args.pageIdentifier,
          (decoded) => PersistedSandboxAccountKeySchema.parse(decoded),
        ),
        Limit: args.pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, PersistedSandboxAccountSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async findAll(args: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedSandboxAccount>> {
    const result = await this.ddbClient.send(
      new ScanCommand({
        TableName: this.tableName,
        ExclusiveStartKey: decodePageIdentifier(
          args.pageIdentifier,
          (decoded) => PersistedSandboxAccountKeySchema.parse(decoded),
        ),
        Limit: args.pageSize,
      }),
    );

    return {
      ...parseResults(result.Items, PersistedSandboxAccountSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  public async get(
    accountId: string,
  ): Promise<SingleItemResult<PersistedSandboxAccount>> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: {
          awsAccountId: accountId,
        },
      }),
    );

    return parseSingleItemResult(result.Item, PersistedSandboxAccountSchema);
  }

  public async update(
    accountId: string,
    params: {
      set?: Partial<Omit<PersistedSandboxAccount, "awsAccountId" | "meta">>;
      remove?: Array<
        keyof Omit<PersistedSandboxAccount, "awsAccountId" | "meta" | "status">
      >;
    },
  ): Promise<void> {
    const setExpressions: string[] = [];
    const removeExpressions: string[] = [];
    const expressionAttributeNames: Record<string, string> = {};
    const expressionAttributeValues: Record<string, unknown> = {};

    // Always update meta.lastEditTime
    setExpressions.push("#meta.#lastEditTime = :lastEditTime");
    expressionAttributeNames["#meta"] = "meta";
    expressionAttributeNames["#lastEditTime"] = "lastEditTime";
    expressionAttributeValues[":lastEditTime"] = nowAsIsoDatetimeString();

    // SET fields (including explicit null → DynamoDB NULL type)
    if (params.set) {
      for (const [key, value] of Object.entries(params.set)) {
        const attrName = `#${key}`;
        expressionAttributeNames[attrName] = key;
        setExpressions.push(`${attrName} = :${key}`);
        expressionAttributeValues[`:${key}`] = value ?? null;
      }
    }

    // REMOVE fields (delete the attribute from the item)
    if (params.remove) {
      for (const key of params.remove) {
        const attrName = `#${key}`;
        expressionAttributeNames[attrName] = key;
        removeExpressions.push(attrName);
      }
    }

    const updateParts: string[] = [];
    if (setExpressions.length > 0) {
      updateParts.push(`SET ${setExpressions.join(", ")}`);
    }
    if (removeExpressions.length > 0) {
      updateParts.push(`REMOVE ${removeExpressions.join(", ")}`);
    }

    await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { awsAccountId: accountId },
        UpdateExpression: updateParts.join(" "),
        ConditionExpression: "attribute_exists(awsAccountId)",
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
  }

  public async acquireLock(
    accountId: string,
    ownerId: string,
    timeoutSeconds: number,
    meta?: Record<string, string>,
  ): Promise<PersistedSandboxAccount> {
    const acquiredAt = nowAsIsoDatetimeString();
    const expiresAt = parseDatetime(acquiredAt)
      .plus({ seconds: timeoutSeconds })
      .toISO()!;

    const lock: ResourceLock = {
      ownerId,
      acquiredAt,
      expiresAt,
      ...(meta ? { meta } : {}),
    };

    const result = await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { awsAccountId: accountId },
        UpdateExpression: "SET resourceLock = :lock",
        ConditionExpression:
          "attribute_exists(awsAccountId) AND (attribute_not_exists(resourceLock) OR resourceLock.ownerId = :ownerId OR resourceLock.expiresAt < :now)",
        ExpressionAttributeValues: {
          ":lock": lock,
          ":ownerId": ownerId,
          ":now": acquiredAt,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    return PersistedSandboxAccountSchema.parse(result.Attributes);
  }

  public async releaseLock(
    accountId: string,
    ownerId: string,
  ): Promise<boolean> {
    try {
      await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { awsAccountId: accountId },
          UpdateExpression: "REMOVE resourceLock",
          ConditionExpression: "resourceLock.ownerId = :ownerId",
          ExpressionAttributeValues: {
            ":ownerId": ownerId,
          },
        }),
      );
      return true;
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        // No-op: lock doesn't exist, already released, or owned by someone else.
        // This makes releaseLock safe for defensive cleanup in catch blocks.
        // Returning false lets callers detect they no longer own the lock (e.g.
        // a preempted execution) and avoid taking owner-only actions.
        return false;
      }
      throw error;
    }
  }
}

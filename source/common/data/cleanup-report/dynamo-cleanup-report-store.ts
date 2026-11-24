// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";

import { CleanupReportStore } from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report-store.js";
import {
  CleanupReportKey,
  CleanupReportSchemaVersion,
  PersistedCleanupReport,
  PersistedCleanupReportKeySchema,
  PersistedCleanupReportSchema,
} from "@amzn/innovation-sandbox-commons/data/cleanup-report/cleanup-report.js";
import {
  PaginatedQueryResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64EncodeCompositeKey,
  decodePageIdentifier,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import {
  parseResults,
  parseSingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

const SK_PREFIX = "CleanupReport#";

/**
 * Resolves a CleanupReportKey into the DynamoDB pk and sk values.
 */
function resolveKey(key: CleanupReportKey): { pk: string; sk: string } {
  return {
    pk: key.accountId,
    sk: `${SK_PREFIX}${key.startedAt}`,
  };
}

interface FieldMapping {
  value: any;
  exprName: string;
  attrName: string;
  valueName: string;
}

export class DynamoCleanupReportStore extends CleanupReportStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: {
    client: DynamoDBDocumentClient;
    cleanupReportTableName: string;
  }) {
    super();
    this.tableName = props.cleanupReportTableName;
    this.ddbClient = props.client;
  }

  public async create(input: {
    key: CleanupReportKey;
    durableExecutionArn: string;
    reasonForCleanup: string;
    initiatedBy?: string;
    ttl: number;
  }): Promise<PersistedCleanupReport> {
    const { pk, sk } = resolveKey(input.key);

    const now = nowAsIsoDatetimeString();
    const report: PersistedCleanupReport = PersistedCleanupReportSchema.parse({
      pk,
      sk,
      accountId: input.key.accountId,
      durableExecutionArn: input.durableExecutionArn,
      status: "IN_PROGRESS",
      cleanupStatus: "INITIALIZING",
      startedAt: input.key.startedAt,
      reasonForCleanup: input.reasonForCleanup,
      ...(input.initiatedBy && { initiatedBy: input.initiatedBy }),
      steps: [],
      ttl: input.ttl,
      meta: {
        schemaVersion: CleanupReportSchemaVersion,
        createdTime: now,
        lastEditTime: now,
      },
    });

    await this.ddbClient.send(
      new PutCommand({
        TableName: this.tableName,
        Item: report,
        ConditionExpression:
          "attribute_not_exists(pk) AND attribute_not_exists(sk)",
      }),
    );

    return report;
  }

  public async updateReport(
    input: Parameters<CleanupReportStore["updateReport"]>[0],
  ): Promise<PersistedCleanupReport> {
    const now = nowAsIsoDatetimeString();
    const { pk, sk } = resolveKey(input.key);

    const updateExpressions: string[] = ["#meta.#lastEditTime = :now"];
    const expressionAttributeNames: Record<string, string> = {
      "#meta": "meta",
      "#lastEditTime": "lastEditTime",
    };
    const expressionAttributeValues: Record<string, any> = {
      ":now": now,
    };

    const fieldMappings: FieldMapping[] = [
      {
        value: input.status,
        exprName: "#status",
        attrName: "status",
        valueName: ":status",
      },
      {
        value: input.cleanupStatus,
        exprName: "#cleanupStatus",
        attrName: "cleanupStatus",
        valueName: ":cleanupStatus",
      },
      {
        value: input.completedAt,
        exprName: "#completedAt",
        attrName: "completedAt",
        valueName: ":completedAt",
      },
      {
        value: input.resourceSummary,
        exprName: "#resourceSummary",
        attrName: "resourceSummary",
        valueName: ":resourceSummary",
      },
      {
        value: input.accessCleanupSummary,
        exprName: "#accessCleanupSummary",
        attrName: "accessCleanupSummary",
        valueName: ":accessCleanupSummary",
      },
      {
        value: input.error,
        exprName: "#error",
        attrName: "error",
        valueName: ":error",
      },
      {
        value: input.skipCooldownCallbackId,
        exprName: "#skipCooldownCallbackId",
        attrName: "skipCooldownCallbackId",
        valueName: ":skipCooldownCallbackId",
      },
      {
        value: input.cooldownSkippedBy,
        exprName: "#cooldownSkippedBy",
        attrName: "cooldownSkippedBy",
        valueName: ":cooldownSkippedBy",
      },
      {
        value: input.ttl,
        exprName: "#ttl",
        attrName: "ttl",
        valueName: ":ttl",
      },
    ];

    for (const { value, exprName, attrName, valueName } of fieldMappings) {
      if (value !== undefined) {
        updateExpressions.push(`${exprName} = ${valueName}`);
        expressionAttributeNames[exprName] = attrName;
        expressionAttributeValues[valueName] = value;
      }
    }

    const result = await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
        ReturnValues: "ALL_NEW",
      }),
    );

    return PersistedCleanupReportSchema.parse(result.Attributes);
  }

  public async addStep(
    input: Parameters<CleanupReportStore["addStep"]>[0],
  ): Promise<number> {
    const now = nowAsIsoDatetimeString();
    const { pk, sk } = resolveKey(input.key);

    const result = await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression:
          "SET #steps = list_append(if_not_exists(#steps, :emptyList), :newStep), #meta.#lastEditTime = :now",
        ConditionExpression: "attribute_exists(pk) AND attribute_exists(sk)",
        ExpressionAttributeNames: {
          "#steps": "steps",
          "#meta": "meta",
          "#lastEditTime": "lastEditTime",
        },
        ExpressionAttributeValues: {
          ":newStep": [input.step],
          ":emptyList": [],
          ":now": now,
        },
        ReturnValues: "ALL_NEW",
      }),
    );

    // Return the zero-based index of the appended step
    const steps = (result.Attributes?.steps as unknown[]) ?? [];
    return steps.length - 1;
  }

  public async updateStepAtIndex(
    input: Parameters<CleanupReportStore["updateStepAtIndex"]>[0],
  ): Promise<void> {
    const now = nowAsIsoDatetimeString();
    const { pk, sk } = resolveKey(input.key);

    // The record has two distinct "meta" fields at different levels:
    //   - Root-level `meta`: { schemaVersion, createdTime, lastEditTime } — record metadata
    //   - Step-level `steps[N].meta`: { codeBuildExecutionArn, outcome, ... } — step-specific data
    // We use separate expression attribute names (#rootMeta vs #stepMeta) to clarify which
    // level is being updated in the DynamoDB expression.
    const updateExpressions: string[] = [
      `#steps[${input.index}].#completedAt = :completedAt`,
      "#rootMeta.#lastEditTime = :now",
    ];
    const expressionAttributeNames: Record<string, string> = {
      "#steps": "steps",
      "#completedAt": "completedAt",
      "#rootMeta": "meta",
      "#lastEditTime": "lastEditTime",
      "#name": "name",
    };
    const expressionAttributeValues: Record<string, any> = {
      ":completedAt": input.completedAt,
      ":now": now,
    };

    if (input.meta !== undefined) {
      updateExpressions.push(`#steps[${input.index}].#stepMeta = :stepMeta`);
      expressionAttributeNames["#stepMeta"] = "meta";
      expressionAttributeValues[":stepMeta"] = input.meta;
    }

    await this.ddbClient.send(
      new UpdateCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        UpdateExpression: `SET ${updateExpressions.join(", ")}`,
        ConditionExpression: `attribute_exists(pk) AND attribute_exists(sk) AND attribute_exists(#steps[${input.index}].#name)`,
        ExpressionAttributeNames: expressionAttributeNames,
        ExpressionAttributeValues: expressionAttributeValues,
      }),
    );
  }

  public async getReport(
    key: CleanupReportKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<PersistedCleanupReport>> {
    const { pk, sk } = resolveKey(key);
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { pk, sk },
        ConsistentRead: options?.consistentRead,
      }),
    );
    return parseSingleItemResult(result.Item, PersistedCleanupReportSchema);
  }

  public async getLatestReport(
    accountId: string,
  ): Promise<SingleItemResult<PersistedCleanupReport>> {
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":pk": accountId,
          ":skPrefix": SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: 1,
      }),
    );

    const item = result.Items?.[0];
    return parseSingleItemResult(item, PersistedCleanupReportSchema);
  }

  public async listRecentReports(args: {
    accountId: string;
    limit?: number;
    pageIdentifier?: string;
  }): Promise<PaginatedQueryResult<PersistedCleanupReport>> {
    const limit = args.limit ?? 5;

    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#pk = :pk AND begins_with(#sk, :skPrefix)",
        ExpressionAttributeNames: {
          "#pk": "pk",
          "#sk": "sk",
        },
        ExpressionAttributeValues: {
          ":pk": args.accountId,
          ":skPrefix": SK_PREFIX,
        },
        ScanIndexForward: false,
        Limit: limit,
        ExclusiveStartKey: decodePageIdentifier(
          args.pageIdentifier,
          (decoded) =>
            PersistedCleanupReportKeySchema.refine(
              (cursor) => cursor.pk === args.accountId,
            ).parse(decoded),
        ),
      }),
    );

    return {
      ...parseResults(result.Items, PersistedCleanupReportSchema),
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }
}

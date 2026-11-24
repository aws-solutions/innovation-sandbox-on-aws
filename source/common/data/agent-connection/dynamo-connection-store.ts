// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  DeleteCommand,
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
} from "@aws-sdk/lib-dynamodb";

import {
  ConnectionRecord,
  ConnectionRecordSchema,
  ConnectionStore,
} from "@amzn/innovation-sandbox-commons/data/agent-connection/connection-store.js";

export class DynamoConnectionStore implements ConnectionStore {
  private readonly client: DynamoDBDocumentClient;
  private readonly tableName: string;

  constructor(props: { client: DynamoDBDocumentClient; tableName: string }) {
    this.client = props.client;
    this.tableName = props.tableName;
  }

  async save(record: ConnectionRecord): Promise<void> {
    await this.client.send(
      new PutCommand({
        TableName: this.tableName,
        Item: record,
      }),
    );
  }

  async delete(connectionId: string): Promise<void> {
    await this.client.send(
      new DeleteCommand({
        TableName: this.tableName,
        Key: { connectionId },
      }),
    );
  }

  async get(connectionId: string): Promise<ConnectionRecord | null> {
    const result = await this.client.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { connectionId },
      }),
    );
    if (!result.Item) return null;
    const parsed = ConnectionRecordSchema.safeParse(result.Item);
    if (!parsed.success) {
      // Fail-closed: return null so the Worker drops this message (no access) rather than
      // retrying indefinitely
      return null;
    }
    return parsed.data;
  }
}

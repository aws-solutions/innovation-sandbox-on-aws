// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  paginateQuery,
  PutCommand,
  QueryCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { backOff } from "exponential-backoff";
import { z } from "zod";

import {
  AGENT_MODELS_SECTION,
  AgentModelAdminUpdate,
  AgentModelCatalogSchemaVersion,
  AgentModelCreate,
  AgentModelCreateSchema,
  agentModelSk,
  parseAgentModelRow,
  PersistedAgentModelCatalogKeySchema,
  PersistedAgentModelCatalogRow,
  PersistedAgentModelCatalogRowSchema,
} from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import {
  ConfigStore,
  ConflictError,
} from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import {
  ConfigSchemaVersion,
  PersistedConfigSectionData,
  PersistedLastSavedBy,
  PersistedLastSavedBySchema,
} from "@amzn/innovation-sandbox-commons/data/config/config.js";
import {
  base64EncodeCompositeKey,
  decodePageIdentifier,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { BatchGetUnprocessedKeysError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  checkSchemaVersion,
  createVersionRangeSchema,
  ItemWithMetadata,
  SchemaMismatchException,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  ConfigSchemas,
  ConfigSection,
  ConfigWriteSchemas,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const logger = new Logger();

const CURRENT_SK = "current";

const SUPPORTED_VERSIONS_SCHEMA = createVersionRangeSchema(
  1,
  ConfigSchemaVersion,
);

/** Version range accepted when reading agent-model catalog rows. */
const CATALOG_SUPPORTED_VERSIONS_SCHEMA = createVersionRangeSchema(
  1,
  AgentModelCatalogSchemaVersion,
);

// The store always writes all three meta fields together; a stored record
// missing any is corruption.
const StoredMetaSchema = z.object({
  createdTime: z.iso.datetime(),
  lastEditTime: z.iso.datetime(),
  schemaVersion: z.number().int(),
});

const ALL_SECTIONS = Object.keys(ConfigSchemas) as ConfigSection[];

/**
 * DynamoDB-backed {@link ConfigStore}. One item per section keyed by
 * `{ section, sk: "current" }`. Writes use {@link UpdateCommand} with a
 * conditional branch for optimistic concurrency (see {@link putSection}); reads
 * validate stored config fields against `ConfigSchemas[section]` and enforce the
 * supported schema-version range.
 */
export class DynamoConfigStore implements ConfigStore {
  private readonly tableName: string;
  private readonly ddbClient: DynamoDBDocumentClient;

  constructor(props: { client: DynamoDBDocumentClient; tableName: string }) {
    this.ddbClient = props.client;
    this.tableName = props.tableName;
  }

  public async getAllSections(): Promise<{
    [K in ConfigSection]?: PersistedConfigSectionData<K>;
  }> {
    const found: Record<string, any>[] = [];
    let keys: { section: string; sk: string }[] = ALL_SECTIONS.map(
      (section) => ({ section, sk: CURRENT_SK }),
    );

    await backOff(
      async () => {
        const result = await this.ddbClient.send(
          new BatchGetCommand({
            RequestItems: { [this.tableName]: { Keys: keys } },
          }),
        );
        found.push(...(result.Responses?.[this.tableName] ?? []));

        const unprocessed = result.UnprocessedKeys?.[this.tableName]?.Keys as
          { section: string; sk: string }[] | undefined;
        if (unprocessed && unprocessed.length > 0) {
          keys = unprocessed;
          throw new BatchGetUnprocessedKeysError(unprocessed.length);
        }
      },
      {
        numOfAttempts: 4,
        startingDelay: 100,
        jitter: "full",
        retry: (error: unknown) =>
          error instanceof BatchGetUnprocessedKeysError,
      },
    );

    const sections: { [K in ConfigSection]?: PersistedConfigSectionData<K> } =
      {};
    for (const item of found) {
      const section = item.section as ConfigSection;
      try {
        (
          sections as Record<
            ConfigSection,
            PersistedConfigSectionData<ConfigSection>
          >
        )[section] = this.toSectionData(section, item);
      } catch (error: unknown) {
        // Skip a malformed section; missing sections fall back to code defaults.
        // Logged for the operator only: the returned map is partial either way,
        // so the caller still cannot tell the two apart.
        //
        // Paths and issue codes, never the zod message, which quotes failing
        // values -- a section carries the terms-of-service text and operator
        // email addresses. Joined raw, safe only because no config field is a
        // `z.record`; an issue inside one would put the KEY on the path.
        logger.warn(
          `${LogPatterns.DataValidationWarning.pattern}: skipping a config section that failed schema validation`,
          {
            section,
            ...(error instanceof z.ZodError
              ? {
                  invalidPaths: error.issues.map((issue) =>
                    issue.path.join("."),
                  ),
                  issueCodes: error.issues.map((issue) => issue.code),
                }
              : // Not zod: `toSectionData` throws SchemaMismatchException, whose
                // message carries the stored schemaVersion and the supported
                // range, and no config field value.
                {
                  error: error instanceof Error ? error.message : String(error),
                }),
          },
        );
      }
    }
    return sections;
  }

  public async getSection<T extends ConfigSection>(
    section: T,
    options?: { consistentRead?: boolean },
  ): Promise<PersistedConfigSectionData<T> | null> {
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { section, sk: CURRENT_SK },
        ConsistentRead: options?.consistentRead,
      }),
    );
    if (!result.Item) {
      return null;
    }
    return this.toSectionData(section, result.Item);
  }

  public async putSection<T extends ConfigSection>(
    section: T,
    data: z.infer<(typeof ConfigWriteSchemas)[T]>,
    editedBy: PersistedLastSavedBy,
    expectedLastEditTime?: string,
  ): Promise<PersistedConfigSectionData<T>> {
    const validatedEditedBy = PersistedLastSavedBySchema.parse(editedBy);
    const now = nowAsIsoDatetimeString();

    // Enforce `.strict()` + field bounds at runtime before any write.
    const parsed = (ConfigWriteSchemas[section] as z.ZodType).parse(data);

    const setParts: string[] = [];
    const names: Record<string, string> = { "#meta": "meta" };
    const values: Record<string, any> = {};

    for (const [field, value] of Object.entries(parsed as object)) {
      names[`#${field}`] = field;
      values[`:${field}`] = value;
      setParts.push(`#${field} = :${field}`);
    }

    names["#lastSavedBy"] = "lastSavedBy";
    values[":lastSavedBy"] = validatedEditedBy;
    setParts.push("#lastSavedBy = :lastSavedBy");

    let conditionExpression: string;
    if (expectedLastEditTime === undefined) {
      // First save: the meta map does not exist yet, so write it whole.
      names["#section"] = "section";
      names["#sk"] = "sk";
      values[":meta"] = {
        createdTime: now,
        lastEditTime: now,
        schemaVersion: ConfigSchemaVersion,
      };
      setParts.push("#meta = :meta");
      conditionExpression =
        "attribute_not_exists(#section) AND attribute_not_exists(#sk)";
    } else {
      // Subsequent save: leave createdTime untouched (write-once).
      names["#lastEditTime"] = "lastEditTime";
      names["#schemaVersion"] = "schemaVersion";
      values[":now"] = now;
      values[":schemaVersion"] = ConfigSchemaVersion;
      values[":expected"] = expectedLastEditTime;
      setParts.push(
        "#meta.#lastEditTime = :now",
        "#meta.#schemaVersion = :schemaVersion",
      );
      conditionExpression = "#meta.#lastEditTime = :expected";
    }

    try {
      const result = await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { section, sk: CURRENT_SK },
          UpdateExpression: `SET ${setParts.join(", ")}`,
          ConditionExpression: conditionExpression,
          ExpressionAttributeNames: names,
          ExpressionAttributeValues: values,
          ReturnValues: "ALL_NEW",
        }),
      );
      return this.toSectionData(
        section,
        result.Attributes as Record<string, any>,
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConflictError(
          expectedLastEditTime === undefined
            ? "Configuration section already exists."
            : "Configuration section was modified by another process.",
        );
      }
      throw error;
    }
  }

  public async migrateSections(
    sections: { [K in ConfigSection]?: z.infer<(typeof ConfigSchemas)[K]> },
    editedBy: PersistedLastSavedBy,
  ): Promise<{ migrated: boolean }> {
    const validatedEditedBy = PersistedLastSavedBySchema.parse(editedBy);
    const now = nowAsIsoDatetimeString();

    const transactItems = (
      Object.entries(sections) as [
        ConfigSection,
        z.infer<(typeof ConfigSchemas)[ConfigSection]>,
      ][]
    ).map(([section, fields]) => ({
      Put: {
        TableName: this.tableName,
        Item: {
          section,
          sk: CURRENT_SK,
          ...(fields as object),
          lastSavedBy: validatedEditedBy,
          meta: {
            createdTime: now,
            lastEditTime: now,
            schemaVersion: ConfigSchemaVersion,
          },
        },
        // Idempotency guard: write only if the section does not already exist,
        // so a re-invoked migrator never overwrites admin-saved config.
        ConditionExpression:
          "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
        ExpressionAttributeNames: { "#section": "section", "#sk": "sk" },
      },
    }));

    try {
      await this.ddbClient.send(
        new TransactWriteCommand({ TransactItems: transactItems }),
      );
      return { migrated: true };
    } catch (error: unknown) {
      // No-op only when the cancellation is purely conditional (every reason
      // is ConditionalCheckFailed or "None"). A transient reason (throttling,
      // TransactionConflict) must surface, not be misread as "already migrated".
      if (
        error instanceof TransactionCanceledException &&
        error.CancellationReasons?.length &&
        error.CancellationReasons.every(
          (reason) =>
            reason.Code === "ConditionalCheckFailed" || reason.Code === "None",
        )
      ) {
        return { migrated: false };
      }
      throw error;
    }
  }

  /**
   * Shared read-assembly for `toSectionData` and `getAgentModels`:
   * version check → strip composite keys → validate meta.
   */
  private stripAndValidateMeta(
    item: Record<string, any>,
    versionSchema: z.ZodType<number>,
  ): {
    fields: Record<string, unknown>;
    lastSavedBy: unknown;
    meta: z.infer<typeof StoredMetaSchema>;
  } {
    checkSchemaVersion(item as ItemWithMetadata, versionSchema);
    const { section: _section, sk: _sk, lastSavedBy, meta, ...fields } = item;
    const metaResult = StoredMetaSchema.safeParse(meta);
    if (!metaResult.success) {
      throw new SchemaMismatchException(
        `Stored config item has invalid meta: ${metaResult.error.message}`,
      );
    }
    return { fields, lastSavedBy, meta: metaResult.data };
  }

  /**
   * Reassembles a stored section item into a typed {@link PersistedConfigSectionData}.
   * Normalizes a missing `lastSavedBy` to `null`.
   */
  private toSectionData<T extends ConfigSection>(
    section: T,
    item: Record<string, any>,
  ): PersistedConfigSectionData<T> {
    const { fields, lastSavedBy, meta } = this.stripAndValidateMeta(
      item,
      SUPPORTED_VERSIONS_SCHEMA,
    );
    const parsedFields = (ConfigSchemas[section] as z.ZodType).parse(
      fields,
    ) as z.infer<(typeof ConfigSchemas)[T]>;
    return {
      ...parsedFields,
      lastSavedBy: lastSavedBy ?? null,
      meta,
    } as PersistedConfigSectionData<T>;
  }

  /**
   * Returns all rows under `section = "agentModels"` via a paginated Query.
   * Follows the same read pattern as `toSectionData`: strips composite-key
   * fields, validates meta with `StoredMetaSchema`, enforces schema-version
   * range with `checkSchemaVersion`, then parses fields against the strict
   * catalog schema. Rows that fail any of these checks are dropped and logged
   * (fail-open), so a single corrupt row does not break the settings page or
   * Worker cache load.
   */
  public async getAgentModels(options?: {
    consistentRead?: boolean;
  }): Promise<PersistedAgentModelCatalogRow[]> {
    const paginator = paginateQuery(
      { client: this.ddbClient },
      {
        TableName: this.tableName,
        KeyConditionExpression: "#section = :section",
        ExpressionAttributeNames: { "#section": "section" },
        ExpressionAttributeValues: { ":section": AGENT_MODELS_SECTION },
        ConsistentRead: options?.consistentRead,
      },
    );

    const rows: PersistedAgentModelCatalogRow[] = [];
    for await (const page of paginator) {
      for (const item of page.Items ?? []) {
        const sk = item.sk as string | undefined;
        try {
          // Steps 1–3 (version, key strip, meta). Step 4: parse full row schema.
          const { fields, lastSavedBy, meta } = this.stripAndValidateMeta(
            item,
            CATALOG_SUPPORTED_VERSIONS_SCHEMA,
          );
          rows.push(
            PersistedAgentModelCatalogRowSchema.parse({
              ...fields,
              lastSavedBy,
              meta,
            }),
          );
        } catch (error) {
          logger.warn(
            `${LogPatterns.DataValidationWarning.pattern}: dropping agent-model catalog row that failed schema validation`,
            {
              section: AGENT_MODELS_SECTION,
              sk,
              ...(error instanceof z.ZodError
                ? {
                    invalidPaths: error.issues.map((i) => i.path.join(".")),
                    issueCodes: error.issues.map((i) => i.code),
                  }
                : {
                    error:
                      error instanceof Error ? error.message : String(error),
                  }),
            },
          );
        }
      }
    }
    return rows;
  }

  /** Returns one catalog row by modelId, or undefined when absent or invalid. */
  public async getAgentModel(
    modelId: string,
  ): Promise<PersistedAgentModelCatalogRow | undefined> {
    const sk = agentModelSk(modelId);
    const result = await this.ddbClient.send(
      new GetCommand({
        TableName: this.tableName,
        Key: { section: AGENT_MODELS_SECTION, sk },
      }),
    );
    if (!result.Item) return undefined;
    try {
      const { fields, lastSavedBy, meta } = this.stripAndValidateMeta(
        result.Item,
        CATALOG_SUPPORTED_VERSIONS_SCHEMA,
      );
      return PersistedAgentModelCatalogRowSchema.parse({
        ...fields,
        lastSavedBy,
        meta,
      });
    } catch (error) {
      logger.warn(
        `${LogPatterns.DataValidationWarning.pattern}: agent-model catalog row failed schema validation`,
        {
          section: AGENT_MODELS_SECTION,
          sk,
          ...(error instanceof z.ZodError
            ? {
                invalidPaths: error.issues.map((i) => i.path.join(".")),
                issueCodes: error.issues.map((i) => i.code),
              }
            : {
                error: error instanceof Error ? error.message : String(error),
              }),
        },
      );
      return undefined;
    }
  }

  public async getAgentModelsPaginated(props: {
    pageSize?: number;
    pageIdentifier?: string;
  }): Promise<{
    rows: PersistedAgentModelCatalogRow[];
    nextPageIdentifier: string | null;
  }> {
    const { pageSize, pageIdentifier } = props;
    const result = await this.ddbClient.send(
      new QueryCommand({
        TableName: this.tableName,
        KeyConditionExpression: "#section = :section",
        ExpressionAttributeNames: { "#section": "section" },
        ExpressionAttributeValues: { ":section": AGENT_MODELS_SECTION },
        ...(pageSize === undefined ? {} : { Limit: pageSize }),
        ...(pageIdentifier === undefined
          ? {}
          : {
              ExclusiveStartKey: decodePageIdentifier(
                pageIdentifier,
                (decoded) => PersistedAgentModelCatalogKeySchema.parse(decoded),
              ),
            }),
      }),
    );

    const rows: PersistedAgentModelCatalogRow[] = [];
    for (const item of result.Items ?? []) {
      const sk = item.sk as string | undefined;
      try {
        const { fields, lastSavedBy, meta } = this.stripAndValidateMeta(
          item,
          CATALOG_SUPPORTED_VERSIONS_SCHEMA,
        );
        rows.push(
          PersistedAgentModelCatalogRowSchema.parse({
            ...fields,
            lastSavedBy,
            meta,
          }),
        );
      } catch (error) {
        logger.warn(
          `${LogPatterns.DataValidationWarning.pattern}: dropping agent-model catalog row that failed schema validation`,
          {
            section: AGENT_MODELS_SECTION,
            sk,
            ...(error instanceof z.ZodError
              ? {
                  invalidPaths: error.issues.map((i) => i.path.join(".")),
                  issueCodes: error.issues.map((i) => i.code),
                }
              : {
                  error: error instanceof Error ? error.message : String(error),
                }),
          },
        );
      }
    }

    return {
      rows,
      nextPageIdentifier: base64EncodeCompositeKey(result.LastEvaluatedKey),
    };
  }

  /**
   * Add-only discovery write. Re-fetches never overwrite existing rows.
   * @throws {ConflictError} when the row already exists.
   */
  public async putModelRow(
    row: AgentModelCreate,
    addedBy: PersistedLastSavedBy,
  ): Promise<PersistedAgentModelCatalogRow> {
    const validatedAddedBy = PersistedLastSavedBySchema.parse(addedBy);
    const now = nowAsIsoDatetimeString();

    // Parse first so defaults (e.g. enabled: false) are applied.
    const parsed = AgentModelCreateSchema.parse(row);
    const sk = agentModelSk(parsed.modelId);

    const item = {
      section: AGENT_MODELS_SECTION,
      sk,
      ...parsed,
      addedAt: now,
      lastSavedBy: validatedAddedBy,
      meta: {
        createdTime: now,
        lastEditTime: now,
        schemaVersion: AgentModelCatalogSchemaVersion,
      },
    };

    try {
      await this.ddbClient.send(
        new PutCommand({
          TableName: this.tableName,
          Item: item,
          ConditionExpression:
            "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
          ExpressionAttributeNames: { "#section": "section", "#sk": "sk" },
        }),
      );
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConflictError("Agent model row already exists.");
      }
      throw error;
    }

    return parseAgentModelRow(item);
  }

  /**
   * Admin enable/disable toggle. Updates `enabled`, stamps `lastSavedBy` and
   * `meta.lastEditTime`, OCC-guarded on `expectedLastEditTime`.
   *
   * @throws {ConflictError} when the condition fails (stale token).
   */
  public async updateModelAdminFields(
    modelId: string,
    update: AgentModelAdminUpdate,
    editedBy: PersistedLastSavedBy,
    expectedLastEditTime: string,
  ): Promise<PersistedAgentModelCatalogRow> {
    const validatedEditedBy = PersistedLastSavedBySchema.parse(editedBy);
    const now = nowAsIsoDatetimeString();
    const sk = agentModelSk(modelId);

    try {
      const result = await this.ddbClient.send(
        new UpdateCommand({
          TableName: this.tableName,
          Key: { section: AGENT_MODELS_SECTION, sk },
          UpdateExpression:
            "SET #enabled = :enabled, #lastSavedBy = :lastSavedBy, " +
            "#meta.#lastEditTime = :now, #meta.#schemaVersion = :schemaVersion",
          ConditionExpression: "#meta.#lastEditTime = :expected",
          ExpressionAttributeNames: {
            "#enabled": "enabled",
            "#lastSavedBy": "lastSavedBy",
            "#meta": "meta",
            "#lastEditTime": "lastEditTime",
            "#schemaVersion": "schemaVersion",
          },
          ExpressionAttributeValues: {
            ":enabled": update.enabled,
            ":lastSavedBy": validatedEditedBy,
            ":now": now,
            ":schemaVersion": AgentModelCatalogSchemaVersion,
            ":expected": expectedLastEditTime,
          },
          ReturnValues: "ALL_NEW",
        }),
      );
      return parseAgentModelRow(result.Attributes ?? {});
    } catch (error: unknown) {
      if (error instanceof ConditionalCheckFailedException) {
        throw new ConflictError(
          "Agent model row was modified by another process.",
        );
      }
      throw error;
    }
  }
}

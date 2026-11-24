// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ConditionalCheckFailedException,
  TransactionCanceledException,
} from "@aws-sdk/client-dynamodb";
import {
  BatchGetCommand,
  DynamoDBDocumentClient,
  GetCommand,
  TransactWriteCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { ConfigSchemaVersion } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { BatchGetUnprocessedKeysError } from "@amzn/innovation-sandbox-commons/data/errors.js";
import { SchemaMismatchException } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  ConfigSchemas,
  ConfigSection,
  LeasesConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";

const mockDynamoClient = mockClient(DynamoDBDocumentClient);

const TABLE_NAME = "test-config-table";
const NOW = "2024-06-01T12:00:00.000Z";

describe("DynamoConfigStore", () => {
  let store: DynamoConfigStore;

  beforeEach(() => {
    mockDynamoClient.reset();
    store = new DynamoConfigStore({
      client: mockDynamoClient as unknown as DynamoDBDocumentClient,
      tableName: TABLE_NAME,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("getAllSections()", () => {
    test("returns every section when all are present", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [
            buildStoredItem("leases"),
            buildStoredItem("cleanup"),
            buildStoredItem("notification"),
            buildStoredItem("maintenance"),
            buildStoredItem("termsOfService"),
            buildStoredItem("costReporting"),
          ],
        },
      });

      const result = await store.getAllSections();

      expect(Object.keys(result).sort()).toEqual(
        [
          "cleanup",
          "costReporting",
          "leases",
          "maintenance",
          "notification",
          "termsOfService",
        ].sort(),
      );
      expect(result.leases!.maxBudget).toBe(50);
      expect(result.leases!.lastSavedBy).toBe("admin@example.com");
      expect(result.leases!.meta.schemaVersion).toBe(ConfigSchemaVersion);
    });

    test("returns only the sections present in DynamoDB", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [buildStoredItem("leases"), buildStoredItem("cleanup")],
        },
      });

      const result = await store.getAllSections();

      expect(Object.keys(result).sort()).toEqual(["cleanup", "leases"]);
      expect(result.notification).toBeUndefined();
    });

    test("returns an empty object when no sections exist", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({ Responses: {} });

      const result = await store.getAllSections();

      expect(result).toEqual({});
    });

    test("retries unprocessed keys with backoff", async () => {
      vi.useRealTimers();
      mockDynamoClient
        .on(BatchGetCommand)
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [buildStoredItem("leases")] },
          UnprocessedKeys: {
            [TABLE_NAME]: { Keys: [{ section: "cleanup", sk: "current" }] },
          },
        })
        .resolvesOnce({
          Responses: { [TABLE_NAME]: [buildStoredItem("cleanup")] },
        });

      const result = await store.getAllSections();

      const calls = mockDynamoClient.commandCalls(BatchGetCommand);
      expect(calls).toHaveLength(2);
      expect(calls[1]!.args[0].input.RequestItems![TABLE_NAME]!.Keys).toEqual([
        { section: "cleanup", sk: "current" },
      ]);
      expect(Object.keys(result).sort()).toEqual(["cleanup", "leases"]);
    });

    test("skips a single malformed section and returns the valid ones", async () => {
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [
            buildStoredItem("leases"),
            buildStoredItem("cleanup", {
              meta: {
                createdTime: NOW,
                lastEditTime: NOW,
                schemaVersion: ConfigSchemaVersion + 1,
              },
            }),
          ],
        },
      });

      const result = await store.getAllSections();

      expect(Object.keys(result)).toEqual(["leases"]);
      expect(result.cleanup).toBeUndefined();
    });

    test("skips a section whose stored meta is present but incomplete", async () => {
      // A meta missing `lastEditTime` (the concurrency token) is corruption, not
      // a valid never-saved state — the aggregate read drops it to code defaults
      // rather than forwarding a half-populated meta.
      const { meta: _meta, ...cleanupWithoutEditTime } =
        buildStoredItem("cleanup");
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: {
          [TABLE_NAME]: [
            buildStoredItem("leases"),
            {
              ...cleanupWithoutEditTime,
              meta: { createdTime: NOW, schemaVersion: ConfigSchemaVersion },
            },
          ],
        },
      });

      const result = await store.getAllSections();

      expect(Object.keys(result)).toEqual(["leases"]);
      expect(result.cleanup).toBeUndefined();
    });

    test("rejects after exhausting retries on unprocessed keys", async () => {
      vi.useRealTimers();
      mockDynamoClient.on(BatchGetCommand).resolves({
        Responses: { [TABLE_NAME]: [] },
        UnprocessedKeys: {
          [TABLE_NAME]: { Keys: [{ section: "leases", sk: "current" }] },
        },
      });

      await expect(store.getAllSections()).rejects.toBeInstanceOf(
        BatchGetUnprocessedKeysError,
      );
    });
  });

  describe("getSection()", () => {
    test("loads an existing configuration with required groups missing so an admin can repair it", async () => {
      mockDynamoClient.on(GetCommand).resolves({
        Item: buildStoredItem("costReporting", {
          requireCostReportGroup: true,
          costReportGroups: [],
        }),
      });

      await expect(store.getSection("costReporting")).resolves.toMatchObject({
        requireCostReportGroup: true,
        costReportGroups: [],
      });
    });

    test("returns the parsed section when the item exists", async () => {
      mockDynamoClient
        .on(GetCommand)
        .resolves({ Item: buildStoredItem("leases") });

      const result = await store.getSection("leases");

      const input = mockDynamoClient.commandCalls(GetCommand)[0]!.args[0].input;
      expect(input.Key).toEqual({ section: "leases", sk: "current" });
      expect(result).not.toBeNull();
      expect(result!.maxBudget).toBe(50);
      expect(result!.lastSavedBy).toBe("admin@example.com");
    });
    test("defaults group assignment mode for records created before the field existed", async () => {
      const {
        groupAssignmentMode: _groupAssignmentMode,
        ...storedBeforeField
      } = buildStoredItem("leases");
      mockDynamoClient.on(GetCommand).resolves({ Item: storedBeforeField });

      const result = await store.getSection("leases");

      expect(result?.groupAssignmentMode).toBe("NONE");
    });

    test("defaults the notification channel toggles for records created before the fields existed", async () => {
      const {
        sesEnabled: _sesEnabled,
        snsIntegrationTopicEnabled: _snsIntegrationTopicEnabled,
        ...storedBeforeToggles
      } = buildStoredItem("notification", { emailFrom: "ops@example.com" });
      mockDynamoClient.on(GetCommand).resolves({ Item: storedBeforeToggles });

      const result = await store.getSection("notification");

      expect(result).toMatchObject({
        emailFrom: "ops@example.com",
        sesEnabled: true,
        snsIntegrationTopicEnabled: false,
      });
    });

    test("returns null when the item does not exist", async () => {
      mockDynamoClient.on(GetCommand).resolves({});

      expect(await store.getSection("leases")).toBeNull();
    });

    test("uses a strongly consistent read only when asked", async () => {
      mockDynamoClient
        .on(GetCommand)
        .resolves({ Item: buildStoredItem("leases") });

      await store.getSection("leases");
      await store.getSection("leases", { consistentRead: true });

      const calls = mockDynamoClient.commandCalls(GetCommand);
      expect(calls[0]!.args[0].input.ConsistentRead).toBeUndefined();
      expect(calls[1]!.args[0].input.ConsistentRead).toBe(true);
    });

    test("throws when the stored item is missing meta", async () => {
      const { meta: _meta, ...itemWithoutMeta } = buildStoredItem("leases");
      mockDynamoClient.on(GetCommand).resolves({ Item: itemWithoutMeta });

      await expect(store.getSection("leases")).rejects.toThrow(
        SchemaMismatchException,
      );
    });

    test("throws when the stored meta is present but missing a timestamp", async () => {
      // The persisted invariant requires all three meta fields. A meta with a
      // `createdTime` but no `lastEditTime` is corruption; the single-section
      // read surfaces it loudly (becomes a 500 upstream) rather than returning a
      // successful response whose next write cannot save.
      const item = buildStoredItem("leases", {
        meta: { createdTime: NOW, schemaVersion: ConfigSchemaVersion },
      });
      mockDynamoClient.on(GetCommand).resolves({ Item: item });

      await expect(store.getSection("leases")).rejects.toThrow(
        SchemaMismatchException,
      );
    });
  });

  describe("putSection()", () => {
    const leasesBody = LeasesConfigSchema.parse({});

    test("rejects required cost report groups with an empty list before writing", async () => {
      const invalidConfig = {
        requireCostReportGroup: true,
        costReportGroups: [],
      };
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("costReporting", invalidConfig),
      });

      await expect(
        store.putSection("costReporting", invalidConfig, "admin@example.com"),
      ).rejects.toMatchObject({
        issues: [
          expect.objectContaining({
            path: ["costReportGroups"],
            message:
              "Add at least one cost report group or turn off Require cost report group.",
          }),
        ],
      });
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("first save uses attribute_not_exists and writes the whole meta map", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases"),
      });

      await store.putSection("leases", leasesBody, "admin@example.com");

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.Key).toEqual({ section: "leases", sk: "current" });
      expect(input.ConditionExpression).toBe(
        "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
      );
      expect(input.UpdateExpression).toContain("#meta = :meta");
      expect(input.ExpressionAttributeValues![":meta"]).toEqual({
        createdTime: NOW,
        lastEditTime: NOW,
        schemaVersion: ConfigSchemaVersion,
      });
      expect(input.ExpressionAttributeValues![":lastSavedBy"]).toBe(
        "admin@example.com",
      );
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    test("subsequent save matches lastEditTime and does not write createdTime", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases"),
      });

      await store.putSection(
        "leases",
        leasesBody,
        "admin@example.com",
        "2024-05-01T00:00:00.000Z",
      );

      const input =
        mockDynamoClient.commandCalls(UpdateCommand)[0]!.args[0].input;
      expect(input.ConditionExpression).toBe("#meta.#lastEditTime = :expected");
      expect(input.UpdateExpression).toContain("#meta.#lastEditTime = :now");
      expect(input.UpdateExpression).not.toContain("createdTime");
      expect(input.ExpressionAttributeValues![":expected"]).toBe(
        "2024-05-01T00:00:00.000Z",
      );
    });

    test("validates editedBy before writing", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases"),
      });

      await expect(
        store.putSection("leases", leasesBody, "not-an-email" as never),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("rejects a schema-violating payload before writing", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases"),
      });

      await expect(
        store.putSection(
          "leases",
          { ...leasesBody, maxBudget: -1 },
          "admin@example.com",
        ),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("rejects an unknown-field payload before writing", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases"),
      });

      await expect(
        store.putSection(
          "leases",
          { ...leasesBody, bogusField: true } as never,
          "admin@example.com",
        ),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(UpdateCommand)).toHaveLength(0);
    });

    test("accepts a system: sentinel as editedBy", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases", {
          lastSavedBy: "system:migration",
        }),
      });

      const result = await store.putSection(
        "leases",
        leasesBody,
        "system:migration",
      );

      expect(result.lastSavedBy).toBe("system:migration");
    });

    test("maps a conditional check failure on first save to ConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailure());

      await expect(
        store.putSection("leases", leasesBody, "admin@example.com"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    test("maps a conditional check failure on subsequent save to ConflictError", async () => {
      mockDynamoClient.on(UpdateCommand).rejects(conditionalCheckFailure());

      await expect(
        store.putSection(
          "leases",
          leasesBody,
          "admin@example.com",
          "2024-05-01T00:00:00.000Z",
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    test("returns the parsed written section", async () => {
      mockDynamoClient.on(UpdateCommand).resolves({
        Attributes: buildStoredItem("leases", { maxBudget: 500 }),
      });

      const result = await store.putSection(
        "leases",
        { ...leasesBody, maxBudget: 500 },
        "admin@example.com",
        "2024-05-01T00:00:00.000Z",
      );

      expect(result.maxBudget).toBe(500);
      expect(result.meta.schemaVersion).toBe(ConfigSchemaVersion);
    });
  });

  describe("migrateSections()", () => {
    const sections = {
      leases: ConfigSchemas.leases.parse({}),
      cleanup: ConfigSchemas.cleanup.parse({}),
    };

    test("writes all supplied sections in one transaction with the audit envelope", async () => {
      mockDynamoClient.on(TransactWriteCommand).resolves({});

      const result = await store.migrateSections(sections, "system:migration");

      expect(result).toEqual({ migrated: true });

      const calls = mockDynamoClient.commandCalls(TransactWriteCommand);
      expect(calls).toHaveLength(1);

      const items = (calls[0]!.args[0].input.TransactItems ?? []).map(
        (t: any) => t.Put.Item,
      );
      expect(items.map((i: any) => i.section).sort()).toEqual([
        "cleanup",
        "leases",
      ]);
      for (const item of items) {
        expect(item.sk).toBe("current");
        expect(item.lastSavedBy).toBe("system:migration");
        expect(item.meta).toEqual({
          createdTime: NOW,
          lastEditTime: NOW,
          schemaVersion: ConfigSchemaVersion,
        });
      }
      // Each item targets the configured table.
      for (const t of (calls[0]!.args[0].input.TransactItems ?? []) as any[]) {
        expect(t.Put.TableName).toBe(TABLE_NAME);
      }
    });

    test("guards every section write with an attribute_not_exists condition", async () => {
      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await store.migrateSections(sections, "system:migration");

      const puts = (
        mockDynamoClient.commandCalls(TransactWriteCommand)[0]!.args[0].input
          .TransactItems ?? []
      ).map((t: any) => t.Put);
      expect(puts).toHaveLength(2);
      for (const put of puts) {
        expect(put.ConditionExpression).toBe(
          "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
        );
        expect(put.ExpressionAttributeNames).toEqual({
          "#section": "section",
          "#sk": "sk",
        });
      }
    });

    test("returns { migrated: false } (no-op) when the sections already exist", async () => {
      // A conditional failure inside a transaction surfaces as
      // TransactionCanceledException with a ConditionalCheckFailed reason.
      mockDynamoClient
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(["ConditionalCheckFailed", "None"]));

      const result = await store.migrateSections(sections, "system:migration");

      expect(result).toEqual({ migrated: false });
    });

    test("rethrows a transaction cancellation that is NOT a conditional check (e.g. throttling)", async () => {
      // A throttle/capacity cancellation must NOT be misread as "already
      // migrated" — it has to surface so the deploy retries/fails.
      mockDynamoClient
        .on(TransactWriteCommand)
        .rejects(transactionCanceled(["TransactionConflict"]));

      await expect(
        store.migrateSections(sections, "system:migration"),
      ).rejects.toBeInstanceOf(TransactionCanceledException);
    });

    test("rethrows a MIXED cancellation (conditional + transient) instead of masking it", async () => {
      // One item already exists (ConditionalCheckFailed) while another hits a
      // transient failure (TransactionConflict). A `.some()` check would treat
      // this as "already migrated" and silently drop the section that failed
      // to write; the stricter `.every()` check must rethrow so the real
      // failure surfaces.
      mockDynamoClient
        .on(TransactWriteCommand)
        .rejects(
          transactionCanceled([
            "ConditionalCheckFailed",
            "TransactionConflict",
          ]),
        );

      await expect(
        store.migrateSections(sections, "system:migration"),
      ).rejects.toBeInstanceOf(TransactionCanceledException);
    });

    test("validates editedBy before writing", async () => {
      mockDynamoClient.on(TransactWriteCommand).resolves({});

      await expect(
        store.migrateSections(sections, "not-an-email" as never),
      ).rejects.toThrow();
      expect(mockDynamoClient.commandCalls(TransactWriteCommand)).toHaveLength(
        0,
      );
    });
  });
});

function transactionCanceled(
  reasonCodes: string[],
): TransactionCanceledException {
  return new TransactionCanceledException({
    message: "Transaction cancelled",
    $metadata: {},
    CancellationReasons: reasonCodes.map((Code) => ({ Code })),
  });
}

function conditionalCheckFailure(): ConditionalCheckFailedException {
  return new ConditionalCheckFailedException({
    message: "The conditional request failed",
    $metadata: {},
  });
}

/**
 * Builds a stored DynamoDB item for a section: the section's code-default fields
 * plus the key, audit, and metadata attributes the store persists.
 */
function buildStoredItem(
  section: ConfigSection,
  overrides: Record<string, any> = {},
): Record<string, any> {
  const fields = ConfigSchemas[section].parse({});
  return {
    section,
    sk: "current",
    ...fields,
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: NOW,
      lastEditTime: NOW,
      schemaVersion: ConfigSchemaVersion,
    },
    ...overrides,
  };
}

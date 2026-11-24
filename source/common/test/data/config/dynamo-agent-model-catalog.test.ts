// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  ConditionalCheckFailedException,
  DynamoDBClient,
} from "@aws-sdk/client-dynamodb";
import {
  DynamoDBDocumentClient,
  GetCommand,
  PutCommand,
  QueryCommand,
  UpdateCommand,
} from "@aws-sdk/lib-dynamodb";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import {
  AGENT_MODEL_SK_PREFIX,
  AGENT_MODELS_SECTION,
  AgentModelCatalogSchemaVersion,
  agentModelSk,
  PersistedAgentModelCatalogRow,
} from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import { ConflictError } from "@amzn/innovation-sandbox-commons/data/config/config-store.js";
import { DynamoConfigStore } from "@amzn/innovation-sandbox-commons/data/config/dynamo-config-store.js";
import { ConfigSchemas } from "@amzn/innovation-sandbox-shared/types/configuration.js";

const ddbClient = DynamoDBDocumentClient.from(new DynamoDBClient({}));
const mockDdb = mockClient(ddbClient);

const TABLE_NAME = "test-config-table";
const NOW = "2026-09-10T12:00:00.000Z";
const MODEL_ID = "global.anthropic.claude-sonnet-4-6";
const SK = agentModelSk(MODEL_ID);

function baseModelRow(
  overrides: Partial<PersistedAgentModelCatalogRow> = {},
): PersistedAgentModelCatalogRow {
  return {
    modelId: MODEL_ID,
    displayName: "Claude Sonnet 4.6",
    provider: "Anthropic",
    availability: "global",
    description: "A capable model.",
    enabled: false,
    addedAt: NOW,
    lastSavedBy: "admin@example.com",
    meta: {
      createdTime: NOW,
      lastEditTime: NOW,
      schemaVersion: AgentModelCatalogSchemaVersion,
    },
    ...overrides,
  };
}

function storedRow(overrides: Partial<PersistedAgentModelCatalogRow> = {}) {
  return {
    section: AGENT_MODELS_SECTION,
    sk: SK,
    ...baseModelRow(overrides),
  };
}

describe("DynamoConfigStore — agent model catalog", () => {
  let store: DynamoConfigStore;

  beforeEach(() => {
    mockDdb.reset();
    store = new DynamoConfigStore({
      client: ddbClient as unknown as DynamoDBDocumentClient,
      tableName: TABLE_NAME,
    });
    vi.useFakeTimers();
    vi.setSystemTime(new Date(NOW));
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.useRealTimers();
  });

  describe("getAgentModel()", () => {
    test("reads one row by section and MODEL# sort key", async () => {
      mockDdb.on(GetCommand).resolves({ Item: storedRow() });

      const row = await store.getAgentModel(MODEL_ID);

      const calls = mockDdb.commandCalls(GetCommand);
      expect(calls).toHaveLength(1);
      expect(calls[0]!.args[0].input.Key).toEqual({
        section: AGENT_MODELS_SECTION,
        sk: SK,
      });
      expect(row).toEqual(baseModelRow());
    });

    test("returns undefined when the row does not exist", async () => {
      mockDdb.on(GetCommand).resolves({});

      await expect(store.getAgentModel(MODEL_ID)).resolves.toBeUndefined();
    });

    test("returns undefined for a row that carries pricing fields", async () => {
      mockDdb.on(GetCommand).resolves({
        Item: { ...storedRow(), inputPricePer1KTokens: 0.003 },
      });
      await expect(store.getAgentModel(MODEL_ID)).resolves.toBeUndefined();
    });
    test("returns undefined for a row that fails schema validation", async () => {
      mockDdb
        .on(GetCommand)
        .resolves({ Item: { ...storedRow(), enabled: "yes" } });

      await expect(store.getAgentModel(MODEL_ID)).resolves.toBeUndefined();
    });
  });

  describe("getAgentModels()", () => {
    test("issues one Query on the section PK", async () => {
      mockDdb.on(QueryCommand).resolves({ Items: [storedRow()] });

      await store.getAgentModels();

      const calls = mockDdb.commandCalls(QueryCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.KeyConditionExpression).toBe("#section = :section");
      expect(input.ExpressionAttributeValues![":section"]).toBe(
        AGENT_MODELS_SECTION,
      );
    });

    test("uses a strongly consistent read only when asked", async () => {
      mockDdb.on(QueryCommand).resolves({ Items: [storedRow()] });

      await store.getAgentModels();
      await store.getAgentModels({ consistentRead: true });

      const calls = mockDdb.commandCalls(QueryCommand);
      expect(calls[0]!.args[0].input.ConsistentRead).toBeUndefined();
      expect(calls[1]!.args[0].input.ConsistentRead).toBe(true);
    });

    test("returns all valid rows", async () => {
      const secondModelId = "us.amazon.nova-pro-v1:0";
      mockDdb.on(QueryCommand).resolves({
        Items: [
          storedRow(),
          {
            section: AGENT_MODELS_SECTION,
            sk: agentModelSk(secondModelId),
            ...baseModelRow({
              modelId: secondModelId,
              displayName: "Nova Pro",
            }),
          },
        ],
      });

      const result = await store.getAgentModels();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.modelId)).toEqual(
        expect.arrayContaining([MODEL_ID, secondModelId]),
      );
    });

    test("returns empty array when no rows exist", async () => {
      mockDdb.on(QueryCommand).resolves({ Items: [] });

      const result = await store.getAgentModels();

      expect(result).toEqual([]);
    });

    test("drops a corrupt row and returns the valid ones (fail-open)", async () => {
      const corruptRow = {
        section: AGENT_MODELS_SECTION,
        sk: "MODEL#bad",
        // modelId missing — will fail schema parse
        displayName: "Bad Row",
      };
      mockDdb.on(QueryCommand).resolves({
        Items: [storedRow(), corruptRow],
      });

      const result = await store.getAgentModels();

      expect(result).toHaveLength(1);
      expect(result[0]!.modelId).toBe(MODEL_ID);
    });

    test("agentModels is absent from ConfigSchemas so getAllSections() never fetches it", async () => {
      // This is the invariant that keeps getAgentModels() from adding reads to
      // every API invocation's BatchGet. If "agentModels" appeared in ConfigSchemas,
      // getAllSections() would include it in its BatchGet and silently fetch 0 rows
      // (wrong key shape) on every request across the whole platform.
      expect(Object.keys(ConfigSchemas)).not.toContain(AGENT_MODELS_SECTION);
    });

    test("follows pagination across multiple pages", async () => {
      const secondModelId = "us.amazon.nova-pro-v1:0";
      mockDdb
        .on(QueryCommand)
        .resolvesOnce({
          Items: [storedRow()],
          LastEvaluatedKey: { section: AGENT_MODELS_SECTION, sk: SK },
        })
        .resolves({
          Items: [
            {
              section: AGENT_MODELS_SECTION,
              sk: agentModelSk(secondModelId),
              ...baseModelRow({ modelId: secondModelId }),
            },
          ],
        });

      const result = await store.getAgentModels();

      expect(result).toHaveLength(2);
      expect(result.map((r) => r.modelId)).toEqual(
        expect.arrayContaining([MODEL_ID, secondModelId]),
      );
      expect(mockDdb.commandCalls(QueryCommand)).toHaveLength(2);
    });

    test("drops a row whose meta.schemaVersion is out of range, keeps valid rows", async () => {
      const futureVersionRow = {
        section: AGENT_MODELS_SECTION,
        sk: agentModelSk("future.model"),
        ...baseModelRow({ modelId: "future.model" }),
        meta: { ...baseModelRow().meta, schemaVersion: 999 },
      };
      mockDdb.on(QueryCommand).resolves({
        Items: [storedRow(), futureVersionRow],
      });

      const result = await store.getAgentModels();

      // The schema-version-999 row is dropped; the valid row survives.
      expect(result).toHaveLength(1);
      expect(result[0]!.modelId).toBe(MODEL_ID);
    });
  });

  describe("getAgentModelsPaginated()", () => {
    test("uses the persisted agent-model key as the pagination cursor", async () => {
      mockDdb.on(QueryCommand).resolves({ Items: [] });
      const lastKey = { section: AGENT_MODELS_SECTION, sk: SK };
      const pageIdentifier = Buffer.from(
        JSON.stringify(lastKey),
        "utf8",
      ).toString("base64url");

      await store.getAgentModelsPaginated({ pageIdentifier });

      const input = mockDdb.commandCalls(QueryCommand)[0]!.args[0].input;
      expect(input.ExclusiveStartKey).toEqual(lastKey);
    });

    test.each([
      ["another section", { section: "leases", sk: SK }],
      [
        "a non-model sort key",
        { section: AGENT_MODELS_SECTION, sk: "current" },
      ],
      [
        "an empty model ID",
        { section: AGENT_MODELS_SECTION, sk: AGENT_MODEL_SK_PREFIX },
      ],
    ])("rejects a cursor for %s", async (_description, lastKey) => {
      const pageIdentifier = Buffer.from(
        JSON.stringify(lastKey),
        "utf8",
      ).toString("base64url");

      await expect(
        store.getAgentModelsPaginated({ pageIdentifier }),
      ).rejects.toThrow();
      expect(mockDdb.commandCalls(QueryCommand)).toHaveLength(0);
    });
  });

  describe("putModelRow()", () => {
    const createInput = {
      modelId: MODEL_ID,
      displayName: "Claude Sonnet 4.6",
      provider: "Anthropic",
      availability: "global",
      description: "A capable model.",
      enabled: false,
    };

    test("sends PutCommand with attribute_not_exists condition", async () => {
      mockDdb.on(PutCommand).resolves({});

      await store.putModelRow(createInput, "admin@example.com");

      const calls = mockDdb.commandCalls(PutCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.ConditionExpression).toBe(
        "attribute_not_exists(#section) AND attribute_not_exists(#sk)",
      );
      expect(input.Item!.section).toBe(AGENT_MODELS_SECTION);
      expect(input.Item!.sk).toBe(SK);
    });

    test("sets addedAt, lastSavedBy, and meta server-side", async () => {
      mockDdb.on(PutCommand).resolves({});

      await store.putModelRow(createInput, "admin@example.com");

      const item = mockDdb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
      expect(item.addedAt).toBe(NOW);
      expect(item.lastSavedBy).toBe("admin@example.com");
      expect(item.meta).toEqual({
        createdTime: NOW,
        lastEditTime: NOW,
        schemaVersion: AgentModelCatalogSchemaVersion,
      });
    });

    test("new model arrives disabled by default", async () => {
      mockDdb.on(PutCommand).resolves({});

      // Omit `enabled` — schema default of false should apply
      const { enabled: _enabled, ...inputWithoutEnabled } = createInput;
      // Cast needed because enabled has a default — the type still shows it required
      // but the schema accepts undefined and coerces to false
      await store.putModelRow(
        inputWithoutEnabled as Parameters<typeof store.putModelRow>[0],
        "admin@example.com",
      );

      const item = mockDdb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
      expect(item.enabled).toBe(false);
    });

    test("returns the parsed row", async () => {
      mockDdb.on(PutCommand).resolves({});

      const result = await store.putModelRow(createInput, "admin@example.com");

      expect(result.modelId).toBe(MODEL_ID);
      expect(result.lastSavedBy).toBe("admin@example.com");
      expect(result.meta.schemaVersion).toBe(AgentModelCatalogSchemaVersion);
    });

    test("throws ConflictError when row already exists", async () => {
      mockDdb.on(PutCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(
        store.putModelRow(createInput, "admin@example.com"),
      ).rejects.toBeInstanceOf(ConflictError);
    });

    test("validates editedBy — rejects non-email non-system string", async () => {
      await expect(
        store.putModelRow(createInput, "not-valid" as never),
      ).rejects.toThrow();
      expect(mockDdb.commandCalls(PutCommand)).toHaveLength(0);
    });

    test("accepts a system: sentinel as addedBy", async () => {
      mockDdb.on(PutCommand).resolves({});

      const result = await store.putModelRow(createInput, "system:migration");

      expect(result.lastSavedBy).toBe("system:migration");
    });

    test("writes no pricing fields", async () => {
      mockDdb.on(PutCommand).resolves({});
      await store.putModelRow(createInput, "admin@example.com");
      const item = mockDdb.commandCalls(PutCommand)[0]!.args[0].input.Item!;
      expect(
        Object.keys(item).filter((key) => /price|pricing/i.test(key)),
      ).toEqual([]);
    });
  });

  describe("updateModelAdminFields()", () => {
    test("sends UpdateCommand with OCC condition on meta.lastEditTime", async () => {
      mockDdb
        .on(UpdateCommand)
        .resolves({ Attributes: storedRow({ enabled: true }) });

      await store.updateModelAdminFields(
        MODEL_ID,
        { enabled: true },
        "admin@example.com",
        NOW,
      );

      const calls = mockDdb.commandCalls(UpdateCommand);
      expect(calls).toHaveLength(1);
      const input = calls[0]!.args[0].input;
      expect(input.Key).toEqual({ section: AGENT_MODELS_SECTION, sk: SK });
      expect(input.ConditionExpression).toBe("#meta.#lastEditTime = :expected");
      expect(input.ExpressionAttributeValues![":expected"]).toBe(NOW);
      expect(input.ReturnValues).toBe("ALL_NEW");
    });

    test("writes enabled, lastSavedBy, and bumps meta.lastEditTime", async () => {
      const LATER = "2026-09-10T13:00:00.000Z";
      vi.setSystemTime(new Date(LATER));
      mockDdb
        .on(UpdateCommand)
        .resolves({ Attributes: storedRow({ enabled: true }) });

      await store.updateModelAdminFields(
        MODEL_ID,
        { enabled: true },
        "admin@example.com",
        NOW,
      );

      const values =
        mockDdb.commandCalls(UpdateCommand)[0]!.args[0].input
          .ExpressionAttributeValues!;
      expect(values[":enabled"]).toBe(true);
      expect(values[":lastSavedBy"]).toBe("admin@example.com");
      expect(values[":now"]).toBe(LATER);
    });

    test("never writes pricing fields or catalog-identity fields", async () => {
      mockDdb
        .on(UpdateCommand)
        .resolves({ Attributes: storedRow({ enabled: true }) });

      await store.updateModelAdminFields(
        MODEL_ID,
        { enabled: true },
        "admin@example.com",
        NOW,
      );

      const input = mockDdb.commandCalls(UpdateCommand)[0]!.args[0].input;
      const expr = input.UpdateExpression ?? "";
      // Pricing and identity fields must not appear in the expression
      for (const field of [
        "inputPricePer1KTokens",
        "outputPricePer1KTokens",
        "pricingSource",
        "modelId",
        "displayName",
      ]) {
        expect(expr).not.toContain(field);
        expect(Object.keys(input.ExpressionAttributeNames ?? {})).not.toContain(
          `#${field}`,
        );
      }
    });

    test("returns the parsed updated row", async () => {
      mockDdb
        .on(UpdateCommand)
        .resolves({ Attributes: storedRow({ enabled: true }) });

      const result = await store.updateModelAdminFields(
        MODEL_ID,
        { enabled: true },
        "admin@example.com",
        NOW,
      );

      expect(result.enabled).toBe(true);
      expect(result.modelId).toBe(MODEL_ID);
    });

    test("throws ConflictError on stale lastEditTime", async () => {
      mockDdb.on(UpdateCommand).rejects(
        new ConditionalCheckFailedException({
          message: "The conditional request failed",
          $metadata: {},
        }),
      );

      await expect(
        store.updateModelAdminFields(
          MODEL_ID,
          { enabled: true },
          "admin@example.com",
          "2026-01-01T00:00:00.000Z", // stale
        ),
      ).rejects.toBeInstanceOf(ConflictError);
    });
  });
});

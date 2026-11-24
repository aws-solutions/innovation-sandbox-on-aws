// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  GetSandboxSpacesUsageCommand,
  ListAgentHistoryCommand,
  ListAgentModelCatalogCommand,
  ListAgentModelsCommand,
  PutAgentModelCatalogEntryCommand,
} from "@amzn/innovation-sandbox-api-client";
import { SmithySandboxAgentClient } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/smithy-client";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";

function createMockClient(
  handler: (command: unknown) => Promise<unknown> = vi
    .fn()
    .mockResolvedValue({}),
) {
  return { send: vi.fn(handler) };
}

// Build a minimal SmithyServiceError (4xx) that normalizeSmithyError will
// convert into an ApiError.
function makeSmithyError(statusCode: number, message = "Service error") {
  const err = new Error(message) as Error & {
    $metadata?: { httpStatusCode: number };
    data?: unknown;
  };
  err.$metadata = { httpStatusCode: statusCode };
  err.data = { errors: [{ message }] };
  return err;
}

describe("SmithySandboxAgentClient.listHistory", () => {
  it("sends ListAgentHistoryCommand and maps the response", async () => {
    const rawResponse = {
      data: {
        leaseUuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        messages: [
          {
            messageId: "event-1:0",
            role: "user",
            content: "hello",
            createdAt: new Date("2026-09-10T00:00:00.000Z"),
          },
        ],
      },
    };

    const client = createMockClient(vi.fn().mockResolvedValue(rawResponse));
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.listHistory("lease-1", "next-token", 10);

    expect(client.send).toHaveBeenCalledWith(
      expect.any(ListAgentHistoryCommand),
    );
    expect(result.messages[0]?.messageId).toBe("event-1:0");
    expect(result.messages[0]?.role).toBe("user");
    expect(result.messages[0]?.content).toBe("hello");
    expect(typeof result.messages[0]?.createdAt).toBe("string");
  });

  it("rejects a history message without a messageId", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({
        data: {
          messages: [
            {
              role: "user",
              content: "hello",
              createdAt: new Date("2026-09-10T00:00:00.000Z"),
            },
          ],
        },
      }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listHistory("lease-1")).rejects.toThrow();
  });

  it("throws when output.data is missing", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({}));
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listHistory("lease-1")).rejects.toThrow(
      "History response did not contain data",
    );
  });

  it("normalizes a 4xx Smithy error", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(403, "Forbidden")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listHistory("lease-1")).rejects.toMatchObject({
      message: expect.stringContaining("Forbidden"),
    });
  });
});

describe("SmithySandboxAgentClient.getSandboxSpacesUsage", () => {
  it("sends GetSandboxSpacesUsageCommand for the lease and returns the spend rows", async () => {
    const spendByUsers = [
      { userId: "user-a", sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
      { userId: "user-b", sandboxSpacesEstimatedTokenCostAccrued: 0 },
    ];
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { spendByUsers } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.getSandboxSpacesUsage("lease-1");

    expect(client.send).toHaveBeenCalledWith(
      expect.any(GetSandboxSpacesUsageCommand),
    );
    expect(client.send.mock.calls[0]![0]).toMatchObject({
      input: { leaseId: "lease-1" },
    });
    expect(result).toEqual({ spendByUsers });
  });

  it("throws when output.data is missing", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({}));
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.getSandboxSpacesUsage("lease-1")).rejects.toThrow(
      "Usage response did not contain data",
    );
  });

  it("rejects a malformed user spend row", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({
        data: {
          spendByUsers: [
            {
              userId: "user-a",
              sandboxSpacesEstimatedTokenCostAccrued: undefined,
            },
          ],
        },
      }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.getSandboxSpacesUsage("lease-1")).rejects.toThrow();
  });

  it("normalizes a 4xx Smithy error to an ApiError", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(403, "Forbidden")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const error = await sut
      .getSandboxSpacesUsage("lease-1")
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 403,
      message: expect.stringContaining("Forbidden"),
    });
  });
});

describe("SmithySandboxAgentClient.listModels", () => {
  it("sends ListAgentModelsCommand and returns the models array", async () => {
    const models = [
      { modelId: "amazon.nova-lite-v1:0", displayName: "Nova Lite" },
    ];
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.listModels();

    expect(client.send).toHaveBeenCalledWith(
      expect.any(ListAgentModelsCommand),
    );
    expect(result).toEqual(models);
  });

  it("filters out models with no modelId", async () => {
    const models = [
      { modelId: "amazon.nova-lite-v1:0", displayName: "Nova Lite" },
      { modelId: undefined, displayName: "Ghost Model" },
      { modelId: "other-model", displayName: "Other" },
    ];
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.listModels();

    expect(result.map((m) => m.modelId)).toEqual([
      "amazon.nova-lite-v1:0",
      "other-model",
    ]);
  });

  it("fills displayName with modelId when displayName is missing", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models: [{ modelId: "m1" }] } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const [model] = await sut.listModels();
    expect(model?.displayName).toBe("m1");
  });

  it("returns an empty array when models is undefined", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({ data: {} }));
    const sut = new SmithySandboxAgentClient(client as any);

    expect(await sut.listModels()).toEqual([]);
  });

  it("throws when output.data is missing", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({}));
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listModels()).rejects.toThrow(
      "ListAgentModels response did not contain data",
    );
  });

  it("normalizes a 4xx Smithy error", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(400, "Bad request")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listModels()).rejects.toMatchObject({
      message: expect.stringContaining("Bad request"),
    });
  });
});

const discoveryRow = {
  modelId: "us.amazon.nova-pro-v1",
  displayName: "Nova Pro",
  provider: "Amazon",
  availability: "us-east-1",
  description: "Amazon Nova Pro",
  modelType: "inference-profile",
  pricingSource: "price-list",
  pricingRefreshedAt: new Date("2026-09-10T00:00:00.000Z"),
  inputPricePer1KTokens: 0.0008,
  outputPricePer1KTokens: 0.0032,
  cacheReadPricePer1KTokens: 0.0002,
  cacheWritePricePer1KTokens: 0.001,
};

// A persisted catalog row carries no `modelType`; it adds the enabled flag,
// audit fields, and the OCC envelope.
const catalogRow = {
  modelId: "us.amazon.nova-pro-v1",
  displayName: "Nova Pro",
  provider: "Amazon",
  availability: "us-east-1",
  pricingSource: "price-list",
  pricingRefreshedAt: "2026-09-10T00:00:00.000Z",
  inputPricePer1KTokens: 0.0008,
  enabled: false,
  addedAt: "2026-09-01T00:00:00.000Z",
  lastSavedBy: "admin@example.com",
  meta: {
    createdTime: "2026-09-01T00:00:00.000Z",
    lastEditTime: "2026-09-01T12:00:00.000Z",
  },
};

const upsertInput = {
  modelId: catalogRow.modelId,
  enabled: true,
};

describe("SmithySandboxAgentClient.discoverModels", () => {
  it("sends ListAgentModelsCommand and normalizes the pricing timestamp to an ISO string", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models: [discoveryRow] } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.discoverModels();

    expect(client.send).toHaveBeenCalledWith(
      expect.any(ListAgentModelsCommand),
    );
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      modelId: "us.amazon.nova-pro-v1",
      modelType: "inference-profile",
      pricingRefreshedAt: "2026-09-10T00:00:00.000Z",
      inputPricePer1KTokens: 0.0008,
    });
  });

  it("returns an empty array when models is undefined", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({ data: {} }));
    const sut = new SmithySandboxAgentClient(client as any);

    expect(await sut.discoverModels()).toEqual([]);
  });

  it("drops discovery rows missing modelType, which could never be created", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({
        data: {
          models: [discoveryRow, { ...discoveryRow, modelType: undefined }],
        },
      }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.discoverModels();

    expect(result).toHaveLength(1);
    expect(result[0]!.modelType).toBe(discoveryRow.modelType);
  });

  it("normalizes a 4xx Smithy error", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(403, "Forbidden")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.discoverModels()).rejects.toMatchObject({
      message: expect.stringContaining("Forbidden"),
    });
  });
});

describe("SmithySandboxAgentClient.listCatalog", () => {
  it("sends ListAgentModelCatalogCommand and maps the catalog rows", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models: [catalogRow] } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.listCatalog();

    expect(client.send).toHaveBeenCalledWith(
      expect.any(ListAgentModelCatalogCommand),
    );
    expect(result).toEqual([catalogRow]);
  });

  it("follows nextToken until absent to page the full catalog", async () => {
    const secondRow = {
      ...catalogRow,
      modelId: "global.anthropic.claude-sonnet-4-6",
      displayName: "Claude Sonnet 4.6",
    };
    const client = createMockClient(
      vi
        .fn()
        .mockResolvedValueOnce({
          data: { models: [catalogRow], nextToken: "page-2" },
        })
        .mockResolvedValueOnce({ data: { models: [secondRow] } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.listCatalog();

    expect(client.send).toHaveBeenCalledTimes(2);
    expect(client.send.mock.calls[1]![0]).toMatchObject({
      input: { nextToken: "page-2" },
    });
    expect(result.map((model) => model.modelId)).toEqual([
      "us.amazon.nova-pro-v1",
      "global.anthropic.claude-sonnet-4-6",
    ]);
  });

  it("drops catalog rows missing the OCC token", async () => {
    const { meta: _meta, ...rowWithoutMeta } = catalogRow;
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { models: [rowWithoutMeta] } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    expect(await sut.listCatalog()).toEqual([]);
  });

  it("returns an empty array when models is undefined", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({ data: {} }));
    const sut = new SmithySandboxAgentClient(client as any);

    expect(await sut.listCatalog()).toEqual([]);
  });

  it("normalizes a 4xx Smithy error", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(404, "Not found")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.listCatalog()).rejects.toMatchObject({
      message: expect.stringContaining("Not found"),
    });
  });
});

describe("SmithySandboxAgentClient.putCatalogEntry", () => {
  it("sends a create upsert without expectedLastEditTime and returns the entry", async () => {
    const saved = { ...catalogRow, enabled: true };
    const client = createMockClient(vi.fn().mockResolvedValue({ data: saved }));
    const sut = new SmithySandboxAgentClient(client as any);

    const result = await sut.putCatalogEntry(upsertInput);

    expect(client.send).toHaveBeenCalledWith(
      expect.any(PutAgentModelCatalogEntryCommand),
    );
    const command = client.send.mock.calls[0]![0] as { input: object };
    expect(command.input).toEqual(upsertInput);
    expect(command.input).not.toHaveProperty("expectedLastEditTime");
    expect(result).toEqual(saved);
  });

  it("sends a toggle upsert with the OCC token", async () => {
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: { ...catalogRow, enabled: true } }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await sut.putCatalogEntry({
      ...upsertInput,
      expectedLastEditTime: "2026-09-01T12:00:00.000Z",
    });

    expect(client.send.mock.calls[0]![0]).toMatchObject({
      input: { expectedLastEditTime: "2026-09-01T12:00:00.000Z" },
    });
  });

  it("throws when output.data is missing", async () => {
    const client = createMockClient(vi.fn().mockResolvedValue({}));
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.putCatalogEntry(upsertInput)).rejects.toThrow(
      "Catalog entry response did not contain data",
    );
  });

  it("throws when the response is missing the OCC envelope", async () => {
    const { meta: _meta, ...rowWithoutMeta } = catalogRow;
    const client = createMockClient(
      vi.fn().mockResolvedValue({ data: rowWithoutMeta }),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    await expect(sut.putCatalogEntry(upsertInput)).rejects.toThrow(
      "Catalog entry response was missing required fields",
    );
  });

  it("normalizes a 409 conflict to an ApiError", async () => {
    const client = createMockClient(
      vi.fn().mockRejectedValue(makeSmithyError(409, "Conflict")),
    );
    const sut = new SmithySandboxAgentClient(client as any);

    const error = await sut
      .putCatalogEntry({ ...upsertInput, expectedLastEditTime: "stale" })
      .catch((cause: unknown) => cause);

    expect(error).toBeInstanceOf(ApiError);
    expect(error).toMatchObject({
      statusCode: 409,
      message: expect.stringContaining("Conflict"),
    });
  });
});

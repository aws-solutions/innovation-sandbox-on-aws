// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it, vi } from "vitest";

import {
  getSandboxAgentService,
  SandboxAgentService,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/service";
import { SmithySandboxAgentApi } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/smithy-client";
import { AgentHistoryResponse } from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

const createMockApi = (): SmithySandboxAgentApi => ({
  listHistory: vi.fn(),
  getSandboxSpacesUsage: vi.fn(),
  listModels: vi.fn(),
  discoverModels: vi.fn(),
  listCatalog: vi.fn(),
  putCatalogEntry: vi.fn(),
});

describe("SandboxAgentService", () => {
  describe("listHistory", () => {
    it("passes leaseId through to the Smithy client on the User path", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      const response: AgentHistoryResponse = {
        leaseUuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        messages: [
          {
            messageId: "event-1:0",
            role: "user",
            content: "hello",
            createdAt: "2026-09-09T00:00:00.000Z",
          },
        ],
      };
      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        response,
      );

      const result = await service.listHistory(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
      );

      expect(mockApi.listHistory).toHaveBeenCalledWith(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        undefined,
        undefined,
      );
      expect(result).toEqual(response);
    });

    it("passes undefined leaseId through on the Admin path", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      const response: AgentHistoryResponse = { messages: [] };
      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        response,
      );

      const result = await service.listHistory(undefined);

      expect(mockApi.listHistory).toHaveBeenCalledWith(
        undefined,
        undefined,
        undefined,
      );
      expect(result).toEqual(response);
    });

    it("passes nextToken through alongside leaseId", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
      });

      await service.listHistory(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "page-2-token",
      );

      expect(mockApi.listHistory).toHaveBeenCalledWith(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "page-2-token",
        undefined,
      );
    });

    it("passes maxResults after nextToken", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
      });

      await service.listHistory(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "page-2-token",
        25,
      );

      expect(mockApi.listHistory).toHaveBeenCalledWith(
        "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        "page-2-token",
        25,
      );
    });

    it("passes nextToken through without leaseId on the Admin path", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
        messages: [],
      });

      await service.listHistory(undefined, "page-2-token");

      expect(mockApi.listHistory).toHaveBeenCalledWith(
        undefined,
        "page-2-token",
        undefined,
      );
    });

    it("propagates errors from the API layer", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      (mockApi.listHistory as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(
        service.listHistory("6ba7b810-9dad-11d1-80b4-00c04fd430c8"),
      ).rejects.toThrow("Network error");
    });
  });

  describe("getUsage", () => {
    it("passes leaseId through and returns the usage view", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);
      const usage = {
        spendByUsers: [
          { userId: "user-a", sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
        ],
      };
      (
        mockApi.getSandboxSpacesUsage as ReturnType<typeof vi.fn>
      ).mockResolvedValueOnce(usage);

      const result = await service.getUsage("lease-1");

      expect(mockApi.getSandboxSpacesUsage).toHaveBeenCalledWith("lease-1");
      expect(result).toEqual(usage);
    });
  });

  describe("listModels", () => {
    it("returns the enabled model catalog from the Smithy client", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      const models = [
        {
          modelId: "global.anthropic.claude-sonnet-4-6",
          displayName: "Claude Sonnet 4.6",
          provider: "Anthropic",
          availability: "global",
        },
      ];
      (mockApi.listModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
        models,
      );

      const result = await service.listModels();

      expect(mockApi.listModels).toHaveBeenCalledOnce();
      expect(result).toEqual(models);
    });

    it("propagates errors from the API layer", async () => {
      const mockApi = createMockApi();
      const service = new SandboxAgentService(mockApi);

      (mockApi.listModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
        new Error("Network error"),
      );

      await expect(service.listModels()).rejects.toThrow("Network error");
    });
  });
});

describe("discoverModels", () => {
  it("returns the array from the API layer", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    const models = [
      {
        modelId: "amazon.nova-lite-v1:0",
        displayName: "Amazon Nova Lite",
        provider: "Amazon",
      },
    ];
    (mockApi.discoverModels as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      models,
    );

    const result = await service.discoverModels();

    expect(mockApi.discoverModels).toHaveBeenCalledOnce();
    expect(result).toEqual(models);
  });

  it("propagates errors from the API layer", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    (mockApi.discoverModels as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Network error"),
    );

    await expect(service.discoverModels()).rejects.toThrow("Network error");
  });
});

describe("listCatalog", () => {
  it("returns catalog entries from the API layer", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    const entries = [
      {
        modelId: "amazon.nova-lite-v1:0",
        enabled: true,
        addedAt: "2026-09-01T00:00:00.000Z",
      },
    ];
    (mockApi.listCatalog as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      entries,
    );

    const result = await service.listCatalog();

    expect(mockApi.listCatalog).toHaveBeenCalledOnce();
    expect(result).toEqual(entries);
  });

  it("propagates errors from the API layer", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    (mockApi.listCatalog as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Not found"),
    );

    await expect(service.listCatalog()).rejects.toThrow("Not found");
  });
});

describe("putCatalogEntry", () => {
  it("passes input through and returns the upserted entry", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    const input = {
      modelId: "amazon.nova-lite-v1:0",
      enabled: true,
    };
    const entry = {
      ...input,
      displayName: "Nova Lite",
      provider: "Amazon",
      availability: "global",
      addedAt: "2026-09-01T00:00:00.000Z",
    };
    (mockApi.putCatalogEntry as ReturnType<typeof vi.fn>).mockResolvedValueOnce(
      entry,
    );

    const result = await service.putCatalogEntry(input);

    expect(mockApi.putCatalogEntry).toHaveBeenCalledWith(input);
    expect(result).toEqual(entry);
  });

  it("propagates errors from the API layer", async () => {
    const mockApi = createMockApi();
    const service = new SandboxAgentService(mockApi);

    (mockApi.putCatalogEntry as ReturnType<typeof vi.fn>).mockRejectedValueOnce(
      new Error("Conflict"),
    );

    await expect(
      service.putCatalogEntry({
        modelId: "x",
        enabled: true,
      }),
    ).rejects.toThrow("Conflict");
  });
});

describe("getSandboxAgentService singleton", () => {
  it("returns the same instance on repeated calls", () => {
    const a = getSandboxAgentService();
    const b = getSandboxAgentService();
    expect(a).toBe(b);
  });

  it("creates a fresh instance after resetApiSingletons", async () => {
    const { resetApiSingletons } =
      await import("@amzn/innovation-sandbox-frontend/helpers/apiSingletons");
    const first = getSandboxAgentService();
    resetApiSingletons();
    const second = getSandboxAgentService();
    expect(second).not.toBe(first);
  });
});

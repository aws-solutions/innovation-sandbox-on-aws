// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Do NOT import from the global mock — we need the real implementation.
// vi.mock in setupTests.tsx mocks this module globally, so we unmock it here.
vi.unmock("@amzn/innovation-sandbox-frontend/helpers/config");

const mockConfigJson = {
  CognitoUserPoolId: "us-east-1_TestPool",
  CognitoAppClientId: "test-client-id",
  CognitoIdentityPoolId: "us-east-1:00000000-0000-0000-0000-000000000000",
  CognitoDomain: "test-isb",
  Region: "us-east-1",
  AwsAccessPortalUrl: "https://test.awsapps.com/start",
  ApiGatewayHost: "test1234.execute-api.us-east-1.amazonaws.com",
  ApiGatewayStage: "prod",
  SandboxAgentWebSocketUrl:
    "wss://test5678.execute-api.us-east-1.amazonaws.com/prod",
  SandboxAgentMcpGatewayUrl:
    "https://test5678.gateway.bedrock-agentcore.us-east-1.amazonaws.com/mcp",
};

describe("config", () => {
  beforeEach(async () => {
    vi.restoreAllMocks();
    // Reset the module to clear the cached config between tests
    vi.resetModules();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  describe("loadConfig", () => {
    it("fetches /config.json and caches the result", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfigJson),
      });

      const { loadConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      const config = await loadConfig();

      expect(fetch).toHaveBeenCalledWith("/config.json", {
        cache: "no-store",
      });
      expect(config.CognitoUserPoolId).toBe("us-east-1_TestPool");
      expect(config.CognitoAppClientId).toBe("test-client-id");
      expect(config.AwsAccessPortalUrl).toBe("https://test.awsapps.com/start");
    });

    it("uses window.location.origin/api when VITE_API_URL is unset", async () => {
      vi.stubEnv("VITE_API_URL", undefined);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfigJson),
      });

      const { loadConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      const config = await loadConfig();

      expect(config.ApiUrl).toBe(`${window.location.origin}/api`);
    });

    it("uses VITE_API_URL when it is set", async () => {
      vi.stubEnv("VITE_API_URL", "https://example.test/api");
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfigJson),
      });

      const { loadConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      const config = await loadConfig();

      expect(config.ApiUrl).toBe("https://example.test/api");
    });

    it("returns cached config on subsequent calls", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfigJson),
      });

      const { loadConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      const first = await loadConfig();
      const second = await loadConfig();

      expect(first).toBe(second);
      expect(fetch).toHaveBeenCalledTimes(1);
    });

    it("throws when fetch fails", async () => {
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: false,
        status: 404,
      });

      const { loadConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      await expect(loadConfig()).rejects.toThrow(
        "Failed to load config.json: 404",
      );
    });
  });

  describe("getConfig", () => {
    it("throws when loadConfig has not been called", async () => {
      const { getConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      expect(() => getConfig()).toThrow(
        "Config not loaded. Call loadConfig() before accessing config.",
      );
    });

    it("returns cached config after loadConfig", async () => {
      vi.stubEnv("VITE_API_URL", undefined);
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockConfigJson),
      });

      const { loadConfig, getConfig } =
        await import("@amzn/innovation-sandbox-frontend/helpers/config");

      await loadConfig();
      const config = getConfig();

      expect(config.CognitoUserPoolId).toBe("us-east-1_TestPool");
      expect(config.ApiUrl).toBe(`${window.location.origin}/api`);
    });
  });
});

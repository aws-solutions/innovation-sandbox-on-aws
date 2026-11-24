// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// Mocks for the modules `main.tsx` consumes at import time. Each test
// resets the registry with `vi.resetModules()` before re-importing
// `main.tsx`, so application initialization runs fresh per case with
// the mocks below.
const loadConfig = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/helpers/config", () => ({
  loadConfig: (...args: unknown[]) => loadConfig(...args),
  getConfig: vi.fn(),
}));

const configureAmplifyAuth = vi.fn();
vi.mock("@amzn/innovation-sandbox-frontend/helpers/cognito-config", () => ({
  configureAmplifyAuth: (...args: unknown[]) => configureAmplifyAuth(...args),
}));

const reactRender = vi.fn();
vi.mock("react-dom/client", () => ({
  default: { createRoot: vi.fn(() => ({ render: reactRender })) },
  createRoot: vi.fn(() => ({ render: reactRender })),
}));

vi.mock("@amzn/innovation-sandbox-frontend/App", () => ({
  App: () => null,
}));

const completeConfig = {
  ApiUrl: "http://localhost/api",
  CognitoUserPoolId: "us-east-1_TestPool",
  CognitoAppClientId: "test-client-id",
  CognitoIdentityPoolId: "us-east-1:00000000-0000-0000-0000-000000000000",
  CognitoDomain: "test-isb",
  Region: "us-east-1",
  AwsAccessPortalUrl: "https://test.awsapps.com/start",
  ApiGatewayHost: "test1234.execute-api.us-east-1.amazonaws.com",
  ApiGatewayStage: "prod",
};

async function importMain(): Promise<void> {
  vi.resetModules();
  await import("@amzn/innovation-sandbox-frontend/main");
}

describe("main entry point", () => {
  let rootEl: HTMLDivElement;

  beforeEach(() => {
    rootEl = document.createElement("div");
    rootEl.id = "root";
    document.body.appendChild(rootEl);
  });

  afterEach(() => {
    rootEl.remove();
    vi.clearAllMocks();
  });

  it("configures Amplify and renders the app when config is complete", async () => {
    loadConfig.mockResolvedValue(completeConfig);

    await importMain();

    expect(configureAmplifyAuth).toHaveBeenCalledWith({
      userPoolId: completeConfig.CognitoUserPoolId,
      appClientId: completeConfig.CognitoAppClientId,
      identityPoolId: completeConfig.CognitoIdentityPoolId,
      domain: completeConfig.CognitoDomain,
      region: completeConfig.Region,
      awsAccessPortalUrl: completeConfig.AwsAccessPortalUrl,
    });
    expect(reactRender).toHaveBeenCalledTimes(1);
  });

  it("renders an admin-contact message and skips Amplify when config is incomplete", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig.mockResolvedValue({ ...completeConfig, Region: "" });

    await importMain();

    expect(configureAmplifyAuth).not.toHaveBeenCalled();
    expect(reactRender).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Incomplete Cognito configuration"),
    );
    expect(rootEl.textContent).toBe(
      "Authentication is not configured. Please contact your administrator.",
    );
    consoleSpy.mockRestore();
  });

  it("renders a load-failed message when loadConfig rejects", async () => {
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    loadConfig.mockRejectedValue(new Error("network down"));

    await importMain();

    expect(configureAmplifyAuth).not.toHaveBeenCalled();
    expect(reactRender).not.toHaveBeenCalled();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to initialize application",
      expect.any(Error),
    );
    expect(rootEl.textContent).toBe(
      "Application failed to load. Please refresh the page or contact your administrator.",
    );
    consoleSpy.mockRestore();
  });

  it("logs but does not crash when the root element is missing", async () => {
    // Cover the falsy `if (root)` branch on both error paths — incomplete
    // config and loadConfig rejection — without actually crashing the
    // module.
    rootEl.remove();
    const consoleSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    loadConfig.mockResolvedValueOnce({ ...completeConfig, Region: "" });
    await importMain();
    expect(consoleSpy).toHaveBeenCalledWith(
      expect.stringContaining("Incomplete Cognito configuration"),
    );

    consoleSpy.mockClear();
    loadConfig.mockRejectedValueOnce(new Error("network down"));
    await importMain();
    expect(consoleSpy).toHaveBeenCalledWith(
      "Failed to initialize application",
      expect.any(Error),
    );

    consoleSpy.mockRestore();
  });
});

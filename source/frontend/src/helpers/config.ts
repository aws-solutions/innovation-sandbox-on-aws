// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

export type ConfigData = {
  ApiUrl: string;
  CognitoUserPoolId: string;
  CognitoAppClientId: string;
  CognitoIdentityPoolId: string;
  CognitoDomain: string;
  Region: string;
  AwsAccessPortalUrl: string;
  ApiGatewayHost: string;
  ApiGatewayStage: string;
  SandboxAgentWebSocketUrl: string;
  SandboxAgentMcpGatewayUrl: string;
};

let cachedConfig: ConfigData | undefined;

/**
 * Fetches /config.json at runtime and caches the result. Must be called
 * once during app initialization (in main.tsx) before any component renders.
 */
export async function loadConfig(): Promise<ConfigData> {
  if (cachedConfig) {
    return cachedConfig;
  }

  const response = await fetch("/config.json", { cache: "no-store" });
  if (!response.ok) {
    throw new Error(`Failed to load config.json: ${response.status}`);
  }

  const data = (await response.json()) as ConfigData;
  cachedConfig = {
    ...data,
    ApiUrl: import.meta.env.VITE_API_URL ?? `${globalThis.location.origin}/api`,
  };

  return cachedConfig;
}

/** Returns the cached config synchronously. Throws if loadConfig() hasn't been called. */
export function getConfig(): ConfigData {
  if (!cachedConfig) {
    throw new Error(
      "Config not loaded. Call loadConfig() before accessing config.",
    );
  }
  return cachedConfig;
}

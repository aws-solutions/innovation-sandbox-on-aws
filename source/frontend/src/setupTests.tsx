// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import React, { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

import { resetApiSingletons } from "@amzn/innovation-sandbox-frontend/helpers/apiSingletons";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";

// Create a single QueryClient instance
const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: false,
    },
  },
});

beforeAll(() => server.listen());
afterEach(() => {
  cleanup();
  server.resetHandlers();
  queryClient.clear();
  // Drop memoized API service/client singletons so state (and any memoized
  // credentials) never leak across tests — mirrors the logout/user-change reset.
  resetApiSingletons();
});
afterAll(() => server.close());

export const createQueryClientWrapper = () => {
  // eslint-disable-next-line react/display-name
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
  );
};

export function renderWithQueryClient(ui: React.ReactElement, options = {}) {
  return render(
    <QueryClientProvider client={queryClient}>{ui}</QueryClientProvider>,
    options,
  );
}

// Mock the runtime config module so that getConfig() works
// without calling loadConfig() (which fetches /config.json at runtime).
vi.mock("@amzn/innovation-sandbox-frontend/helpers/config", () => {
  const testConfig = {
    ApiUrl: "http://localhost/api",
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
  return {
    loadConfig: vi.fn().mockResolvedValue(testConfig),
    getConfig: vi.fn().mockReturnValue(testConfig),
  };
});

// Mock Amplify auth modules used by CognitoAuthService
vi.mock("aws-amplify/auth", async () => {
  const { MOCK_ID_TOKEN, mockCognitoCredentials } =
    await import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures");
  return {
    fetchAuthSession: vi.fn().mockResolvedValue({
      tokens: {
        idToken: { toString: () => MOCK_ID_TOKEN, payload: {} },
      },
      credentials: mockCognitoCredentials,
    }),
    signInWithRedirect: vi.fn(),
    signOut: vi.fn(),
  };
});

vi.mock("aws-amplify/utils", () => ({
  Hub: {
    listen: vi.fn(() => vi.fn()),
  },
}));

// Mock the AppLayoutContext hook
vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext",
  () => ({
    useAppLayoutContext: vi.fn(() => ({
      setTools: vi.fn(),
      setToolsOpen: vi.fn(),
    })),
    AppLayoutProvider: ({ children }: { children: React.ReactNode }) =>
      children,
  }),
);

// Mocking matchMedia for future use cases
Object.defineProperty(globalThis.window, "matchMedia", {
  writable: true,
  value: (query: any) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: vi.fn(),
    removeListener: vi.fn(),
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
    dispatchEvent: vi.fn(),
  }),
});

// Mocking window.scrollTo
Object.defineProperty(globalThis.window, "scrollTo", {
  writable: true,
  value: vi.fn(),
});

// Adding global mocks
// Spy on fetch without replacing it — replacing with vi.fn() would kill
// Smithy's FetchHttpHandler-based clients (CloudFrontFetchHttpHandler calls
// globalThis.fetch directly, and a no-op stub causes all queries to hang).
// MSW's setupServer already intercepts fetch in Node via @mswjs/interceptors;
// stubbing it here clobbers that before beforeAll(() => server.listen()) runs.
vi.spyOn(globalThis, "fetch");
globalThis.URL.createObjectURL = vi.fn();
vi.stubGlobal("SOLUTION_VERSION", "1.0.0-test");

// Mock sessionStorage — CognitoAuthService uses Amplify-managed storage
// (mocked via aws-amplify/auth above), not manual keys.
Object.defineProperty(globalThis.window, "sessionStorage", {
  value: {
    getItem: vi.fn().mockReturnValue(null),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    length: 0,
    key: vi.fn().mockReturnValue(null),
  },
  writable: true,
});

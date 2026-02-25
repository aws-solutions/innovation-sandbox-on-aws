// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import "@testing-library/jest-dom";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render } from "@testing-library/react";
import React, { ReactNode } from "react";
import { afterAll, afterEach, beforeAll, vi } from "vitest";

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

// Mocking the config for future use cases
vi.mock("../config", () => ({
  config: {
    ApiUrl: "MOCK_API_URL",
  },
}));

// Mock the AppLayoutContext hook
vi.mock(
  "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext",
  () => ({
    useAppLayoutContext: vi.fn(() => ({
      setTools: vi.fn(),
      setToolsOpen: vi.fn(),
      setToolsHide: vi.fn(),
    })),
    AppLayoutProvider: ({ children }: { children: React.ReactNode }) =>
      children,
  }),
);

// Mocking matchMedia for future use cases
Object.defineProperty(window, "matchMedia", {
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
Object.defineProperty(window, "scrollTo", {
  writable: true,
  value: vi.fn(),
});

// Adding global mocks
globalThis.fetch = vi.fn();
globalThis.URL.createObjectURL = vi.fn();
vi.stubGlobal("SOLUTION_VERSION", "1.0.0-test");

// Mock sessionStorage to provide access token for tests
Object.defineProperty(window, "sessionStorage", {
  value: {
    getItem: vi.fn(function (key) {
      if (key === "isb-jwt") {
        return "mock-jwt-token";
      }
      return null;
    }),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
  },
  writable: true,
});

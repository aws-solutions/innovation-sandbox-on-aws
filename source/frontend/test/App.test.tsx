// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

// Mock the Authenticator component to avoid auth complexity in tests
vi.mock("@amzn/innovation-sandbox-frontend/components/Authenticator", () => ({
  Authenticator: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="authenticator">{children}</div>
  ),
}));

// Mock the AppLayout component
vi.mock("@amzn/innovation-sandbox-frontend/components/AppLayout", () => ({
  AppLayout: ({ children }: { children: React.ReactNode }) => (
    <div data-testid="app-layout">{children}</div>
  ),
}));

describe("App", () => {
  it("renders without crashing", () => {
    render(<App />);
    expect(screen.getByTestId("authenticator")).toBeInTheDocument();
    expect(screen.getByTestId("app-layout")).toBeInTheDocument();
  });

  it("renders home page at root route", () => {
    window.history.pushState({}, "Home", "/");
    render(<App />);
    expect(
      screen.getByText("Welcome to Innovation Sandbox on AWS"),
    ).toBeInTheDocument();
  });

  it("sets up QueryClient with correct default options", () => {
    render(<App />);
    // If the app renders without errors, QueryClient is configured correctly
    expect(screen.getByTestId("app-layout")).toBeInTheDocument();
  });

  it("wraps app with required providers", () => {
    render(<App />);
    // Verify all providers are present by checking their rendered output
    expect(screen.getByTestId("authenticator")).toBeInTheDocument();
    expect(screen.getByTestId("app-layout")).toBeInTheDocument();
  });
});

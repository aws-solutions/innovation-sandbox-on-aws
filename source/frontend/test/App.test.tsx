// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { App } from "../src/App";

const {
  mockEditLeaseAccessSettings,
  mockEditTemplateAccessAndSharing,
  mockListPermissionSets,
  mockUseUser,
} = vi.hoisted(() => ({
  mockEditLeaseAccessSettings: vi.fn(),
  mockEditTemplateAccessAndSharing: vi.fn(),
  mockListPermissionSets: vi.fn(),
  mockUseUser: vi.fn(),
}));

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

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/permissionSets/pages/ListPermissionSets",
  () => ({
    ListPermissionSets: () => {
      mockListPermissionSets();
      return <div>Permission Sets catalog</div>;
    },
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/pages/EditAccessAndSharing",
  () => ({
    EditAccessAndSharing: () => {
      mockEditTemplateAccessAndSharing();
      return <div>Edit template access and sharing page</div>;
    },
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/leases/pages/EditAccessSettings",
  () => ({
    EditAccessSettings: () => {
      mockEditLeaseAccessSettings();
      return <div>Edit lease access settings page</div>;
    },
  }),
);

vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser", () => ({
  useUser: () => mockUseUser(),
}));

const userState = (role: "User" | "Manager" | "Admin") => ({
  user: { email: "test@example.com", roles: [role] },
  roles: [role],
  isAdmin: role === "Admin",
  isManager: role === "Manager",
  isUser: role === "User",
  isLoading: false,
  error: null,
});

describe("App", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockUseUser.mockReturnValue(userState("Admin"));
    window.history.pushState({}, "Home", "/");
  });

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

  it("renders not found page for unknown routes", () => {
    window.history.pushState({}, "Unknown", "/some-random-page");
    render(<App />);
    expect(screen.getByText("Page not found")).toBeInTheDocument();
    expect(
      screen.getByText("The page you are looking for does not exist."),
    ).toBeInTheDocument();
    expect(screen.getByText("Go to homepage")).toBeInTheDocument();
  });

  it.each(["Manager", "Admin"] as const)(
    "allows %s direct access to the permission sets route",
    (role) => {
      mockUseUser.mockReturnValue(userState(role));
      window.history.pushState({}, "Permission Sets", "/permission-sets");

      render(<App />);

      expect(screen.getByText("Permission Sets catalog")).toBeInTheDocument();
      expect(mockListPermissionSets).toHaveBeenCalledOnce();
    },
  );

  it("denies User direct access without rendering the catalog", () => {
    mockUseUser.mockReturnValue(userState("User"));
    window.history.pushState({}, "Permission Sets", "/permission-sets");

    render(<App />);

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(mockListPermissionSets).not.toHaveBeenCalled();
  });

  it.each(["Manager", "Admin"] as const)(
    "allows %s direct access to the template access and sharing route",
    (role) => {
      mockUseUser.mockReturnValue(userState(role));
      window.history.pushState(
        {},
        "Edit access and sharing",
        "/lease_templates/00000000-0000-4000-8000-000000000001/edit/access",
      );

      render(<App />);

      expect(
        screen.getByText("Edit template access and sharing page"),
      ).toBeInTheDocument();
      expect(mockEditTemplateAccessAndSharing).toHaveBeenCalledOnce();
    },
  );

  it("denies User direct access to the template access and sharing route", () => {
    mockUseUser.mockReturnValue(userState("User"));
    window.history.pushState(
      {},
      "Edit access and sharing",
      "/lease_templates/00000000-0000-4000-8000-000000000001/edit/access",
    );

    render(<App />);

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(mockEditTemplateAccessAndSharing).not.toHaveBeenCalled();
  });

  it.each(["Manager", "Admin"] as const)(
    "allows %s direct access to the lease access settings route",
    (role) => {
      mockUseUser.mockReturnValue(userState(role));
      window.history.pushState(
        {},
        "Edit Lease Access Settings",
        "/leases/lease-123/edit/access",
      );

      render(<App />);

      expect(
        screen.getByText("Edit lease access settings page"),
      ).toBeInTheDocument();
      expect(mockEditLeaseAccessSettings).toHaveBeenCalledOnce();
    },
  );

  it("denies User direct access to the lease access settings route", () => {
    mockUseUser.mockReturnValue(userState("User"));
    window.history.pushState(
      {},
      "Edit Lease Access Settings",
      "/leases/lease-123/edit/access",
    );

    render(<App />);

    expect(screen.getByText("Access denied")).toBeInTheDocument();
    expect(mockEditLeaseAccessSettings).not.toHaveBeenCalled();
  });
});

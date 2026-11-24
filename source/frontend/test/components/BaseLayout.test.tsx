// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import type { ComponentProps } from "react";
import { BrowserRouter as Router } from "react-router-dom";
import { beforeEach, describe, expect, test, vi } from "vitest";

import {
  BaseLayout,
  TOP_NAVIGATION_SELECTOR,
} from "@amzn/innovation-sandbox-frontend/components/AppLayout/BaseLayout";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { AdminConfigurationView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  adminConfigGetHandler,
  createAdminConfig,
} from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { server } from "@amzn/innovation-sandbox-frontend/mocks/server";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { IdcIdentity } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

// Loaded dynamically because the configured Prettier and ESLint import sorters
// disagree on ordering "@amzn/...-frontend-test" against "@amzn/...-frontend/".
const { authenticated } =
  await import("@amzn/innovation-sandbox-frontend-test/utils/cognitoFixtures");

// Builds the aggregate configuration view with maintenance toggled on or off.
const configWithMaintenance = (enabled: boolean): AdminConfigurationView => {
  const config = createAdminConfig();
  return {
    ...config,
    maintenance: { ...config.maintenance, enabled },
  };
};

// Renders a marker once the shared admin-config query resolves. The maintenance
// banner renders nothing both while the query is loading and when maintenance
// is off, so a synchronous absence check would pass against the loading render
// without ever exercising the disabled branch. Gating the assertion on this
// probe forces the query to settle first.
const ConfigSettledProbe = () => {
  const { isSuccess } = useGetConfigurations();
  return isSuccess ? <div data-testid="config-settled" /> : null;
};

const UserSettledProbe = () => {
  const { isLoading } = useUser();
  return isLoading ? null : <div data-testid="user-settled" />;
};

const userWithRoles = (roles: IdcIdentity["roles"]): IdcIdentity => ({
  type: "user",
  email: "test@example.com",
  userId: "test-user-id",
  roles,
});

// vi.mock is hoisted above every import, so the factory body cannot close over
// top-level variables; it pulls the shared mock in via dynamic import() once
// Vitest first resolves the mocked module. The helper supplies
// getCredentials/getIdToken for the SigV4 signing path in the API client; per-test
// role switching is done below via vi.mocked(CognitoAuthService.getCurrentUser).
vi.mock(
  "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService",
  async () => {
    const { buildCognitoAuthServiceMock } =
      await import("@amzn/innovation-sandbox-frontend-test/utils/cognitoServiceMock");
    return { CognitoAuthService: buildCognitoAuthServiceMock() };
  },
);

const recordToolbarProps = vi.hoisted(() => vi.fn());

// Records the props BaseLayout passes to AppLayoutToolbar while still rendering
// the real component, so navigation and content behave as in production.
vi.mock("@cloudscape-design/components", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@cloudscape-design/components")>();
  const { createElement } = await import("react");
  const RealToolbar = actual.AppLayoutToolbar;
  const AppLayoutToolbar = (props: ComponentProps<typeof RealToolbar>) => {
    recordToolbarProps(props);
    return createElement(RealToolbar, props);
  };
  return { ...actual, AppLayoutToolbar };
});

describe("BaseLayout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
      authenticated(userWithRoles(["User"])),
    );
  });

  const renderComponent = () =>
    renderWithQueryClient(
      <Router>
        <BaseLayout>
          <div data-testid="child-content">Child Content</div>
          <ConfigSettledProbe />
          <UserSettledProbe />
        </BaseLayout>
      </Router>,
    );

  test("marks the top navigation as the layout header outside the page content", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    await screen.findByTestId("user-settled");
    const headers = document.querySelectorAll(TOP_NAVIGATION_SELECTOR);
    expect(headers).toHaveLength(1);
    const [header] = headers;
    expect(header).toHaveTextContent("Innovation Sandbox on AWS");
    expect(header).not.toContainElement(screen.getByTestId("child-content"));
  });

  test("keeps the marked top navigation pinned to the top of the viewport", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    await screen.findByTestId("user-settled");
    expect(document.querySelector(TOP_NAVIGATION_SELECTOR)).toHaveStyle({
      position: "sticky",
      top: "0px",
      zIndex: "1002",
    });
  });

  test("sizes the layout below the marked top navigation", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    await screen.findByTestId("user-settled");
    expect(recordToolbarProps).toHaveBeenLastCalledWith(
      expect.objectContaining({ headerSelector: TOP_NAVIGATION_SELECTOR }),
    );
  });

  test("does not render maintenance banner when maintenance mode is disabled", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    // Wait for the config query to resolve before asserting absence, otherwise
    // the banner would be absent merely because the config is still loading,
    // and the test would pass without exercising the disabled branch.
    await screen.findByTestId("config-settled");
    expect(screen.queryByText("Maintenance Mode")).not.toBeInTheDocument();
  });

  test("renders maintenance banner when maintenance mode is enabled", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(true)));

    renderComponent();

    expect(await screen.findByText("Maintenance Mode")).toBeInTheDocument();
    // The banner deep-links to the maintenance control in General settings.
    // The Settings nav item is gated off for this User role, so the only
    // Settings link present is the banner's.
    expect(
      await screen.findByRole("link", { name: /settings/i }),
    ).toHaveAttribute("href", "/settings#setting-maintenance-enabled");
  });

  test.each(["Admin", "Manager"] as const)(
    "shows the default-review badge only to admins (%s)",
    async (role) => {
      vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
        authenticated(userWithRoles([role])),
      );
      // Maintenance is disabled so the banner's own "/settings" link is absent and the side-nav
      // item is the only Settings link (the maintenance banner is covered by its
      // own test above).
      server.use(
        adminConfigGetHandler({
          ...createAdminConfig({ unsaved: ["leases", "cleanup"] }),
          maintenance: { enabled: false, lastSavedBy: "admin@example.com" },
        }),
      );

      renderComponent();

      const settingsLink = await screen.findByRole("link", {
        name: /settings/i,
      });
      expect(settingsLink).toHaveAttribute("href", "/settings");
      await screen.findByTestId("config-settled");
      const badges = screen.queryAllByRole("img", {
        name: "3 settings pages have unsaved defaults",
      });
      expect(badges).toHaveLength(role === "Admin" ? 1 : 0);
      if (role === "Admin") expect(badges[0]).toHaveTextContent("3");
    },
  );

  test.each(["Manager", "Admin"] as const)(
    "shows Permission Sets navigation for %s",
    async (role) => {
      vi.mocked(CognitoAuthService.getCurrentUser).mockResolvedValue(
        authenticated(userWithRoles([role])),
      );
      server.use(adminConfigGetHandler(configWithMaintenance(false)));

      renderComponent();

      expect(
        await screen.findByRole("link", { name: "Permission Sets" }),
      ).toHaveAttribute("href", "/permission-sets");
    },
  );

  test("hides Permission Sets navigation from users", async () => {
    server.use(adminConfigGetHandler(configWithMaintenance(false)));

    renderComponent();

    await screen.findByTestId("user-settled");
    expect(
      screen.queryByRole("link", { name: "Permission Sets" }),
    ).not.toBeInTheDocument();
  });
});

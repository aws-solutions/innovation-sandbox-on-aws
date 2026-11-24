// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AppLayoutToolbar,
  Box,
  BreadcrumbGroup,
  SideNavigation,
  SideNavigationProps,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { ReactNode, useCallback, useMemo, useState } from "react";
import { useLocation, useNavigate } from "react-router-dom";

import logo from "@amzn/innovation-sandbox-frontend/assets/images/logo.png";
import { useAppContext } from "@amzn/innovation-sandbox-frontend/components/AppContext/context";
import { AppLayoutProps } from "@amzn/innovation-sandbox-frontend/components/AppLayout";
import { AppLayoutProvider } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { NavHeader } from "@amzn/innovation-sandbox-frontend/components/AppLayout/NavHeader";
import { VersionAlert } from "@amzn/innovation-sandbox-frontend/components/AppLayout/VersionLayout";
import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";
import { MaintenanceBanner } from "@amzn/innovation-sandbox-frontend/components/MaintenanceBanner";
import { ApprovalsBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ApprovalsBadge";
import { SettingsBadge } from "@amzn/innovation-sandbox-frontend/domains/settings/components/SettingsBadge";
import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { useVersionCheck } from "@amzn/innovation-sandbox-frontend/hooks/useVersion";

const LARGE_DISPLAY_MINIMUM_WIDTH = 688;

// Let AppLayoutToolbar size content below the top navigation.
export const TOP_NAVIGATION_SELECTOR = "[data-isb-top-navigation]";

export const BaseLayout = ({ children }: AppLayoutProps) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const location = useLocation();
  const { breadcrumb } = useAppContext();
  const { user } = useUser();
  const [isLoggingOut, setIsLoggingOut] = useState(false);
  const [navigationOpen, setNavigationOpen] = useState(
    window.innerWidth > LARGE_DISPLAY_MINIMUM_WIDTH,
  );
  const [toolsOpen, setToolsOpen] = useState(false);
  const [toolsContent, setToolsContent] = useState<ReactNode>(null);

  const { data: versionData } = useVersionCheck({
    enabled: user?.roles?.includes("Admin"),
  });

  const onExit = useCallback(async () => {
    setIsLoggingOut(true);
    queryClient.clear();
    try {
      await CognitoAuthService.logout();
    } catch (error) {
      console.error("Logout failed", error);
      globalThis.location.href = getConfig().AwsAccessPortalUrl;
    }
  }, [queryClient]);

  const navigation = useMemo(() => {
    const isAdmin = user?.roles?.includes("Admin");
    const isManager = user?.roles?.includes("Manager");
    const navigationItems: SideNavigationProps.Item[] = [];

    // Home (all users)
    navigationItems.push(
      { href: "/", text: "Home", type: "link" },
      { href: "/leases", text: "Leases", type: "link" },
    );

    // Manager and Admin items
    if (isManager || isAdmin) {
      navigationItems.push(
        { type: "divider" },
        {
          href: "/approvals",
          text: "Approvals",
          type: "link",
          info: <ApprovalsBadge />,
        },
        {
          href: "/lease_templates",
          text: "Lease Templates",
          type: "link",
        },
        {
          href: "/blueprints",
          text: "Blueprints",
          type: "link",
        },
        {
          href: "/permission-sets",
          text: "Permission Sets",
          type: "link",
        },
      );
    }

    // Admin-only items
    if (isAdmin) {
      navigationItems.push({
        href: "/accounts",
        text: "Accounts",
        type: "link",
      });
    }

    // Settings (Manager and Admin)
    if (isManager || isAdmin) {
      navigationItems.push({
        href: "/settings",
        text: "Settings",
        type: "link",
        info: isAdmin ? <SettingsBadge /> : undefined,
      });
    }

    // Common items (all users)
    navigationItems.push(
      { type: "divider" },
      {
        external: true,
        href: "https://docs.aws.amazon.com/solutions/latest/innovation-sandbox-on-aws/use-the-solution.html",
        text: "Documentation",
        type: "link",
      },
    );

    // Add divider before version alert for admins
    if (isAdmin) {
      navigationItems.push({ type: "divider" });
    }

    return (
      <>
        <SideNavigation
          items={navigationItems}
          activeHref={location.pathname}
          onFollow={(event) => {
            if (!event.detail.external) {
              event.preventDefault();
              navigate(event.detail.href);
            }
          }}
        />
        {isAdmin && (
          <VersionAlert
            latestVersion={versionData?.latestVersion}
            isNewestVersion={versionData?.isNewestVersion}
          />
        )}
      </>
    );
  }, [user?.roles, navigate, location.pathname, versionData]);

  if (isLoggingOut) {
    return <FullPageLoader label="Signing out..." />;
  }

  return (
    <AppLayoutProvider
      toolsOpen={toolsOpen}
      onToolsChange={setToolsOpen}
      onToolsContentChange={setToolsContent}
    >
      {/* AppLayoutToolbar offsets its sticky toolbar by this element's
          height, so this element must stay sticky too. zIndex 1002 keeps it
          and its menus above Cloudscape's toolbar (1000) and mobile
          navigation (1001), and below popovers and modals. */}
      <Box
        nativeAttributes={{
          "data-isb-top-navigation": "true",
          style: { position: "sticky", top: 0, zIndex: 1002 },
        }}
      >
        <NavHeader
          title="Innovation Sandbox on AWS"
          logo={logo}
          user={user}
          onExit={onExit}
        />
      </Box>
      <AppLayoutToolbar
        headerSelector={TOP_NAVIGATION_SELECTOR}
        disableContentPaddings
        navigation={navigation}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        tools={toolsContent}
        toolsOpen={toolsOpen}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        notifications={<MaintenanceBanner />}
        breadcrumbs={
          <BreadcrumbGroup
            items={breadcrumb}
            onClick={(e) => {
              e.preventDefault();
              navigate(e.detail.item.href);
            }}
          />
        }
        content={children}
      />
    </AppLayoutProvider>
  );
};

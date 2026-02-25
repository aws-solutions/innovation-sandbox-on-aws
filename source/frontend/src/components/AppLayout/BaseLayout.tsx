// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  AppLayoutToolbar,
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
import { AuthService } from "@amzn/innovation-sandbox-frontend/helpers/AuthService";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { useVersionCheck } from "@amzn/innovation-sandbox-frontend/hooks/useVersion";

const LARGE_DISPLAY_MINIMUM_WIDTH = 688;

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

  const onExit = useCallback(() => {
    setIsLoggingOut(true);
    queryClient.clear();
    AuthService.logout();
  }, [queryClient]);

  const navigation = useMemo(() => {
    const isAdmin = user?.roles?.includes("Admin");
    const isManager = user?.roles?.includes("Manager");
    const navigationItems: SideNavigationProps.Item[] = [];

    // Home (all users)
    navigationItems.push({ href: "/", text: "Home", type: "link" });

    // Manager and Admin items
    if (isManager || isAdmin) {
      navigationItems.push({ type: "divider" });
      navigationItems.push({
        href: "/approvals",
        text: "Approvals",
        type: "link",
        info: <ApprovalsBadge />,
      });
      navigationItems.push({ href: "/leases", text: "Leases", type: "link" });
      navigationItems.push({
        href: "/lease_templates",
        text: "Lease Templates",
        type: "link",
      });
      navigationItems.push({
        href: "/blueprints",
        text: "Blueprints",
        type: "link",
      });
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
      <NavHeader
        title="Innovation Sandbox on AWS"
        logo={logo}
        user={user}
        onExit={onExit}
      />
      <AppLayoutToolbar
        disableContentPaddings
        navigation={navigation}
        navigationOpen={navigationOpen}
        onNavigationChange={({ detail }) => setNavigationOpen(detail.open)}
        tools={toolsContent}
        toolsOpen={toolsOpen}
        onToolsChange={({ detail }) => setToolsOpen(detail.open)}
        breadcrumbs={
          <BreadcrumbGroup
            items={breadcrumb}
            onClick={(e) => {
              e.preventDefault();
              navigate(e.detail.item.href);
            }}
          />
        }
        content={
          <>
            <MaintenanceBanner />
            {children}
          </>
        }
      />
    </AppLayoutProvider>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import AppLayoutBase from "@aws-northstar/ui/components/AppLayout";
import { BreadcrumbGroup } from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import logo from "@amzn/innovation-sandbox-frontend/assets/images/logo.png";
import { useAppContext } from "@amzn/innovation-sandbox-frontend/components/AppContext/context";
import { AppLayoutProps } from "@amzn/innovation-sandbox-frontend/components/AppLayout";
import {
  adminNavItems,
  commonNavItems,
  managerNavItems,
  userNavItems,
} from "@amzn/innovation-sandbox-frontend/components/AppLayout/constants";
import { NavHeader } from "@amzn/innovation-sandbox-frontend/components/AppLayout/NavHeader";
import { FullPageLoader } from "@amzn/innovation-sandbox-frontend/components/FullPageLoader";
import { MaintenanceBanner } from "@amzn/innovation-sandbox-frontend/components/MaintenanceBanner";
import { AuthService } from "@amzn/innovation-sandbox-frontend/helpers/AuthService";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

export const BaseLayout = ({ children }: AppLayoutProps) => {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { breadcrumb } = useAppContext();
  const { user } = useUser();
  const [isLoggingOut, setIsLoggingOut] = useState(false);

  const onExit = () => {
    setIsLoggingOut(true);
    queryClient.clear();
    AuthService.logout();
  };

  const navigationItems = useMemo(() => {
    if (user?.roles?.includes("Admin")) {
      return [...adminNavItems, ...commonNavItems];
    }

    if (user?.roles?.includes("Manager")) {
      return [...managerNavItems, ...commonNavItems];
    }

    return [...userNavItems, ...commonNavItems];
  }, [user?.roles]);

  if (isLoggingOut) {
    return <FullPageLoader label="Signing out..." />;
  }

  return (
    <AppLayoutBase
      headerSelector="#app-header"
      header={
        <NavHeader
          title="Innovation Sandbox on AWS"
          logo={logo}
          user={user}
          onExit={onExit}
        />
      }
      title="Innovation Sandbox on AWS"
      navigationItems={navigationItems}
      navigationOpen={window.innerWidth > 688}
      breadcrumbGroup={
        <BreadcrumbGroup
          items={breadcrumb}
          onClick={(e) => {
            e.preventDefault();
            navigate(e.detail.item.href);
          }}
        />
      }
    >
      <MaintenanceBanner />
      {children}
    </AppLayoutBase>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header, SpaceBetween } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { Divider } from "@amzn/innovation-sandbox-frontend/components/Divider";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { AccountsPanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/AccountsPanel";
import { ActiveLeases } from "@amzn/innovation-sandbox-frontend/domains/home/components/ActiveLeases";
import { ApprovalsPanel } from "@amzn/innovation-sandbox-frontend/domains/home/components/ApprovalsPanel";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

export const Home = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { user, isAdmin, isManager } = useUser();

  useEffect(() => {
    setBreadcrumb([{ text: "Home", href: "/" }]);
    setTools(<Markdown file={"home"} />);
  }, []);

  const body = () => {
    if (user?.roles?.includes("Admin")) {
      return (
        <SpaceBetween size="m">
          <Divider />
          <ApprovalsPanel />
          <Divider />
          <AccountsPanel />
          <Divider />
          <ActiveLeases />
        </SpaceBetween>
      );
    }

    if (user?.roles?.includes("Manager")) {
      return (
        <SpaceBetween size="m">
          <Divider />
          <ApprovalsPanel />
          <Divider />
          <ActiveLeases />
        </SpaceBetween>
      );
    }

    return (
      <SpaceBetween size="m">
        <Divider />
        <ActiveLeases />
      </SpaceBetween>
    );
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            <SpaceBetween direction="horizontal" size="xs">
              <Button onClick={() => navigate("/request")}>
                Request lease
              </Button>
              {(isAdmin || isManager) && (
                <Button onClick={() => navigate("/assign")}>
                  Assign lease
                </Button>
              )}
            </SpaceBetween>
          }
          info={<InfoLink markdown="home" />}
        >
          Welcome to Innovation Sandbox on AWS
        </Header>
      }
    >
      {body()}
    </ContentLayout>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Header, Tabs } from "@cloudscape-design/components";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { CleanupSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/CleanupSettings";
import { CostReportingSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/CostReportingSettings";
import { GeneralSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/GeneralSettings";
import { LeaseSettings } from "@amzn/innovation-sandbox-frontend/domains/settings/components/LeaseSettings";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useEffect } from "react";

export const Settings = () => {
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Settings", href: "/settings" },
    ]);
    setTools(<Markdown file="settings" />);
  }, []);

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="settings" />}
          description="Manage global settings here."
        >
          Settings
        </Header>
      }
    >
      <Tabs
        tabs={[
          {
            label: "General Settings",
            id: "general",
            content: <GeneralSettings />,
          },
          {
            label: "Lease Settings",
            id: "lease",
            content: <LeaseSettings />,
          },
          {
            label: "Clean Up Settings",
            id: "clean",
            content: <CleanupSettings />,
          },
          {
            label: "Cost Reporting Settings",
            id: "cost",
            content: <CostReportingSettings />,
          },
        ]}
      />
    </ContentLayout>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, ContentLayout, Header } from "@cloudscape-design/components";
import { useNavigate } from "react-router-dom";

import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { LeaseTemplatesTable } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/LeaseTemplatesTable";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useAppLayoutContext } from "@aws-northstar/ui/components/AppLayout";
import { useEffect } from "react";

export const ListLeaseTemplates = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  // set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
    ]);
    setTools(<Markdown file="lease-templates" />);
  }, []);

  // navigate to new lease template page
  const onCreateClick = () => {
    navigate("/lease_templates/new");
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="lease-templates" />}
          actions={
            <Button onClick={onCreateClick} variant="primary">
              Add new lease template
            </Button>
          }
          description="Manage the available templates to request leases from"
        >
          Lease Templates
        </Header>
      }
    >
      <LeaseTemplatesTable />
    </ContentLayout>
  );
};

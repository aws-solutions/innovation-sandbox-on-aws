// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Header } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { LeaseTemplateSummary } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/LeaseTemplateSummary";
import { useGetLeaseTemplateById } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";

export const LeaseTemplateDetails = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  const query = useGetLeaseTemplateById(uuid!);
  const { data: leaseTemplate, isFetching, isError, refetch, error } = query;

  const {
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();

  // Set page breadcrumb on page init
  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Lease Templates", href: "/lease_templates" },
      { text: leaseTemplate?.name ?? "...", href: "" },
    ]);
    setTools(<Markdown file="lease-template-details" />);
  }, [leaseTemplate, setBreadcrumb]);

  if (isFetching || isLoadingConfig) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError || !leaseTemplate) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this lease template."
          retry={refetch}
          error={error as Error}
        />
      </ContentLayout>
    );
  }

  if (isConfigError) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading global configuration settings."
          retry={refetchConfig}
          error={configError as Error}
        />
      </ContentLayout>
    );
  }

  return (
    <ContentLayout header={<Header variant="h1">{leaseTemplate.name}</Header>}>
      <LeaseTemplateSummary
        leaseTemplate={leaseTemplate}
        showEditButtons={true}
        onEditBasic={() =>
          navigate(`/lease_templates/${leaseTemplate.uuid}/edit/basic`)
        }
        onEditBlueprint={() =>
          navigate(`/lease_templates/${leaseTemplate.uuid}/edit/blueprint`)
        }
        onEditBudget={() =>
          navigate(`/lease_templates/${leaseTemplate.uuid}/edit/budget`)
        }
        onEditDuration={() =>
          navigate(`/lease_templates/${leaseTemplate.uuid}/edit/duration`)
        }
        onEditCostReport={() =>
          navigate(`/lease_templates/${leaseTemplate.uuid}/edit/cost-report`)
        }
      />
    </ContentLayout>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { BasicDetailsForm } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BasicDetailsForm";
import {
  BudgetForm,
  BudgetFormData,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BudgetForm";
import {
  CostReportForm,
  CostReportFormData,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/CostReportForm";
import {
  DurationForm,
  DurationFormData,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/DurationForm";
import { generateBreadcrumb } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/helpers";
import {
  useGetLeaseTemplateById,
  useUpdateLeaseTemplate,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import {
  Alert,
  ContentLayout,
  Header,
  SpaceBetween,
  Tabs,
} from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

export const UpdateLeaseTemplate = () => {
  const { uuid } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();

  // get leaseTemplate hook
  const query = useGetLeaseTemplateById(uuid!);
  const { data: leaseTemplate, isLoading, isError, refetch } = query;

  // update leaseTemplate hook
  const { mutateAsync: updateLeaseTemplate, isPending: isUpdating } =
    useUpdateLeaseTemplate();

  // get global settings
  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error,
  } = useGetConfigurations();

  // call api to update lease template budget fields
  const onUpdateBudget = async (data: any) => {
    // get data from form
    const { maxSpend, maxBudgetEnabled, budgetThresholds } =
      data as BudgetFormData;

    // construct PUT api request
    const updatedLeaseTemplate: LeaseTemplate = {
      ...(leaseTemplate as LeaseTemplate),
      maxSpend: maxBudgetEnabled ? maxSpend : undefined,
      budgetThresholds,
    };

    await updateLeaseTemplate(updatedLeaseTemplate);
    navigate("/lease_templates");
  };

  // call api to update lease template duration fields
  const onUpdateDuration = async (data: any) => {
    // get data from form
    const { leaseDurationInHours, maxDurationEnabled, durationThresholds } =
      data as DurationFormData;

    // construct PUT api request
    const updatedLeaseTemplate: LeaseTemplate = {
      ...(leaseTemplate as LeaseTemplate),
      leaseDurationInHours: maxDurationEnabled
        ? leaseDurationInHours
        : undefined,
      durationThresholds,
    };

    await updateLeaseTemplate(updatedLeaseTemplate);
    navigate("/lease_templates");
  };

  const onCancel = () => {
    navigate("/lease_templates");
  };

  const onUpdateCostReport = async (data: any) => {
    const { costReportGroup } = data as CostReportFormData;

    const updatedLeaseTemplate: LeaseTemplate = {
      ...(leaseTemplate as LeaseTemplate),
      costReportGroup: costReportGroup ?? undefined,
    };

    await updateLeaseTemplate(updatedLeaseTemplate);
    navigate("/lease_templates");
  };

  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query);
    setBreadcrumb(breadcrumb);
  }, [query.isLoading]);

  if (isLoading || isLoadingConfig) {
    return <Loader />;
  }

  if (isError || !leaseTemplate) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease template."
        retry={refetch}
        error={error as Error}
      />
    );
  }

  if (isConfigError) {
    return (
      <ErrorPanel
        description="There was a problem loading global configuration settings."
        retry={refetchConfig}
        error={error as Error}
      />
    );
  }

  return (
    <ContentLayout
      header={
        <Header variant="h1" description={leaseTemplate.description}>
          {leaseTemplate.name}
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Alert type="info" header="Please Note">
          Making changes to this lease template will only affect new leases.
          Existing leases using this lease template will not be affected.
        </Alert>
        <Tabs
          tabs={[
            {
              id: "basic",
              label: "Basic Details",
              content: <BasicDetailsForm leaseTemplate={leaseTemplate} />,
            },
            {
              id: "budget",
              label: "Budget",
              content: (
                <BudgetForm
                  maxSpend={leaseTemplate.maxSpend}
                  budgetThresholds={leaseTemplate.budgetThresholds}
                  onSubmit={onUpdateBudget}
                  onCancel={onCancel}
                  isUpdating={isUpdating}
                  globalMaxBudget={config?.leases.maxBudget}
                />
              ),
            },
            {
              id: "duration",
              label: "Duration",
              content: (
                <DurationForm
                  leaseDurationInHours={leaseTemplate.leaseDurationInHours}
                  durationThresholds={leaseTemplate.durationThresholds}
                  onSubmit={onUpdateDuration}
                  onCancel={onCancel}
                  isUpdating={isUpdating}
                  globalMaxDuration={config?.leases.maxDurationHours}
                />
              ),
            },
            {
              id: "costReport",
              label: "Cost Report",
              content: (
                <CostReportForm
                  costReportGroup={leaseTemplate.costReportGroup}
                  onSubmit={onUpdateCostReport}
                  onCancel={onCancel}
                  isUpdating={isUpdating}
                  costReportGroups={config?.costReportGroups}
                  requireCostReportGroup={config?.requireCostReportGroup}
                />
              ),
            },
          ]}
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

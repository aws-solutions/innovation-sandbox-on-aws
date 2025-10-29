// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ContentLayout, Header, Tabs } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { isMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { showSuccessToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  LeaseDurationForm,
  LeaseDurationFormData,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseDurationForm";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { generateBreadcrumb } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useGetLeaseById,
  useUpdateLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeasePatchRequest } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import {
  BudgetForm,
  BudgetFormData,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/BudgetForm";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import {
  CostReportForm,
  CostReportFormData,
} from "../../leaseTemplates/components/CostReportForm";

export const UpdateLease = () => {
  const { leaseId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();

  // get leaseTemplate hook
  const query = useGetLeaseById(leaseId!);
  const { data: lease, isLoading, isError, refetch } = query;

  // update leaseTemplate hook
  const { mutateAsync: updateLease, isPending: isUpdating } = useUpdateLease();

  // get global settings
  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error,
  } = useGetConfigurations();

  // update breadcrumb with lease details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query);
    setBreadcrumb(breadcrumb);
  }, [query.isLoading]);

  if (isLoading || isLoadingConfig) {
    return <Loader />;
  }

  if (isError || !lease) {
    return (
      <ErrorPanel
        description="There was a problem loading this lease."
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

  // call api to update lease budget fields
  const onUpdateBudget = async (data: any) => {
    // get data from form
    const { maxSpend, budgetThresholds, maxBudgetEnabled } =
      data as BudgetFormData;

    // create patch api request
    const leasePatchRequest: LeasePatchRequest = {
      leaseId: lease.leaseId,
      budgetThresholds,
      maxSpend: maxBudgetEnabled ? maxSpend : null,
    };

    await updateLease(leasePatchRequest);
    showSuccessToast("Lease updated successfully.");
  };

  // call api to update lease duration fields
  const onUpdateDuration = async (data: any) => {
    // get data from form
    const { expirationDate, durationThresholds, expiryDateEnabled } =
      data as LeaseDurationFormData;

    // create patch api request
    const leasePatchRequest: LeasePatchRequest = {
      leaseId: lease.leaseId,
      durationThresholds: expiryDateEnabled ? durationThresholds : [],
      expirationDate: expiryDateEnabled ? expirationDate : null,
    };

    await updateLease(leasePatchRequest);
    showSuccessToast("Lease updated successfully.");
  };

  const onUpdateCostReport = async (data: any) => {
    const { costReportGroup } = data as CostReportFormData;

    const leasePatchRequest: LeasePatchRequest = {
      leaseId: lease.leaseId,
      costReportGroup: costReportGroup ?? null,
    };

    await updateLease(leasePatchRequest);
    showSuccessToast("Lease updated successfully.");
  };

  const onCancel = () => {
    navigate("/leases");
  };

  const body = () => {
    if (!isMonitoredLease(lease)) {
      // if lease is not active, don't show tabs for budget/duration
      return <LeaseSummary lease={lease} />;
    }

    return (
      <Tabs
        tabs={[
          {
            label: "Summary",
            id: "summary",
            content: <LeaseSummary lease={lease} />,
          },
          {
            label: "Budget",
            id: "budget",
            content: (
              <BudgetForm
                maxSpend={lease.maxSpend}
                budgetThresholds={lease.budgetThresholds}
                onSubmit={onUpdateBudget}
                onCancel={onCancel}
                isUpdating={isUpdating}
                globalMaxBudget={config?.leases.maxBudget}
              />
            ),
          },
          {
            label: "Duration",
            id: "duration",
            content: (
              <LeaseDurationForm
                expirationDate={lease.expirationDate}
                durationThresholds={lease.durationThresholds}
                onSubmit={onUpdateDuration}
                onCancel={onCancel}
                isUpdating={isUpdating}
              />
            ),
          },
          {
            label: "Cost Report",
            id: "costReport",
            content: (
              <CostReportForm
                costReportGroup={lease.costReportGroup}
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
    );
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={<>{lease?.originalLeaseTemplateName}</>}
        >
          {lease.userEmail}
        </Header>
      }
    >
      {body()}
    </ContentLayout>
  );
};

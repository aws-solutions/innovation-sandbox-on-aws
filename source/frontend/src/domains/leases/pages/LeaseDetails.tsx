// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Button,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect } from "react";
import { useNavigate, useParams } from "react-router-dom";

import { isMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { PendingExtensionInfo } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingExtensionInfo";
import { RequestExtensionModal } from "@amzn/innovation-sandbox-frontend/domains/leases/components/RequestExtensionModal";
import { generateBreadcrumb } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { MonitoredLeaseWithLeaseId } from "@amzn/innovation-sandbox-frontend/domains/leases/types";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

export const LeaseDetails = () => {
  const { leaseId } = useParams();
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { showModal, hideModal } = useModal();

  const query = useGetLeaseById(leaseId!);
  const { data: lease, isFetching, isError, refetch, error } = query;

  const {
    data: config,
    isLoading: isLoadingConfig,
    isError: isConfigError,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();

  // Update breadcrumb with lease details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query);
    setBreadcrumb(breadcrumb);
    setTools(<Markdown file="lease-details" />);
  }, [query.isLoading, setBreadcrumb]);

  const showExtensionModal = () => {
    if (!lease || !isMonitoredLease(lease)) return;

    showModal({
      header: "Request Lease Extension",
      content: (
        <RequestExtensionModal
          lease={lease as MonitoredLeaseWithLeaseId}
          maxDurationHours={config?.leases.maxDurationHours}
          onCancel={hideModal}
        />
      ),
    });
  };

  if (isFetching || isLoadingConfig) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError || !lease) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="There was a problem loading this lease."
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

  // Only show edit buttons for monitored leases (active leases)
  const showEditButtons = isMonitoredLease(lease);

  // Show extension button for Active or Frozen leases
  const showExtensionButton =
    lease.status === "Active" || lease.status === "Frozen";

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            showExtensionButton ? (
              <SpaceBetween size="s" direction="horizontal">
                <Button iconName="add-plus" onClick={showExtensionModal}>
                  Request Extension
                </Button>
              </SpaceBetween>
            ) : undefined
          }
        >
          {lease.userEmail}
        </Header>
      }
    >
      <SpaceBetween size="l">
        {isMonitoredLease(lease) && lease.pendingExtensionRequest && (
          <PendingExtensionInfo
            pendingExtensionRequest={lease.pendingExtensionRequest}
          />
        )}
        <LeaseSummary
          lease={lease}
          showEditButtons={showEditButtons}
          onEditBudget={
            showEditButtons
              ? () => navigate(`/leases/${leaseId}/edit/budget`)
              : undefined
          }
          onEditDuration={
            showEditButtons
              ? () => navigate(`/leases/${leaseId}/edit/duration`)
              : undefined
          }
          onEditCostReport={
            showEditButtons
              ? () => navigate(`/leases/${leaseId}/edit/cost-report`)
              : undefined
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

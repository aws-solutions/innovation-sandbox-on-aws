// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Button,
  Header,
  SpaceBetween,
  Tabs,
} from "@cloudscape-design/components";
import { useEffect } from "react";
import { useParams, useSearchParams } from "react-router-dom";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { PendingAssignmentsList } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingAssignmentsList";
import { ReviewLeaseConfirmation } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewLeaseConfirmation";
import {
  generateBreadcrumb,
  getLeaseDisplayName,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

export const ApprovalDetails = () => {
  const { leaseId } = useParams();
  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab = searchParams.get("tab") ?? "summary";
  const setBreadcrumb = useBreadcrumb();

  // modal hook
  const { showModal, hideModal } = useModal();

  // get leaseTemplate hook
  const query = useGetLeaseById(leaseId);
  const { data: lease, isLoading, isError, refetch, error } = query;

  const { data: config } = useGetConfigurations();
  const leaseSharingEnabled = config?.leases.leaseSharingEnabled ?? false;
  const sandboxSpacesEnabled = config?.agent.sandboxSpacesEnabled ?? false;

  // update breadcrumb with approval details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query, { isApprovalPage: true });
    setBreadcrumb(breadcrumb);
  }, [query.isLoading]);

  const errorPanel = (
    <ContentLayout>
      <ErrorPanel
        description="There was a problem loading this lease."
        retry={refetch}
        error={error as Error}
      />
    </ContentLayout>
  );

  const showReviewModal = (mode: "approve" | "deny") => {
    if (!lease) {
      return errorPanel;
    }

    showModal({
      header: mode === "approve" ? "Approve request(s)" : "Deny request(s)",
      content: (
        <ReviewLeaseConfirmation
          mode={mode}
          leaseId={lease.leaseId}
          onCancel={hideModal}
        />
      ),
    });
  };

  if (isLoading) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  if (isError || !lease) {
    return errorPanel;
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={<>{lease?.originalLeaseTemplateName}</>}
          actions={
            <SpaceBetween size="s" direction="horizontal">
              <Button
                iconName="check"
                onClick={() => showReviewModal("approve")}
              >
                Approve
              </Button>
              <Button iconName="close" onClick={() => showReviewModal("deny")}>
                Deny
              </Button>
            </SpaceBetween>
          }
        >
          {getLeaseDisplayName(lease)}
        </Header>
      }
    >
      {lease.desiredAssignments && lease.desiredAssignments.length > 0 ? (
        <Tabs
          activeTabId={activeTab}
          onChange={({ detail }) =>
            setSearchParams({ tab: detail.activeTabId })
          }
          tabs={[
            {
              id: "summary",
              label: "Summary",
              content: (
                <LeaseSummary
                  lease={lease}
                  showAdminFields={true}
                  leaseSharingEnabled={leaseSharingEnabled}
                  sandboxSpacesEnabled={sandboxSpacesEnabled}
                />
              ),
            },
            {
              id: "access",
              label: "Access",
              content: (
                <PendingAssignmentsList
                  desiredAssignments={lease.desiredAssignments}
                  defaultPermissionSet={lease.defaultPermissionSet}
                  allowedPermissionSets={lease.allowedPermissionSets}
                  ownerEmail={lease.userEmail}
                />
              ),
            },
          ]}
        />
      ) : (
        <LeaseSummary
          lease={lease}
          showAdminFields={true}
          leaseSharingEnabled={leaseSharingEnabled}
          sandboxSpacesEnabled={sandboxSpacesEnabled}
        />
      )}
    </ContentLayout>
  );
};

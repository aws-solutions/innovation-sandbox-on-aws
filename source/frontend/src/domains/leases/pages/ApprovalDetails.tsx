// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header, SpaceBetween } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { ReviewLeaseConfirmation } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewLeaseConfirmation";
import { generateBreadcrumb } from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

export const ApprovalDetails = () => {
  const { leaseId } = useParams();
  const setBreadcrumb = useBreadcrumb();

  // modal hook
  const { showModal, hideModal } = useModal();

  // get leaseTemplate hook
  const query = useGetLeaseById(leaseId!);
  const { data: lease, isLoading, isError, refetch, error } = query;

  // update breadcrumb with approval details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query, true);
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
          {lease.userEmail}
        </Header>
      }
    >
      <LeaseSummary lease={lease} />
    </ContentLayout>
  );
};

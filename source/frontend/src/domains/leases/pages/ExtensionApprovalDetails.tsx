// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Button, Header, SpaceBetween } from "@cloudscape-design/components";
import { useEffect } from "react";
import { useParams } from "react-router-dom";

import { isMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import { PendingExtensionInfo } from "@amzn/innovation-sandbox-frontend/domains/leases/components/PendingExtensionInfo";
import { ReviewExtensionConfirmation } from "@amzn/innovation-sandbox-frontend/domains/leases/components/ReviewExtensionConfirmation";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

export const ExtensionApprovalDetails = () => {
  const { leaseId } = useParams();
  const setBreadcrumb = useBreadcrumb();

  const { showModal, hideModal } = useModal();

  const query = useGetLeaseById(leaseId!);
  const { data: lease, isLoading, isError, refetch, error } = query;

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Approvals", href: "/approvals" },
      { text: "Extension Request", href: "" },
    ]);
  }, [setBreadcrumb]);

  const showReviewModal = (mode: "approve" | "deny") => {
    if (
      !lease ||
      !isMonitoredLease(lease) ||
      !lease.pendingExtensionRequest
    ) {
      return;
    }

    showModal({
      header:
        mode === "approve"
          ? "Approve Extension Request"
          : "Deny Extension Request",
      content: (
        <ReviewExtensionConfirmation
          mode={mode}
          leaseId={lease.leaseId}
          pendingExtensionRequest={lease.pendingExtensionRequest}
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

  const hasPendingExtension =
    isMonitoredLease(lease) && !!lease.pendingExtensionRequest;

  if (!hasPendingExtension) {
    return (
      <ContentLayout>
        <ErrorPanel
          description="This lease does not have a pending extension request."
          retry={refetch}
          error={new Error("No pending extension request")}
        />
      </ContentLayout>
    );
  }

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          description={<>Extension request from {lease.userEmail}</>}
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
          Extension Request
        </Header>
      }
    >
      <SpaceBetween size="l">
        {isMonitoredLease(lease) && lease.pendingExtensionRequest && (
          <PendingExtensionInfo
            pendingExtensionRequest={lease.pendingExtensionRequest}
          />
        )}
        <LeaseSummary lease={lease} />
      </SpaceBetween>
    </ContentLayout>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Button,
  ButtonDropdown,
  ContentLayout,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import moment from "moment";
import { useEffect, useState } from "react";

import { LeaseWithLeaseId as Lease } from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useGetPendingApprovals,
  useReviewLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useAppLayoutContext } from "@aws-northstar/ui/components/AppLayout";

const DateRequestedCell = ({ lease }: { lease: Lease }) => (
  <>{moment(lease.meta?.createdTime).fromNow()}</>
);

const CommentsCell = ({ lease }: { lease: Lease }) => <>{lease.comments}</>;

const RequestorCell = ({
  lease,
  includeLinks,
}: {
  lease: Lease;
  includeLinks: boolean;
}) =>
  includeLinks ? (
    <TextLink to={`/approvals/${lease.leaseId}`}>{lease.userEmail}</TextLink>
  ) : (
    lease.userEmail
  );

// Review modal content component
type ReviewModalContentProps = {
  selectedRequests: Lease[];
  mode: "approve" | "deny";
  reviewLease: (params: { leaseId: string; approve: boolean }) => Promise<any>;
};

const createColumnDefinitions = (includeLinks: boolean) => [
  {
    id: "requestor",
    header: "Requested by",
    sortingField: "requestor.name",
    cell: (
      lease: Lease, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    ) => <RequestorCell lease={lease} includeLinks={includeLinks} />,
  },
  {
    id: "originalLeaseTemplateName",
    header: "Lease Template",
    sortingField: "originalLeaseTemplateName",
    cell: (lease: Lease) => lease.originalLeaseTemplateName,
  },
  {
    id: "dateRequested",
    header: "Requested",
    sortingField: "dateRequested",
    cell: (lease: Lease) => <DateRequestedCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
  },
  {
    id: "comments",
    header: "Comments",
    sortingField: "comments",
    cell: (lease: Lease) => <CommentsCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
  },
];

const ReviewModalContent = ({
  selectedRequests,
  mode,
  reviewLease,
}: ReviewModalContentProps) => {
  return (
    <BatchActionReview
      items={selectedRequests}
      description={`${selectedRequests.length} lease request(s) to review`}
      columnDefinitions={createColumnDefinitions(false)}
      identifierKey="leaseId"
      onSubmit={async (lease: Lease) => {
        await reviewLease({
          leaseId: lease.leaseId,
          approve: mode === "approve",
        });
      }}
      onSuccess={() => {
        showSuccessToast(
          mode === "approve"
            ? "Lease request(s) were successfully approved."
            : "Lease request(s) were successfully denied.",
        );
      }}
      onError={() =>
        showErrorToast(
          "One or more lease requests failed to review, try resubmitting.",
          "Failed to review lease requests",
        )
      }
    />
  );
};

export const ListApprovals = () => {
  // base ui hooks
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();

  // modal hook
  const { showModal } = useModal();

  // state
  const [selectedRequests, setSelectedRequests] = useState<Lease[]>([]);

  // api hooks
  const { data: requests, isFetching, refetch } = useGetPendingApprovals();
  const { mutateAsync: reviewLease } = useReviewLease();

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Approvals", href: "/approvals" },
    ]);
    setTools(<Markdown file="approvals" />);
  }, []);

  const showReviewModal = (mode: "approve" | "deny") => {
    showModal({
      header: mode === "approve" ? "Approve request(s)" : "Deny request(s)",
      content: (
        <ReviewModalContent
          selectedRequests={selectedRequests}
          mode={mode}
          reviewLease={reviewLease}
        />
      ),
      size: "max",
    });
  };

  const handleSelectionChange = ({ detail }: { detail: any }) => {
    const approvals = detail.selectedItems as Lease[];
    setSelectedRequests(approvals);
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="approvals" />}
          description="Manage requests to lease sandbox accounts"
        >
          Approvals
        </Header>
      }
    >
      <Table
        stripedRows
        trackBy="leaseId"
        columnDefinitions={createColumnDefinitions(true)}
        header="Approvals"
        totalItemsCount={(requests || []).length}
        items={requests || []}
        selectedItems={selectedRequests}
        onSelectionChange={handleSelectionChange}
        loading={isFetching}
        actions={
          <SpaceBetween direction="horizontal" size="s">
            <Button
              iconName="refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            />
            <ButtonDropdown
              disabled={selectedRequests.length === 0}
              items={[
                { text: "Approve request(s)", id: "approve" },
                { text: "Deny request(s)", id: "deny" },
              ]}
              onItemClick={({ detail }) => {
                showReviewModal(detail.id === "approve" ? "approve" : "deny");
              }}
            >
              Actions
            </ButtonDropdown>
          </SpaceBetween>
        }
      />
    </ContentLayout>
  );
};

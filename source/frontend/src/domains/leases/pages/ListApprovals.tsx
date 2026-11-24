// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Button,
  ButtonDropdown,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { assignmentPrincipalKey } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import {
  useGetPendingApprovals,
  useReviewLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { LEASE_NOT_PENDING_REVIEW_ERROR } from "@amzn/innovation-sandbox-shared/types/lease.js";

/**
 * Drops selected rows no longer pending in the latest fetch so a batch review
 * never submits a stale row (which 409s). Returns the same reference when
 * unchanged so the effect driving it doesn't loop.
 */
export const reconcileSelectedRequests = (
  selected: LeaseView[],
  requests: LeaseView[],
): LeaseView[] => {
  const pendingIds = new Set(requests.map((r) => r.leaseId));
  const reconciled = selected.filter((r) => pendingIds.has(r.leaseId));
  return reconciled.length === selected.length ? selected : reconciled;
};

const DateRequestedCell = ({ lease }: { lease: LeaseView }) =>
  lease.meta?.createdTime
    ? DateTime.fromISO(lease.meta.createdTime).toRelative()
    : undefined;

const CommentsCell = ({ lease }: { lease: LeaseView }) => <>{lease.comments}</>;

export const getSharedPrincipalCount = (lease: LeaseView): number => {
  const assignments = lease.desiredAssignments ?? [];
  const owner = assignments.find(
    ({ email, principalType }) =>
      principalType === "USER" &&
      email?.toLowerCase() === lease.userEmail.toLowerCase(),
  );
  const ownerKey = owner ? assignmentPrincipalKey(owner) : undefined;
  return new Set(
    assignments
      .map(assignmentPrincipalKey)
      .filter((principalKey) => principalKey !== ownerKey),
  ).size;
};

const SharedPrincipalsCell = ({
  lease,
  includeLinks,
}: {
  lease: LeaseView;
  includeLinks: boolean;
}) => {
  const sharedCount = getSharedPrincipalCount(lease);
  if (sharedCount === 0) {
    return "-";
  }
  const label = `${sharedCount} ${sharedCount === 1 ? "principal" : "principals"}`;
  return includeLinks ? (
    <TextLink to={`/approvals/${lease.leaseId}?tab=access`}>{label}</TextLink>
  ) : (
    label
  );
};

const RequestorCell = ({
  lease,
  includeLinks,
}: {
  lease: LeaseView;
  includeLinks: boolean;
}) =>
  includeLinks ? (
    <TextLink to={`/approvals/${lease.leaseId}`}>{lease.userEmail}</TextLink>
  ) : (
    lease.userEmail
  );

// Review modal content component
type ReviewModalContentProps = {
  selectedRequests: LeaseView[];
  mode: "approve" | "deny";
  reviewLease: (params: { leaseId: string; approve: boolean }) => Promise<any>;
  queryClient: any;
  setSelectedRequests: React.Dispatch<React.SetStateAction<LeaseView[]>>;
};

const createColumnDefinitions = (includeLinks: boolean) => [
  {
    id: "requestor",
    header: "Requested by",
    sortingField: "userEmail",
    cell: (
      lease: LeaseView, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    ) => <RequestorCell lease={lease} includeLinks={includeLinks} />,
  },
  {
    id: "originalLeaseTemplateName",
    header: "Lease Template",
    sortingField: "originalLeaseTemplateName",
    cell: (lease: LeaseView) => lease.originalLeaseTemplateName,
  },
  {
    id: "dateRequested",
    header: "Requested",
    sortingComparator: createDateSortingComparator<LeaseView>(
      (a) => a.meta?.createdTime,
    ),
    cell: (lease: LeaseView) => <DateRequestedCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
  },
  {
    id: "comments",
    header: "Comments",
    sortingField: "comments",
    cell: (lease: LeaseView) => <CommentsCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
  },
  {
    id: "sharedPrincipals",
    header: "Shared with",
    sortingComparator: (a: LeaseView, b: LeaseView) =>
      getSharedPrincipalCount(a) - getSharedPrincipalCount(b),
    cell: (lease: LeaseView) => (
      <SharedPrincipalsCell lease={lease} includeLinks={includeLinks} />
    ), // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
  },
];

const ReviewModalContent = ({
  selectedRequests,
  mode,
  reviewLease,
  queryClient,
  setSelectedRequests,
}: ReviewModalContentProps) => {
  return (
    <BatchActionReview
      items={selectedRequests}
      description={`${selectedRequests.length} lease request(s) to review`}
      columnDefinitions={createColumnDefinitions(false)}
      identifierKey="leaseId"
      sequential
      onSubmit={async (lease: LeaseView) => {
        try {
          await reviewLease({
            leaseId: lease.leaseId,
            approve: mode === "approve",
          });
        } catch (error) {
          // Already reviewed elsewhere: treat this benign 409 as done so the
          // batch doesn't error and prompt a redundant re-review.
          if (!(
            error instanceof ApiError &&
            error.statusCode === 409 &&
            error.message === LEASE_NOT_PENDING_REVIEW_ERROR
          )) {
            throw error;
          }
        }
        setSelectedRequests((prev) =>
          prev.filter((r) => r.leaseId !== lease.leaseId),
        );
      }}
      onSuccess={() => {
        queryClient.invalidateQueries({
          queryKey: ["leases"],
          refetchType: "all",
        });
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

  // query client
  const queryClient = useQueryClient();

  // state
  const [selectedRequests, setSelectedRequests] = useState<LeaseView[]>([]);

  // api hooks
  const { data: requests, isFetching, refetch } = useGetPendingApprovals();
  const { mutateAsync: reviewLease } = useReviewLease({
    skipInvalidation: true,
  });

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Approvals", href: "/approvals" },
    ]);
    setTools(<Markdown file="approvals" />);
  }, []);

  useEffect(() => {
    if (!requests) return;
    setSelectedRequests((prev) => reconcileSelectedRequests(prev, requests));
  }, [requests]);

  const showReviewModal = (mode: "approve" | "deny") => {
    showModal({
      header: mode === "approve" ? "Approve request(s)" : "Deny request(s)",
      content: (
        <ReviewModalContent
          selectedRequests={selectedRequests}
          mode={mode}
          reviewLease={reviewLease}
          queryClient={queryClient}
          setSelectedRequests={setSelectedRequests}
        />
      ),
      size: "max",
    });
  };

  const handleSelectionChange = ({ detail }: { detail: any }) => {
    const approvals = detail.selectedItems as LeaseView[];
    setSelectedRequests(approvals);
  };

  return (
    <ContentLayout
      disablePadding
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

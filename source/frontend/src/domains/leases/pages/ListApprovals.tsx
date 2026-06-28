// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Button,
  ButtonDropdown,
  Header,
  SpaceBetween,
  Tabs,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useEffect, useState } from "react";

import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";

import {
  LeaseWithLeaseId as Lease,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useGetPendingApprovals,
  useGetPendingExtensions,
  useReviewLease,
  useReviewLeaseExtension,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

const DateRequestedCell = ({ lease }: { lease: Lease }) =>
  lease.meta?.createdTime
    ? DateTime.fromISO(lease.meta.createdTime).toRelative()
    : undefined;

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
  queryClient: any;
  setSelectedRequests: React.Dispatch<React.SetStateAction<Lease[]>>;
};

const createColumnDefinitions = (includeLinks: boolean) => [
  {
    id: "requestor",
    header: "Requested by",
    sortingField: "userEmail",
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
    sortingComparator: createDateSortingComparator<Lease>(
      (a) => a.meta?.createdTime,
    ),
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
      onSubmit={async (lease: Lease) => {
        await reviewLease({
          leaseId: lease.leaseId,
          approve: mode === "approve",
        });
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
  const [selectedRequests, setSelectedRequests] = useState<Lease[]>([]);
  const [selectedExtensions, setSelectedExtensions] = useState<Lease[]>([]);

  // api hooks
  const { data: requests, isFetching, refetch } = useGetPendingApprovals();
  const {
    data: extensionRequests,
    isFetching: isFetchingExtensions,
    refetch: refetchExtensions,
  } = useGetPendingExtensions();
  const { mutateAsync: reviewLease } = useReviewLease({
    skipInvalidation: true,
  });
  const { mutateAsync: reviewExtension } = useReviewLeaseExtension();

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
          queryClient={queryClient}
          setSelectedRequests={setSelectedRequests}
        />
      ),
      size: "max",
    });
  };

  const handleSelectionChange = ({ detail }: { detail: any }) => {
    const approvals = detail.selectedItems as Lease[];
    setSelectedRequests(approvals);
  };

  const handleExtensionSelectionChange = ({ detail }: { detail: any }) => {
    const extensions = detail.selectedItems as Lease[];
    setSelectedExtensions(extensions);
  };

  const showExtensionReviewModal = (mode: "approve" | "deny") => {
    showModal({
      header:
        mode === "approve"
          ? "Approve extension request(s)"
          : "Deny extension request(s)",
      content: (
        <BatchActionReview
          items={selectedExtensions}
          description={`${selectedExtensions.length} extension request(s) to review`}
          columnDefinitions={extensionColumnDefinitions}
          identifierKey="leaseId"
          sequential
          onSubmit={async (lease: Lease) => {
            await reviewExtension({
              leaseId: lease.leaseId,
              action: mode === "approve" ? "Approve" : "Deny",
            });
            setSelectedExtensions((prev) =>
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
                ? "Extension request(s) were successfully approved."
                : "Extension request(s) were successfully denied.",
            );
          }}
          onError={() =>
            showErrorToast(
              "One or more extension requests failed to review, try resubmitting.",
              "Failed to review extension requests",
            )
          }
        />
      ),
      size: "max",
    });
  };

  const extensionColumnDefinitions = [
    {
      id: "requestor",
      header: "Requested by",
      sortingField: "userEmail",
      cell: (lease: Lease) => (
        <TextLink to={`/approvals/extensions/${lease.leaseId}`}>
          {lease.userEmail}
        </TextLink>
      ),
    },
    {
      id: "originalLeaseTemplateName",
      header: "Lease Template",
      sortingField: "originalLeaseTemplateName",
      cell: (lease: Lease) => lease.originalLeaseTemplateName,
    },
    {
      id: "requestedExpiration",
      header: "Requested Expiration",
      cell: (lease: Lease) => {
        const monitored = lease as MonitoredLease & { leaseId: string };
        return monitored.pendingExtensionRequest
          ? DateTime.fromISO(
              monitored.pendingExtensionRequest.requestedExpirationDate,
            ).toLocaleString(DateTime.DATETIME_SHORT)
          : "-";
      },
    },
    {
      id: "requestedAt",
      header: "Requested",
      sortingComparator: createDateSortingComparator<Lease>((a) => {
        const monitored = a as MonitoredLease & { leaseId: string };
        return monitored.pendingExtensionRequest?.requestedAt;
      }),
      cell: (lease: Lease) => {
        const monitored = lease as MonitoredLease & { leaseId: string };
        return monitored.pendingExtensionRequest?.requestedAt
          ? DateTime.fromISO(
              monitored.pendingExtensionRequest.requestedAt,
            ).toRelative()
          : "-";
      },
    },
    {
      id: "comments",
      header: "Comments",
      cell: (lease: Lease) => {
        const monitored = lease as MonitoredLease & { leaseId: string };
        return monitored.pendingExtensionRequest?.comments ?? "";
      },
    },
  ];

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
      <Tabs
        tabs={[
          {
            label: "Lease Requests",
            id: "lease-requests",
            content: (
              <Table
                stripedRows
                trackBy="leaseId"
                columnDefinitions={createColumnDefinitions(true)}
                header="Lease Requests"
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
                        showReviewModal(
                          detail.id === "approve" ? "approve" : "deny",
                        );
                      }}
                    >
                      Actions
                    </ButtonDropdown>
                  </SpaceBetween>
                }
              />
            ),
          },
          {
            label: "Extension Requests",
            id: "extension-requests",
            content: (
              <Table
                stripedRows
                trackBy="leaseId"
                columnDefinitions={extensionColumnDefinitions}
                header="Extension Requests"
                totalItemsCount={(extensionRequests || []).length}
                items={extensionRequests || []}
                selectedItems={selectedExtensions}
                onSelectionChange={handleExtensionSelectionChange}
                loading={isFetchingExtensions}
                actions={
                  <SpaceBetween direction="horizontal" size="s">
                    <Button
                      iconName="refresh"
                      onClick={() => refetchExtensions()}
                      disabled={isFetchingExtensions}
                    />
                    <ButtonDropdown
                      disabled={selectedExtensions.length === 0}
                      items={[
                        { text: "Approve request(s)", id: "approve" },
                        { text: "Deny request(s)", id: "deny" },
                      ]}
                      onItemClick={({ detail }) => {
                        showExtensionReviewModal(
                          detail.id === "approve" ? "approve" : "deny",
                        );
                      }}
                    >
                      Actions
                    </ButtonDropdown>
                  </SpaceBetween>
                }
              />
            ),
          },
        ]}
      />
    </ContentLayout>
  );
};

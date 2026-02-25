// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Table } from "@aws-northstar/ui";
import {
  Alert,
  Box,
  Button,
  ButtonDropdown,
  ColumnLayout,
  Container,
  FormField,
  Header,
  Multiselect,
  MultiselectProps,
  SelectProps,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import {
  ApprovalDeniedLeaseStatusSchema,
  ExpiredLeaseStatusSchema,
  isExpiredLease,
  isMonitoredLease,
  LeaseWithLeaseId as Lease,
  LeaseStatus,
  MonitoredLeaseStatusSchema,
  PendingLeaseStatusSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { AccountLoginLink } from "@amzn/innovation-sandbox-frontend/components/AccountLoginLink";
import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import {
  getLeaseStatusDisplayName,
  leaseExpirySortingComparator,
  leaseStatusSortingComparator,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useFreezeLease,
  useGetLeases,
  useTerminateLease,
  useUnfreezeLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { DateTime } from "luxon";

const filterOptions: SelectProps.Options = [
  {
    label: "Active",
    options: MonitoredLeaseStatusSchema.options.map((status) => ({
      label: getLeaseStatusDisplayName(status as LeaseStatus),
      value: status,
    })),
  },
  {
    label: "Pending",
    options: [
      {
        label: getLeaseStatusDisplayName(PendingLeaseStatusSchema.value),
        value: PendingLeaseStatusSchema.value,
      },
    ],
  },
  {
    label: "Expired",
    options: [
      ...ExpiredLeaseStatusSchema.options,
      ApprovalDeniedLeaseStatusSchema.value,
    ].map((status) => ({
      label: getLeaseStatusDisplayName(status as LeaseStatus),
      value: status,
    })),
  },
];

const UserCell = ({
  lease,
  includeLinks,
}: {
  lease: Lease;
  includeLinks: boolean;
}) =>
  includeLinks ? (
    <TextLink to={`/leases/${lease.leaseId}`}>{lease.userEmail}</TextLink>
  ) : (
    lease.userEmail
  );

const BudgetCell = ({ lease }: { lease: Lease }) => {
  return isMonitoredLease(lease) || isExpiredLease(lease) ? (
    <BudgetProgressBar
      currentValue={lease.totalCostAccrued}
      maxValue={lease.maxSpend}
    />
  ) : (
    "No costs accrued"
  );
};

const ExpiryCell = ({ lease }: { lease: Lease }) => {
  return <DurationStatus {...getLeaseExpiryInfo(lease)} />;
};

const AwsAccountCell = ({ lease }: { lease: Lease }) =>
  isMonitoredLease(lease) || isExpiredLease(lease) ? (
    lease.awsAccountId
  ) : (
    <StatusIndicator type="warning">No account assigned</StatusIndicator>
  );

const AccessCell = ({ lease }: { lease: Lease }) => (
  <>
    {isMonitoredLease(lease) && (
      <AccountLoginLink accountId={lease.awsAccountId} />
    )}
  </>
);

const CostReportGroupCell = ({ lease }: { lease: Lease }) => {
  return lease.costReportGroup ? (
    <span>{lease.costReportGroup}</span>
  ) : (
    <StatusIndicator type="info">Not assigned</StatusIndicator>
  );
};

// Helper function to check budget threshold breach risk
const checkBudgetThresholdRisk = (
  lease: Lease,
): {
  budgetRisk: boolean;
  budgetThreshold?: number;
} => {
  if (!isMonitoredLease(lease) || !lease.budgetThresholds) {
    return { budgetRisk: false };
  }

  const freezingBudgetThresholds = lease.budgetThresholds.filter(
    (threshold) => threshold.action === "FREEZE_ACCOUNT",
  );

  for (const threshold of freezingBudgetThresholds) {
    if (lease.totalCostAccrued >= threshold.dollarsSpent) {
      return { budgetRisk: true, budgetThreshold: threshold.dollarsSpent };
    }
  }

  return { budgetRisk: false };
};

// Helper function to check duration threshold breach risk
const checkDurationThresholdRisk = (
  lease: Lease,
): {
  durationRisk: boolean;
  durationThreshold?: number;
} => {
  if (
    !isMonitoredLease(lease) ||
    !lease.durationThresholds ||
    !lease.expirationDate
  ) {
    return { durationRisk: false };
  }

  const freezingDurationThresholds = lease.durationThresholds.filter(
    (threshold) => threshold.action === "FREEZE_ACCOUNT",
  );

  const expirationDate = DateTime.fromISO(lease.expirationDate);
  const hoursRemaining = expirationDate.diff(DateTime.now(), "hours").hours;

  for (const threshold of freezingDurationThresholds) {
    if (hoursRemaining <= threshold.hoursRemaining) {
      return {
        durationRisk: true,
        durationThreshold: threshold.hoursRemaining,
      };
    }
  }

  return { durationRisk: false };
};

// Helper function to detect if a frozen lease is likely to be re-frozen due to threshold breaches
const detectThresholdBreachRisk = (
  lease: Lease,
): {
  hasRisk: boolean;
  budgetRisk: boolean;
  durationRisk: boolean;
  budgetThreshold?: number;
  durationThreshold?: number;
} => {
  if (!isMonitoredLease(lease) || lease.status !== "Frozen") {
    return { hasRisk: false, budgetRisk: false, durationRisk: false };
  }

  const { budgetRisk, budgetThreshold } = checkBudgetThresholdRisk(lease);
  const { durationRisk, durationThreshold } = checkDurationThresholdRisk(lease);

  return {
    hasRisk: budgetRisk || durationRisk,
    budgetRisk,
    durationRisk,
    budgetThreshold,
    durationThreshold,
  };
};

type ActionModalContentProps = {
  selectedLeases: Lease[];
  action: "terminate" | "freeze" | "unfreeze";
  onAction: (leaseId: string) => Promise<any>;
  queryClient: any;
  setSelectedLeases: React.Dispatch<React.SetStateAction<Lease[]>>;
};

const UnfreezeWarningContent = ({
  selectedLeases,
}: {
  selectedLeases: Lease[];
}) => {
  const leasesWithRisk = selectedLeases
    .map((lease) => ({ lease, risk: detectThresholdBreachRisk(lease) }))
    .filter(({ risk }) => risk.hasRisk);

  if (leasesWithRisk.length === 0) {
    return null;
  }

  return (
    <Alert type="warning" header="Threshold Breach Warning">
      <SpaceBetween size="s">
        <p>
          The following lease(s) were likely frozen due to threshold breaches.
          Unfreezing them without extending the lease configuration may result
          in them being automatically re-frozen by the monitoring system:
        </p>
        {leasesWithRisk.map(({ lease, risk }) => (
          <Box key={lease.leaseId}>
            <strong>{lease.userEmail}</strong> -{" "}
            {lease.originalLeaseTemplateName}
            <ul style={{ marginTop: "4px", marginBottom: "0" }}>
              {risk.budgetRisk && (
                <li>
                  Budget threshold breached: $
                  {isMonitoredLease(lease)
                    ? lease.totalCostAccrued.toFixed(2)
                    : "0.00"}{" "}
                  ≥ ${risk.budgetThreshold?.toFixed(2)}
                </li>
              )}
              {risk.durationRisk && (
                <li>
                  Duration threshold breached: ≤ {risk.durationThreshold} hours
                  remaining
                </li>
              )}
            </ul>
          </Box>
        ))}
        <p>
          <strong>Recommendation:</strong> Consider extending the lease duration
          or budget limits before unfreezing to prevent automatic re-freezing.
          You can update lease configurations by selecting "Update" from the
          Actions menu.
        </p>
      </SpaceBetween>
    </Alert>
  );
};

const createColumnDefinitions = (includeLinks: boolean) =>
  [
    {
      id: "user",
      header: "User",
      sortingField: "userEmail",
      cell: (lease: Lease) => (
        <UserCell lease={lease} includeLinks={includeLinks} />
      ), // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "originalLeaseTemplateName",
      header: "Lease Template",
      sortingField: "originalLeaseTemplateName",
      cell: (lease: Lease) => lease.originalLeaseTemplateName,
    },
    {
      id: "blueprint",
      header: "Blueprint",
      sortingField: "blueprintName",
      // prettier-ignore
      cell: (lease: Lease) => <BlueprintName blueprintName={lease.blueprintName} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "costReportGroup",
      header: "Cost Report Group",
      sortingField: "costReportGroup",
      cell: (lease: Lease) => <CostReportGroupCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "budget",
      header: "Budget",
      sortingField: "totalCostAccrued",
      cell: (lease: Lease) => <BudgetCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "expirationDate",
      header: "Expiry",
      sortingComparator: leaseExpirySortingComparator,
      cell: (lease: Lease) => <ExpiryCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "status",
      header: "Status",
      sortingComparator: leaseStatusSortingComparator,
      cell: (lease: Lease) => <LeaseStatusBadge lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "awsAccountId",
      header: "AWS Account",
      sortingField: "awsAccountId",
      cell: (lease: Lease) => <AwsAccountCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "createdBy",
      header: "Created By",
      sortingField: "createdBy",
      cell: (lease: Lease) => lease.createdBy, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
    {
      id: "link",
      header: "Access",
      cell: (lease: Lease) => <AccessCell lease={lease} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
    },
  ].filter((column) => includeLinks || column.id !== "link");

const ActionModalContent = ({
  selectedLeases,
  action,
  onAction,
  queryClient,
  setSelectedLeases,
}: ActionModalContentProps) => {
  return (
    <SpaceBetween size="m">
      {action === "unfreeze" && (
        <UnfreezeWarningContent selectedLeases={selectedLeases} />
      )}
      <BatchActionReview
        items={selectedLeases}
        description={`${selectedLeases.length} lease(s) to ${action}`}
        columnDefinitions={createColumnDefinitions(false)}
        identifierKey="leaseId"
        sequential
        onSubmit={async (lease: Lease) => {
          await onAction(lease.leaseId);
          setSelectedLeases((prev) =>
            prev.filter((l) => l.leaseId !== lease.leaseId),
          );
        }}
        onSuccess={() => {
          queryClient.invalidateQueries({
            queryKey: ["leases"],
            refetchType: "all",
          });
          const actionMap = {
            freeze: "frozen",
            terminate: "terminated",
            unfreeze: "unfrozen",
          };
          showSuccessToast(`Leases(s) were ${actionMap[action]} successfully.`);
        }}
        onError={() =>
          showErrorToast(
            `One or more leases failed to ${action}, try resubmitting.`,
            `Failed to ${action} lease(s)`,
          )
        }
      />
    </SpaceBetween>
  );
};

export const ListLeases = () => {
  const navigate = useNavigate();
  const { setTools } = useAppLayoutContext();
  const setBreadcrumb = useBreadcrumb();
  const { isAdmin, isManager } = useUser();
  const [searchParams] = useSearchParams();
  const [filteredLeases, setFilteredLeases] = useState<Lease[]>([]);
  const [selectedLeases, setSelectedLeases] = useState<Lease[]>([]);
  const [leaseTemplates, setLeaseTemplates] = useState<SelectProps.Options>([]);
  const { showModal } = useModal();
  const queryClient = useQueryClient();

  // Get leaseId from URL if present
  const urlLeaseId = searchParams.get("leaseId");

  // default status filter to active leases
  const [statusFilter, setStatusFilter] = useState<SelectProps.Options>(
    (filterOptions[0] as SelectProps.OptionGroup).options,
  );
  const [leaseTemplateFilter, setLeaseTemplateFilter] =
    useState<SelectProps.Options>([]);

  const { data: leases, isFetching, refetch } = useGetLeases();

  const { mutateAsync: terminateLease } = useTerminateLease({
    skipInvalidation: true,
  });

  const { mutateAsync: freezeLease } = useFreezeLease({
    skipInvalidation: true,
  });

  const { mutateAsync: unfreezeLease } = useUnfreezeLease({
    skipInvalidation: true,
  });

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
    ]);
    setTools(<Markdown file="leases" />);
  }, []);

  const filterLeases = (leases: Lease[]) => {
    // filter by lease ID from URL if present
    if (urlLeaseId) {
      const matchedLease = leases.find((lease) => lease.leaseId === urlLeaseId);
      return matchedLease ? [matchedLease] : [];
    }

    // filter by status
    const filteredByStatus =
      statusFilter.length > 0
        ? leases.filter((lease) =>
            statusFilter.map((x) => x.value).includes(lease.status),
          )
        : leases;

    // filter by lease template
    const filterByLeaseTemplate =
      leaseTemplateFilter.length > 0
        ? filteredByStatus.filter((lease) =>
            leaseTemplateFilter
              .map((x) => x.value)
              .includes(lease.originalLeaseTemplateName),
          )
        : filteredByStatus;

    return filterByLeaseTemplate;
  };

  useEffect(() => {
    if (leases) {
      // get list of unique lease template names from list of leases
      const uniqueLeaseTemplateNames: string[] = [
        ...new Set(leases.map((lease) => lease.originalLeaseTemplateName)),
      ];
      const leaseTemplateOptions: SelectProps.Options =
        uniqueLeaseTemplateNames.map((type) => ({ value: type, label: type }));

      // populate lease template filter dropdown
      setLeaseTemplates(leaseTemplateOptions);

      // update filtered list of leases
      setFilteredLeases(filterLeases(leases));
    }
  }, [leases]);

  useEffect(() => {
    // update filtered list of leases
    setFilteredLeases(filterLeases(leases ?? []));
  }, [statusFilter, leaseTemplateFilter]);

  const handleSelectionChange = ({ detail }: { detail: any }) => {
    const approvals = detail.selectedItems as Lease[];
    setSelectedLeases(approvals);
  };

  const showTerminateModal = () => {
    showModal({
      header: "Terminate Lease(s)",
      content: (
        <ActionModalContent
          selectedLeases={selectedLeases}
          action="terminate"
          onAction={terminateLease}
          queryClient={queryClient}
          setSelectedLeases={setSelectedLeases}
        />
      ),
      size: "max",
    });
  };

  const showFreezeModal = () => {
    showModal({
      header: "Freeze Lease(s)",
      content: (
        <ActionModalContent
          selectedLeases={selectedLeases}
          action="freeze"
          onAction={freezeLease}
          queryClient={queryClient}
          setSelectedLeases={setSelectedLeases}
        />
      ),
      size: "max",
    });
  };

  const showUnfreezeModal = () => {
    showModal({
      header: "Unfreeze Lease(s)",
      content: (
        <ActionModalContent
          selectedLeases={selectedLeases}
          action="unfreeze"
          onAction={unfreezeLease}
          queryClient={queryClient}
          setSelectedLeases={setSelectedLeases}
        />
      ),
      size: "max",
    });
  };

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="leases" />}
          description="Manage sandbox account leases"
          actions={
            (isAdmin || isManager) && (
              <Button onClick={() => navigate("/assign")} variant="primary">
                Assign lease
              </Button>
            )
          }
        >
          Leases
        </Header>
      }
    >
      <SpaceBetween size="s">
        <Container header={<Header variant="h3">Filter Options</Header>}>
          <ColumnLayout columns={3}>
            <Box>
              <FormField label="Status" />
              <Multiselect
                data-testid="status-filter"
                selectedOptions={statusFilter}
                onChange={({ detail }) =>
                  setStatusFilter(
                    detail.selectedOptions as MultiselectProps.Option[],
                  )
                }
                options={filterOptions}
                placeholder="Choose options"
              />
            </Box>
            <Box>
              <FormField label="Lease Template" />
              <Multiselect
                selectedOptions={leaseTemplateFilter}
                onChange={({ detail }) =>
                  setLeaseTemplateFilter(
                    detail.selectedOptions as MultiselectProps.Option[],
                  )
                }
                options={leaseTemplates}
                placeholder="Choose options"
                loadingText="Loading..."
                empty="No leases found"
                statusType={isFetching ? "loading" : undefined}
              />
            </Box>
          </ColumnLayout>
        </Container>
        <Table
          stripedRows
          trackBy="leaseId"
          columnDefinitions={createColumnDefinitions(true)}
          stickyColumns={{ first: 1, last: 1 }}
          header="Leases"
          totalItemsCount={(filteredLeases || []).length}
          items={filteredLeases || []}
          selectedItems={selectedLeases}
          onSelectionChange={handleSelectionChange}
          loading={isFetching}
          actions={
            <SpaceBetween direction="horizontal" size="s">
              <Button
                iconName="refresh"
                ariaLabel="Refresh"
                onClick={() => refetch()}
                disabled={isFetching}
              />
              <ButtonDropdown
                disabled={selectedLeases.length === 0}
                items={[
                  {
                    text: "Terminate",
                    id: "terminate",
                    disabled: !selectedLeases.every(
                      (lease) =>
                        lease.status === "Active" || lease.status === "Frozen",
                    ),
                    disabledReason:
                      "Only active or frozen leases can be terminated.",
                  },
                  {
                    text: "Freeze",
                    id: "freeze",
                    disabled: !selectedLeases.every(
                      (lease) => lease.status === "Active",
                    ),
                    disabledReason: "Only active leases can be frozen.",
                  },
                  {
                    text: "Unfreeze",
                    id: "unfreeze",
                    disabled: !selectedLeases.every(
                      (lease) => lease.status === "Frozen",
                    ),
                    disabledReason: "Only frozen leases can be unfrozen.",
                  },
                  {
                    text: "Update",
                    id: "update",
                    disabled: selectedLeases.length > 1,
                    disabledReason:
                      "Only a single lease can be updated at a time.",
                  },
                ]}
                onItemClick={({ detail }) => {
                  switch (detail.id) {
                    case "terminate":
                      showTerminateModal();
                      break;
                    case "freeze":
                      showFreezeModal();
                      break;
                    case "unfreeze":
                      showUnfreezeModal();
                      break;
                    case "update":
                      navigate(`/leases/${selectedLeases[0].leaseId}`);
                      break;
                  }
                }}
              >
                Actions
              </ButtonDropdown>
            </SpaceBetween>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

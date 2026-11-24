// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Button,
  Header,
  SpaceBetween,
  Tabs,
} from "@cloudscape-design/components";
import { type ComponentProps, useEffect } from "react";
import { useNavigate, useParams, useSearchParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import { AssignmentsTab } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsTab";
import { CostSection } from "@amzn/innovation-sandbox-frontend/domains/leases/components/CostSection";
import { LeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseActions";
import { LeaseSummary } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseSummary";
import {
  generateBreadcrumb,
  getLeaseDisplayName,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  type ExpiredLeaseView,
  type LeaseView,
  type MonitoredLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { useLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/useLeaseActions";
import {
  isSandboxSpaceAssignee,
  isSandboxSpaceAvailable,
  isSandboxSpacesGloballyUsable,
  SANDBOX_SPACE_ASSIGNEE_ONLY_REASON,
  sandboxSpacePath,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  DEFAULT_GROUP_ASSIGNMENT_MODE,
  type GroupAssignmentMode,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  isActiveLease,
  isExpiredLease,
  isFrozenLease,
  isMonitoredLease,
  type Lease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { getUserEmail } from "@amzn/innovation-sandbox-shared/utils/auth-utils";

const DEFAULT_LEASE_DETAILS_TAB_ID = "summary";

export const LeaseDetails = () => {
  const { leaseId } = useParams();
  const setBreadcrumb = useBreadcrumb();
  const { isAdmin, isManager, user } = useUser();

  // Poll while a lock is held so the lock-gated header actions re-enable on
  // their own once the Assignment Processor finishes.
  const query = useGetLeaseById(leaseId, { pollWhileLocked: true });
  const { data: lease, isLoading, refetch, error } = query;

  const {
    isLoading: isLoadingConfig,
    isError: isConfigError,
    data: config,
    refetch: refetchConfig,
    error: configError,
  } = useGetConfigurations();

  const isAdminOrManager = isAdmin || isManager;

  // Details page is the operator surface for a single lease, so it opts in to
  // the Admin/Manager-only freeze/unfreeze controls.
  const { hasAnyAction } = useLeaseActions(lease, {
    includeElevatedActions: true,
  });

  // Update breadcrumb with lease details
  useEffect(() => {
    const breadcrumb = generateBreadcrumb(query, {
      isUserView: !isAdminOrManager,
    });
    setBreadcrumb(breadcrumb);
  }, [query.isLoading, setBreadcrumb, isAdminOrManager]);

  if (isLoading || isLoadingConfig) {
    return (
      <ContentLayout>
        <Loader />
      </ContentLayout>
    );
  }

  // Only where no lease has loaded: a refresh that fails after one has, such as the
  // lock poll's or the cost section's, keeps the last lease on screen rather than
  // replacing the page and the ranges picked on it.
  if (!lease) {
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
          error={configError}
        />
      </ContentLayout>
    );
  }

  const leaseSharingEnabled = config?.leases.leaseSharingEnabled || false;
  const enablePrincipalSearch = config?.leases.enablePrincipalSearch ?? false;
  const groupAssignmentMode =
    config?.leases.groupAssignmentMode ?? DEFAULT_GROUP_ASSIGNMENT_MODE;
  const sandboxSpacesEnabled = isSandboxSpacesGloballyUsable(
    config?.agent.sandboxSpacesEnabled,
  );

  return (
    <LeaseDetailsView
      lease={lease}
      leaseId={leaseId}
      isAdminOrManager={isAdminOrManager}
      hasAnyAction={hasAnyAction}
      user={user}
      leaseSharingEnabled={leaseSharingEnabled}
      sandboxSpacesEnabled={sandboxSpacesEnabled}
      enablePrincipalSearch={enablePrincipalSearch}
      groupAssignmentMode={groupAssignmentMode}
    />
  );
};

// Only a lease that has been monitored carries it.
const lastEvaluatedSpendOf = (lease: LeaseView): number | undefined =>
  "lastEvaluatedSpend" in lease
    ? (lease.lastEvaluatedSpend ?? undefined)
    : undefined;

// Convert the lease model to the cost component's focused interface without
// adding lease lifecycle concerns to CostSection.
const costSectionPropsOf = (
  lease: MonitoredLeaseView | ExpiredLeaseView,
): ComponentProps<typeof CostSection> => {
  // The span the cost chart covers when the whole lease was requested. A lease
  // that has ended ends where it ended; one still running ends at its expiry,
  // and one with no duration set has no end to give.
  const record: Lease = lease;
  const leaseEndedAt = isExpiredLease(record) ? record.endDate : undefined;
  const leaseExpiresAt =
    "expirationDate" in lease ? lease.expirationDate : undefined;
  const leaseEnd = leaseEndedAt ?? leaseExpiresAt;

  return {
    leaseId: lease.leaseId,
    predictiveBudgetEnabled: lease.predictiveBudgetEnabled ?? false,
    bedrockTokenMonitoringEnabled: lease.bedrockTokenMonitoringEnabled ?? false,
    maxSpend: lease.maxSpend,
    budgetThresholds: lease.budgetThresholds,
    leaseSpan: {
      from: lease.startDate,
      ...(leaseEnd === undefined ? {} : { to: leaseEnd }),
    },
    ...(leaseEndedAt === undefined ? {} : { leaseEndedAt }),
    lastEvaluatedSpend: lastEvaluatedSpendOf(lease),
  };
};

// Presentational view for a successfully-loaded lease; the parent handles data
// fetching and loading/error states.
const LeaseDetailsView = ({
  lease,
  leaseId,
  isAdminOrManager,
  hasAnyAction,
  user,
  leaseSharingEnabled,
  sandboxSpacesEnabled,
  enablePrincipalSearch,
  groupAssignmentMode,
}: {
  lease: LeaseView;
  leaseId: string | undefined;
  isAdminOrManager: boolean;
  hasAnyAction: boolean;
  user: ReturnType<typeof useUser>["user"];
  leaseSharingEnabled: boolean;
  sandboxSpacesEnabled: boolean;
  enablePrincipalSearch: boolean;
  groupAssignmentMode: GroupAssignmentMode;
}) => {
  const navigate = useNavigate();
  const { setTools } = useAppLayoutContext();
  const [searchParams, setSearchParams] = useSearchParams();
  const viewerEmail = user ? getUserEmail(user) : undefined;
  const isOwner = viewerEmail === lease.userEmail;

  // Edit controls route to admin-only pages, so only managers/admins get them.
  // They also only apply to monitored (Active/Frozen) leases.
  const showEditButtons = isAdminOrManager && isMonitoredLease(lease);
  const showOpenSpaceAction =
    !!leaseId && isSandboxSpaceAvailable(lease) && sandboxSpacesEnabled;
  const openSpaceDisabledReason = isSandboxSpaceAssignee(lease, user)
    ? undefined
    : SANDBOX_SPACE_ASSIGNEE_ONLY_REASON;

  // Only a lease that has held an account has account details to show. Owners
  // can read their own; Admins and Managers can read any lease.
  const showAccountDetails =
    (isActiveLease(lease) || isFrozenLease(lease) || isExpiredLease(lease)) &&
    (isAdminOrManager || isOwner);

  // All four edit controls share the same show/hide rule; only the target
  // route differs.
  const makeEditHandler = (path: string) =>
    showEditButtons ? () => navigate(path) : undefined;

  const summary = (
    <LeaseSummary
      lease={lease}
      showEditButtons={showEditButtons}
      showAdminFields={isAdminOrManager}
      leaseSharingEnabled={leaseSharingEnabled}
      sandboxSpacesEnabled={sandboxSpacesEnabled}
      onEditBudget={makeEditHandler(`/leases/${leaseId}/edit/budget`)}
      onEditDuration={makeEditHandler(`/leases/${leaseId}/edit/duration`)}
      onEditCostReport={makeEditHandler(`/leases/${leaseId}/edit/cost-report`)}
      onEditSandboxSpaces={makeEditHandler(
        `/leases/${leaseId}/edit/sandbox-spaces`,
      )}
      onEditAccessSettings={makeEditHandler(`/leases/${leaseId}/edit/access`)}
    />
  );

  const tabs = [
    {
      id: DEFAULT_LEASE_DETAILS_TAB_ID,
      label: "Summary",
      content: summary,
      helpPanel: "lease-details",
    },
    ...(showAccountDetails
      ? [
          {
            id: "cost",
            label: "Cost",
            content: <CostSection {...costSectionPropsOf(lease)} />,
            helpPanel: "lease-cost",
          },
          {
            id: "assignments",
            label: "Assignments",
            content: (
              <AssignmentsTab
                lease={lease}
                leaseRouteId={leaseId!}
                leaseSharingEnabled={leaseSharingEnabled}
                enablePrincipalSearch={enablePrincipalSearch}
                isElevated={isAdminOrManager}
                groupAssignmentMode={groupAssignmentMode}
                isOwner={isOwner}
              />
            ),
            helpPanel: "assignments",
          },
        ]
      : []),
  ];
  const requestedTab = searchParams.get("tab");
  const activeTab = tabs.find(({ id }) => id === requestedTab) ?? tabs[0];

  useEffect(() => {
    setTools(<Markdown file={activeTab.helpPanel} />);
  }, [activeTab.helpPanel, setTools]);

  useEffect(() => {
    if (requestedTab !== null && requestedTab !== activeTab.id) {
      const nextSearchParams = new URLSearchParams(searchParams);
      nextSearchParams.delete("tab");
      setSearchParams(nextSearchParams, { replace: true });
    }
  }, [activeTab.id, requestedTab, searchParams, setSearchParams]);

  const handleActiveTabChange = (nextTabId: string) => {
    const nextSearchParams = new URLSearchParams(searchParams);
    if (nextTabId === DEFAULT_LEASE_DETAILS_TAB_ID) {
      nextSearchParams.delete("tab");
    } else {
      nextSearchParams.set("tab", nextTabId);
    }
    setSearchParams(nextSearchParams, { replace: true });
  };

  return (
    <ContentLayout
      header={
        <Header
          variant="h1"
          actions={
            showOpenSpaceAction || hasAnyAction ? (
              <SpaceBetween direction="horizontal" size="xs">
                {showOpenSpaceAction && (
                  <Button
                    iconName="gen-ai"
                    disabled={!!openSpaceDisabledReason}
                    disabledReason={openSpaceDisabledReason}
                    onClick={() => navigate(sandboxSpacePath(leaseId))}
                  >
                    Open Space
                  </Button>
                )}
                {hasAnyAction && (
                  <LeaseActions lease={lease} includeElevatedActions />
                )}
              </SpaceBetween>
            ) : undefined
          }
        >
          {getLeaseDisplayName(lease)}
        </Header>
      }
    >
      {tabs.length > 1 ? (
        <Tabs
          activeTabId={activeTab.id}
          onChange={({ detail }) => handleActiveTabChange(detail.activeTabId)}
          tabs={tabs}
        />
      ) : (
        activeTab.content
      )}
    </ContentLayout>
  );
};

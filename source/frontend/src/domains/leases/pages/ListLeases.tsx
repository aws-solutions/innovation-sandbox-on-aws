// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Header,
  SpaceBetween,
  Tabs,
} from "@cloudscape-design/components";
import { useEffect, useMemo } from "react";
import { useNavigate, useSearchParams } from "react-router-dom";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { FilterableTable } from "@amzn/innovation-sandbox-frontend/components/FilterableTable";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  DEFAULT_VISIBLE_COLUMNS,
  getDefaultStatusFilterQuery,
  getLeaseColumnDefinitions,
  getLeaseFilteringProperties,
  LeaseTableItem,
} from "@amzn/innovation-sandbox-frontend/domains/leases/components/leaseTableConfig";
import { useBulkLeaseActions } from "@amzn/innovation-sandbox-frontend/domains/leases/components/useBulkLeaseActions";
import {
  enrichLeasesWithName,
  isLeaseOwner,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useGetLeases,
  useGetSharedLeases,
  useLeasesForCurrentUser,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  LeaseView,
  SharedLeaseAccessType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import {
  isSandboxSpacesGloballyUsable,
  sandboxSpacePath,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

type LeaseTab = "all" | "my" | "shared";

/**
 * Merges multiple lease sources into a single deduped list with access type
 * annotations. Sources are processed in priority order — first occurrence wins.
 */
function mergeWithAccessType(
  sources: { leases: LeaseView[]; accessType: SharedLeaseAccessType }[],
): LeaseTableItem[] {
  const seen = new Set<string>();
  const result: LeaseTableItem[] = [];
  for (const { leases, accessType } of sources) {
    for (const lease of leases) {
      const key = lease.leaseId ?? lease.uuid;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...lease, accessType });
      }
    }
  }
  return result;
}

function getTabLabels(
  tab: LeaseTab,
  isElevated: boolean,
): { title: string; description: string; emptyText: string } {
  switch (tab) {
    case "all":
      return {
        title: "All Leases",
        description: isElevated
          ? "All sandbox account leases across the organization"
          : "All sandbox accounts you can access",
        emptyText: "No leases found.",
      };
    case "my":
      return {
        title: "My Leases",
        description: "Sandbox accounts that you own",
        emptyText: "You don't have any leases yet.",
      };
    case "shared":
      return {
        title: "Shared with me",
        description: "Sandbox accounts that others have shared with you",
        emptyText: "No shared leases found.",
      };
  }
}

export const ListLeases = () => {
  const navigate = useNavigate();
  const { setTools } = useAppLayoutContext();
  const setBreadcrumb = useBreadcrumb();
  const { isAdmin, isManager } = useUser();
  const [searchParams, setSearchParams] = useSearchParams();

  const isElevated = isAdmin || isManager;
  const activeTab = (searchParams.get("tab") ?? "all") as LeaseTab;

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Leases", href: "/leases" },
    ]);
    setTools(<Markdown file="leases" />);
  }, []);

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          info={<InfoLink markdown="leases" />}
          description="Manage sandbox account leases"
          actions={
            <SpaceBetween direction="horizontal" size="s">
              <Button onClick={() => navigate("/request")} variant="normal">
                Request lease
              </Button>
              {isElevated && (
                <Button onClick={() => navigate("/assign")} variant="normal">
                  Assign lease
                </Button>
              )}
            </SpaceBetween>
          }
        >
          Leases
        </Header>
      }
    >
      <Tabs
        activeTabId={activeTab}
        onChange={({ detail }) => setSearchParams({ tab: detail.activeTabId })}
        tabs={[
          {
            id: "all",
            label: "All Leases",
            content: (
              <LeaseTabContent
                tab="all"
                isAdmin={isAdmin}
                isElevated={isElevated}
                isManager={isManager}
              />
            ),
          },
          {
            id: "my",
            label: "My Leases",
            content: (
              <LeaseTabContent
                tab="my"
                isAdmin={isAdmin}
                isElevated={isElevated}
                isManager={isManager}
              />
            ),
          },
          {
            id: "shared",
            label: "Shared with me",
            content: (
              <LeaseTabContent
                tab="shared"
                isAdmin={isAdmin}
                isElevated={isElevated}
                isManager={isManager}
              />
            ),
          },
        ]}
      />
    </ContentLayout>
  );
};

interface LeaseTabContentProps {
  tab: LeaseTab;
  isAdmin: boolean;
  isElevated: boolean;
  isManager: boolean;
}

/**
 * Single component that renders the FilterableTable with parameters based on
 * the active tab and user role.
 */
const LeaseTabContent = ({
  tab,
  isAdmin,
  isElevated,
  isManager,
}: LeaseTabContentProps) => {
  const { user } = useUser();
  const navigate = useNavigate();
  const { data: config } = useGetConfigurations();
  const { selectionType, selectedItems, onSelectionChange, headerActions } =
    useBulkLeaseActions();

  // ─── Data fetching (hooks are always called; conditional logic is in useMemo) ─

  const {
    data: allLeases,
    isFetching: isAllFetching,
    isError: isAllError,
    refetch: refetchAll,
  } = useGetLeases({ enabled: isElevated });

  const {
    data: myLeases,
    isFetching: isMyFetching,
    isError: isMyError,
    refetch: refetchMy,
  } = useLeasesForCurrentUser();

  const {
    data: directData,
    isFetching: isDirectFetching,
    isError: isDirectError,
    refetch: refetchDirect,
  } = useGetSharedLeases("direct");

  const {
    data: groupData,
    isFetching: isGroupFetching,
    isError: isGroupError,
    refetch: refetchGroup,
  } = useGetSharedLeases("group");

  // Stabilize references for useMemo dependency array
  const directLeaseResults = directData?.result;
  const groupLeaseResults = groupData?.result;

  // ─── Derived state based on tab + role ──────────────────────────────────────

  const { items, isFetching, isError, refetch } = useMemo(() => {
    if (tab === "all" && isElevated) {
      // Admin/Manager "All": priority order owner > direct > group > global
      return {
        items: mergeWithAccessType([
          { leases: myLeases ?? [], accessType: "owner" },
          { leases: directLeaseResults ?? [], accessType: "direct" },
          { leases: groupLeaseResults ?? [], accessType: "group" },
          { leases: allLeases ?? [], accessType: "global" },
        ]),
        isFetching:
          isAllFetching || isMyFetching || isDirectFetching || isGroupFetching,
        isError: isAllError || isMyError || isDirectError || isGroupError,
        refetch: () => {
          refetchAll();
          refetchMy();
          refetchDirect();
          refetchGroup();
        },
      };
    }

    if (tab === "my") {
      return {
        items: mergeWithAccessType([
          { leases: myLeases ?? [], accessType: "owner" },
        ]),
        isFetching: isMyFetching,
        isError: isMyError,
        refetch: refetchMy,
      };
    }

    if (tab === "all") {
      // Non-elevated "All": owner > direct > group
      return {
        items: mergeWithAccessType([
          { leases: myLeases ?? [], accessType: "owner" },
          { leases: directLeaseResults ?? [], accessType: "direct" },
          { leases: groupLeaseResults ?? [], accessType: "group" },
        ]),
        isFetching: isMyFetching || isDirectFetching || isGroupFetching,
        isError: isMyError || isDirectError || isGroupError,
        refetch: () => {
          refetchMy();
          refetchDirect();
          refetchGroup();
        },
      };
    }

    // "Shared with me": direct + group, excluding leases the user owns
    const shared = mergeWithAccessType([
      { leases: directLeaseResults ?? [], accessType: "direct" },
      { leases: groupLeaseResults ?? [], accessType: "group" },
    ]).filter((lease) => !isLeaseOwner(lease, user));

    return {
      items: shared,
      isFetching: isDirectFetching || isGroupFetching,
      isError: isDirectError || isGroupError,
      refetch: () => {
        refetchDirect();
        refetchGroup();
      },
    };
  }, [
    tab,
    isElevated,
    allLeases,
    myLeases,
    directLeaseResults,
    groupLeaseResults,
    isAllFetching,
    isMyFetching,
    isDirectFetching,
    isGroupFetching,
    isAllError,
    isMyError,
    isDirectError,
    isGroupError,
    user,
  ]);

  const { title, description, emptyText } = getTabLabels(tab, isElevated);

  const enrichedItems = useMemo(() => enrichLeasesWithName(items), [items]);

  return (
    <FilterableTable<LeaseTableItem>
      title={title}
      description={description}
      items={enrichedItems}
      columnDefinitions={getLeaseColumnDefinitions(
        { isAdmin, isManager },
        isSandboxSpacesGloballyUsable(config?.agent.sandboxSpacesEnabled)
          ? {
              user,
              onOpenSpace: (lease) => navigate(sandboxSpacePath(lease.leaseId)),
            }
          : undefined,
      )}
      filteringProperties={getLeaseFilteringProperties()}
      loading={isFetching}
      loadingText={`Loading ${title.toLowerCase()}...`}
      trackBy="leaseId"
      selectionType={selectionType}
      selectedItems={selectedItems}
      onSelectionChange={onSelectionChange}
      onRefresh={() => refetch()}
      isError={isError}
      errorContent={
        <Box textAlign="center" color="inherit" padding="l">
          <Alert
            type="error"
            header={`Failed to load ${title.toLowerCase()}`}
            action={<Button onClick={() => refetch()}>Retry</Button>}
          >
            An error occurred while fetching leases.
          </Alert>
        </Box>
      }
      defaultVisibleColumns={DEFAULT_VISIBLE_COLUMNS}
      defaultFilteringQuery={getDefaultStatusFilterQuery()}
      headerActions={headerActions}
      emptyContent={
        <Box textAlign="center" color="inherit" variant="p">
          {emptyText}
        </Box>
      }
    />
  );
};

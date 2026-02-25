// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Box,
  Button,
  ButtonDropdown,
  CollectionPreferences,
  Header,
  Pagination,
  SpaceBetween,
  Table,
  TextFilter,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { DateTime } from "luxon";
import { useMemo, useState } from "react";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

import { DeploymentHistory } from "@amzn/innovation-sandbox-frontend/domains/blueprints/components/DeploymentHistory";
import { deploymentSuccessRateSortingComparator } from "@amzn/innovation-sandbox-frontend/domains/blueprints/helpers";
import {
  useGetBlueprints,
  useUnregisterBlueprints,
} from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import { Blueprint } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";

const NameCell = ({ item }: { item: Blueprint }) => (
  <Box>
    <TextLink to={`/blueprints/${item.blueprintId}`}>{item.name}</TextLink>
  </Box>
);

const DeploymentSuccessCell = ({ item }: { item: Blueprint }) => {
  const { totalDeploymentCount, totalSuccessfulCount } =
    item.totalHealthMetrics;

  if (totalDeploymentCount === 0) {
    return <Box>-</Box>;
  }

  return (
    <Box>
      {totalSuccessfulCount} / {totalDeploymentCount}
    </Box>
  );
};

const LastDeploymentCell = ({ item }: { item: Blueprint }) => {
  if (!item.totalHealthMetrics.lastDeploymentAt) {
    return <Box>-</Box>;
  }

  return (
    <Box>
      {DateTime.fromISO(item.totalHealthMetrics.lastDeploymentAt).toRelative()}
    </Box>
  );
};

export const BlueprintTable = () => {
  const { isAdmin } = useUser();
  const { showModal } = useModal();
  const queryClient = useQueryClient();
  const {
    data: response,
    isFetching,
    isError,
    refetch,
    error: getError,
  } = useGetBlueprints();

  const [preferences, setPreferences] = useState({
    pageSize: 10,
    visibleContent: [
      "name",
      "createdBy",
      "deploymentSuccess",
      "deploymentHistory",
      "lastDeployment",
      "deploymentTimeout",
      "meta.lastEditTime",
    ],
  });

  const [selectedItems, setSelectedItems] = useState<Blueprint[]>([]);

  const { mutateAsync: unregisterBlueprint } = useUnregisterBlueprints({
    skipInvalidation: true,
  });

  const allBlueprints: Blueprint[] =
    response?.blueprints?.map((b) => ({
      ...b.blueprint,
      recentDeployments: b.recentDeployments,
    })) || [];

  // Use Cloudscape collection hooks for filtering, sorting, and pagination (NOT selection)
  // Note: useCollection's selection feature returns readonly arrays which cause TypeScript conflicts
  // with Table component's mutable selectedItems prop.
  const {
    items,
    actions,
    filteredItemsCount,
    collectionProps,
    filterProps,
    paginationProps,
  } = useCollection(allBlueprints, {
    filtering: {
      empty: (
        <Box textAlign="center" color="inherit" variant="p">
          No blueprints found
        </Box>
      ),
      noMatch: (
        <Box textAlign="center" color="inherit">
          <Box variant="p">No matches</Box>
          <Button onClick={() => actions.setFiltering("")}>Clear filter</Button>
        </Box>
      ),
    },
    pagination: { pageSize: preferences.pageSize },
    sorting: {},
  });

  const columnDefinitions = useMemo(
    () => [
      {
        id: "name",
        header: "Name",
        sortingField: "name",
        cell: (item: Blueprint) => <NameCell item={item} />, // NOSONAR typescript:S6478 - Table API requires cell render functions
      },
      {
        id: "createdBy",
        header: "Created by",
        sortingField: "createdBy",
        cell: (item: Blueprint) => item.createdBy,
      },
      {
        id: "deploymentSuccess",
        header: "Successful deployments",
        sortingComparator: deploymentSuccessRateSortingComparator,
        cell: (item: Blueprint) => <DeploymentSuccessCell item={item} />, // NOSONAR typescript:S6478 - Table API requires cell render functions
      },
      {
        id: "deploymentHistory",
        header: "Deployment history",
        // prettier-ignore
        cell: (item: Blueprint) => ( // NOSONAR typescript:S6478 - Table API requires cell render functions
          <DeploymentHistory deployments={item.recentDeployments} />
        ),
      },
      {
        id: "lastDeployment",
        header: "Last deployment",
        sortingComparator: createDateSortingComparator<Blueprint>(
          (a) => a.totalHealthMetrics.lastDeploymentAt,
        ),
        cell: (item: Blueprint) => <LastDeploymentCell item={item} />, // NOSONAR typescript:S6478 - Table API requires cell render functions
      },
      {
        id: "deploymentTimeout",
        header: "Timeout",
        sortingField: "deploymentTimeoutMinutes",
        cell: (item: Blueprint) => `${item.deploymentTimeoutMinutes} min`,
      },
      {
        id: "meta.lastEditTime",
        header: "Last updated",
        sortingComparator: createDateSortingComparator<Blueprint>(
          (a) => a.meta?.lastEditTime,
        ),
        cell: (item: Blueprint) =>
          item.meta?.lastEditTime
            ? DateTime.fromISO(item.meta.lastEditTime).toRelative()
            : "",
      },
    ],
    [],
  );

  const showUnregisterModal = () => {
    showModal({
      header: `Unregister blueprint${selectedItems.length > 1 ? "s" : ""}`,
      content: (
        <BatchActionReview
          items={selectedItems}
          description={`${selectedItems.length} blueprint${selectedItems.length > 1 ? "s" : ""} to unregister. This will remove ${selectedItems.length > 1 ? "them" : "it"} from Innovation Sandbox but will not delete the underlying StackSet${selectedItems.length > 1 ? "s" : ""}.`}
          columnDefinitions={[
            {
              id: "name",
              header: "Name",
              cell: (item: Blueprint) => item.name,
            },
            {
              id: "createdBy",
              header: "Created By",
              cell: (item: Blueprint) => item.createdBy,
            },
          ]}
          identifierKey="blueprintId"
          sequential
          onSubmit={async (blueprint: Blueprint) => {
            await unregisterBlueprint([blueprint.blueprintId]);
            setSelectedItems((prev) =>
              prev.filter((b) => b.blueprintId !== blueprint.blueprintId),
            );
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({
              queryKey: ["blueprints"],
              refetchType: "all",
            });
            showSuccessToast(
              `Blueprint${selectedItems.length > 1 ? "s" : ""} unregistered successfully`,
            );
          }}
          onError={() => {
            queryClient.invalidateQueries({
              queryKey: ["blueprints"],
              refetchType: "all",
            });
            showErrorToast(
              "One or more blueprints failed to unregister. Try resubmitting.",
              "Unregister failed",
            );
          }}
        />
      ),
      size: "large",
    });
  };

  if (isError) {
    return (
      <ErrorPanel
        retry={refetch}
        description="Could not load blueprints. Please try again."
        error={getError as Error}
      />
    );
  }

  return (
    <Table
      variant="container"
      stripedRows
      resizableColumns
      trackBy="blueprintId"
      loading={isFetching}
      loadingText="Loading blueprints..."
      selectionType="multi"
      selectedItems={selectedItems}
      onSelectionChange={({ detail }) => setSelectedItems(detail.selectedItems)}
      sortingColumn={collectionProps.sortingColumn}
      sortingDescending={collectionProps.sortingDescending}
      onSortingChange={collectionProps.onSortingChange}
      empty={
        <Box textAlign="center" color="inherit" variant="p">
          No blueprints found
        </Box>
      }
      filter={
        <TextFilter
          {...filterProps}
          filteringPlaceholder="Find blueprints"
          filteringAriaLabel="Filter blueprints"
          countText={`${filteredItemsCount} ${filteredItemsCount === 1 ? "match" : "matches"}`}
        />
      }
      header={
        <Header
          variant="h2"
          actions={
            <SpaceBetween direction="horizontal" size="s">
              <Button
                data-testid="refresh-button"
                iconName="refresh"
                ariaLabel="Refresh"
                onClick={() => refetch()}
                disabled={isFetching}
              />
              {isAdmin && (
                <ButtonDropdown
                  disabled={selectedItems.length === 0}
                  items={[
                    {
                      text: "Unregister",
                      id: "unregister",
                    },
                  ]}
                  onItemClick={({ detail }) => {
                    if (detail.id === "unregister") {
                      showUnregisterModal();
                    }
                  }}
                >
                  Actions
                </ButtonDropdown>
              )}
            </SpaceBetween>
          }
        >
          Blueprints
        </Header>
      }
      items={items}
      columnDefinitions={columnDefinitions}
      pagination={<Pagination {...paginationProps} />}
      preferences={
        <CollectionPreferences
          title="Preferences"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          preferences={{
            pageSize: preferences.pageSize,
            visibleContent: preferences.visibleContent,
          }}
          onConfirm={({ detail }) =>
            setPreferences({
              pageSize: detail.pageSize ?? preferences.pageSize,
              visibleContent: detail.visibleContent
                ? [...detail.visibleContent]
                : preferences.visibleContent,
            })
          }
          pageSizePreference={{
            title: "Page size",
            options: [
              { value: 10, label: "10 rows" },
              { value: 20, label: "20 rows" },
              { value: 30, label: "30 rows" },
              { value: 50, label: "50 rows" },
            ],
          }}
          visibleContentPreference={{
            title: "Select visible columns",
            options: [
              {
                label: "Main properties",
                options: columnDefinitions.map((col) => ({
                  id: col.id,
                  label: typeof col.header === "string" ? col.header : col.id,
                  editable: col.id !== "name",
                })),
              },
            ],
          }}
        />
      }
    />
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Header,
  Link,
  SpaceBetween,
  TextFilter,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useRef, useState } from "react";

import { useAppLayoutContext } from "@amzn/innovation-sandbox-frontend/components/AppLayout/AppLayoutContext";
import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  FilterableColumnDefinition,
  FilterableTable,
} from "@amzn/innovation-sandbox-frontend/components/FilterableTable";
import { InfoLink } from "@amzn/innovation-sandbox-frontend/components/InfoLink";
import { Markdown } from "@amzn/innovation-sandbox-frontend/components/Markdown";
import {
  PERMISSION_SETS_PAGE_SIZE,
  PERMISSION_SETS_QUERY_MAX_LENGTH,
  usePermissionSets,
} from "@amzn/innovation-sandbox-frontend/domains/permissionSets/hooks";
import type { PermissionSetView } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/model";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import {
  permissionSetCatalogConsoleUrl,
  permissionSetDetailsConsoleUrl,
} from "@amzn/innovation-sandbox-shared/utils/permission-set";

const boundedFilterText = (value: string) =>
  value.slice(0, PERMISSION_SETS_QUERY_MAX_LENGTH);

const isInvalidPageIdentifierError = (error: unknown) =>
  error instanceof ApiError &&
  error.statusCode === 400 &&
  Array.isArray(error.data?.errors) &&
  error.data.errors.some(
    (errorDetail) =>
      typeof errorDetail === "object" &&
      errorDetail !== null &&
      "field" in errorDetail &&
      errorDetail.field === "pageIdentifier",
  );

function getCatalogErrorHeader(
  isFetchNextPageError: boolean,
  error: unknown,
): string {
  if (!isFetchNextPageError) {
    return "The catalog could not be refreshed.";
  }
  if (isInvalidPageIdentifierError(error)) {
    return "The catalog changed while loading the next page.";
  }
  return "The next page could not be loaded.";
}

const PAGE_SIZE_OPTIONS = [
  { value: 10, label: "10 rows" },
  { value: 20, label: "20 rows" },
  { value: 30, label: "30 rows" },
  { value: 50, label: "50 rows" },
];

const createColumnDefinitions = (
  region: string,
  showConsoleLinks: boolean,
): FilterableColumnDefinition<PermissionSetView>[] => [
  {
    id: "name",
    header: "Name",
    cell: (item) =>
      showConsoleLinks ? (
        <Link
          external
          href={permissionSetDetailsConsoleUrl({
            region,
            permissionSetArn: item.permissionSetArn,
          })}
        >
          {item.name}
        </Link>
      ) : (
        item.name
      ),
  },
  {
    id: "description",
    header: "Description",
    cell: (item) => item.description ?? "—",
  },
  {
    id: "sessionDuration",
    header: "Session duration",
    cell: (item) => item.sessionDuration ?? "Not specified",
  },
];

export function ListPermissionSets() {
  const [filterText, setFilterText] = useState("");
  const [queryText, setQueryText] = useState("");
  const [pageSize, setPageSize] = useState(PERMISSION_SETS_PAGE_SIZE);
  const [currentPageIndex, setCurrentPageIndex] = useState(1);
  const currentCatalogRequestRef = useRef({ queryText, pageSize });
  const setBreadcrumb = useBreadcrumb();
  const { setTools } = useAppLayoutContext();
  const { isAdmin } = useUser();
  const region = getConfig().Region;
  const {
    data,
    permissionSets,
    error,
    fetchNextPage,
    hasNextPage,
    isFetchNextPageError,
    isFetching,
    isFetchingNextPage,
    isLoading,
    isLoadingError,
    isRefetchError,
    refetch,
    reloadCatalog,
  } = usePermissionSets(queryText, { pageSize });
  const permissionSetPages = data?.pages ?? [];
  const currentPermissionSets =
    permissionSetPages[currentPageIndex - 1]?.result ?? [];
  const isFilterPending = filterText.trim() !== queryText.trim();
  let emptyStateText = "No registered permission sets were found.";
  if (isLoadingError) {
    emptyStateText = "Permission sets could not be loaded.";
  } else if (filterText.trim()) {
    emptyStateText = "No permission sets match the filter.";
  }

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Permission Sets", href: "/permission-sets" },
    ]);
    setTools(<Markdown file="permission-sets" />);
  }, [setBreadcrumb, setTools]);

  useEffect(() => {
    currentCatalogRequestRef.current = { queryText, pageSize };
    setCurrentPageIndex(1);
  }, [pageSize, queryText]);

  useEffect(() => {
    setCurrentPageIndex((pageIndex) =>
      Math.min(pageIndex, Math.max(permissionSetPages.length, 1)),
    );
  }, [permissionSetPages.length]);

  const columnDefinitions = useMemo(
    () => createColumnDefinitions(region, isAdmin),
    [isAdmin, region],
  );

  const changePage = async (requestedPageIndex: number) => {
    if (requestedPageIndex <= permissionSetPages.length) {
      setCurrentPageIndex(requestedPageIndex);
      return;
    }

    if (!hasNextPage) {
      return;
    }

    const requestedCatalog = { queryText, pageSize };
    const result = await fetchNextPage();
    if (
      currentCatalogRequestRef.current.queryText ===
        requestedCatalog.queryText &&
      currentCatalogRequestRef.current.pageSize === requestedCatalog.pageSize &&
      (result.data?.pages.length ?? 0) >= requestedPageIndex
    ) {
      setCurrentPageIndex(requestedPageIndex);
    }
  };

  const reloadFromFirstPage = () => {
    setCurrentPageIndex(1);
    void reloadCatalog();
  };

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          info={
            <InfoLink
              markdown="permission-sets"
              ariaLabel="Learn about permission sets"
            />
          }
          description="View permission sets registered for sandbox lease access."
          actions={
            isAdmin ? (
              <Button
                href={permissionSetCatalogConsoleUrl(region)}
                target="_blank"
                iconName="external"
                variant="primary"
              >
                Manage permission sets
              </Button>
            ) : undefined
          }
        >
          Permission Sets
        </Header>
      }
    >
      <SpaceBetween size="m">
        {isLoadingError && (
          <ErrorPanel
            retry={() => void refetch()}
            description="Could not load permission sets. Please try again."
            error={error}
          />
        )}
        {(isFetchNextPageError || isRefetchError) && (
          <Alert
            type="error"
            header={getCatalogErrorHeader(isFetchNextPageError, error)}
            action={
              <Button onClick={reloadFromFirstPage}>Reload catalog</Button>
            }
          >
            Previously loaded permission sets remain available below.
          </Alert>
        )}
        <FilterableTable<PermissionSetView>
          collectionMode="server"
          title="Registered permission sets"
          items={currentPermissionSets}
          loading={isLoading || isFetchingNextPage}
          loadingText="Loading permission sets..."
          trackBy="permissionSetArn"
          columnDefinitions={columnDefinitions}
          pageSize={pageSize}
          pageSizeOptions={PAGE_SIZE_OPTIONS}
          onPageSizeChange={(nextPageSize) => {
            setCurrentPageIndex(1);
            setPageSize(nextPageSize);
          }}
          filter={
            <TextFilter
              filteringText={filterText}
              filteringPlaceholder="Find permission sets"
              filteringAriaLabel="Filter permission sets by name or description"
              countText={`${permissionSets.length} ${permissionSets.length === 1 ? "match" : "matches"} loaded`}
              loading={isFilterPending || (isFetching && !isFetchingNextPage)}
              onChange={({ detail }) => {
                setCurrentPageIndex(1);
                setFilterText(boundedFilterText(detail.filteringText));
              }}
              onDelayedChange={({ detail }) => {
                setCurrentPageIndex(1);
                setQueryText(boundedFilterText(detail.filteringText));
              }}
            />
          }
          emptyContent={
            <Box textAlign="center" color="inherit" variant="p">
              {emptyStateText}
            </Box>
          }
          counter={`(${permissionSets.length}${hasNextPage ? "+" : ""})`}
          onRefresh={() => void refetch()}
          refreshAriaLabel="Refresh permission sets"
          refreshDisabled={isFetching}
          pagination={
            permissionSetPages.length > 1 || hasNextPage
              ? {
                  currentPageIndex,
                  pagesCount: permissionSetPages.length,
                  openEnd: hasNextPage,
                  disabled: isFetching,
                  onChange: (pageIndex) => void changePage(pageIndex),
                  ariaLabels: {
                    paginationLabel: "Permission sets pagination",
                    nextPageLabel: "Next page",
                    previousPageLabel: "Previous page",
                    pageLabel: (pageNumber) => `Page ${pageNumber}`,
                  },
                }
              : undefined
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
}

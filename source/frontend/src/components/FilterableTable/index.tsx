// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  useCollection,
  UseCollectionResult,
} from "@cloudscape-design/collection-hooks";
import {
  Box,
  Button,
  CollectionPreferences,
  Header,
  Pagination,
  PropertyFilter,
  SpaceBetween,
  Table,
  TableProps,
} from "@cloudscape-design/components";
import { PropertyFilterProps } from "@cloudscape-design/components/property-filter";
import { ReactNode, useEffect, useRef, useState } from "react";

/** Column definition with required `id` field (FilterableTable needs it for visibility preferences). */
export type FilterableColumnDefinition<T> = TableProps.ColumnDefinition<T> & {
  id: string;
};

export interface FilterableTablePageSizeOption {
  value: number;
  label: string;
}

interface ServerPaginationConfig {
  currentPageIndex: number;
  pagesCount: number;
  openEnd?: boolean;
  disabled?: boolean;
  onChange: (currentPageIndex: number) => void;
  ariaLabels?: {
    paginationLabel?: string;
    nextPageLabel?: string;
    previousPageLabel?: string;
    pageLabel?: (pageNumber: number) => string;
  };
}

interface FilterableTableCommonProps<T> {
  /** Table title displayed in the header */
  title: string;
  /** Optional description below the header title */
  description?: string;
  /** Complete client collection or the current server page */
  items: ReadonlyArray<T>;
  /** Column definitions for the table (id is required) */
  columnDefinitions: ReadonlyArray<FilterableColumnDefinition<T>>;
  /** Whether data is currently being fetched */
  loading?: boolean;
  /** Loading text */
  loadingText?: string;
  /** Unique key for each item */
  trackBy: keyof T & string;
  /** Whether to show selection checkboxes */
  selectionType?: "single" | "multi";
  /** Currently selected items */
  selectedItems?: ReadonlyArray<T>;
  /** Selection change handler */
  onSelectionChange?: (items: T[]) => void;
  /** Callback when refresh button is clicked */
  onRefresh?: () => void;
  /** Accessible label for the refresh button */
  refreshAriaLabel?: string;
  /** Whether the refresh button should be disabled */
  refreshDisabled?: boolean;
  /** Additional action buttons to render in the header */
  headerActions?: ReactNode;
  /** Content to display when the table is empty and no error */
  emptyContent?: ReactNode;
  /** Content to display when an error occurred */
  errorContent?: ReactNode;
  /** Whether an error occurred */
  isError?: boolean;
  /** Default visible columns (by id) */
  defaultVisibleColumns?: string[];
  /** Page-size choices displayed in collection preferences */
  pageSizeOptions?: ReadonlyArray<FilterableTablePageSizeOption>;
  /** Whether to show the counter in the header */
  showCounter?: boolean;
}

export interface ClientFilterableTableProps<
  T,
> extends FilterableTableCommonProps<T> {
  /** Eagerly loaded collections use local filtering, sorting, and pagination. */
  collectionMode?: "client";
  /** Property filter definitions for the property filter component */
  filteringProperties: PropertyFilterProps.FilteringProperty[];
  /** Default page size */
  defaultPageSize?: number;
  /** Default property filter query applied on mount (user-adjustable) */
  defaultFilteringQuery?: PropertyFilterProps.Query;
}

export interface ServerFilterableTableProps<
  T,
> extends FilterableTableCommonProps<T> {
  /** Server collections provide already filtered and paginated items. */
  collectionMode: "server";
  /** Controlled filtering UI, such as a TextFilter or PropertyFilter. */
  filter?: ReactNode;
  /** Controlled page size */
  pageSize: number;
  /** Called when the user confirms a new page size */
  onPageSizeChange: (pageSize: number) => void;
  /** Controlled pagination state */
  pagination?: ServerPaginationConfig;
  /** Header counter supplied by the server collection owner */
  counter?: string;
  /** Controlled server-side sorting state */
  sortingColumn?: TableProps.SortingColumn<T>;
  sortingDescending?: boolean;
  onSortingChange?: TableProps<T>["onSortingChange"];
}

type ClientModeProps<T> = ClientFilterableTableProps<T>;
type ServerModeProps<T> = ServerFilterableTableProps<T>;

export type FilterableTableProps<T> = ClientModeProps<T> | ServerModeProps<T>;

const DEFAULT_PAGE_SIZE_OPTIONS = [
  { value: 10, label: "10 rows" },
  { value: 25, label: "25 rows" },
  { value: 50, label: "50 rows" },
  { value: 100, label: "100 rows" },
];

const EMPTY_FILTERING_QUERY: PropertyFilterProps.Query = {
  tokens: [],
  operation: "and",
};

type CollectionTableProps<T> = Pick<
  TableProps<T>,
  | "items"
  | "empty"
  | "filter"
  | "pagination"
  | "sortingColumn"
  | "sortingDescending"
  | "onSortingChange"
>;

interface CollectionView<T> {
  tableProps: CollectionTableProps<T>;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  counter?: string;
}

interface ClientCollectionFilterProps<T> {
  title: string;
  filteredItemsCount: number;
  collection: UseCollectionResult<T>;
}

function ClientCollectionFilter<T>({
  title,
  filteredItemsCount,
  collection,
}: Readonly<ClientCollectionFilterProps<T>>) {
  return (
    <PropertyFilter
      {...collection.propertyFilterProps}
      i18nStrings={{
        filteringAriaLabel: `Filter ${title.toLowerCase()}`,
        filteringPlaceholder: `Filter ${title.toLowerCase()}`,
        groupValuesText: "Values",
        groupPropertiesText: "Properties",
        operatorsText: "Operators",
        operationAndText: "and",
        operationOrText: "or",
        operatorLessText: "Less than",
        operatorLessOrEqualText: "Less than or equal",
        operatorGreaterText: "Greater than",
        operatorGreaterOrEqualText: "Greater than or equal",
        operatorContainsText: "Contains",
        operatorDoesNotContainText: "Does not contain",
        operatorEqualsText: "Equals",
        operatorDoesNotEqualText: "Does not equal",
        editTokenHeader: "Edit filter",
        propertyText: "Property",
        operatorText: "Operator",
        valueText: "Value",
        cancelActionText: "Cancel",
        applyActionText: "Apply",
        clearFiltersText: "Clear filters",
        removeTokenButtonAriaLabel: (token) =>
          `Remove filter: ${token.propertyLabel} ${token.operator} ${token.value}`,
        enteredTextLabel: (text) => `Use: "${text}"`,
      }}
      countText={`${filteredItemsCount} ${filteredItemsCount === 1 ? "match" : "matches"}`}
      expandToViewport
    />
  );
}

function ServerCollectionPagination({
  title,
  pagination,
}: Readonly<{
  title: string;
  pagination: ServerPaginationConfig;
}>) {
  return (
    <Pagination
      currentPageIndex={pagination.currentPageIndex}
      pagesCount={pagination.pagesCount}
      openEnd={pagination.openEnd}
      disabled={pagination.disabled}
      onChange={({ detail }) => pagination.onChange(detail.currentPageIndex)}
      ariaLabels={{
        paginationLabel: `${title} pagination`,
        nextPageLabel: "Next page",
        previousPageLabel: "Previous page",
        pageLabel: (pageNumber) => `Page ${pageNumber}`,
        ...pagination.ariaLabels,
      }}
    />
  );
}

function createServerCollectionView<T>(
  props: ServerFilterableTableProps<T>,
  showCounter: boolean,
): CollectionView<T> {
  return {
    tableProps: {
      items: props.items,
      empty: props.emptyContent,
      filter: props.filter,
      pagination: props.pagination ? (
        <ServerCollectionPagination
          title={props.title}
          pagination={props.pagination}
        />
      ) : undefined,
      sortingColumn: props.sortingColumn,
      sortingDescending: props.sortingDescending,
      onSortingChange: props.onSortingChange,
    },
    pageSize: props.pageSize,
    onPageSizeChange: props.onPageSizeChange,
    counter: showCounter ? props.counter : undefined,
  };
}

function createClientCollectionView<T>({
  props,
  collection,
  pageSize,
  onPageSizeChange,
  showCounter,
  loading,
}: {
  props: ClientFilterableTableProps<T>;
  collection: UseCollectionResult<T>;
  pageSize: number;
  onPageSizeChange: (pageSize: number) => void;
  showCounter: boolean;
  loading: boolean;
}): CollectionView<T> {
  const filteredItemsCount =
    collection.filteredItemsCount ?? props.items.length;
  const counter =
    filteredItemsCount === props.items.length
      ? `(${props.items.length})`
      : `(${filteredItemsCount}/${props.items.length})`;

  return {
    tableProps: {
      items: collection.items,
      empty: collection.collectionProps.empty,
      filter: (
        <ClientCollectionFilter
          title={props.title}
          filteredItemsCount={filteredItemsCount}
          collection={collection}
        />
      ),
      pagination: <Pagination {...collection.paginationProps} />,
      sortingColumn: collection.collectionProps.sortingColumn,
      sortingDescending: collection.collectionProps.sortingDescending,
      onSortingChange: collection.collectionProps.onSortingChange,
    },
    pageSize,
    onPageSizeChange,
    counter: showCounter && !loading ? counter : undefined,
  };
}

/**
 * Reusable Cloudscape table supporting both eagerly loaded client collections
 * and controlled server-side filtering, sorting, and pagination.
 */
export function FilterableTable<T>(props: FilterableTableProps<T>) {
  const collectionMode = props.collectionMode ?? "client";
  const clientProps = props.collectionMode === "server" ? undefined : props;
  const previousCollectionMode = useRef(collectionMode);
  const [clientPageSize, setClientPageSize] = useState(
    clientProps?.defaultPageSize ?? 25,
  );
  const [visibleContent, setVisibleContent] = useState(
    props.defaultVisibleColumns ??
      props.columnDefinitions.map((column) => column.id),
  );

  // Hooks cannot be called conditionally. Server mode supplies no collection
  // operations, so useCollection returns the current server page unchanged.
  const collection = useCollection(
    props.items,
    clientProps
      ? {
          propertyFiltering: {
            filteringProperties: clientProps.filteringProperties,
            defaultQuery: clientProps.defaultFilteringQuery,
            empty: props.emptyContent ?? (
              <Box textAlign="center" color="inherit" variant="p">
                No items found
              </Box>
            ),
            noMatch: (
              <Box textAlign="center" color="inherit">
                <SpaceBetween size="s">
                  <Box variant="p">No matches</Box>
                  <Button
                    onClick={() =>
                      collection.actions.setPropertyFiltering({
                        tokens: [],
                        operation: "and",
                      })
                    }
                  >
                    Clear filter
                  </Button>
                </SpaceBetween>
              </Box>
            ),
          },
          pagination: { pageSize: clientPageSize },
          sorting: {},
          selection: {},
        }
      : {},
  );

  useEffect(() => {
    const previousMode = previousCollectionMode.current;
    previousCollectionMode.current = collectionMode;

    if (
      previousMode === "server" &&
      collectionMode === "client" &&
      clientProps
    ) {
      setClientPageSize(clientProps.defaultPageSize ?? 25);
      collection.actions.setCurrentPage(1);
      collection.actions.setPropertyFiltering(
        clientProps.defaultFilteringQuery ?? EMPTY_FILTERING_QUERY,
      );
      collection.actions.setMultiSorting([]);
    }
  }, [clientProps, collection.actions, collectionMode]);

  const {
    title,
    description,
    columnDefinitions,
    loading = false,
    loadingText = "Loading...",
    trackBy,
    selectionType,
    selectedItems,
    onSelectionChange,
    onRefresh,
    refreshAriaLabel = "Refresh",
    refreshDisabled,
    headerActions,
    errorContent,
    isError = false,
    pageSizeOptions = DEFAULT_PAGE_SIZE_OPTIONS,
    showCounter = true,
  } = props;
  const collectionView =
    props.collectionMode === "server"
      ? createServerCollectionView(props, showCounter)
      : createClientCollectionView({
          props,
          collection,
          pageSize: clientPageSize,
          onPageSizeChange: setClientPageSize,
          showCounter,
          loading,
        });
  const {
    tableProps: { empty: collectionEmpty, ...collectionTableProps },
    pageSize,
    onPageSizeChange,
    counter,
  } = collectionView;

  return (
    <Table
      {...collectionTableProps}
      variant="container"
      stripedRows
      resizableColumns
      trackBy={trackBy}
      loading={loading}
      loadingText={loadingText}
      selectionType={selectionType}
      selectedItems={selectedItems}
      onSelectionChange={
        onSelectionChange
          ? ({ detail }) => onSelectionChange([...detail.selectedItems])
          : undefined
      }
      columnDisplay={columnDefinitions.map((column) => ({
        id: column.id,
        visible: visibleContent.includes(column.id),
      }))}
      columnDefinitions={columnDefinitions}
      empty={
        isError
          ? (errorContent ?? (
              <Box textAlign="center" color="inherit" variant="p">
                An error occurred while loading data.
              </Box>
            ))
          : collectionEmpty
      }
      header={
        <Header
          variant="h2"
          counter={counter}
          description={description}
          actions={
            <SpaceBetween direction="horizontal" size="s">
              {onRefresh && (
                <Button
                  iconName="refresh"
                  ariaLabel={refreshAriaLabel}
                  onClick={onRefresh}
                  disabled={refreshDisabled ?? loading}
                />
              )}
              {headerActions}
            </SpaceBetween>
          }
        >
          {title}
        </Header>
      }
      preferences={
        <CollectionPreferences
          title="Preferences"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          preferences={{ pageSize, visibleContent }}
          onConfirm={({ detail }) => {
            const nextPageSize = detail.pageSize ?? pageSize;
            setVisibleContent(
              detail.visibleContent
                ? [...detail.visibleContent]
                : visibleContent,
            );
            if (nextPageSize !== pageSize) {
              onPageSizeChange(nextPageSize);
            }
          }}
          pageSizePreference={{
            title: "Page size",
            options: pageSizeOptions,
          }}
          visibleContentPreference={{
            title: "Select visible columns",
            options: [
              {
                label: "Properties",
                options: columnDefinitions.map((column) => ({
                  id: column.id,
                  label:
                    typeof column.header === "string"
                      ? column.header
                      : column.id,
                  editable: true,
                })),
              },
            ],
          }}
        />
      }
    />
  );
}

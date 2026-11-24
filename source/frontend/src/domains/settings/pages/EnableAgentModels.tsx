// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import type { TableProps } from "@cloudscape-design/components";
import {
  Alert,
  Box,
  Button,
  CollectionPreferences,
  FormField,
  Header,
  Pagination,
  Select,
  SpaceBetween,
  StatusIndicator,
  Table,
  TextFilter,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ContentLayout } from "@amzn/innovation-sandbox-frontend/components/ContentLayout";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  useAgentModelCatalog,
  useAgentModelDiscovery,
  usePutAgentModelCatalogEntry,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import type { AgentModelDiscoveryEntry } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import {
  buildUpsertInput,
  formatModelType,
  formatTokenPrice,
  hasPrice,
  MODEL_TYPE_FOUNDATION_MODEL,
  MODEL_TYPE_INFERENCE_PROFILE,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/agent-model-helpers";
import { settingsGroupHref } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [
  { value: 10, label: "10 rows" },
  { value: 25, label: "25 rows" },
  { value: 50, label: "50 rows" },
  { value: 100, label: "100 rows" },
];

const columnDefinitions: TableProps.ColumnDefinition<AgentModelDiscoveryEntry>[] =
  [
    {
      id: "displayName",
      header: "Model",
      cell: (m: AgentModelDiscoveryEntry) => (
        <SpaceBetween direction="vertical" size="xxxs">
          <Box fontWeight="bold">{m.displayName ?? m.modelId}</Box>
          <Box variant="small" color="text-body-secondary">
            {m.modelId}
          </Box>
        </SpaceBetween>
      ),
    },
    {
      id: "provider",
      header: "Provider",
      cell: (m: AgentModelDiscoveryEntry) => m.provider ?? "—",
    },
    {
      id: "type",
      header: "Type",
      minWidth: 140,
      cell: (m: AgentModelDiscoveryEntry) => formatModelType(m),
    },
    {
      id: "availability",
      header: "Availability",
      cell: (m: AgentModelDiscoveryEntry) => {
        const av = m.availability ?? "—";
        return av.charAt(0).toUpperCase() + av.slice(1);
      },
    },
    {
      id: "inputPrice",
      header: "Input / 1K tokens",
      cell: (m: AgentModelDiscoveryEntry) =>
        hasPrice(m) ? (
          formatTokenPrice(m.inputPricePer1KTokens)
        ) : (
          <StatusIndicator type="stopped">Price unavailable</StatusIndicator>
        ),
    },
    {
      id: "outputPrice",
      header: "Output / 1K tokens",
      cell: (m: AgentModelDiscoveryEntry) =>
        formatTokenPrice(m.outputPricePer1KTokens),
    },
    {
      id: "cacheRead",
      header: "Cache read / 1K",
      cell: (m: AgentModelDiscoveryEntry) =>
        formatTokenPrice(m.cacheReadPricePer1KTokens),
    },
    {
      id: "cacheWrite",
      header: "Cache write / 1K",
      cell: (m: AgentModelDiscoveryEntry) =>
        formatTokenPrice(m.cacheWritePricePer1KTokens),
    },
  ];

const reviewColumnDefinitions: TableProps.ColumnDefinition<AgentModelDiscoveryEntry>[] =
  [
    {
      id: "displayName",
      header: "Model",
      cell: (m: AgentModelDiscoveryEntry) => m.displayName ?? m.modelId,
    },
    {
      id: "provider",
      header: "Provider",
      cell: (m: AgentModelDiscoveryEntry) => m.provider ?? "—",
    },
    {
      id: "type",
      header: "Type",
      cell: (m: AgentModelDiscoveryEntry) => formatModelType(m),
    },
  ];

export const EnableAgentModels = () => {
  const navigate = useNavigate();
  const setBreadcrumb = useBreadcrumb();
  const { showModal } = useModal();

  const catalogQuery = useAgentModelCatalog();
  const availableQuery = useAgentModelDiscovery({ enabled: true });
  const upsertMutation = usePutAgentModelCatalogEntry();

  const [selectedModels, setSelectedModels] = useState<
    AgentModelDiscoveryEntry[]
  >([]);
  const [filterText, setFilterText] = useState("");
  const [providerFilter, setProviderFilter] = useState("all");
  const [typeFilter, setTypeFilter] = useState("all");
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);

  const catalog = catalogQuery.data ?? [];
  const available = availableQuery.data ?? [];

  // Exclude only models that are already ENABLED in the catalog. Disabled
  // catalog rows are surfaced here so an admin can re-enable them.
  const enabledCatalogIds = useMemo(
    () => new Set(catalog.filter((r) => r.enabled).map((r) => r.modelId)),
    [catalog],
  );
  // Disabled catalog rows keyed by modelId — re-enabling one is an UPDATE, so
  // we need its OCC token (meta.lastEditTime) rather than a first-insert.
  const disabledCatalogById = useMemo(
    () =>
      new Map(
        catalog.filter((r) => !r.enabled).map((r) => [r.modelId, r] as const),
      ),
    [catalog],
  );
  const newModels = useMemo(
    () => available.filter((m) => !enabledCatalogIds.has(m.modelId)),
    [available, enabledCatalogIds],
  );

  // Provider dropdown: populate from uncataloged models only.
  const providers = useMemo(() => {
    const unique = [
      ...new Set(
        newModels.map((m) => m.provider).filter((p): p is string => Boolean(p)),
      ),
    ];
    return unique.sort((a, b) => a.localeCompare(b));
  }, [newModels]);

  // Single predicate for all three filters (text + provider + type). Text
  // filtering is handled here (not via useCollection's built-in filter) because
  // the provider/type dropdown state lives outside useCollection; the predicate
  // matches against model name, id, and provider.
  const matchesFilters = (
    m: AgentModelDiscoveryEntry,
    text: string,
    provider: string,
    type: string,
  ) => {
    if (provider !== "all" && m.provider !== provider) return false;
    if (type !== "all" && formatModelType(m) !== type) return false;
    const q = text.trim().toLowerCase();
    if (q) {
      const haystack = [m.displayName, m.modelId, m.provider]
        .filter(Boolean)
        .join(" ")
        .toLowerCase();
      if (!haystack.includes(q)) return false;
    }
    return true;
  };

  // Pre-filter by text + provider + type before handing to useCollection
  // (which owns pagination/sorting). Dropdown state lives outside useCollection,
  // so filtering happens here — matching the CleanupDetails pattern.
  const filteredModels = useMemo(
    () =>
      newModels.filter((m) =>
        matchesFilters(m, filterText, providerFilter, typeFilter),
      ),
    [newModels, filterText, providerFilter, typeFilter],
  );

  // useCollection handles pagination and sorting. Selection is kept in local
  // state (useCollection's selection returns readonly arrays that conflict with
  // Table's mutable selectedItems — see BlueprintTable).
  const { items, collectionProps, paginationProps } = useCollection(
    filteredModels,
    { pagination: { pageSize }, sorting: {} },
  );

  // Applies a filter change: updates the relevant filter state and drops any
  // selection that becomes hidden. Centralizes the recompute+reconcile so each
  // onChange handler passes only the field it changed (no duplicated
  // newModels.filter(matchesFilters(...)) expression). Reconciling inline (vs a
  // useEffect on the derived set) avoids a render loop.
  const applyFilters = (next: {
    text?: string;
    provider?: string;
    type?: string;
  }) => {
    const text = next.text ?? filterText;
    const provider = next.provider ?? providerFilter;
    const type = next.type ?? typeFilter;

    if (next.text !== undefined) setFilterText(next.text);
    if (next.provider !== undefined) setProviderFilter(next.provider);
    if (next.type !== undefined) setTypeFilter(next.type);

    const nextIds = new Set(
      newModels
        .filter((m) => matchesFilters(m, text, provider, type))
        .map((m) => m.modelId),
    );
    setSelectedModels((prev) => prev.filter((m) => nextIds.has(m.modelId)));
  };

  useEffect(() => {
    const currentIds = new Set(newModels.map((m) => m.modelId));
    setSelectedModels((prev) => prev.filter((m) => currentIds.has(m.modelId)));
  }, [newModels]);

  useEffect(() => {
    setBreadcrumb([
      { text: "Home", href: "/" },
      { text: "Settings", href: "/settings" },
      { text: "Sandbox Spaces", href: settingsGroupHref("sandbox-spaces") },
      { text: "Add models", href: "/settings/sandbox-spaces/models/new" },
    ]);
  }, [setBreadcrumb]);

  const showAddModal = () => {
    const toAdd = selectedModels.filter(
      (m) => !enabledCatalogIds.has(m.modelId) && hasPrice(m),
    );
    if (toAdd.length === 0) return;

    showModal({
      header: "Review models to add",
      content: (
        <BatchActionReview
          items={toAdd}
          description={`${toAdd.length} model(s) will be added to the catalog and enabled`}
          columnDefinitions={reviewColumnDefinitions}
          identifierKey="modelId"
          sequential
          onSubmit={async (model: AgentModelDiscoveryEntry) => {
            // A disabled catalog row already exists — re-enable it as an
            // UPDATE by supplying its OCC token. Genuinely new models omit the
            // token and are created as a first-insert.
            const existing = disabledCatalogById.get(model.modelId);
            await upsertMutation.mutateAsync(
              buildUpsertInput(model, {
                enabled: true,
                expectedLastEditTime: existing?.meta?.lastEditTime,
              }),
            );
            // BatchActionReview.onSuccess fires only after the whole batch
            // completes — no per-item deselect needed here.
          }}
          onSuccess={() => {
            showSuccessToast("Model(s) added to the catalog and enabled.");
            navigate(settingsGroupHref("sandbox-spaces"));
          }}
          onError={() =>
            showErrorToast(
              "One or more models failed to add. Check each model's status for the reason.",
              "Failed to add model(s)",
            )
          }
        />
      ),
      size: "max",
    });
  };

  // Defensive: table items derive from newModels, which already excludes
  // enabledCatalogIds, so this filter is currently a no-op (equals
  // selectedModels.length). Kept to stay consistent with showAddModal's toAdd
  // guard, which applies the same exclusion.
  const newModelsSelected = selectedModels.filter(
    (m) => !enabledCatalogIds.has(m.modelId),
  ).length;
  const enableButtonLabel =
    newModelsSelected > 0
      ? `Enable selected models (${newModelsSelected})`
      : "Enable selected models";

  return (
    <ContentLayout
      disablePadding
      header={
        <Header
          variant="h1"
          description="Discover eligible Bedrock models and add selected models to the catalog."
          actions={
            <Button
              onClick={() => navigate(settingsGroupHref("sandbox-spaces"))}
            >
              Cancel
            </Button>
          }
        >
          Add Sandbox Spaces models
        </Header>
      }
    >
      <SpaceBetween size="m">
        <Alert type="info" header="Eligible models only">
          This discovery API represents only tool-capable Bedrock models
          eligible for Sandbox Spaces. Global and regional inference targets are
          separate selectable rows.
        </Alert>

        {(availableQuery.isError || catalogQuery.isError) && (
          <ErrorPanel
            retry={() => {
              if (availableQuery.isError) void availableQuery.refetch();
              if (catalogQuery.isError) void catalogQuery.refetch();
            }}
            description={
              availableQuery.isError
                ? "Could not load available Bedrock models. Please try again."
                : "Could not load the model catalog. Please try again."
            }
            error={availableQuery.error ?? catalogQuery.error ?? undefined}
          />
        )}

        <Table
          variant="container"
          stripedRows
          resizableColumns
          wrapLines
          trackBy="modelId"
          columnDefinitions={columnDefinitions}
          items={items}
          loading={availableQuery.isFetching || catalogQuery.isLoading}
          loadingText="Loading available models…"
          selectionType="multi"
          isItemDisabled={(m) => !hasPrice(m)}
          selectedItems={selectedModels}
          onSelectionChange={({ detail }) =>
            setSelectedModels(detail.selectedItems)
          }
          sortingColumn={collectionProps.sortingColumn}
          sortingDescending={collectionProps.sortingDescending}
          onSortingChange={collectionProps.onSortingChange}
          empty={
            newModels.length > 0 ? (
              // Filters exclude everything, but models do exist — offer recovery.
              <Box textAlign="center" color="inherit">
                <Box variant="p">No matches</Box>
                <Button
                  onClick={() =>
                    applyFilters({ text: "", provider: "all", type: "all" })
                  }
                >
                  Clear filter
                </Button>
              </Box>
            ) : (
              <Box textAlign="center" color="inherit" variant="p">
                No available models
              </Box>
            )
          }
          pagination={<Pagination {...paginationProps} />}
          preferences={
            <CollectionPreferences
              title="Preferences"
              confirmLabel="Confirm"
              cancelLabel="Cancel"
              preferences={{ pageSize }}
              onConfirm={({ detail }) =>
                setPageSize(detail.pageSize ?? pageSize)
              }
              pageSizePreference={{
                title: "Page size",
                options: PAGE_SIZE_OPTIONS,
              }}
            />
          }
          filter={
            <SpaceBetween direction="horizontal" size="s">
              <FormField label="Filter models">
                <TextFilter
                  filteringText={filterText}
                  filteringAriaLabel="Filter models"
                  filteringPlaceholder="Find a model or provider"
                  countText={`${filteredModels.length} ${
                    filteredModels.length === 1 ? "match" : "matches"
                  }`}
                  onChange={({ detail }) =>
                    applyFilters({ text: detail.filteringText })
                  }
                />
              </FormField>
              <FormField label="Provider">
                <Select
                  ariaLabel="Filter by provider"
                  selectedOption={
                    providerFilter === "all"
                      ? { label: "All providers", value: "all" }
                      : { label: providerFilter, value: providerFilter }
                  }
                  options={[
                    { label: "All providers", value: "all" },
                    ...providers.map((p) => ({ label: p, value: p })),
                  ]}
                  onChange={({ detail }) =>
                    applyFilters({
                      provider: detail.selectedOption.value ?? "all",
                    })
                  }
                />
              </FormField>
              <FormField label="Type">
                <Select
                  ariaLabel="Filter by type"
                  selectedOption={
                    typeFilter === "all"
                      ? { label: "All types", value: "all" }
                      : { label: typeFilter, value: typeFilter }
                  }
                  options={[
                    { label: "All types", value: "all" },
                    {
                      label: MODEL_TYPE_FOUNDATION_MODEL,
                      value: MODEL_TYPE_FOUNDATION_MODEL,
                    },
                    {
                      label: MODEL_TYPE_INFERENCE_PROFILE,
                      value: MODEL_TYPE_INFERENCE_PROFILE,
                    },
                  ]}
                  onChange={({ detail }) =>
                    applyFilters({ type: detail.selectedOption.value ?? "all" })
                  }
                />
              </FormField>
            </SpaceBetween>
          }
          header={
            <Header
              variant="h2"
              counter={
                availableQuery.isFetching
                  ? undefined
                  : `(${filteredModels.length})`
              }
              actions={
                <SpaceBetween direction="horizontal" size="xs">
                  <Button
                    iconName="refresh"
                    ariaLabel="Refresh available models"
                    onClick={() => void availableQuery.refetch()}
                    disabled={availableQuery.isFetching}
                  />
                  <Button
                    variant="primary"
                    onClick={showAddModal}
                    disabled={newModelsSelected === 0}
                  >
                    {enableButtonLabel}
                  </Button>
                </SpaceBetween>
              }
            >
              Available models
            </Header>
          }
        />
      </SpaceBetween>
    </ContentLayout>
  );
};

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { TableProps } from "@cloudscape-design/components";
import {
  Alert,
  Box,
  Button,
  ButtonDropdown,
  Container,
  Header,
  SpaceBetween,
  Table,
} from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  AGENT_MODEL_CATALOG_KEY,
  useAgentModelCatalog,
  usePutAgentModelCatalogEntry,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import type { AgentModelCatalogEntry } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import {
  buildUpsertInput,
  catalogCellColor,
  formatTokenPrice,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/agent-model-helpers";
import { useTrackUnsavedChanges } from "@amzn/innovation-sandbox-frontend/domains/settings/components/UnsavedChangesGuard";
import type { SettingsSearchField } from "@amzn/innovation-sandbox-frontend/domains/settings/settings-navigation";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";

export type CatalogDraft = {
  dirty: boolean;
  conflict: boolean;
  savedBy: string[];
  /** Models still enabled once the staged disables are saved. */
  remainingEnabledCount: number;
  save: () => Promise<boolean>;
  discard: () => void;
  reload: () => Promise<boolean>;
};
const MODELS_DESCRIPTION =
  "Amazon Bedrock models that lease templates may offer for a Sandbox Space. Lease templates can choose from this list or allow all enabled models. Disabling a model doesn't change templates that allow it, but users can no longer pick it in a Space. Prices are on-demand list prices.";
const MODEL_CATALOG_ANCHOR = "model-catalog";
export const modelCatalogSearchFields: SettingsSearchField[] = [
  {
    id: MODEL_CATALOG_ANCHOR,
    group: "sandbox-spaces",
    subgroup: "Models",
    label: "Model catalog",
    description: MODELS_DESCRIPTION,
  },
];

const ENABLE_ROUTE = "/settings/sandbox-spaces/models/new";

const columns: TableProps.ColumnDefinition<AgentModelCatalogEntry>[] = [
  {
    id: "displayName",
    header: "Model",
    cell: (row) => (
      <Box fontWeight="bold" color={catalogCellColor(row.enabled)}>
        {row.displayName ?? row.modelId}
      </Box>
    ),
    minWidth: 180,
  },
  {
    id: "provider",
    header: "Provider",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>{row.provider ?? "—"}</Box>
    ),
  },
  {
    id: "availability",
    header: "Availability",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>{row.availability ?? "—"}</Box>
    ),
  },
  {
    id: "inputPrice",
    header: "Input / 1K",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>
        {formatTokenPrice(row.inputPricePer1KTokens)}
      </Box>
    ),
  },
  {
    id: "outputPrice",
    header: "Output / 1K",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>
        {formatTokenPrice(row.outputPricePer1KTokens)}
      </Box>
    ),
  },
  {
    id: "cacheRead",
    header: "Cache read / 1K",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>
        {formatTokenPrice(row.cacheReadPricePer1KTokens)}
      </Box>
    ),
  },
  {
    id: "cacheWrite",
    header: "Cache write / 1K",
    cell: (row) => (
      <Box color={catalogCellColor(row.enabled)}>
        {formatTokenPrice(row.cacheWritePricePer1KTokens)}
      </Box>
    ),
  },
];

/** Reports the outcome of a bulk enable/disable batch after allSettled. */
function reportBatchResult(
  results: PromiseSettledResult<AgentModelCatalogEntry>[],
  enabled: boolean,
): void {
  const action = enabled ? "enabled" : "disabled";
  const failed = results.filter((r) => r.status === "rejected");
  const succeeded = results.length - failed.length;

  if (succeeded > 0) {
    showSuccessToast(`${succeeded} model(s) ${action}.`);
  }
  if (failed.length === 0) return;

  const hasConflict = failed.some(
    (r) =>
      r.status === "rejected" &&
      r.reason instanceof ApiError &&
      r.reason.statusCode === 409,
  );
  const verb = enabled ? "enable" : "disable";
  showErrorToast(
    hasConflict
      ? "One or more models were updated by another admin. Reload latest values before saving."
      : `Failed to ${verb} ${failed.length} model(s).`,
    "Action failed",
  );
}

export function ModelCatalogTable({
  readOnly = false,
  visible = true,
  busy = false,
  onDraftChange,
}: Readonly<{
  readOnly?: boolean;
  visible?: boolean;
  busy?: boolean;
  onDraftChange: (draft: CatalogDraft | null) => void;
}>): React.ReactElement | null {
  const navigate = useNavigate();
  // Load on the first visit and stay enabled to avoid refetching on group changes.
  const [hasBeenVisible, setHasBeenVisible] = useState(visible);
  useEffect(() => {
    if (visible) setHasBeenVisible(true);
  }, [visible]);
  const catalogQuery = useAgentModelCatalog({
    enabled: visible || hasBeenVisible,
  });
  const queryClient = useQueryClient();
  // skipInvalidation: true — bulk actions do one invalidation after allSettled
  // rather than N refetches (one per resolved mutation).
  const upsertMutation = usePutAgentModelCatalogEntry({
    skipInvalidation: true,
  });

  // This table shows only models that are enabled for the chat UI. Disabled
  // rows are hidden — use the "Add models" flow to enable more.
  const [pending, setPending] = useState<AgentModelCatalogEntry[]>([]);
  const [conflict, setConflict] = useState(false);
  const [savedBy, setSavedBy] = useState<string[]>([]);
  useTrackUnsavedChanges("modelCatalog", pending.length > 0);
  const catalog = (catalogQuery.data ?? []).filter(
    (row) =>
      row.enabled && !pending.some((entry) => entry.modelId === row.modelId),
  );
  const isEmpty =
    !catalogQuery.isLoading && !catalogQuery.isError && catalog.length === 0;

  const [selectedItems, setSelectedItems] = useState<AgentModelCatalogEntry[]>(
    [],
  );

  const latestDraft = useRef<CatalogDraft | null>(null);
  latestDraft.current = {
    dirty: pending.length > 0,
    conflict,
    savedBy,
    remainingEnabledCount: catalog.length,
    discard: () => {
      setPending([]);
      setConflict(false);
      setSavedBy([]);
      setSelectedItems([]);
    },
    reload: async () => {
      const result = await catalogQuery.refetch();
      if (result.error) {
        showErrorToast("Could not reload the model catalog.", "Reload failed");
        return false;
      }
      setPending([]);
      setConflict(false);
      setSavedBy([]);
      setSelectedItems([]);
      return true;
    },
    save: async () => {
      if (conflict) return false;
      const results = await Promise.allSettled(
        pending.map((row) =>
          upsertMutation.mutateAsync(
            buildUpsertInput(row, {
              enabled: false,
              expectedLastEditTime: row.meta.lastEditTime,
            }),
          ),
        ),
      );
      // Bulk writes skip invalidation, so apply saved rows before the refetch lands.
      const savedByModelId = new Map(
        results.flatMap((result) =>
          result.status === "fulfilled"
            ? [[result.value.modelId, result.value] as const]
            : [],
        ),
      );
      queryClient.setQueryData<AgentModelCatalogEntry[]>(
        AGENT_MODEL_CATALOG_KEY,
        (rows) => rows?.map((row) => savedByModelId.get(row.modelId) ?? row),
      );
      const remaining = pending.filter(
        (_row, index) => results[index].status === "rejected",
      );
      const conflicted = pending.filter((_row, index) => {
        const result = results[index];
        return (
          result.status === "rejected" &&
          result.reason instanceof ApiError &&
          result.reason.statusCode === 409
        );
      });
      setPending(remaining);
      if (conflicted.length) {
        setConflict(true);
        const result = await catalogQuery.refetch();
        setSavedBy([
          ...new Set(
            (result.error ? [] : (result.data ?? []))
              .filter((row) =>
                conflicted.some((entry) => entry.modelId === row.modelId),
              )
              .map((row) => row.lastSavedBy)
              .filter((name): name is string => !!name),
          ),
        ]);
      }
      if (remaining.length) reportBatchResult(results, false);
      void queryClient.invalidateQueries({ queryKey: AGENT_MODEL_CATALOG_KEY });
      void queryClient.invalidateQueries({ queryKey: ["agentModels"] });
      return remaining.length === 0;
    },
  };
  const draft = useMemo<CatalogDraft>(
    () => ({
      dirty: pending.length > 0,
      conflict,
      savedBy,
      remainingEnabledCount: catalog.length,
      save: () => latestDraft.current!.save(),
      discard: () => latestDraft.current!.discard(),
      reload: () => latestDraft.current!.reload(),
    }),
    [pending.length, conflict, savedBy, catalog.length],
  );
  useEffect(() => {
    if (!readOnly) onDraftChange(draft);
    return () => onDraftChange(null);
  }, [onDraftChange, readOnly, draft]);

  const stageDisable = () => {
    const enabled = false;
    const action = "disabled";
    // Narrow to rows with both modelId and OCC token — compiler carries the
    // guarantee so buildUpsertInput receives the required modelId: string.
    type ActionableRow = AgentModelCatalogEntry & {
      modelId: string;
      meta: { lastEditTime: string };
    };
    const isActionable = (r: AgentModelCatalogEntry): r is ActionableRow =>
      typeof r.modelId === "string" && typeof r.meta?.lastEditTime === "string";

    const actionable = selectedItems.filter(isActionable);
    const skipped = selectedItems.length - actionable.length;
    const alreadyCorrect = actionable.filter((row) => row.enabled === enabled);
    const targets = actionable.filter((row) => row.enabled !== enabled);

    if (skipped > 0) {
      showErrorToast(
        `${skipped} model(s) could not be ${action} — the model list is out of date. Reload the list and try again.`,
        "Some models skipped",
      );
    }

    if (targets.length === 0) {
      if (alreadyCorrect.length > 0) {
        showSuccessToast(`All selected models are already ${action}.`);
      }
      return;
    }
    setPending((previous) => {
      const pendingIds = new Set(previous.map((entry) => entry.modelId));
      return [
        ...previous,
        ...targets.filter((row) => !pendingIds.has(row.modelId)),
      ];
    });
    setSelectedItems([]);
  };

  const canDisable = selectedItems.some((r) => r.enabled);
  const tableCounter =
    selectedItems.length > 0
      ? `(${selectedItems.length}/${catalog.length})`
      : `(${catalog.length})`;

  // Selects the body: error panel, empty state, or the catalog table. Extracted
  // to a statement with early returns rather than a nested JSX ternary (SonarQube
  // typescript:S3358).
  const renderCatalogBody = (): React.ReactElement => {
    if (catalogQuery.isError) {
      return (
        <ErrorPanel
          retry={() => void catalogQuery.refetch()}
          description="Could not load the model catalog. Please try again."
          error={catalogQuery.error ?? undefined}
        />
      );
    }

    if (isEmpty) {
      return (
        <SpaceBetween size="s" direction="vertical">
          <Box
            textAlign="center"
            fontSize="heading-m"
            fontWeight="bold"
            color="text-label"
          >
            No Sandbox Spaces models
          </Box>
          <Box textAlign="center" color="text-body-secondary">
            Add tool-capable Bedrock models to make them available for future
            lease templates.
          </Box>
          {!readOnly && (
            <Box textAlign="center">
              <Button
                variant="primary"
                disabled={busy}
                onClick={() => navigate(ENABLE_ROUTE)}
              >
                Add models
              </Button>
            </Box>
          )}
        </SpaceBetween>
      );
    }

    return (
      <Table
        variant="embedded"
        loading={catalogQuery.isLoading}
        loadingText="Updating models…"
        items={catalog}
        columnDefinitions={columns}
        selectionType={readOnly ? undefined : "multi"}
        selectedItems={readOnly ? undefined : selectedItems}
        onSelectionChange={({ detail }) =>
          setSelectedItems(detail.selectedItems)
        }
        trackBy="modelId"
        header={
          <Header
            counter={tableCounter}
            actions={
              <SpaceBetween direction="horizontal" size="xs">
                <Button
                  iconName="refresh"
                  ariaLabel="Refresh model catalog"
                  disabled={catalogQuery.isFetching || busy || conflict}
                  onClick={() => void catalogQuery.refetch()}
                />
                {!readOnly && (
                  <ButtonDropdown
                    disabled={selectedItems.length === 0 || busy || conflict}
                    items={[
                      { text: "Disable", id: "disable", disabled: !canDisable },
                    ]}
                    onItemClick={({ detail }) => {
                      if (detail.id === "disable") stageDisable();
                    }}
                  >
                    Actions
                  </ButtonDropdown>
                )}
              </SpaceBetween>
            }
          >
            Models
          </Header>
        }
      />
    );
  };

  if (!visible) return null;
  return (
    <Box nativeAttributes={{ id: MODEL_CATALOG_ANCHOR, tabIndex: -1 }}>
      <Container
        header={
          <Header
            variant="h2"
            description={MODELS_DESCRIPTION}
            actions={
              // Only show "Add models" in the header when the catalog has rows.
              // Empty state has its own primary CTA; two identical buttons at once
              // is redundant.
              !readOnly && !isEmpty && !catalogQuery.isError ? (
                <Button
                  variant="primary"
                  disabled={busy}
                  onClick={() => navigate(ENABLE_ROUTE)}
                >
                  Add models
                </Button>
              ) : undefined
            }
          >
            Models
          </Header>
        }
      >
        <SpaceBetween size="m">
          {pending.length > 0 && (
            <Box color="text-body-secondary">
              {pending.length} model{pending.length === 1 ? "" : "s"} will be
              disabled when you save this group.
            </Box>
          )}
          {conflict && (
            <Alert type="warning" header="Model catalog conflict">
              {savedBy.length
                ? `${savedBy.join(", ")} saved these settings. `
                : "These models were modified by another administrator. "}
              Reload latest values before saving.
            </Alert>
          )}
          {renderCatalogBody()}
        </SpaceBetween>
      </Container>
    </Box>
  );
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Badge,
  Box,
  Button,
  Pagination,
  Popover,
  SpaceBetween,
  StatusIndicator,
  Table,
  TableProps,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useRef } from "react";

import { SANDBOX_SPACES_CONSTRAINTS } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/validation";
import type { AgentModelCatalogEntry } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

const PAGE_SIZE = 10;

export type SandboxSpacesModel = Pick<
  AgentModelCatalogEntry,
  "modelId" | "displayName" | "provider" | "availability"
>;

export interface SandboxSpacesModelRow {
  model: SandboxSpacesModel;
  isDefault: boolean;
  /** The model is no longer enabled in Settings, or is missing from the catalog. */
  isDisabled: boolean;
}

interface SandboxSpacesModelsTableProps {
  readonly rows: SandboxSpacesModelRow[];
  readonly loading?: boolean;
  readonly empty: string;
  readonly onSetDefault: (modelId: string) => void;
  /** Omitted when the models cannot be removed individually (all enabled models are allowed). */
  readonly onRemove?: (modelId: string) => void;
  /** Clears a default that is no longer enabled, the only way to replace it besides "Set as default". */
  readonly onRemoveDisabledDefault: () => void;
}

interface ModelRowActions {
  onSetDefault: (modelId: string) => void;
  onRemove?: (modelId: string) => void;
  onRemoveDisabledDefault: () => void;
}

/** A row plus its handlers, so the cell renderers can live outside the component. */
interface SandboxSpacesModelItem extends SandboxSpacesModelRow {
  actions: ModelRowActions;
}

function ModelName({ row }: Readonly<{ row: SandboxSpacesModelRow }>) {
  return (
    <SpaceBetween size="xxxs">
      <SpaceBetween direction="horizontal" size="xs">
        <Box>{row.model.displayName}</Box>
        {row.isDefault && <Badge color="blue">Default</Badge>}
        {row.isDisabled && (
          <Popover
            dismissButton={false}
            position="top"
            size="medium"
            triggerType="text"
            triggerAriaLabel={`Warning: ${row.model.displayName} globally disabled`}
            content={
              row.isDefault
                ? SANDBOX_SPACES_CONSTRAINTS.DEFAULT_MODEL_DISABLED_DETAILS
                : SANDBOX_SPACES_CONSTRAINTS.MODEL_DISABLED_DETAILS
            }
          >
            <StatusIndicator type="warning">Disabled</StatusIndicator>
          </Popover>
        )}
      </SpaceBetween>
      <Box variant="small" color="text-body-secondary">
        {row.model.modelId}
      </Box>
    </SpaceBetween>
  );
}

function ModelActions({
  row,
  onSetDefault,
  onRemove,
  onRemoveDisabledDefault,
}: Readonly<{ row: SandboxSpacesModelRow } & ModelRowActions>) {
  const { modelId, displayName } = row.model;
  if (row.isDisabled) {
    const handleRemove = row.isDefault
      ? onRemoveDisabledDefault
      : () => onRemove?.(modelId);
    return (
      <Button
        variant="inline-link"
        formAction="none"
        ariaLabel={`Remove ${displayName}`}
        onClick={handleRemove}
      >
        Remove
      </Button>
    );
  }
  if (row.isDefault) {
    return <Box color="text-status-inactive">-</Box>;
  }

  return (
    <SpaceBetween direction="horizontal" size="s">
      <Button
        variant="inline-link"
        formAction="none"
        ariaLabel={`Set ${displayName} as default model`}
        onClick={() => onSetDefault(modelId)}
      >
        Set as default
      </Button>
      {onRemove && (
        <Button
          variant="inline-link"
          formAction="none"
          ariaLabel={`Remove ${displayName}`}
          onClick={() => onRemove(modelId)}
        >
          Remove
        </Button>
      )}
    </SpaceBetween>
  );
}

function renderModelName(item: SandboxSpacesModelItem) {
  return <ModelName row={item} />;
}

function renderModelActions(item: SandboxSpacesModelItem) {
  return <ModelActions row={item} {...item.actions} />;
}

function trackByModelId(item: SandboxSpacesModelItem) {
  return item.model.modelId;
}

const COLUMN_DEFINITIONS: TableProps.ColumnDefinition<SandboxSpacesModelItem>[] =
  [
    {
      id: "model",
      header: "Model",
      cell: renderModelName,
    },
    {
      id: "provider",
      header: "Provider",
      cell: ({ model }) => model.provider || "-",
    },
    {
      id: "availability",
      header: "Availability",
      cell: ({ model }) => model.availability || "-",
    },
    {
      id: "actions",
      header: "Actions",
      cell: renderModelActions,
      width: 240,
    },
  ];

/** The models a Sandbox Space offers, with the default first. */
export const SandboxSpacesModelsTable = ({
  rows,
  loading = false,
  empty,
  onSetDefault,
  onRemove,
  onRemoveDisabledDefault,
}: SandboxSpacesModelsTableProps) => {
  const setCurrentPageRef = useRef<(pageNumber: number) => void>();
  const tableItems = useMemo<SandboxSpacesModelItem[]>(() => {
    const actions = {
      onSetDefault: (modelId: string) => {
        // The new default moves to the top row, so show the first page.
        setCurrentPageRef.current?.(1);
        onSetDefault(modelId);
      },
      onRemove,
      onRemoveDisabledDefault,
    };
    return rows.map((row) => ({ ...row, actions }));
  }, [rows, onSetDefault, onRemove, onRemoveDisabledDefault]);

  const { items, actions, paginationProps, collectionProps } = useCollection(
    tableItems,
    { pagination: { pageSize: PAGE_SIZE } },
  );

  useEffect(() => {
    setCurrentPageRef.current = actions.setCurrentPage;
  });

  return (
    <Table<SandboxSpacesModelItem>
      {...collectionProps}
      variant="embedded"
      wrapLines
      trackBy={trackByModelId}
      items={items}
      loading={loading}
      loadingText="Loading models"
      columnDefinitions={COLUMN_DEFINITIONS}
      empty={<Box color="text-body-secondary">{empty}</Box>}
      pagination={<Pagination {...paginationProps} />}
    />
  );
};

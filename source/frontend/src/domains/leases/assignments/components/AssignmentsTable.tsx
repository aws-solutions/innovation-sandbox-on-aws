// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  Grid,
  Table,
  type TableProps,
} from "@cloudscape-design/components";
import { type ReactNode, useState } from "react";

import type {
  AssignmentsTableMode,
  AssignmentTableAssignmentBase,
  AssignmentTableItem,
  AssignmentTableOperationBase,
  AssignmentTablePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";
import {
  AssignmentPrincipalNameCell,
  AssignmentPrincipalSubtitleCell,
  AssignmentPrincipalTypeCell,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentPrincipalCells";

export type {
  AssignmentsTableMode,
  AssignmentTableAssignmentBase,
  AssignmentTableItem,
  AssignmentTableOperationBase,
  AssignmentTablePrincipal,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentTable";

type AssignmentsTableProps<
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase = never,
> = {
  principals: AssignmentTablePrincipal<TAssignment, TOperation>[];
  mode: AssignmentsTableMode;
  empty: ReactNode;
  toolbarStart?: ReactNode;
  loading?: boolean;
  loadingText?: string;
  renderStatus?: (
    item: AssignmentTableItem<TAssignment, TOperation>,
  ) => ReactNode | undefined;
  renderPermissionSet: (
    item: AssignmentTableItem<TAssignment, TOperation>,
  ) => ReactNode;
  renderAddedBy?: (
    item: AssignmentTableItem<TAssignment, TOperation>,
  ) => ReactNode | undefined;
  renderAddedDate?: (
    item: AssignmentTableItem<TAssignment, TOperation>,
  ) => ReactNode | undefined;
  renderActions?: (
    item: AssignmentTableItem<TAssignment, TOperation>,
  ) => ReactNode | undefined;
};

type ColumnRenderers<
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase,
> = Pick<
  AssignmentsTableProps<TAssignment, TOperation>,
  | "renderStatus"
  | "renderPermissionSet"
  | "renderAddedBy"
  | "renderAddedDate"
  | "renderActions"
>;

const createColumnDefinitions = <
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase,
>(
  mode: AssignmentsTableMode,
  renderers: ColumnRenderers<TAssignment, TOperation>,
): TableProps.ColumnDefinition<
  AssignmentTableItem<TAssignment, TOperation>
>[] => {
  type Item = AssignmentTableItem<TAssignment, TOperation>;
  const columns: TableProps.ColumnDefinition<Item>[] = [
    {
      id: "name",
      header: "Name",
      cell: (item) => {
        if (item.kind === "operation") {
          return item.action === "grant" ? "Grant access" : "Revoke access";
        }
        return (
          <AssignmentPrincipalNameCell
            displayName={item.displayName}
            isOwner={item.isOwner}
          />
        );
      },
    },
    {
      id: "type",
      header: "Type",
      cell: (item) =>
        item.kind === "principal" ? (
          <AssignmentPrincipalTypeCell principalType={item.principalType} />
        ) : null,
    },
  ];

  if (mode === "management") {
    columns.push({
      id: "status",
      header: "Status",
      cell: (item) => renderers.renderStatus?.(item),
    });
  }

  columns.push(
    {
      id: "permissionSet",
      header: "Permission set",
      cell: renderers.renderPermissionSet,
    },
    {
      id: "subtitle",
      header: "Email / Group",
      cell: (item) =>
        item.kind === "principal" ? (
          <AssignmentPrincipalSubtitleCell
            principalType={item.principalType}
            subtitle={item.subtitle}
          />
        ) : null,
    },
  );

  if (mode === "management") {
    columns.push(
      {
        id: "addedBy",
        header: "Added by",
        cell: (item) => renderers.renderAddedBy?.(item) ?? "—",
      },
      {
        id: "addedDate",
        header: "Added",
        cell: (item) => renderers.renderAddedDate?.(item) ?? "—",
      },
    );
  }

  if (mode !== "readonly" && renderers.renderActions) {
    columns.push({
      id: "actions",
      header: "",
      cell: renderers.renderActions,
    });
  }

  return columns;
};

export const AssignmentsTable = <
  TAssignment extends AssignmentTableAssignmentBase,
  TOperation extends AssignmentTableOperationBase = never,
>({
  principals,
  mode,
  empty,
  toolbarStart,
  loading = false,
  loadingText = "Loading assignments",
  renderStatus,
  renderPermissionSet,
  renderAddedBy,
  renderAddedDate,
  renderActions,
}: AssignmentsTableProps<TAssignment, TOperation>) => {
  type Item = AssignmentTableItem<TAssignment, TOperation>;
  const [expandedRowIds, setExpandedRowIds] = useState<ReadonlySet<string>>(
    () => new Set(),
  );
  const columns = createColumnDefinitions(mode, {
    renderStatus,
    renderPermissionSet,
    renderAddedBy,
    renderAddedDate,
    renderActions,
  });
  const expandablePrincipals = principals.filter(
    ({ operations }) => operations.length > 1,
  );
  const hasExpandableRows = expandablePrincipals.length > 0;
  const allRowsExpanded =
    hasExpandableRows &&
    expandablePrincipals.every(({ rowId }) => expandedRowIds.has(rowId));
  const expandedItems = principals.filter(({ rowId }) =>
    expandedRowIds.has(rowId),
  );
  const toggleAllRows = () => {
    setExpandedRowIds(
      allRowsExpanded
        ? new Set()
        : new Set(expandablePrincipals.map(({ rowId }) => rowId)),
    );
  };

  return (
    <>
      {(toolbarStart || hasExpandableRows) && (
        <Box padding={{ bottom: "s" }}>
          <Grid
            gridDefinition={[
              { colspan: { default: 12, s: 9 } },
              { colspan: { default: 12, s: 3 } },
            ]}
          >
            <Box>{toolbarStart}</Box>
            <Box float="right">
              {hasExpandableRows && (
                <Button variant="inline-link" onClick={toggleAllRows}>
                  {allRowsExpanded ? "Collapse all" : "Expand all"}
                </Button>
              )}
            </Box>
          </Grid>
        </Box>
      )}
      <Table<Item>
        items={principals}
        loading={loading}
        loadingText={loadingText}
        trackBy={(item) => item.rowId}
        variant="embedded"
        ariaLabels={{
          tableLabel: "Lease assignments",
          expandButtonLabel: (item) =>
            item.kind === "principal"
              ? `Show permission set operations for ${item.displayName}`
              : "Show permission set operations",
          collapseButtonLabel: (item) =>
            item.kind === "principal"
              ? `Hide permission set operations for ${item.displayName}`
              : "Hide permission set operations",
        }}
        empty={empty}
        columnDefinitions={columns}
        expandableRows={
          hasExpandableRows
            ? {
                getItemChildren: (item) =>
                  item.kind === "principal" ? item.operations : [],
                isItemExpandable: (item) =>
                  item.kind === "principal" && item.operations.length > 1,
                expandedItems,
                onExpandableItemToggle: ({ detail }) => {
                  if (detail.item.kind !== "principal") return;
                  setExpandedRowIds((current) => {
                    const next = new Set(current);
                    if (detail.expanded) {
                      next.add(detail.item.rowId);
                    } else {
                      next.delete(detail.item.rowId);
                    }
                    return next;
                  });
                },
              }
            : undefined
        }
      />
    </>
  );
};

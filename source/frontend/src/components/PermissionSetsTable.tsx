// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Badge,
  Box,
  Button,
  Header,
  Popover,
  SpaceBetween,
  StatusIndicator,
  Table,
  TableProps,
} from "@cloudscape-design/components";
import { useMemo } from "react";

import { isBuiltInPermissionSet } from "@amzn/innovation-sandbox-frontend/domains/permissionSets/helpers";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

interface PermissionSetTableItem {
  permissionSet?: PermissionSetReference;
  isDefault: boolean;
}

interface PermissionSetsTableProps {
  readonly defaultPermissionSet?: PermissionSetReference;
  readonly allowedPermissionSets?: PermissionSetReference[];
  readonly header?: string;
  readonly disabled?: boolean;
  readonly onRemoveAllowedPermissionSet?: (
    permissionSet: PermissionSetReference,
  ) => void;
  readonly onSetDefaultPermissionSet?: (
    permissionSet: PermissionSetReference,
  ) => void;
}

export function withoutDefaultPermissionSet(
  defaultPermissionSet?: PermissionSetReference,
  allowedPermissionSets: PermissionSetReference[] = [],
) {
  return allowedPermissionSets.filter(
    ({ permissionSetArn }) =>
      permissionSetArn !== defaultPermissionSet?.permissionSetArn,
  );
}

function permissionSetRows(
  defaultPermissionSet?: PermissionSetReference,
  allowedPermissionSets: PermissionSetReference[] = [],
): PermissionSetTableItem[] {
  const rows: PermissionSetTableItem[] = [
    {
      permissionSet: defaultPermissionSet,
      isDefault: true,
    },
  ];

  for (const permissionSet of withoutDefaultPermissionSet(
    defaultPermissionSet,
    allowedPermissionSets,
  )) {
    rows.push({
      permissionSet,
      isDefault: false,
    });
  }
  return rows;
}

function PermissionSetName({
  item,
}: Readonly<{ item: PermissionSetTableItem }>) {
  const { permissionSet, isDefault } = item;
  const isBuiltIn = !permissionSet || isBuiltInPermissionSet(permissionSet);
  const name = isBuiltIn
    ? "Full sandbox access"
    : (permissionSet.name ?? permissionSet.permissionSetArn);

  return (
    <SpaceBetween size="xxs">
      <SpaceBetween direction="horizontal" size="xs">
        <Box fontWeight={isBuiltIn ? "bold" : undefined}>{name}</Box>
        {isDefault && <Badge color="blue">Default</Badge>}
      </SpaceBetween>
      {isBuiltIn && permissionSet?.name && (
        <Box fontSize="body-s" color="text-body-secondary">
          {permissionSet.name}
        </Box>
      )}
    </SpaceBetween>
  );
}

function PermissionSetDescription({
  permissionSet,
}: Readonly<{ permissionSet?: PermissionSetReference }>) {
  if (permissionSet?.availability === "UNAVAILABLE") {
    return (
      <Popover
        dismissButton={false}
        position="top"
        size="medium"
        content="This permission set is not currently available in the catalog. It cannot be used for new assignments or chosen as the default. Remove it if it is no longer needed; if it is currently the default, choose another default first."
      >
        <StatusIndicator type="warning">Unavailable</StatusIndicator>
      </Popover>
    );
  }

  return <Box>{permissionSet?.description ?? "—"}</Box>;
}

function PermissionSetActions({
  disabled,
  item,
  onSetDefault,
  onRemove,
}: Readonly<{
  disabled: boolean;
  item: PermissionSetTableItem;
  onSetDefault?: (permissionSet: PermissionSetReference) => void;
  onRemove?: (permissionSet: PermissionSetReference) => void;
}>) {
  const { permissionSet, isDefault } = item;
  if (isDefault || !permissionSet) {
    return <Box color="text-status-inactive">—</Box>;
  }

  const canSetDefault =
    permissionSet.availability !== "UNAVAILABLE" && onSetDefault !== undefined;
  if (!canSetDefault && !onRemove) {
    return <Box color="text-status-inactive">—</Box>;
  }

  return (
    <SpaceBetween direction="horizontal" size="s">
      {canSetDefault && (
        <Button
          variant="inline-link"
          formAction="none"
          disabled={disabled}
          ariaLabel={`Set ${permissionSet.name ?? permissionSet.permissionSetArn} as default permission set`}
          onClick={() => onSetDefault(permissionSet)}
        >
          Set as default
        </Button>
      )}
      {onRemove && (
        <Button
          variant="inline-link"
          formAction="none"
          disabled={disabled}
          ariaLabel={`Remove ${permissionSet.name ?? permissionSet.permissionSetArn}`}
          onClick={() => onRemove(permissionSet)}
        >
          Remove
        </Button>
      )}
    </SpaceBetween>
  );
}

function createColumnDefinitions({
  disabled,
  onSetDefaultPermissionSet,
  onRemoveAllowedPermissionSet,
}: {
  disabled: boolean;
  onSetDefaultPermissionSet?: (permissionSet: PermissionSetReference) => void;
  onRemoveAllowedPermissionSet?: (
    permissionSet: PermissionSetReference,
  ) => void;
}): TableProps.ColumnDefinition<PermissionSetTableItem>[] {
  const columns: TableProps.ColumnDefinition<PermissionSetTableItem>[] = [
    {
      id: "permissionSet",
      header: "Permission set",
      cell: (item) => <PermissionSetName item={item} />,
    },
    {
      id: "description",
      header: "Description",
      cell: ({ permissionSet }) => (
        <PermissionSetDescription permissionSet={permissionSet} />
      ),
    },
  ];

  if (onSetDefaultPermissionSet || onRemoveAllowedPermissionSet) {
    columns.push({
      id: "actions",
      header: "Actions",
      cell: (item) => (
        <PermissionSetActions
          disabled={disabled}
          item={item}
          onSetDefault={onSetDefaultPermissionSet}
          onRemove={onRemoveAllowedPermissionSet}
        />
      ),
      width: 240,
    });
  }

  return columns;
}

export const PermissionSetsTable = ({
  defaultPermissionSet,
  allowedPermissionSets,
  header = "Permission sets",
  disabled = false,
  onSetDefaultPermissionSet,
  onRemoveAllowedPermissionSet,
}: PermissionSetsTableProps) => {
  const columnDefinitions = useMemo(
    () =>
      createColumnDefinitions({
        disabled,
        onSetDefaultPermissionSet,
        onRemoveAllowedPermissionSet,
      }),
    [disabled, onRemoveAllowedPermissionSet, onSetDefaultPermissionSet],
  );

  return (
    <Table<PermissionSetTableItem>
      variant="embedded"
      stripedRows
      wrapLines
      trackBy={(item) =>
        item.permissionSet?.permissionSetArn ?? "built-in-default"
      }
      items={permissionSetRows(defaultPermissionSet, allowedPermissionSets)}
      header={<Header variant="h3">{header}</Header>}
      columnDefinitions={columnDefinitions}
    />
  );
};

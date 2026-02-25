// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { DeleteConfirmationDialog } from "@aws-northstar/ui";
import Table from "@aws-northstar/ui/components/Table";
import {
  Box,
  Button,
  ButtonDropdown,
  SpaceBetween,
  StatusIndicator,
  TextContent,
} from "@cloudscape-design/components";
import { DateTime, Duration } from "luxon";
import { useEffect, useState } from "react";

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { TextLink } from "@amzn/innovation-sandbox-frontend/components/TextLink";
import { showSuccessToast } from "@amzn/innovation-sandbox-frontend/components/Toast";
import { VisibilityIndicator } from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/components/VisibilityIndicator";
import {
  useDeleteLeaseTemplates,
  useGetLeaseTemplates,
} from "@amzn/innovation-sandbox-frontend/domains/leaseTemplates/hooks";
import { createDateSortingComparator } from "@amzn/innovation-sandbox-frontend/helpers/date-sorting-comparator";
import { formatCurrency } from "@amzn/innovation-sandbox-frontend/helpers/util";

const NameCell = ({ item }: { item: LeaseTemplate }) => (
  <>
    <Box>
      <TextLink to={`/lease_templates/${item.uuid}`}>{item.name}</TextLink>
    </Box>
    <Box>
      <small data-break-spaces>{item.description}</small>
    </Box>
  </>
);

const MaxSpendCell = ({ item }: { item: LeaseTemplate }) => (
  <>
    {item.maxSpend ? (
      formatCurrency(item.maxSpend)
    ) : (
      <StatusIndicator type="info">No max budget</StatusIndicator>
    )}
  </>
);

const ExpiryCell = ({ item }: { item: LeaseTemplate }) => (
  <>
    {item.leaseDurationInHours ? (
      `after ${Duration.fromObject({ hours: item.leaseDurationInHours }).toHuman()}`
    ) : (
      <StatusIndicator type="info">No expiry</StatusIndicator>
    )}
  </>
);

const CostReportCell = ({ item }: { item: LeaseTemplate }) => {
  return item.costReportGroup ? (
    <span>{item.costReportGroup}</span>
  ) : (
    <StatusIndicator type="info">Not assigned</StatusIndicator>
  );
};

export const LeaseTemplatesTable = () => {
  // get lease templates using react query hook
  const {
    data: leaseTemplates,
    isFetching,
    isError,
    refetch,
    error: getError,
  } = useGetLeaseTemplates();

  // selected items state
  const [selectedItems, setSelectedItems] = useState<LeaseTemplate[]>([]);

  // state to show/hide delete modal dialog
  const [isDeleteModalVisible, setDeleteModalVisible] = useState(false);
  const [showDeleteError, setShowDeleteError] = useState(false);

  // hook to delete lease templates
  const {
    mutateAsync: deleteLeaseTemplates,
    isPending: isDeleting,
    isError: isDeleteError,
    error: deleteError,
  } = useDeleteLeaseTemplates();

  // hide error message when displaying modal
  useEffect(() => {
    setShowDeleteError(false);
  }, [isDeleteModalVisible]);

  // show modal error message if error occurred during delete
  useEffect(() => {
    setShowDeleteError(isDeleteError);
  }, [isDeleteError]);

  // delete lease templates using above hook when confirming in modal dialog
  const handleDelete = async () => {
    const selectedIds = selectedItems.map((x) => x.uuid);
    await deleteLeaseTemplates(selectedIds);
    setSelectedItems([]);
    setDeleteModalVisible(false);
    showSuccessToast("Lease template(s) deleted.");
  };

  if (isError) {
    return (
      <ErrorPanel
        retry={refetch}
        description="Could not load lease templates. Please try again."
        error={getError as Error}
      />
    );
  }

  return (
    <>
      <Table
        header="Lease Templates"
        stripedRows
        resizableColumns
        trackBy="uuid"
        loading={isFetching}
        items={leaseTemplates || []}
        totalItemsCount={(leaseTemplates || []).length}
        selectedItems={selectedItems}
        onSelectionChange={({ detail }) =>
          setSelectedItems(detail.selectedItems)
        }
        columnDefinitions={[
          {
            id: "name",
            header: "Name",
            sortingField: "name",
            cell: (item: LeaseTemplate) => <NameCell item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
          },
          {
            id: "createdBy",
            header: "Created by",
            sortingField: "createdBy",
            cell: (item: LeaseTemplate) => item.createdBy,
          },
          {
            id: "blueprint",
            header: "Blueprint",
            sortingField: "blueprintName",
            // prettier-ignore
            cell: (item: LeaseTemplate) => <BlueprintName blueprintName={item.blueprintName} />, // NOSONAR typescript:S6478 - Table API requires cell render functions
          },
          {
            id: "costReportGroup",
            header: "Cost Report Group",
            sortingField: "costReportGroup",
            cell: (item: LeaseTemplate) => <CostReportCell item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
          },
          {
            id: "visibility",
            header: "Visibility",
            sortingField: "visibility",
            cell: (item: LeaseTemplate) => <VisibilityIndicator item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
          },
          {
            id: "maxSpend",
            header: "Max Budget",
            sortingField: "maxSpend",
            cell: (item: LeaseTemplate) => <MaxSpendCell item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
          },
          {
            id: "leaseDurationInHours",
            header: "Expiry",
            sortingField: "leaseDurationInHours",
            cell: (item: LeaseTemplate) => <ExpiryCell item={item} />, // NOSONAR typescript:S6478 - the way the table component works requires defining component during render
          },
          {
            id: "meta.lastEditTime",
            header: "Last Updated",
            sortingComparator: createDateSortingComparator<LeaseTemplate>(
              (a) => a.meta?.lastEditTime,
            ),
            cell: (item: LeaseTemplate) =>
              item.meta?.lastEditTime
                ? DateTime.fromISO(item.meta.lastEditTime).toRelative()
                : "",
          },
        ]}
        actions={
          <SpaceBetween direction="horizontal" size="s">
            <Button
              data-testid="refresh-button"
              iconName="refresh"
              onClick={() => refetch()}
              disabled={isFetching}
            />
            <ButtonDropdown
              disabled={selectedItems.length === 0}
              items={[{ text: "Delete", id: "delete" }]}
              onItemClick={({ detail }) => {
                if (detail.id === "delete") {
                  setDeleteModalVisible(true);
                }
              }}
            >
              Actions
            </ButtonDropdown>
          </SpaceBetween>
        }
      />

      <DeleteConfirmationDialog
        variant="confirmation"
        visible={isDeleteModalVisible}
        title="Remove lease templates"
        onCancelClicked={() => setDeleteModalVisible(false)}
        onDeleteClicked={handleDelete}
        loading={isDeleting}
      >
        <TextContent>
          Are you sure you want to remove these lease template(s)?
        </TextContent>

        {showDeleteError && (
          <ErrorPanel
            description="An error occurred. Please try again."
            error={deleteError as Error}
          />
        )}
      </DeleteConfirmationDialog>
    </>
  );
};

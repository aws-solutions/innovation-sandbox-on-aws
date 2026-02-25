// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Alert,
  Box,
  Header,
  Pagination,
  SpaceBetween,
  Table,
  TableProps,
  TextFilter,
} from "@cloudscape-design/components";
import { Controller, useFormContext } from "react-hook-form";

import { useListStackSets } from "@amzn/innovation-sandbox-frontend/domains/blueprints/hooks";
import { StackSet } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";
import { BlueprintWizardFormValues } from "@amzn/innovation-sandbox-frontend/domains/blueprints/validation";

export function StackSetSelectionForm() {
  const { control } = useFormContext<BlueprintWizardFormValues>();
  const { data: stackSetsData, isLoading: isLoadingStackSets } =
    useListStackSets();

  const stackSets = stackSetsData?.result || [];

  const { items, filterProps, collectionProps, paginationProps } =
    useCollection(stackSets, {
      filtering: {
        empty: "No StackSets found",
        noMatch: "No StackSets match the filter",
      },
      sorting: {
        defaultState: {
          sortingColumn: {
            sortingField: "stackSetName",
          },
        },
      },
      pagination: {
        pageSize: 10,
      },
    });

  const columnDefinitions: TableProps.ColumnDefinition<StackSet>[] = [
    {
      id: "stackSetName",
      header: "StackSet name",
      cell: (item: StackSet) => item.stackSetName,
      sortingField: "stackSetName",
    },
    {
      id: "description",
      header: "Description",
      cell: (item: StackSet) => item.description || "-",
    },
  ];

  return (
    <Controller
      control={control}
      name="selectedStackSet"
      render={({ field, fieldState }) => (
        <SpaceBetween size="l">
          <Alert type="info">
            StackSets must have <strong>ACTIVE</strong> status and{" "}
            <strong>SELF_MANAGED</strong> permission model to be available for
            use in Blueprints
          </Alert>

          <Alert
            type="warning"
            header="Best practice: Enable managed execution"
          >
            For faster deployments, enable managed execution on your StackSet.
            This allows CloudFormation to run multiple operations at once and
            automatically queue new requests.
          </Alert>

          {fieldState.error && (
            <Alert type="error">{fieldState.error.message}</Alert>
          )}

          <Table
            {...collectionProps}
            variant="container"
            columnDefinitions={columnDefinitions}
            items={items}
            loading={isLoadingStackSets}
            loadingText="Loading StackSets..."
            selectionType="single"
            selectedItems={field.value ? [field.value] : []}
            onSelectionChange={({ detail }) =>
              field.onChange(detail.selectedItems[0] || null)
            }
            onRowClick={({ detail }) => field.onChange(detail.item)}
            trackBy="stackSetId"
            empty={
              <Box textAlign="center" color="inherit" variant="p">
                No SELF_MANAGED StackSets found
              </Box>
            }
            filter={
              <TextFilter
                {...filterProps}
                filteringPlaceholder="Find StackSets by name or description"
                filteringAriaLabel="Filter StackSets"
              />
            }
            pagination={<Pagination {...paginationProps} />}
            header={
              <Header
                variant="h2"
                description="Choose a StackSet for your blueprint"
              >
                Available StackSets
              </Header>
            }
          />
        </SpaceBetween>
      )}
    />
  );
}

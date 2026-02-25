// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  ColumnLayout,
  ExpandableSection,
  KeyValuePairs,
  SpaceBetween,
  StatusIndicator,
  Table,
  TableProps,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { useState } from "react";

import { DeploymentHistory } from "@amzn/innovation-sandbox-frontend/domains/blueprints/types";

const formatDateTime = (
  isoString: string,
  format: Intl.DateTimeFormatOptions = DateTime.DATETIME_SHORT,
): string => {
  const dt = DateTime.fromISO(isoString);
  return dt.isValid ? dt.toLocaleString(format) : "-";
};

interface DeploymentHistoryTableProps {
  deployments: DeploymentHistory[];
}

export const DeploymentHistoryTable = ({
  deployments,
}: DeploymentHistoryTableProps) => {
  const [selectedItems, setSelectedItems] = useState<DeploymentHistory[]>([]);

  const selectedDeployment = selectedItems[0] || null;

  const getStatusIndicatorType = (status: string) => {
    const statusMap: Record<string, "success" | "error" | "in-progress"> = {
      SUCCEEDED: "success",
      FAILED: "error",
      RUNNING: "in-progress",
    };
    return statusMap[status] || "info";
  };

  const columnDefinitions: TableProps.ColumnDefinition<DeploymentHistory>[] = [
    {
      id: "leaseId",
      header: "Lease ID",
      cell: (item) => item.leaseId,
      sortingField: "leaseId",
    },
    {
      id: "accountId",
      header: "Account ID",
      cell: (item) => item.accountId,
      sortingField: "accountId",
    },
    {
      id: "status",
      header: "Status",
      // prettier-ignore
      cell: (item) => ( // NOSONAR typescript:S6478 - Table API requires cell render functions
        <StatusIndicator type={getStatusIndicatorType(item.status)}>
          {item.status}
        </StatusIndicator>
      ),
      sortingField: "status",
    },
    {
      id: "started",
      header: "Started",
      cell: (item) => formatDateTime(item.deploymentStartedAt),
      sortingField: "deploymentStartedAt",
    },
    {
      id: "duration",
      header: "Duration",
      cell: (item) => (item.duration ? `${item.duration} min` : "-"),
      sortingField: "duration",
    },
  ];

  const buildOverviewItems = (deployment: DeploymentHistory) => {
    const items: Array<{ label: string; value: string }> = [];

    items.push({ label: "Lease ID", value: deployment.leaseId });
    items.push({ label: "Account ID", value: deployment.accountId });
    items.push({
      label: "Started",
      value: formatDateTime(
        deployment.deploymentStartedAt,
        DateTime.DATETIME_FULL,
      ),
    });

    if (deployment.deploymentCompletedAt) {
      items.push({
        label: "Completed",
        value: formatDateTime(
          deployment.deploymentCompletedAt,
          DateTime.DATETIME_FULL,
        ),
      });
    }

    if (deployment.duration) {
      items.push({
        label: "Duration",
        value: `${deployment.duration} minutes`,
      });
    }

    items.push({
      label: "Operation ID",
      value: deployment.operationId,
    });

    return items;
  };

  const buildErrorItems = (deployment: DeploymentHistory) => {
    const errorItems: Array<{ label: string; value: React.JSX.Element }> = [];

    if (deployment.errorType) {
      errorItems.push({
        label: "Error Type",
        value: <Box color="text-status-error">{deployment.errorType}</Box>,
      });
    }

    if (deployment.errorMessage) {
      const hasRegionErrors = deployment.errorMessage.includes(": ");

      if (hasRegionErrors) {
        const regionErrors = deployment.errorMessage
          .split("; ")
          .map((error) => error.trim())
          .filter((error) => error.length > 0);

        errorItems.push({
          label: "Error Details",
          value: (
            <Box color="text-status-error">
              {regionErrors.map((error) => (
                <Box key={`region-error-${error}`}>{error}</Box>
              ))}
            </Box>
          ),
        });
      } else {
        errorItems.push({
          label: "Error Message",
          value: <Box color="text-status-error">{deployment.errorMessage}</Box>,
        });
      }
    }

    return errorItems;
  };

  const renderDeploymentDetails = () => {
    if (!selectedDeployment) return null;

    const isFailed = selectedDeployment.status === "FAILED";
    const hasErrors =
      selectedDeployment.errorType || selectedDeployment.errorMessage;
    const overviewItems = buildOverviewItems(selectedDeployment);

    return (
      <ExpandableSection
        headerText="Deployment details"
        defaultExpanded
        variant="footer"
      >
        <ColumnLayout columns={2} borders="vertical">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Status",
                value: (
                  <StatusIndicator
                    type={getStatusIndicatorType(selectedDeployment.status)}
                  >
                    {selectedDeployment.status}
                  </StatusIndicator>
                ),
              },
              ...overviewItems,
            ]}
          />

          {isFailed && hasErrors ? (
            <KeyValuePairs
              columns={1}
              items={buildErrorItems(selectedDeployment)}
            />
          ) : (
            <Box color="text-body-secondary">No errors</Box>
          )}
        </ColumnLayout>
      </ExpandableSection>
    );
  };

  return (
    <SpaceBetween size="l">
      <Table
        variant="embedded"
        columnDefinitions={columnDefinitions}
        items={deployments}
        sortingDisabled={false}
        trackBy="operationId"
        selectedItems={selectedItems}
        selectionType="single"
        onSelectionChange={({ detail }) => {
          setSelectedItems(detail.selectedItems);
        }}
        onRowClick={({ detail }) => {
          setSelectedItems([detail.item]);
        }}
        empty={
          <Box textAlign="center" color="inherit" variant="p">
            No recent deployments
          </Box>
        }
      />
      {renderDeploymentDetails()}
    </SpaceBetween>
  );
};

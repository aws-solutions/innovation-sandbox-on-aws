// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { ThresholdDetails } from "@amzn/innovation-sandbox-frontend/components/ThresholdDetails";
import {
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

interface LeaseTemplateSummaryProps {
  leaseTemplate: {
    name: string;
    description?: string;
    uuid?: string;
    createdBy?: string;
    visibility: "PRIVATE" | "PUBLIC";
    requiresApproval: boolean;
    maxSpend?: number;
    budgetThresholds?: Array<{
      dollarsSpent: number;
      action: "ALERT" | "FREEZE_ACCOUNT";
    }>;
    leaseDurationInHours?: number;
    durationThresholds?: Array<{
      hoursRemaining: number;
      action: "ALERT" | "FREEZE_ACCOUNT";
    }>;
    costReportGroup?: string;
    blueprintId?: string | null;
    blueprintName?: string | null;
  };
  showEditButtons?: boolean;
  onEditBasic?: () => void;
  onEditBlueprint?: () => void;
  onEditBudget?: () => void;
  onEditDuration?: () => void;
  onEditCostReport?: () => void;
}

export const LeaseTemplateSummary = ({
  leaseTemplate,
  showEditButtons = false,
  onEditBasic,
  onEditBlueprint,
  onEditBudget,
  onEditDuration,
  onEditCostReport,
}: LeaseTemplateSummaryProps) => {
  const buildBasicDetailsItems = (): Array<{
    label: string;
    value: React.ReactNode;
  }> => {
    const items: Array<{ label: string; value: React.ReactNode }> = [
      {
        label: "Name",
        value: leaseTemplate.name || "—",
      },
      {
        label: "Description",
        value: leaseTemplate.description || "No description provided",
      },
    ];

    if (leaseTemplate.uuid) {
      items.push({
        label: "Id",
        value: leaseTemplate.uuid,
      });
    }

    if (leaseTemplate.createdBy) {
      items.push({
        label: "Created By",
        value: leaseTemplate.createdBy,
      });
    }

    items.push(
      {
        label: "Visibility",
        value: leaseTemplate.visibility ? (
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Box
              color={
                leaseTemplate.visibility === "PUBLIC"
                  ? "text-status-success"
                  : "text-status-info"
              }
            >
              {leaseTemplate.visibility === "PUBLIC" ? "Public" : "Private"}
            </Box>
          </SpaceBetween>
        ) : (
          "—"
        ),
      },
      {
        label: "Requires Approval",
        value: leaseTemplate.requiresApproval ? (
          <StatusIndicator type="success">Yes</StatusIndicator>
        ) : (
          <StatusIndicator type="info">No (Auto-approved)</StatusIndicator>
        ),
      },
    );

    return items;
  };

  return (
    <SpaceBetween size="l">
      {/* Basic Details */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditBasic ? (
                <Button iconName="edit" onClick={onEditBasic}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Basic Details
          </Header>
        }
      >
        <KeyValuePairs columns={2} items={buildBasicDetailsItems()} />
      </Container>

      {/* Blueprint Settings*/}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditBlueprint ? (
                <Button iconName="edit" onClick={onEditBlueprint}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Blueprint Details
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: <Box variant="h3" children={"Blueprint ID"} />,
              value: leaseTemplate.blueprintId ? (
                leaseTemplate.blueprintId
              ) : (
                <StatusIndicator type="info">No Blueprint</StatusIndicator>
              ),
            },
            {
              label: <Box variant="h3" children={"Blueprint Name"} />,
              value: (
                <BlueprintName blueprintName={leaseTemplate.blueprintName} />
              ),
            },
          ]}
        />
      </Container>

      {/* Budget Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditBudget ? (
                <Button iconName="edit" onClick={onEditBudget}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Budget Settings
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3" children={"Maximum Budget"} />,
                value:
                  leaseTemplate.maxSpend !== undefined
                    ? `$${leaseTemplate.maxSpend.toFixed(2)}`
                    : "Not set",
              },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3" children={"Budget Thresholds"} />,
                value: (
                  <ThresholdDetails
                    thresholds={leaseTemplate.budgetThresholds}
                    valueLabel="Cost Accrued"
                    renderValue={(threshold) =>
                      `$${threshold.dollarsSpent.toFixed(2)}`
                    }
                  />
                ),
              },
            ]}
          />
        </ColumnLayout>
      </Container>

      {/* Duration Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditDuration ? (
                <Button iconName="edit" onClick={onEditDuration}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Duration Settings
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3" children={"Maximum Duration"} />,
                value:
                  leaseTemplate.leaseDurationInHours !== undefined
                    ? `${leaseTemplate.leaseDurationInHours} hours`
                    : "Not set",
              },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3" children={"Duration Thresholds"} />,
                value: (
                  <ThresholdDetails
                    thresholds={leaseTemplate.durationThresholds}
                    valueLabel="Hours Remaining"
                    renderValue={(threshold) =>
                      `${threshold.hoursRemaining} hours`
                    }
                  />
                ),
              },
            ]}
          />
        </ColumnLayout>
      </Container>

      {/* Cost Report Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditCostReport ? (
                <Button iconName="edit" onClick={onEditCostReport}>
                  Edit
                </Button>
              ) : undefined
            }
          >
            Cost Report Settings
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Cost Report Group",
              value: leaseTemplate.costReportGroup ? (
                leaseTemplate.costReportGroup
              ) : (
                <StatusIndicator type="info">Not assigned</StatusIndicator>
              ),
            },
          ]}
        />
      </Container>
    </SpaceBetween>
  );
};

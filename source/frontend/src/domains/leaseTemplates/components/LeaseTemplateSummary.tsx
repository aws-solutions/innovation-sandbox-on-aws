// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  ColumnLayout,
  Container,
  Header,
  KeyValuePairs,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { AccessSettingsSummary } from "@amzn/innovation-sandbox-frontend/components/AccessSettingsSummary";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { FeatureStatusIndicator } from "@amzn/innovation-sandbox-frontend/components/FeatureStatusIndicator";
import { predictiveBudgetSummaryItems } from "@amzn/innovation-sandbox-frontend/components/PredictiveBudgetSummaryItems";
import { useSandboxSpacesSummaryItems } from "@amzn/innovation-sandbox-frontend/components/SandboxSpacesSummaryItems";
import { ThresholdDetails } from "@amzn/innovation-sandbox-frontend/components/ThresholdDetails";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set";

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
      triggerOn?: "REPORTED" | "PREDICTED";
    }>;
    predictiveBudgetEnabled?: boolean;
    bedrockTokenMonitoringEnabled?: boolean;
    rateLimits?: Array<{
      basis: "HOURLY" | "DAILY";
      rate: number;
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
    allowOwnerToShareLease?: boolean;
    sandboxSpacesEnabled?: boolean;
    allowedModelIds?: string[];
    defaultModelId?: string;
    defaultPermissionSet?: PermissionSetReference;
    allowedPermissionSets?: PermissionSetReference[];
  };
  showEditButtons?: boolean;
  useRequestAccessTerminology?: boolean;
  leaseSharingEnabled?: boolean;
  sandboxSpacesEnabled?: boolean;
  onEditBasic?: () => void;
  onEditBlueprint?: () => void;
  onEditBudget?: () => void;
  onEditDuration?: () => void;
  onEditCostReport?: () => void;
  onEditSandboxSpaces?: () => void;
  onEditAccessAndSharing?: () => void;
}

export const LeaseTemplateSummary = ({
  leaseTemplate,
  showEditButtons = false,
  useRequestAccessTerminology = false,
  leaseSharingEnabled = false,
  sandboxSpacesEnabled = false,
  onEditBasic,
  onEditBlueprint,
  onEditBudget,
  onEditDuration,
  onEditCostReport,
  onEditSandboxSpaces,
  onEditAccessAndSharing,
}: LeaseTemplateSummaryProps) => {
  const editAction = (
    onEdit?: () => void,
    ariaLabel?: string,
  ): React.ReactNode =>
    showEditButtons && onEdit ? (
      <Button iconName="edit" onClick={onEdit} ariaLabel={ariaLabel}>
        Edit
      </Button>
    ) : undefined;

  // Template pages are Manager/Admin only, so the catalog is always readable.
  const sandboxSpacesModelItems = useSandboxSpacesSummaryItems(leaseTemplate, {
    canReadCatalog: true,
  });

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

    let visibilityText =
      leaseTemplate.visibility === "PUBLIC" ? "Public" : "Private";
    if (useRequestAccessTerminology) {
      visibilityText =
        leaseTemplate.visibility === "PUBLIC"
          ? "Requests allowed"
          : "Assignment only";
    }

    items.push(
      {
        label: useRequestAccessTerminology
          ? "Allow user requests"
          : "Visibility",
        value: leaseTemplate.visibility ? (
          <SpaceBetween direction="horizontal" size="xs" alignItems="center">
            <Box
              color={
                leaseTemplate.visibility === "PUBLIC"
                  ? "text-status-success"
                  : "text-status-info"
              }
            >
              {visibilityText}
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
          <Header variant="h2" actions={editAction(onEditBasic)}>
            Basic Details
          </Header>
        }
      >
        <KeyValuePairs columns={2} items={buildBasicDetailsItems()} />
      </Container>

      {/* Blueprint Settings*/}
      <Container
        header={
          <Header variant="h2" actions={editAction(onEditBlueprint)}>
            Blueprint Details
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: <Box variant="h3">Blueprint ID</Box>,
              value: leaseTemplate.blueprintId ? (
                leaseTemplate.blueprintId
              ) : (
                <StatusIndicator type="info">No Blueprint</StatusIndicator>
              ),
            },
            {
              label: <Box variant="h3">Blueprint Name</Box>,
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
          <Header variant="h2" actions={editAction(onEditBudget)}>
            Budget Settings
          </Header>
        }
      >
        <SpaceBetween size="l">
          {leaseTemplate.sandboxSpacesEnabled && (
            <Alert type="info" header="Bedrock token monitoring required">
              Bedrock token monitoring is required while Sandbox Spaces is
              enabled for this template.
            </Alert>
          )}
          <ColumnLayout columns={2} variant="text-grid">
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Maximum Budget</Box>,
                  value:
                    leaseTemplate.maxSpend === undefined
                      ? "Not set"
                      : `$${leaseTemplate.maxSpend.toFixed(2)}`,
                },
                // Plain-string empty state, matching the Maximum Budget row above
                ...predictiveBudgetSummaryItems(leaseTemplate, "Not set"),
              ]}
            />
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Budget Thresholds</Box>,
                  value: (
                    <ThresholdDetails
                      thresholds={leaseTemplate.budgetThresholds}
                      valueLabel="Cost Accrued"
                      renderValue={(threshold) =>
                        `$${threshold.dollarsSpent.toFixed(2)}`
                      }
                      showTriggerOn
                    />
                  ),
                },
              ]}
            />
          </ColumnLayout>
        </SpaceBetween>
      </Container>

      {/* Duration Settings */}
      <Container
        header={
          <Header variant="h2" actions={editAction(onEditDuration)}>
            Duration Settings
          </Header>
        }
      >
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3">Maximum Duration</Box>,
                value:
                  leaseTemplate.leaseDurationInHours === undefined
                    ? "Not set"
                    : `${leaseTemplate.leaseDurationInHours} hours`,
              },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: <Box variant="h3">Duration Thresholds</Box>,
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
          <Header variant="h2" actions={editAction(onEditCostReport)}>
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

      {/* Sandbox Spaces */}
      <Container
        header={
          <Header variant="h2" actions={editAction(onEditSandboxSpaces)}>
            Sandbox Spaces
          </Header>
        }
      >
        <KeyValuePairs
          columns={1}
          items={[
            {
              label: "Sandbox Spaces",
              value: (
                <FeatureStatusIndicator
                  featureName="Sandbox Spaces"
                  enabled={leaseTemplate.sandboxSpacesEnabled === true}
                  globallyEnabled={sandboxSpacesEnabled}
                />
              ),
            },
            ...sandboxSpacesModelItems,
          ]}
        />
      </Container>

      {/* Access and sharing */}
      <Container
        header={
          <Header
            variant="h2"
            actions={editAction(
              onEditAccessAndSharing,
              "Edit access and sharing",
            )}
          >
            Access and sharing
          </Header>
        }
      >
        <AccessSettingsSummary
          allowOwnerToShareLease={leaseTemplate.allowOwnerToShareLease}
          leaseSharingEnabled={leaseSharingEnabled}
          defaultPermissionSet={leaseTemplate.defaultPermissionSet}
          allowedPermissionSets={leaseTemplate.allowedPermissionSets}
        />
      </Container>
    </SpaceBetween>
  );
};

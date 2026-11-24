// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Box,
  Button,
  ColumnLayout,
  Container,
  CopyToClipboard,
  Header,
  KeyValuePairs,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import { AccessSettingsSummary } from "@amzn/innovation-sandbox-frontend/components/AccessSettingsSummary";
import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { BudgetStatus } from "@amzn/innovation-sandbox-frontend/components/BudgetStatus";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { FeatureStatusIndicator } from "@amzn/innovation-sandbox-frontend/components/FeatureStatusIndicator";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";
import { predictiveBudgetSummaryItems } from "@amzn/innovation-sandbox-frontend/components/PredictiveBudgetSummaryItems";
import { useSandboxSpacesSummaryItems } from "@amzn/innovation-sandbox-frontend/components/SandboxSpacesSummaryItems";
import { ThresholdDetails } from "@amzn/innovation-sandbox-frontend/components/ThresholdDetails";
import { TimePopover } from "@amzn/innovation-sandbox-frontend/components/TimePopover";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import {
  getCurrentLeaseSpend,
  isExpiredLease,
  isMonitoredLease,
  isPendingLease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

interface LeaseSummaryProps {
  lease: LeaseView;
  showEditButtons?: boolean;
  showAdminFields?: boolean;
  leaseSharingEnabled?: boolean;
  /** Global `agent.sandboxSpacesEnabled` flag; when off, an enabled lease reads as overridden. */
  sandboxSpacesEnabled?: boolean;
  onEditBudget?: () => void;
  onEditDuration?: () => void;
  onEditCostReport?: () => void;
  onEditSandboxSpaces?: () => void;
  onEditAccessSettings?: () => void;
}

// Helper function to render approved by
const renderApprovedBy = (lease: LeaseView) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not approved</StatusIndicator>;
  }

  if (lease.approvedBy === "AUTO_APPROVED") {
    return <StatusIndicator type="success">Auto Approved</StatusIndicator>;
  }

  return lease.approvedBy;
};

// Helper function to render lease started
const renderLeaseStarted = (lease: LeaseView) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not started</StatusIndicator>;
  }

  return <TimePopover time={lease.startDate} />;
};

// Helper function to render last monitored
const renderLastMonitored = (lease: LeaseView) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not monitored</StatusIndicator>;
  }

  return <TimePopover time={lease.lastCheckedDate} />;
};

// Helper function to render comments
const renderComments = (comments?: string) => {
  if (!comments) {
    return <StatusIndicator type="info">No comments provided</StatusIndicator>;
  }

  return comments;
};

// Helper function to render budget status
const renderBudgetStatus = (lease: LeaseView) => {
  const isPending = isPendingLease(lease);
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (isPending) {
    return <BudgetStatus maxSpend={lease.maxSpend} />;
  }

  return (
    <BudgetProgressBar
      currentValue={isMonitoredOrExpired ? getCurrentLeaseSpend(lease) : 0}
      maxValue={lease.maxSpend}
    />
  );
};

// Helper function to render cost report group
const renderCostReportGroup = (costReportGroup?: string) => {
  if (!costReportGroup) {
    return <StatusIndicator type="info">Not assigned</StatusIndicator>;
  }

  return costReportGroup;
};

export const LeaseSummary = ({
  lease,
  showEditButtons = false,
  showAdminFields = false,
  leaseSharingEnabled = false,
  sandboxSpacesEnabled = false,
  onEditBudget,
  onEditDuration,
  onEditCostReport,
  onEditSandboxSpaces,
  onEditAccessSettings,
}: LeaseSummaryProps) => {
  const leaseSandboxSpacesEnabled = lease.sandboxSpacesEnabled === true;
  const sandboxSpacesModelItems = useSandboxSpacesSummaryItems(lease, {
    canReadCatalog: showAdminFields,
  });

  return (
    <SpaceBetween size="l">
      {/* Basic Details */}
      <Container header={<Header variant="h2">Lease Details</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Name",
                value: (
                  <LeaseName
                    uuid={lease.uuid}
                    templateName={lease.originalLeaseTemplateName}
                  />
                ),
              },
              {
                label: "UUID",
                value: (
                  <CopyToClipboard
                    variant="inline"
                    textToCopy={lease.uuid}
                    copyButtonAriaLabel="Copy lease UUID"
                    copySuccessText="UUID copied"
                    copyErrorText="Failed to copy"
                  />
                ),
              },
              {
                label: "AWS Account ID",
                value: (
                  <AccountId
                    accountId={
                      isMonitoredLease(lease) || isExpiredLease(lease)
                        ? lease.awsAccountId
                        : undefined
                    }
                    copyable
                  />
                ),
              },
              {
                label: "Lease Template",
                value: (
                  <LeaseTemplateName
                    uuid={lease.originalLeaseTemplateUuid}
                    name={lease.originalLeaseTemplateName}
                  />
                ),
              },
              {
                label: "Blueprint Name",
                value: <BlueprintName blueprintName={lease.blueprintName} />,
              },
              {
                label: "Owner",
                value: lease.userEmail,
              },
            ]}
          />
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Status",
                value: <LeaseStatusBadge lease={lease} />,
              },
              {
                label: "Created By",
                value: lease.createdBy ?? lease.userEmail,
              },
              {
                label: "Approved By",
                value: renderApprovedBy(lease),
              },
              {
                label: "Lease Started",
                value: renderLeaseStarted(lease),
              },
              ...(showAdminFields
                ? [
                    {
                      label: "Last Monitored",
                      value: renderLastMonitored(lease),
                    },
                  ]
                : []),
              {
                label: "Comments from Requester",
                value: renderComments(lease.comments),
              },
            ]}
          />
        </ColumnLayout>
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
                label: <Box variant="h3">Budget Status</Box>,
                value: renderBudgetStatus(lease),
              },
              ...predictiveBudgetSummaryItems(
                lease,
                <StatusIndicator type="info">Not set</StatusIndicator>,
              ),
            ]}
          />
          {showAdminFields && (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Budget Thresholds</Box>,
                  value: (
                    <ThresholdDetails
                      thresholds={lease.budgetThresholds}
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
          )}
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
                label: <Box variant="h3">Lease Expiry</Box>,
                value: <DurationStatus {...getLeaseExpiryInfo(lease)} />,
              },
            ]}
          />
          {showAdminFields && (
            <KeyValuePairs
              columns={1}
              items={[
                {
                  label: <Box variant="h3">Duration Thresholds</Box>,
                  value: (
                    <ThresholdDetails
                      thresholds={lease.durationThresholds}
                      valueLabel="Hours Remaining"
                      renderValue={(threshold) =>
                        `${threshold.hoursRemaining} hours`
                      }
                    />
                  ),
                },
              ]}
            />
          )}
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
              value: renderCostReportGroup(lease.costReportGroup),
            },
          ]}
        />
      </Container>

      {/* Access Settings */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditAccessSettings ? (
                <Button
                  iconName="edit"
                  onClick={onEditAccessSettings}
                  ariaLabel="Edit access settings"
                >
                  Edit
                </Button>
              ) : undefined
            }
          >
            Access settings
          </Header>
        }
      >
        <AccessSettingsSummary
          allowOwnerToShareLease={lease.allowOwnerToShareLease}
          leaseSharingEnabled={leaseSharingEnabled}
          defaultPermissionSet={lease.defaultPermissionSet}
          allowedPermissionSets={lease.allowedPermissionSets}
        />
      </Container>

      {/* Sandbox Spaces */}
      <Container
        header={
          <Header
            variant="h2"
            actions={
              showEditButtons && onEditSandboxSpaces ? (
                <Button iconName="edit" onClick={onEditSandboxSpaces}>
                  Edit
                </Button>
              ) : undefined
            }
          >
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
                  enabled={leaseSandboxSpacesEnabled}
                  globallyEnabled={sandboxSpacesEnabled}
                />
              ),
            },
            ...sandboxSpacesModelItems,
          ]}
        />
      </Container>
    </SpaceBetween>
  );
};

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
  Popover,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";

import {
  isExpiredLease,
  isMonitoredLease,
  isPendingLease,
  Lease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { BudgetStatus } from "@amzn/innovation-sandbox-frontend/components/BudgetStatus";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { ThresholdDetails } from "@amzn/innovation-sandbox-frontend/components/ThresholdDetails";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { DateTime } from "luxon";

interface LeaseSummaryProps {
  lease: Lease;
  showEditButtons?: boolean;
  onEditBudget?: () => void;
  onEditDuration?: () => void;
  onEditCostReport?: () => void;
}

// Helper function to render time popover
const renderTimePopover = (date: string) => (
  <Popover
    position="top"
    size="large"
    dismissButton={false}
    content={DateTime.fromISO(date).toLocaleString(DateTime.DATETIME_HUGE)}
  >
    <Box>{DateTime.fromISO(date).toRelative()}</Box>
  </Popover>
);

// Helper function to render account ID
const renderAccountId = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return (
      <StatusIndicator type="warning">No account assigned</StatusIndicator>
    );
  }

  return (
    <CopyToClipboard
      variant="inline"
      textToCopy={lease.awsAccountId}
      copySuccessText="Copied AWS Account ID"
      copyErrorText="Failed to copy AWS Account ID"
    />
  );
};

// Helper function to render approved by
const renderApprovedBy = (lease: Lease) => {
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
const renderLeaseStarted = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not started</StatusIndicator>;
  }

  return renderTimePopover(lease.startDate);
};

// Helper function to render last monitored
const renderLastMonitored = (lease: Lease) => {
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (!isMonitoredOrExpired) {
    return <StatusIndicator type="info">Not monitored</StatusIndicator>;
  }

  return renderTimePopover(lease.lastCheckedDate);
};

// Helper function to render comments
const renderComments = (comments?: string) => {
  if (!comments) {
    return <StatusIndicator type="info">No comments provided</StatusIndicator>;
  }

  return comments;
};

// Helper function to render budget status
const renderBudgetStatus = (lease: Lease) => {
  const isPending = isPendingLease(lease);
  const isMonitoredOrExpired = isMonitoredLease(lease) || isExpiredLease(lease);

  if (isPending) {
    return <BudgetStatus maxSpend={lease.maxSpend} />;
  }

  return (
    <BudgetProgressBar
      currentValue={isMonitoredOrExpired ? lease.totalCostAccrued : 0}
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
  onEditBudget,
  onEditDuration,
  onEditCostReport,
}: LeaseSummaryProps) => {
  return (
    <SpaceBetween size="l">
      {/* Basic Details */}
      <Container header={<Header variant="h2">Lease Details</Header>}>
        <ColumnLayout columns={2} variant="text-grid">
          <KeyValuePairs
            columns={1}
            items={[
              {
                label: "Lease ID",
                value: (
                  <CopyToClipboard
                    variant="inline"
                    textToCopy={lease.uuid}
                    copySuccessText="Copied Lease ID"
                    copyErrorText="Failed to copy Lease ID"
                  />
                ),
              },
              {
                label: "AWS Account ID",
                value: renderAccountId(lease),
              },
              {
                label: "Lease Template",
                value: lease.originalLeaseTemplateName,
              },
              {
                label: "Blueprint Name",
                value: <BlueprintName blueprintName={lease.blueprintName} />,
              },
              {
                label: "User Email",
                value: lease.userEmail,
              },
              {
                label: "Created By",
                value: lease.createdBy ?? lease.userEmail,
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
                label: "Approved By",
                value: renderApprovedBy(lease),
              },
              {
                label: "Lease Started",
                value: renderLeaseStarted(lease),
              },
              {
                label: "Last Monitored",
                value: renderLastMonitored(lease),
              },
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
                label: <Box variant="h3" children={"Budget Status"} />,
                value: renderBudgetStatus(lease),
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
                    thresholds={lease.budgetThresholds}
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
                label: <Box variant="h3" children={"Lease Expiry"} />,
                value: <DurationStatus {...getLeaseExpiryInfo(lease)} />,
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
    </SpaceBetween>
  );
};

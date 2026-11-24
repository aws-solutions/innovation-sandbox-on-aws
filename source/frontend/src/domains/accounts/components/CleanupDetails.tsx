// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCollection } from "@cloudscape-design/collection-hooks";
import {
  Badge,
  Box,
  Button,
  CollectionPreferences,
  Container,
  CopyToClipboard,
  ExpandableSection,
  Grid,
  Header,
  Icon,
  KeyValuePairs,
  Pagination,
  Select,
  SpaceBetween,
  StatusIndicator,
  Steps,
  Table,
  TextFilter,
} from "@cloudscape-design/components";
import { StepsProps } from "@cloudscape-design/components/steps";
import { useState } from "react";

import { TimePopover } from "@amzn/innovation-sandbox-frontend/components/TimePopover";
import {
  formatDuration,
  formatReason,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/components/cleanup-report-helpers";
import {
  compareResourceTypeRows,
  formatCooldownRemaining,
  getStatusAriaLabel,
  getStepDetails,
  getStepDurationText,
  getStepStatus,
  hasValidationWarning,
  isSilentMode,
  ResourceTypeRow,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/components/CleanupDetails.helpers";
import { getStepDisplayName } from "@amzn/innovation-sandbox-frontend/domains/accounts/helpers";
import {
  CleanupRemainingResourceView,
  CleanupReportView,
} from "@amzn/innovation-sandbox-frontend/domains/accounts/types";

// =============================================================================
// Helpers
// =============================================================================

function parseResourceName(arn: string): string {
  const parts = arn.split(":");
  const resource = parts.slice(5).join(":");
  const lastSlash = resource.lastIndexOf("/");
  return lastSlash >= 0 ? resource.substring(lastSlash + 1) : resource;
}

function CleanupReportStatus({
  status,
}: Readonly<{ status: CleanupReportView["status"] }>) {
  if (status === "IN_PROGRESS")
    return <StatusIndicator type="in-progress">In progress</StatusIndicator>;
  if (status === "COMPLETED")
    return <StatusIndicator type="success">Completed</StatusIndicator>;
  return <StatusIndicator type="error">Failed</StatusIndicator>;
}

function buildSummaryItems(report: CleanupReportView) {
  const items: Array<{ label: string; value: string | React.ReactNode }> = [];

  items.push(
    {
      label: "Status",
      value: <CleanupReportStatus status={report.status} />,
    },
    {
      label: "Cleanup reason",
      value: formatReason(report.reasonForCleanup),
    },
  );

  if (report.initiatedBy) {
    items.push({
      label: "Initiated by",
      value: report.initiatedBy,
    });
  }

  items.push({
    label: "Started",
    value: <TimePopover time={report.startedAt} />,
  });

  if (report.completedAt) {
    items.push({
      label: "Completed",
      value: <TimePopover time={report.completedAt} />,
    });
  }

  items.push({
    label: report.completedAt ? "Duration" : "Elapsed",
    value: formatDuration(report),
  });

  return items;
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_PAGE_SIZE = 10;
const PAGE_SIZE_OPTIONS = [
  { value: 10, label: "10 items" },
  { value: 25, label: "25 items" },
  { value: 50, label: "50 items" },
];

// =============================================================================
// Main Component
// =============================================================================

interface CleanupDetailsProps {
  report: CleanupReportView;
  onSkipCooldown?: () => void;
  isSkipping?: boolean;
}

export const CleanupDetails = ({
  report,
  onSkipCooldown,
  isSkipping,
}: CleanupDetailsProps) => {
  return (
    <SpaceBetween size="l">
      <TopLevelDetails report={report} />
      <Grid
        gridDefinition={[
          { colspan: { default: 12, m: 4 } },
          { colspan: { default: 12, m: 8 } },
        ]}
      >
        <CleanupStepsWidget report={report} />
        <ResourceSummaryWidget
          report={report}
          onSkipCooldown={onSkipCooldown}
          isSkipping={isSkipping}
        />
      </Grid>
      {/* Hidden in Silent mode (nothing actionable to show). */}
      {report.resourceSummary?.afterCooldown && !isSilentMode(report) && (
        <PostCleanupValidation report={report} />
      )}
    </SpaceBetween>
  );
};

// =============================================================================
// Widget: Top-Level Details
// =============================================================================

const TopLevelDetails = ({ report }: { report: CleanupReportView }) => {
  const validationWarning =
    report.status === "COMPLETED" && hasValidationWarning(report);

  return (
    <Container
      header={
        <Header
          variant="h2"
          actions={<CleanupOutcomeBadge status={report.status} />}
        >
          Cleanup details
        </Header>
      }
    >
      <SpaceBetween size="m">
        <KeyValuePairs columns={3} items={buildSummaryItems(report)} />
        {report.error && (
          <Box color="text-status-error">
            <Box variant="awsui-key-label">
              Error at step: {getStepDisplayName(report.error.step)}
            </Box>
            {report.error.message}
          </Box>
        )}
        {validationWarning && (
          <Box color="text-status-warning" variant="small">
            Cleanup succeeded with validation warnings. Remaining resources were
            detected but validation is set to warn only.
          </Box>
        )}
      </SpaceBetween>
    </Container>
  );
};

// =============================================================================
// Widget: Cleanup Steps (using Steps component)
// =============================================================================

// In Silent mode the RE validation is background-only, so hide its steps.
const HIDDEN_SILENT_STEPS = new Set([
  "summarize-account-before-cleanup",
  "summarize-account-after-cleanup",
  "validate-cleanup",
]);

// Renders the cleanup outcome indicator for Silent mode (no RE validation UI).
const SilentModeOutcome = ({
  isInProgress,
  isFailed,
}: {
  isInProgress: boolean;
  isFailed: boolean;
}) => {
  if (isInProgress) {
    return (
      <StatusIndicator type="in-progress">Cleanup in progress</StatusIndicator>
    );
  }
  if (isFailed) {
    return (
      <SpaceBetween size="s" alignItems="center">
        <Icon name="status-negative" size="large" variant="error" />
        <Box variant="h3" color="text-status-error">
          Cleanup failed
        </Box>
      </SpaceBetween>
    );
  }
  return (
    <SpaceBetween size="s" alignItems="center">
      <Icon name="status-positive" size="large" variant="success" />
      <Box variant="h3" color="text-status-success">
        Cleanup complete
      </Box>
    </SpaceBetween>
  );
};

const CleanupStepsWidget = ({ report }: { report: CleanupReportView }) => {
  const visibleSteps = isSilentMode(report)
    ? report.steps.filter((step) => !HIDDEN_SILENT_STEPS.has(step.name))
    : report.steps;

  if (visibleSteps.length === 0) {
    return (
      <Container fitHeight header={<Header variant="h2">Steps</Header>}>
        <Box textAlign="center" color="text-body-secondary" variant="p">
          <StatusIndicator type="pending">
            Waiting for cleanup to begin
          </StatusIndicator>
        </Box>
      </Container>
    );
  }

  const steps: StepsProps.Step[] = visibleSteps.map((step, index) => {
    const nextStep = visibleSteps[index + 1];
    const isLast = index === visibleSteps.length - 1;
    const status = getStepStatus({ step, isLast, nextStep, report });
    const durationText = getStepDurationText({
      step,
      nextStep,
      isLast,
      report,
    });
    const details = getStepDetails(step, report, durationText);

    return {
      status,
      statusIconAriaLabel: getStatusAriaLabel(status),
      header: getStepDisplayName(step.name),
      details,
    };
  });

  return (
    <Container fitHeight header={<Header variant="h2">Steps</Header>}>
      <Steps steps={steps} ariaLabel="Cleanup steps" />
    </Container>
  );
};

// =============================================================================
// Widget: Resource Summary
// =============================================================================

// Renders the centered status block of the cleanup summary.
const CleanupSummaryStatus = ({
  validationComplete,
  isSuccess,
  isValidationWarning,
  totalBefore,
  typesCount,
  filteredCount,
  remainingCount,
  cleanedCount,
  remainingTypesCount,
}: {
  validationComplete: boolean;
  isSuccess: boolean;
  isValidationWarning: boolean;
  totalBefore: number;
  typesCount: number;
  filteredCount: number;
  remainingCount: number;
  cleanedCount: number;
  remainingTypesCount: number;
}) => {
  if (!validationComplete) {
    return (
      <SpaceBetween size="s" alignItems="center">
        <StatusIndicator type="in-progress">
          Cleanup in progress
        </StatusIndicator>
        <Box color="text-body-secondary">
          {totalBefore} resources · {typesCount} types · {filteredCount}{" "}
          filtered
        </Box>
      </SpaceBetween>
    );
  }

  if (isSuccess) {
    return (
      <SpaceBetween size="s" alignItems="center">
        <Icon name="status-positive" size="large" variant="success" />
        <Box variant="h3" color="text-status-success">
          All resources cleaned successfully
        </Box>
        <Box color="text-body-secondary">
          {totalBefore} resources · {typesCount} types · {filteredCount}{" "}
          filtered
        </Box>
      </SpaceBetween>
    );
  }

  if (isValidationWarning) {
    return (
      <SpaceBetween size="s" alignItems="center">
        <Icon name="status-warning" size="large" variant="warning" />
        <Box variant="h3" color="text-status-warning">
          {remainingCount} resource{remainingCount === 1 ? "" : "s"} remaining —
          validation not enforced
        </Box>
        <Box color="text-body-secondary">
          {cleanedCount}/{totalBefore} cleaned · {remainingTypesCount} types
          remaining · {filteredCount} filtered
        </Box>
      </SpaceBetween>
    );
  }

  return (
    <SpaceBetween size="s" alignItems="center">
      <Icon name="status-negative" size="large" variant="error" />
      <Box variant="h3" color="text-status-error">
        {remainingCount} resource{remainingCount === 1 ? "" : "s"} failed to
        clean up
      </Box>
      <Box color="text-body-secondary">
        {cleanedCount}/{totalBefore} cleaned · {remainingTypesCount} types
        remaining · {filteredCount} filtered
      </Box>
    </SpaceBetween>
  );
};

const ResourceSummaryWidget = ({
  report,
  onSkipCooldown,
  isSkipping,
}: {
  report: CleanupReportView;
  onSkipCooldown?: () => void;
  isSkipping?: boolean;
}) => {
  const isCoolingDown =
    report.cleanupStatus === "COOLING_DOWN" && report.status === "IN_PROGRESS";
  const cooldownStep = isCoolingDown
    ? report.steps.find((s) => s.name === "account-cooldown")
    : undefined;
  const cooldownHours = cooldownStep?.meta?.cooldownDurationHours;

  const cooldownBanner = isCoolingDown ? (
    <Box textAlign="center" padding={{ vertical: "s" }}>
      <SpaceBetween size="s" alignItems="center">
        <StatusIndicator type="pending">
          Account cooling down
          {formatCooldownRemaining(cooldownStep, cooldownHours)}
        </StatusIndicator>
        {onSkipCooldown && (
          <Button onClick={onSkipCooldown} loading={isSkipping}>
            Skip cooldown
          </Button>
        )}
      </SpaceBetween>
    </Box>
  ) : null;

  // In Silent mode, show the overall cleanup outcome instead of the RE
  // before/after evaluation (which is background-only).
  if (isSilentMode(report)) {
    const isFailed = report.status === "FAILED";
    const isInProgress = report.status === "IN_PROGRESS";

    return (
      <Container
        fitHeight
        header={<Header variant="h2">Cleanup summary</Header>}
      >
        <SpaceBetween size="l">
          {cooldownBanner}
          {/* The cooldown banner already conveys the in-progress state. */}
          {!(isInProgress && isCoolingDown) && (
            <Box textAlign="center" padding={{ vertical: "l" }}>
              <SilentModeOutcome
                isInProgress={isInProgress}
                isFailed={isFailed}
              />
            </Box>
          )}
          <Box textAlign="center">
            <StatusIndicator type="info">
              Resource Explorer validation disabled (Silent mode)
            </StatusIndicator>
          </Box>
        </SpaceBetween>
      </Container>
    );
  }

  const resourceSummary = report.resourceSummary;

  if (!resourceSummary) {
    return (
      <Container
        fitHeight
        header={<Header variant="h2">Cleanup summary</Header>}
      >
        <Box textAlign="center" color="text-body-secondary" variant="p">
          <StatusIndicator type="pending">
            Waiting for resource enumeration
          </StatusIndicator>
        </Box>
      </Container>
    );
  }

  const { beforeCleanup, afterCooldown } = resourceSummary;

  if (!beforeCleanup) {
    return (
      <Container
        fitHeight
        header={<Header variant="h2">Cleanup summary</Header>}
      >
        <Box textAlign="center" color="text-body-secondary" variant="p">
          <StatusIndicator type="pending">
            Waiting for resource enumeration
          </StatusIndicator>
        </Box>
      </Container>
    );
  }

  const isFailed = report.status === "FAILED";
  const remainingCount = afterCooldown?.totalCount ?? 0;
  const { totalCount: totalBefore, ignoredCount: filteredCount } =
    beforeCleanup;
  const cleanedCount = totalBefore - remainingCount;

  // Build resource type rows with before/after comparison
  const typeRows = Object.entries(beforeCleanup.byType)
    .map(([type, beforeCount]) => {
      const afterCount = afterCooldown
        ? (afterCooldown.byType[type] ?? 0)
        : null;
      const hasRemaining = afterCount !== null && afterCount > 0;
      return { type, before: beforeCount, after: afterCount, hasRemaining };
    })
    .sort((a, b) => compareResourceTypeRows(a, b, isFailed));

  const typesCount = typeRows.length;
  const validationComplete = afterCooldown != null;
  const isSuccess = validationComplete && remainingCount === 0;
  const isValidationWarning =
    validationComplete && hasValidationWarning(report);
  const isFailure =
    validationComplete && remainingCount > 0 && !isValidationWarning;

  return (
    <Container fitHeight header={<Header variant="h2">Cleanup summary</Header>}>
      <SpaceBetween size="l">
        {cooldownBanner}
        <Box textAlign="center" padding={{ vertical: "l" }}>
          <CleanupSummaryStatus
            validationComplete={validationComplete}
            isSuccess={isSuccess}
            isValidationWarning={isValidationWarning}
            totalBefore={totalBefore}
            typesCount={typesCount}
            filteredCount={filteredCount}
            remainingCount={remainingCount}
            cleanedCount={cleanedCount}
            remainingTypesCount={resourceSummary.remainingTypes?.length ?? 0}
          />
        </Box>

        <ExpandableSection
          variant="footer"
          defaultExpanded={isFailure}
          headerText="Resource type details"
        >
          <ResourceTypeTable rows={typeRows} warnOnly={isValidationWarning} />
        </ExpandableSection>
      </SpaceBetween>
    </Container>
  );
};

// =============================================================================
// Widget: Post-Cleanup Validation
// =============================================================================

const PostCleanupValidation = ({ report }: { report: CleanupReportView }) => {
  const resourceSummary = report.resourceSummary!;
  const afterCooldown = resourceSummary.afterCooldown!;
  const remainingResources = resourceSummary.remainingResources ?? [];
  const remainingTotalCount =
    resourceSummary.remainingResourcesTotalCount ?? afterCooldown.totalCount;
  const hasRemaining = afterCooldown.totalCount > 0;
  const warnOnly = hasValidationWarning(report);
  const filteredResources = resourceSummary.ignoredResources ?? [];
  const filteredTotalCount =
    resourceSummary.ignoredResourcesTotalCount ??
    resourceSummary.beforeCleanup?.ignoredCount ??
    0;
  const resourceLabel = remainingTotalCount === 1 ? "resource" : "resources";
  const validationOutcome = warnOnly
    ? "validation not enforced"
    : "account quarantined";

  return (
    <Container
      header={
        <Header
          variant="h2"
          description={
            hasRemaining
              ? `${remainingTotalCount} ${resourceLabel} remain after cleanup — ${validationOutcome}`
              : "All resources successfully cleaned up"
          }
        >
          Post-cleanup validation
        </Header>
      }
    >
      <SpaceBetween size="m">
        {resourceSummary.validationMode !== "Quarantine" && hasRemaining && (
          <StatusIndicator type="warning">
            Validation was not enforced. Remaining resources were detected but
            the account was allowed to proceed.
          </StatusIndicator>
        )}

        {/* Filtered resources */}
        <ExpandableSection
          variant="footer"
          defaultExpanded={false}
          headerText={
            <SpaceBetween direction="horizontal" size="xs">
              <Box variant="awsui-key-label">Filtered resources</Box>
              <Box color="text-body-secondary">{filteredTotalCount}</Box>
            </SpaceBetween>
          }
        >
          {filteredResources.length > 0 ? (
            <SpaceBetween size="s">
              {filteredResources.length < filteredTotalCount && (
                <Box color="text-body-secondary" variant="small">
                  Showing {filteredResources.length} of {filteredTotalCount}{" "}
                  filtered resources
                </Box>
              )}
              <PaginatedResourceTable items={filteredResources} />
            </SpaceBetween>
          ) : (
            <Box color="text-body-secondary" variant="p">
              Resources matching exclusion patterns are filtered during
              validation. These are intentionally preserved (ISB infrastructure,
              Control Tower roles, service-linked roles, etc.).
            </Box>
          )}
        </ExpandableSection>

        {/* Remaining resources */}
        <ExpandableSection
          variant="footer"
          defaultExpanded={hasRemaining}
          headerText={
            <SpaceBetween direction="horizontal" size="xs">
              <Box variant="awsui-key-label">Remaining resources</Box>
              {hasRemaining ? (
                <StatusIndicator type={warnOnly ? "warning" : "error"}>
                  {remainingTotalCount}
                </StatusIndicator>
              ) : (
                <StatusIndicator type="success">0</StatusIndicator>
              )}
            </SpaceBetween>
          }
        >
          {remainingResources.length > 0 ? (
            <SpaceBetween size="s">
              {remainingResources.length < remainingTotalCount && (
                <Box color="text-body-secondary" variant="small">
                  Showing {remainingResources.length} of {remainingTotalCount}{" "}
                  remaining resources
                </Box>
              )}
              <PaginatedResourceTable items={remainingResources} />
            </SpaceBetween>
          ) : (
            <Box textAlign="center" color="inherit" variant="p">
              All resources were successfully cleaned up.
            </Box>
          )}
        </ExpandableSection>
      </SpaceBetween>
    </Container>
  );
};

// =============================================================================
// Paginated Tables
// =============================================================================

function resourceTypeStatusCell(warnOnly: boolean) {
  return function ResourceTypeStatusCell(row: ResourceTypeRow) {
    if (row.after === null)
      return <StatusIndicator type="in-progress">Deleting</StatusIndicator>;
    if (row.hasRemaining)
      return (
        <StatusIndicator type={warnOnly ? "warning" : "error"}>
          {row.after} remaining
        </StatusIndicator>
      );
    return <StatusIndicator type="success">Deleted</StatusIndicator>;
  };
}

const ResourceTypeTable = ({
  rows,
  warnOnly = false,
}: {
  rows: ResourceTypeRow[];
  warnOnly?: boolean;
}) => {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const { items, paginationProps } = useCollection(rows, {
    pagination: { pageSize },
    sorting: {},
  });

  return (
    <Table
      variant="embedded"
      columnDefinitions={[
        {
          id: "type",
          header: "Resource type",
          cell: (row: ResourceTypeRow) => row.type,
          sortingField: "type",
        },
        {
          id: "before",
          header: "Before",
          cell: (row: ResourceTypeRow) => row.before,
        },
        {
          id: "after",
          header: "After",
          cell: (row: ResourceTypeRow) => row.after ?? "-",
        },
        {
          id: "status",
          header: "Status",
          cell: resourceTypeStatusCell(warnOnly),
        },
      ]}
      items={items}
      empty={
        <Box textAlign="center" color="inherit" variant="p">
          No resources found
        </Box>
      }
      pagination={
        rows.length > pageSize ? <Pagination {...paginationProps} /> : undefined
      }
      preferences={
        <CollectionPreferences
          title="Preferences"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          pageSizePreference={{
            title: "Page size",
            options: PAGE_SIZE_OPTIONS,
          }}
          preferences={{ pageSize }}
          onConfirm={({ detail }) =>
            setPageSize(detail.pageSize ?? DEFAULT_PAGE_SIZE)
          }
        />
      }
    />
  );
};

const PaginatedResourceTable = ({
  items: allItems,
}: {
  items: CleanupRemainingResourceView[];
}) => {
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE);
  const [filterText, setFilterText] = useState("");
  const [selectedRegion, setSelectedRegion] = useState<string | null>(null);

  // Derive unique regions for the Select dropdown
  const regionOptions = [
    { value: "", label: "All regions" },
    ...[...new Set(allItems.map((item) => item.region))]
      .sort((a, b) => a.localeCompare(b))
      .map((region) => ({ value: region, label: region })),
  ];

  const filteredItems = allItems.filter((item) => {
    if (selectedRegion && item.region !== selectedRegion) return false;
    if (filterText) {
      const text = filterText.toLowerCase();
      return (
        item.arn.toLowerCase().includes(text) ||
        item.resourceType.toLowerCase().includes(text) ||
        item.region.toLowerCase().includes(text) ||
        parseResourceName(item.arn).toLowerCase().includes(text)
      );
    }
    return true;
  });

  const { items, paginationProps } = useCollection(filteredItems, {
    pagination: { pageSize },
    sorting: {},
  });

  return (
    <Table
      variant="embedded"
      columnDefinitions={[
        {
          id: "type",
          header: "Type",
          cell: (r: CleanupRemainingResourceView) => r.resourceType,
        },
        {
          id: "name",
          header: "Name",
          cell: (r: CleanupRemainingResourceView) => parseResourceName(r.arn),
        },
        {
          id: "region",
          header: "Region",
          cell: (r: CleanupRemainingResourceView) => r.region,
        },
        {
          id: "copy",
          header: "",
          cell: renderResourceArnCopyCell,
          width: 50,
        },
      ]}
      items={items}
      filter={
        <SpaceBetween direction="horizontal" size="xs">
          <TextFilter
            filteringText={filterText}
            onChange={({ detail }) => setFilterText(detail.filteringText)}
            filteringPlaceholder="Filter resources"
            countText={`${filteredItems.length} match${filteredItems.length === 1 ? "" : "es"}`}
          />
          <Select
            selectedOption={
              selectedRegion
                ? { value: selectedRegion, label: selectedRegion }
                : { value: "", label: "All regions" }
            }
            onChange={({ detail }) =>
              setSelectedRegion(detail.selectedOption.value || null)
            }
            options={regionOptions}
            placeholder="Region"
          />
        </SpaceBetween>
      }
      empty={
        <Box textAlign="center" color="inherit" variant="p">
          No resources
        </Box>
      }
      pagination={
        filteredItems.length > pageSize ? (
          <Pagination {...paginationProps} />
        ) : undefined
      }
      preferences={
        <CollectionPreferences
          title="Preferences"
          confirmLabel="Confirm"
          cancelLabel="Cancel"
          pageSizePreference={{
            title: "Page size",
            options: PAGE_SIZE_OPTIONS,
          }}
          preferences={{ pageSize }}
          onConfirm={({ detail }) =>
            setPageSize(detail.pageSize ?? DEFAULT_PAGE_SIZE)
          }
        />
      }
    />
  );
};

const renderResourceArnCopyCell = (resource: CleanupRemainingResourceView) => (
  <CopyToClipboard
    variant="icon"
    textToCopy={resource.arn}
    copyButtonAriaLabel={`Copy ARN for ${parseResourceName(resource.arn)}`}
    copySuccessText="ARN copied"
    copyErrorText="Failed to copy"
  />
);

// =============================================================================
// Badge Component
// =============================================================================

const CleanupOutcomeBadge = ({
  status,
}: {
  status: "IN_PROGRESS" | "COMPLETED" | "FAILED";
}) => {
  switch (status) {
    case "IN_PROGRESS":
      return <Badge color="blue">In Progress</Badge>;
    case "COMPLETED":
      return <Badge color="green">Completed</Badge>;
    case "FAILED":
      return <Badge color="red">Failed</Badge>;
    default:
      return <Badge>{status}</Badge>;
  }
};

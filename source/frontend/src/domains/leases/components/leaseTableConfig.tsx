// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { StatusIndicator } from "@cloudscape-design/components";
import { PropertyFilterProps } from "@cloudscape-design/components/property-filter";

import { AccessTypeBadge } from "@amzn/innovation-sandbox-frontend/components/AccessTypeBadge";
import { AccountId } from "@amzn/innovation-sandbox-frontend/components/AccountId";
import { BlueprintName } from "@amzn/innovation-sandbox-frontend/components/BlueprintName";
import { BudgetProgressBar } from "@amzn/innovation-sandbox-frontend/components/BudgetProgressBar";
import { DurationStatus } from "@amzn/innovation-sandbox-frontend/components/DurationStatus";
import { FilterableColumnDefinition } from "@amzn/innovation-sandbox-frontend/components/FilterableTable";
import { LeaseName } from "@amzn/innovation-sandbox-frontend/components/LeaseName";
import { LeaseTemplateName } from "@amzn/innovation-sandbox-frontend/components/LeaseTemplateName";
import { LeaseAccessCell } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseAccessCell";
import { LeaseStatusBadge } from "@amzn/innovation-sandbox-frontend/domains/leases/components/LeaseStatusBadge";
import {
  canLoginToLease,
  leaseExpirySortingComparator,
  type LeaseLoginPermissions,
  leaseSpendSortingComparator,
  leaseStatusSortingComparator,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  LeaseView,
  SharedLeaseAccessType,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { canOpenSandboxSpace } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import {
  getCurrentLeaseSpend,
  isExpiredLease,
  isMonitoredLease,
  LeaseStatus,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

// ─── Column Definitions ────────────────────────────────────────────────────────

/** Lease item as rendered in the table — accessType is optional since not all code paths set it. */
export type LeaseTableItem = LeaseView & {
  accessType?: SharedLeaseAccessType;
};

/**
 * What the Access column needs to offer Open Space. Pass it only when an
 * administrator has turned Sandbox Spaces on for the deployment; omit it to
 * show only Login.
 */
export interface LeaseSandboxSpaceOptions {
  readonly user: IsbUser | undefined;
  readonly onOpenSpace: (lease: LeaseTableItem) => void;
}

/**
 * Builds lease table column definitions.
 * All data columns are always included; visibility is controlled by
 * default visible columns preferences, not by omitting definitions.
 */
export function getLeaseColumnDefinitions(
  permissions: LeaseLoginPermissions,
  sandboxSpaces?: LeaseSandboxSpaceOptions,
): FilterableColumnDefinition<LeaseTableItem>[] {
  return [
    {
      id: "name",
      header: "Name",
      sortingField: "name",
      cell: (lease) => (
        <LeaseName
          uuid={lease.uuid}
          templateName={lease.originalLeaseTemplateName}
          leaseId={lease.leaseId}
        />
      ),
    },
    {
      id: "uuid",
      header: "UUID",
      sortingField: "uuid",
      cell: (lease) => lease.uuid,
    },
    {
      id: "userEmail",
      header: "Owner",
      sortingField: "userEmail",
      cell: (lease) => lease.userEmail,
    },
    {
      id: "originalLeaseTemplateName",
      header: "Lease Template",
      sortingField: "originalLeaseTemplateName",
      cell: (lease) => (
        <LeaseTemplateName
          name={lease.originalLeaseTemplateName}
          uuid={lease.originalLeaseTemplateUuid}
        />
      ),
    },
    {
      id: "blueprintName",
      header: "Blueprint",
      sortingField: "blueprintName",
      cell: (lease) => <BlueprintName blueprintName={lease.blueprintName} />,
    },
    {
      id: "costReportGroup",
      header: "Cost Report Group",
      sortingField: "costReportGroup",
      cell: (lease) =>
        lease.costReportGroup ? (
          <span>{lease.costReportGroup}</span>
        ) : (
          <StatusIndicator type="info">Not assigned</StatusIndicator>
        ),
    },
    {
      id: "budget",
      header: "Budget",
      sortingComparator: leaseSpendSortingComparator,
      minWidth: 150,
      cell: (lease) =>
        isMonitoredLease(lease) || isExpiredLease(lease) ? (
          <BudgetProgressBar
            currentValue={getCurrentLeaseSpend(lease)}
            maxValue={lease.maxSpend}
          />
        ) : (
          "No costs accrued"
        ),
    },
    {
      id: "expirationDate",
      header: "Expiry",
      sortingComparator: leaseExpirySortingComparator,
      cell: (lease) => <DurationStatus {...getLeaseExpiryInfo(lease)} />,
    },
    {
      id: "status",
      header: "Status",
      sortingComparator: leaseStatusSortingComparator,
      cell: (lease) => <LeaseStatusBadge lease={lease} />,
    },
    {
      id: "awsAccountId",
      header: "AWS Account",
      sortingField: "awsAccountId",
      cell: (lease) => (
        <AccountId
          accountId={
            isMonitoredLease(lease) || isExpiredLease(lease)
              ? lease.awsAccountId
              : undefined
          }
        />
      ),
    },
    {
      id: "createdBy",
      header: "Created By",
      sortingField: "createdBy",
      cell: (lease) => lease.createdBy,
    },
    {
      id: "accessType",
      header: "Access Type",
      sortingField: "accessType",
      cell: (lease) => {
        if (!lease.accessType) return "-";
        return <AccessTypeBadge accessType={lease.accessType} />;
      },
    },
    {
      id: "access",
      header: "Access",
      cell: (lease) =>
        canLoginToLease(lease, permissions) ? (
          <LeaseAccessCell
            accountId={lease.awsAccountId}
            openSpace={
              sandboxSpaces && canOpenSandboxSpace(lease, sandboxSpaces.user)
                ? { onOpen: () => sandboxSpaces.onOpenSpace(lease) }
                : undefined
            }
          />
        ) : null,
    },
  ];
}

// ─── Property Filter Definitions ───────────────────────────────────────────────

const BASE_FILTERING_PROPERTIES: PropertyFilterProps.FilteringProperty[] = [
  {
    key: "name",
    propertyLabel: "Lease Name",
    groupValuesLabel: "Lease Name values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "uuid",
    propertyLabel: "UUID",
    groupValuesLabel: "UUID values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "userEmail",
    propertyLabel: "Owner",
    groupValuesLabel: "Owner values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "status",
    propertyLabel: "Status",
    groupValuesLabel: "Status values",
    operators: ["=", "!="],
  },
  {
    key: "originalLeaseTemplateName",
    propertyLabel: "Lease Template",
    groupValuesLabel: "Lease Template values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "awsAccountId",
    propertyLabel: "AWS Account",
    groupValuesLabel: "Account values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "createdBy",
    propertyLabel: "Created By",
    groupValuesLabel: "Created By values",
    operators: ["=", "!=", ":", "!:"],
  },
  {
    key: "costReportGroup",
    propertyLabel: "Cost Report Group",
    groupValuesLabel: "Cost Report Group values",
    operators: ["=", "!=", ":", "!:"],
  },
];

export function getLeaseFilteringProperties(): PropertyFilterProps.FilteringProperty[] {
  return [
    ...BASE_FILTERING_PROPERTIES,
    {
      key: "accessType",
      propertyLabel: "Access Type",
      groupValuesLabel: "Access Type values",
      operators: [
        "=",
        "!=",
      ] as PropertyFilterProps.FilteringProperty["operators"],
    },
  ];
}

export const DEFAULT_VISIBLE_COLUMNS = [
  "name",
  "userEmail",
  "accessType",
  "originalLeaseTemplateName",
  "budget",
  "expirationDate",
  "status",
  "awsAccountId",
  "access",
];

/** Lease statuses shown by default on lease list views. */
export const DEFAULT_VISIBLE_LEASE_STATUSES: LeaseStatus[] = [
  "PendingApproval",
  "Active",
  "Frozen",
  "Provisioning",
];

/**
 * Default property filter query that limits lease list views to active
 * statuses (pending, active, frozen, provisioning). Applied on mount and
 * adjustable by the user via the property filter.
 */
export function getDefaultStatusFilterQuery(): PropertyFilterProps.Query {
  return {
    operation: "or",
    tokens: DEFAULT_VISIBLE_LEASE_STATUSES.map((status) => ({
      propertyKey: "status",
      operator: "=",
      value: status,
    })),
  };
}

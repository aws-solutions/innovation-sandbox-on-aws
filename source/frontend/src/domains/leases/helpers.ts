// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";
import { DateTime } from "luxon";

import type {
  LeaseView,
  MonitoredLeaseView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import {
  CriticalLockIntents,
  getCurrentLeaseSpend,
  isExpiredLease,
  isMonitoredLease,
  Lease,
  LeaseStatus,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  getUserEmail,
  type IsbUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils";

/** Formats a lease into a descriptive display name: `<templateName> (<first8 of uuid>)`. */
export const getLeaseDisplayName = (lease: {
  uuid: string;
  originalLeaseTemplateName: string;
}): string => `${lease.originalLeaseTemplateName} (${lease.uuid.slice(0, 8)})`;

export const getLeaseAssignmentsPath = (leaseId: string): string =>
  `/leases/${leaseId}?tab=assignments`;

/** A lease record enriched with the derived display name for filtering/display. */
export type LeaseWithName<T extends { uuid: string }> = T & { name: string };

/** Adds a `name` field (derived from uuid + template name) to each lease for use in tables and filters. */
export const enrichLeasesWithName = <
  T extends { uuid: string; originalLeaseTemplateName: string },
>(
  leases: T[],
): LeaseWithName<T>[] =>
  leases.map((lease) => ({
    ...lease,
    name: getLeaseDisplayName(lease),
  }));

// CriticalLockIntents is a readonly tuple; widen it so .includes() accepts an
// arbitrary intent string.
const CRITICAL_LOCK_INTENTS: readonly string[] = CriticalLockIntents;

/**
 * True when the lease holds a live assignment-processing lock. An expired lock
 * does not gate actions — the backend's acquire condition also treats it as
 * free. Mirrors isCleanupLockActive in the accounts domain.
 */
export const isAssignmentLockActive = (
  lease: Pick<Lease, "resourceLock">,
): boolean =>
  !!lease.resourceLock &&
  new Date(lease.resourceLock.expiresAt).getTime() > Date.now();

/**
 * True when the live lock is held for a critical intent (TERMINATE/FREEZE).
 * Critical intents preempt the overridable ones but conflict with each other,
 * so freeze and terminate use this narrower check while unfreeze — overridable
 * — is blocked by any live lock.
 */
export const isCriticalAssignmentLockActive = (
  lease: Pick<Lease, "resourceLock">,
): boolean =>
  isAssignmentLockActive(lease) &&
  CRITICAL_LOCK_INTENTS.includes(lease.resourceLock?.meta?.intent ?? "");

/**
 * True when a termination is already in flight. Terminate is the operator's
 * escape hatch, so it is deliberately not gated on the broader critical-lock
 * check — an in-flight freeze must not block terminating.
 */
export const isTerminationLockActive = (
  lease: Pick<Lease, "resourceLock">,
): boolean =>
  isAssignmentLockActive(lease) &&
  lease.resourceLock?.meta?.intent === "TERMINATE";

/**
 * Returns true when the given user is the leaseholder.
 * Mirrors the backend ownership check in leases-handler.ts terminateLeaseHandler.
 */
export const isLeaseOwner = (
  lease: Pick<Lease, "userEmail">,
  user: IsbUser | undefined,
): boolean => {
  if (!user) return false;
  return lease.userEmail === getUserEmail(user);
};

export interface LeaseLoginPermissions {
  readonly isAdmin: boolean;
  readonly isManager: boolean;
}

/**
 * Determines whether the viewer can open the AWS console for a current lease.
 * Expired leases are always excluded because their accounts may have been
 * reassigned to a different lease.
 */
export const canLoginToLease = (
  lease: LeaseView,
  { isAdmin, isManager }: LeaseLoginPermissions,
): lease is MonitoredLeaseView => {
  if (!isMonitoredLease(lease)) {
    return false;
  }

  switch (lease.status) {
    case "Active":
      return true;
    case "Frozen":
      return isAdmin || isManager;
    case "Provisioning":
      return isAdmin;
    default:
      return false;
  }
};

// helper function to turn labels like "PendingApproval" into "Pending Approval"
const splitCamelCase = (str: string): string => {
  return str
    .replace(/([a-z])([A-Z0-9])/g, "$1 $2")
    .replace(/([A-Z])([A-Z][a-z])/g, "$1 $2");
};

export const getLeaseStatusDisplayName = (status: LeaseStatus): string => {
  switch (status) {
    case "Active":
      return "Active";
    case "Frozen":
      return "Frozen";
    case "PendingApproval":
      return "Pending Approval";
    case "ApprovalDenied":
      return "Approval Denied";
    case "Expired":
      return "Lease Duration Expired";
    case "BudgetExceeded":
      return "Budget Exceeded";
    case "ManuallyTerminated":
      return "Lease Manually Terminated";
    case "UserTerminated":
      return "Terminated by User";
    case "AccountQuarantined":
      return "Account Quarantined";
    case "Ejected":
      return "Account Manually Ejected";
    default:
      return splitCamelCase(status);
  }
};

export const generateBreadcrumb = (
  query: UseQueryResult<Lease | undefined, unknown>,
  options?: { isApprovalPage?: boolean; isUserView?: boolean },
) => {
  const { data: lease, isLoading, isError } = query;
  const { isApprovalPage, isUserView } = options ?? {};

  const breadcrumbItems = [{ text: "Home", href: "/" }];

  // Users reach lease details straight from Home and can't open the
  // admin-only Approvals/Leases lists, so omit that intermediate crumb.
  if (isApprovalPage) {
    breadcrumbItems.push({ text: "Approvals", href: "/approvals" });
  } else if (!isUserView) {
    breadcrumbItems.push({ text: "Leases", href: "/leases" });
  }

  if (isLoading) {
    breadcrumbItems.push({ text: "Loading...", href: "#" });
    return breadcrumbItems;
  }

  if (isError || !lease) {
    breadcrumbItems.push({ text: "Error", href: "#" });
    return breadcrumbItems;
  }

  breadcrumbItems.push({
    text: getLeaseDisplayName(lease),
    href: "#",
  });

  return breadcrumbItems;
};

export const leaseStatusSortingComparator = (a: Lease, b: Lease): number => {
  const statusOrder = {
    PendingApproval: 1,
    Provisioning: 2,
    Frozen: 3,
    Active: 4,
    Expired: 5,
    BudgetExceeded: 6,
    AccountQuarantined: 7,
    ManuallyTerminated: 8,
    UserTerminated: 9,
    Ejected: 10,
    ApprovalDenied: 11,
    ProvisioningFailed: 12,
  };

  const statusA = statusOrder[a.status] || Number.MAX_VALUE;
  const statusB = statusOrder[b.status] || Number.MAX_VALUE;

  return statusA - statusB;
};

const getExpirySortValue = (
  info: ReturnType<typeof getLeaseExpiryInfo>,
): number => {
  if (info?.date) return DateTime.fromISO(String(info.date)).toMillis();
  if (info?.durationInHours)
    return DateTime.now().plus({ hours: info.durationInHours }).toMillis();
  return Number.MAX_VALUE;
};

export const leaseExpirySortingComparator = (a: Lease, b: Lease): number => {
  return (
    getExpirySortValue(getLeaseExpiryInfo(a)) -
    getExpirySortValue(getLeaseExpiryInfo(b))
  );
};

// A lease that was never monitored has no spend and sorts as zero.
const getSpendSortValue = (lease: Lease): number =>
  isMonitoredLease(lease) || isExpiredLease(lease)
    ? getCurrentLeaseSpend(lease)
    : 0;

export const leaseSpendSortingComparator = (a: Lease, b: Lease): number =>
  getSpendSortValue(a) - getSpendSortValue(b);

/**
 * Removes display-only fields from assignments before submission.
 * Returns undefined when there are no assignments.
 */
export const toAssignmentRefs = (
  assignments:
    | Array<{
        principalId: string;
        principalType: "USER" | "GROUP";
        permissionSetArn?: string;
      }>
    | undefined,
) =>
  assignments?.length
    ? assignments.map(({ principalId, principalType, permissionSetArn }) => ({
        principalId,
        principalType,
        ...(permissionSetArn ? { permissionSetArn } : {}),
      }))
    : undefined;

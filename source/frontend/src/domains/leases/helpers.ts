// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { UseQueryResult } from "@tanstack/react-query";

import {
  Lease,
  LeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease";
import { getLeaseExpiryInfo } from "@amzn/innovation-sandbox-frontend/helpers/LeaseExpiryInfo";
import { DateTime } from "luxon";

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
  isApprovalPage?: boolean,
) => {
  const { data: lease, isLoading, isError } = query;

  const breadcrumbItems = [{ text: "Home", href: "/" }];

  if (isApprovalPage) {
    breadcrumbItems.push({ text: "Approvals", href: "/approvals" });
  } else {
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
    text: lease.userEmail,
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
    Ejected: 9,
    ApprovalDenied: 10,
    ProvisioningFailed: 11,
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

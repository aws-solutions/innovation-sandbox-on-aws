// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { StatusIndicatorProps } from "@cloudscape-design/components/status-indicator";

import { SandboxAccountView } from "@amzn/innovation-sandbox-frontend/domains/accounts/model";
import { CleanupStatus } from "@amzn/innovation-sandbox-shared/types/sandbox-account";

type GenerateAccountBreadcrumbArgs = {
  isLoading?: boolean;
  isError?: boolean;
  account?: SandboxAccountView;
};

export const generateAccountBreadcrumb = ({
  isLoading,
  isError,
  account,
}: GenerateAccountBreadcrumbArgs) => {
  const breadcrumbItems = [
    { text: "Home", href: "/" },
    { text: "Accounts", href: "/accounts" },
  ];

  if (isLoading) {
    breadcrumbItems.push({ text: "Loading...", href: "#" });
  }

  if (isError) {
    breadcrumbItems.push({ text: "Error", href: "#" });
  }

  if (account) {
    breadcrumbItems.push(
      {
        text: account.awsAccountId,
        href: `/accounts/${account?.awsAccountId}`,
      },
      { text: "Add Account", href: "#" },
    );
  }

  return breadcrumbItems;
};

/**
 * True while the account holds a live (non-expired) cleanup resource lock,
 * i.e. a cleanup execution is currently running. Used to gate the retry-
 * cleanup actions: dispatching a second CleanAccountRequest would race the
 * running execution (the backend rejects it with AccountInCleanUpError). An
 * EXPIRED lock is deliberately not "active" — that is the stuck-execution
 * case the retry exists to recover, so it must not block the action.
 */
export const isCleanupLockActive = (account: SandboxAccountView): boolean =>
  !!account.resourceLock &&
  new Date(account.resourceLock.expiresAt).getTime() > Date.now();

export const accountStatusSortingComparator = (
  a: SandboxAccountView,
  b: SandboxAccountView,
): number => {
  const statusOrder = {
    Quarantine: 1,
    Frozen: 2,
    Active: 3,
    CleanUp: 4,
    Available: 5,
  };

  const statusA = statusOrder[a.status] || Number.MAX_VALUE;
  const statusB = statusOrder[b.status] || Number.MAX_VALUE;

  return statusA - statusB;
};

interface CleanupStatusConfig {
  label: string;
  type: StatusIndicatorProps.Type;
}

export const getCleanupStatusConfig = (
  status: CleanupStatus,
): CleanupStatusConfig => {
  if (status.startsWith("NUKE_PHASE_")) {
    const phase = status.replace("NUKE_PHASE_", "");
    return { label: `Nuke Phase ${phase}`, type: "in-progress" };
  }

  switch (status) {
    case "INITIALIZING":
      return { label: "Initializing", type: "in-progress" };
    case "REVOKING_ACCESS":
      return { label: "Revoking Access", type: "in-progress" };
    case "VALIDATING":
      return { label: "Validating", type: "in-progress" };
    case "COOLING_DOWN":
      return { label: "Cooling Down", type: "pending" };
    case "COMPLETED":
      return { label: "Completed", type: "success" };
    case "FAILED":
      return { label: "Failed", type: "error" };
    default:
      return { label: status, type: "info" };
  }
};

// Step names are not a closed set: nuke phases are generated per iteration
// (`nuke-phase-<iteration>-start`) and a newer backend may add steps this
// frontend has not seen. Anything unrecognized falls through to the raw name.
export const getStepDisplayName = (name: string): string => {
  const nameMap: Record<string, string> = {
    "acquire-cleanup-lock": "Acquire Lock",
    "initialize-cleanup": "Initialize Cleanup",
    "initialize-reporting": "Initialize Reporting",
    "summarize-account-before-cleanup": "Summarize Account (Before Cleanup)",
    "summarize-account-after-cleanup": "Summarize Account (After Cleanup)",
    "revoke-access": "Revoking Access",
    "cleanup-account-access": "Cleanup Account Access",
    "validate-cleanup": "Validate Cleanup",
    "remove-lease-tags": "Remove Lease Tags",
    "account-cooldown": "Account Cooldown",
    "finalize-cleanup": "Finalize Cleanup",
    "cleanup-complete": "Cleanup Complete",
    "cleanup-failed": "Cleanup Failed",
  };

  if (name.startsWith("nuke-phase-")) {
    const phase = name.replace("nuke-phase-", "").replace("-start", "");
    return `Nuke Phase ${phase}`;
  }

  return nameMap[name] ?? name;
};

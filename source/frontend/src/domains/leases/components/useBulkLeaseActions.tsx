// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { ButtonDropdown, SpaceBetween } from "@cloudscape-design/components";
import { useQueryClient } from "@tanstack/react-query";
import { ReactNode, useState } from "react";
import { useNavigate } from "react-router-dom";

import { BatchActionReview } from "@amzn/innovation-sandbox-frontend/components/MultiSelectTableActionReview";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import {
  isAssignmentLockActive,
  isCriticalAssignmentLockActive,
  isTerminationLockActive,
} from "@amzn/innovation-sandbox-frontend/domains/leases/helpers";
import {
  useFreezeLease,
  useTerminateLease,
  useUnfreezeLease,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { useModal } from "@amzn/innovation-sandbox-frontend/hooks/useModal";
import { useUser } from "@amzn/innovation-sandbox-frontend/hooks/useUser";

/**
 * Hook providing bulk action state and UI for elevated users (Admin/Manager).
 * Returns selection state + header actions ReactNode to pass into LeaseTable.
 *
 * For non-elevated users, returns no selection and no actions.
 */
export function useBulkLeaseActions(): {
  selectionType: "multi" | undefined;
  selectedItems: LeaseView[];
  onSelectionChange: ((items: LeaseView[]) => void) | undefined;
  headerActions: ReactNode | undefined;
} {
  const { isAdmin, isManager } = useUser();
  const isElevated = isAdmin || isManager;
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { showModal } = useModal();
  const [selectedLeases, setSelectedLeases] = useState<LeaseView[]>([]);

  const { mutateAsync: terminateLease } = useTerminateLease({
    skipInvalidation: true,
  });
  const { mutateAsync: freezeLease } = useFreezeLease({
    skipInvalidation: true,
  });
  const { mutateAsync: unfreezeLease } = useUnfreezeLease({
    skipInvalidation: true,
  });

  if (!isElevated) {
    return {
      selectionType: undefined,
      selectedItems: [],
      onSelectionChange: undefined,
      headerActions: undefined,
    };
  }

  const deselectLease = (leaseId: string) =>
    setSelectedLeases((prev) => prev.filter((l) => l.leaseId !== leaseId));

  const showActionModal = (action: "terminate" | "freeze" | "unfreeze") => {
    const actionLabels = {
      terminate: "Terminate",
      freeze: "Freeze",
      unfreeze: "Unfreeze",
    };
    const actionFns = {
      terminate: terminateLease,
      freeze: freezeLease,
      unfreeze: unfreezeLease,
    };
    const pastTense = {
      terminate: "terminated",
      freeze: "frozen",
      unfreeze: "unfrozen",
    };

    showModal({
      header: `${actionLabels[action]} Lease(s)`,
      content: (
        <BatchActionReview
          items={selectedLeases}
          description={`${selectedLeases.length} lease(s) to ${action}`}
          columnDefinitions={[
            {
              id: "user",
              header: "Owner",
              cell: (l: LeaseView) => l.userEmail,
            },
            {
              id: "template",
              header: "Template",
              cell: (l: LeaseView) => l.originalLeaseTemplateName,
            },
          ]}
          identifierKey="leaseId"
          sequential
          onSubmit={async (lease: LeaseView) => {
            await actionFns[action](lease.leaseId);
            deselectLease(lease.leaseId);
          }}
          onSuccess={() => {
            queryClient.invalidateQueries({
              queryKey: ["leases"],
              refetchType: "all",
            });
            queryClient.invalidateQueries({
              queryKey: ["sharedLeases"],
              refetchType: "all",
            });
            queryClient.invalidateQueries({
              queryKey: ["accounts"],
              refetchType: "all",
            });
            showSuccessToast(`Lease(s) ${pastTense[action]} successfully.`);
          }}
          onError={() => {
            // Partial failure: some mutations may have succeeded, so invalidate
            // the cache even though the batch as a whole failed.
            queryClient.invalidateQueries({
              queryKey: ["leases"],
              refetchType: "all",
            });
            queryClient.invalidateQueries({
              queryKey: ["sharedLeases"],
              refetchType: "all",
            });
            queryClient.invalidateQueries({
              queryKey: ["accounts"],
              refetchType: "all",
            });
            showErrorToast(
              `One or more leases failed to ${action}.`,
              `Failed to ${action}`,
            );
          }}
        />
      ),
      size: "max",
    });
  };

  // Mirrors the per-lease gating in useLeaseActions; see the lock predicates in
  // leases/helpers.ts for which intents block what.
  const lockedForUnfreeze = selectedLeases.filter(isAssignmentLockActive);
  const lockedForFreeze = selectedLeases.filter(isCriticalAssignmentLockActive);
  const lockedForTerminate = selectedLeases.filter(isTerminationLockActive);

  const headerActions = (
    <SpaceBetween direction="horizontal" size="s">
      <ButtonDropdown
        disabled={selectedLeases.length === 0}
        items={[
          {
            text: "Terminate",
            id: "terminate",
            disabled:
              !selectedLeases.every(
                (l) => l.status === "Active" || l.status === "Frozen",
              ) || lockedForTerminate.length > 0,
            disabledReason:
              lockedForTerminate.length > 0
                ? "A termination is already in progress for a selected lease."
                : "Only active or frozen leases can be terminated.",
          },
          {
            text: "Freeze",
            id: "freeze",
            disabled:
              !selectedLeases.every((l) => l.status === "Active") ||
              lockedForFreeze.length > 0,
            disabledReason:
              lockedForFreeze.length > 0
                ? "A freeze or termination is already in progress for a selected lease."
                : "Only active leases can be frozen.",
          },
          {
            text: "Unfreeze",
            id: "unfreeze",
            disabled:
              !selectedLeases.every((l) => l.status === "Frozen") ||
              lockedForUnfreeze.length > 0,
            disabledReason:
              lockedForUnfreeze.length > 0
                ? "Assignment processing is in progress for a selected lease. Wait for it to finish before unfreezing."
                : "Only frozen leases can be unfrozen.",
          },
          {
            text: "Update",
            id: "update",
            disabled: selectedLeases.length > 1,
            disabledReason: "Only a single lease can be updated at a time.",
          },
        ]}
        onItemClick={({ detail }) => {
          if (detail.id === "update") {
            navigate(`/leases/${selectedLeases[0].leaseId}`);
          } else {
            showActionModal(detail.id as "terminate" | "freeze" | "unfreeze");
          }
        }}
      >
        Actions
      </ButtonDropdown>
    </SpaceBetween>
  );

  return {
    selectionType: "multi",
    selectedItems: selectedLeases,
    onSelectionChange: setSelectedLeases,
    headerActions,
  };
}

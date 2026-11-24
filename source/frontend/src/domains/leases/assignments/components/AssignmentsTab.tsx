// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  Container,
  Header,
  SpaceBetween,
} from "@cloudscape-design/components";
import { useEffect, useMemo, useRef, useState } from "react";

import { ErrorPanel } from "@amzn/innovation-sandbox-frontend/components/ErrorPanel";
import { Loader } from "@amzn/innovation-sandbox-frontend/components/Loader";
import {
  showErrorToast,
  showSuccessToast,
} from "@amzn/innovation-sandbox-frontend/components/Toast";
import type { AssignmentPermissionSetConfig } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorTransitions";
import { AssignmentsManagementTable } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/components/AssignmentsManagementTable";
import { useAssignmentPermissionSets } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentPermissionSets";
import { useAssignmentsEditor } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsEditor";
import {
  useGetAssignments,
  useUpdateAssignments,
} from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import type { LeaseView } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { ApiError } from "@amzn/innovation-sandbox-frontend/helpers/apiError";
import {
  DEFAULT_GROUP_ASSIGNMENT_MODE,
  type GroupAssignmentMode,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  isExpiredLease,
  isFrozenLease,
  type LeaseLockIntent,
  MAX_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { groupAssignmentsEnabled } from "@amzn/innovation-sandbox-shared/utils/group-assignment-policy.js";

const IN_FLIGHT_MESSAGE: Record<LeaseLockIntent, string> = {
  FREEZE:
    "Freezing this lease. Account access is being revoked for everyone listed.",
  UNFREEZE:
    "Unfreezing this lease. Account access is being restored for everyone listed.",
  TERMINATE:
    "Terminating this lease. Account access is being revoked for everyone listed.",
  PUBLISH: "Setting up access for this lease.",
  UPDATE:
    "An update is being processed. Saving more changes is paused until it completes.",
};

type AssignmentsTabProps = {
  lease: LeaseView;
  leaseRouteId: string;
  leaseSharingEnabled: boolean;
  enablePrincipalSearch: boolean;
  groupAssignmentMode?: GroupAssignmentMode;
  isElevated: boolean;
  isOwner: boolean;
};

export const AssignmentsTab = ({
  lease,
  leaseRouteId,
  leaseSharingEnabled,
  enablePrincipalSearch,
  groupAssignmentMode = DEFAULT_GROUP_ASSIGNMENT_MODE,
  isElevated,
  isOwner,
}: AssignmentsTabProps) => {
  const isFrozen = isFrozenLease(lease);
  const isTerminal = isExpiredLease(lease);
  const isAuthorizedToManage =
    isElevated ||
    (isOwner && leaseSharingEnabled && (lease.allowOwnerToShareLease ?? false));
  const canManage = isAuthorizedToManage && !isFrozen && !isTerminal;

  const { assignablePermissionSets, permissionSetOptions } =
    useAssignmentPermissionSets(
      lease.defaultPermissionSet,
      lease.allowedPermissionSets,
    );
  const permissionSetConfig = useMemo<AssignmentPermissionSetConfig>(
    () => ({
      defaultPermissionSetArn: lease.defaultPermissionSet.permissionSetArn,
      assignablePermissionSets,
    }),
    [assignablePermissionSets, lease.defaultPermissionSet.permissionSetArn],
  );

  const { data, isFetching, isError, refetch, error } =
    useGetAssignments(leaseRouteId);
  const updateAssignments = useUpdateAssignments({
    refetchAssignmentsOnSuccess: false,
  });
  const [isSaving, setIsSaving] = useState(false);
  const editor = useAssignmentsEditor({
    leaseRouteId,
    leaseOwnerEmail: lease.userEmail,
    response: data,
    permissionSetConfig,
    isSaving,
  });

  const saveInProgressRef = useRef(false);
  const activeLockIntent = data?.operationInProgress;
  const isAwaitingBackend = activeLockIntent !== undefined;
  const isBusy = isSaving || updateAssignments.isPending || isAwaitingBackend;
  const noAssignablePermissionSets = assignablePermissionSets.length === 0;
  const assignmentTarget = groupAssignmentsEnabled(groupAssignmentMode)
    ? "user or group"
    : "user";
  const showRetry =
    canManage &&
    !isAwaitingBackend &&
    editor.hasSyncFailures &&
    !editor.isDirty;

  useEffect(() => {
    if (!isAwaitingBackend) return;
    const interval = setInterval(() => refetch(), 5_000);
    return () => clearInterval(interval);
  }, [isAwaitingBackend, refetch]);

  const handleSaveError = async (
    saveError: unknown,
    assignmentsSaved: boolean,
  ) => {
    console.error("Failed to update assignments", saveError);
    if (
      !assignmentsSaved &&
      saveError instanceof ApiError &&
      saveError.statusCode === 409
    ) {
      await refetch({ throwOnError: true }).catch((refreshError) => {
        console.error(
          "Failed to refresh assignments after a conflict",
          refreshError,
        );
      });
    }
    showErrorToast(
      assignmentsSaved
        ? "Assignments were saved, but the latest status could not be loaded. Refresh the page to see the current state."
        : "Failed to save assignment changes. Please try again.",
      assignmentsSaved ? "Status refresh failed" : "Save failed",
    );
  };

  const saveAssignments = async () => {
    if (saveInProgressRef.current || editor.hasConcurrentChanges) return;

    saveInProgressRef.current = true;
    setIsSaving(true);
    let assignmentsSaved = false;
    try {
      const latestBeforeSave = await refetch({ throwOnError: true });
      if (latestBeforeSave.data?.operationInProgress) {
        return;
      }
      if (
        latestBeforeSave.data &&
        editor.hasServerChanges(latestBeforeSave.data)
      ) {
        editor.markConcurrentChanges();
        return;
      }

      await updateAssignments.mutateAsync({
        leaseId: leaseRouteId,
        assignments: editor.desiredAssignments,
      });
      assignmentsSaved = true;
      editor.expectServerState();

      const refreshed = await refetch({ throwOnError: true });
      if (!refreshed.data) {
        throw new Error("Assignments response did not contain data");
      }
      editor.acceptServerState(refreshed.data);
      showSuccessToast("Assignments saved. Access changes will apply shortly.");
    } catch (saveError) {
      await handleSaveError(saveError, assignmentsSaved);
    } finally {
      saveInProgressRef.current = false;
      setIsSaving(false);
    }
  };

  if (isFetching && !data) {
    return <Loader />;
  }
  if (isError && !data) {
    return (
      <ErrorPanel
        description="There was a problem loading assignments for this lease."
        retry={refetch}
        error={error}
      />
    );
  }

  return (
    <SpaceBetween size="m">
      {isError && data && (
        <Alert
          type="warning"
          header="Assignments may be out of date"
          action={
            <Button onClick={() => void refetch()} loading={isFetching}>
              Retry refresh
            </Button>
          }
        >
          The latest assignment status could not be loaded. The last available
          assignments are shown below.
        </Alert>
      )}

      {!leaseSharingEnabled && isElevated && (
        <Alert type="info" header="Lease sharing is disabled globally">
          Lease owners can't manage assignments while this feature is off. As an
          Admin or Manager you can still add or remove assignments.
        </Alert>
      )}

      <Container
        header={
          <Header
            variant="h3"
            counter={`(${editor.desiredAssignments.length}/${MAX_ASSIGNMENTS})`}
            description={
              canManage
                ? `Pick a ${assignmentTarget} to add to this lease.`
                : undefined
            }
          >
            {canManage ? "Configure access" : "Assignments"}
          </Header>
        }
      >
        <SpaceBetween size="m">
          {canManage && editor.isAtCapacity && (
            <Alert type="warning">
              {editor.isOverCapacity
                ? `Configure access for no more than ${MAX_ASSIGNMENTS} principals before saving.`
                : `This lease has reached the maximum of ${MAX_ASSIGNMENTS} principals.`}
            </Alert>
          )}

          {canManage && noAssignablePermissionSets && (
            <Alert type="warning">
              No configured permission sets are currently available. Existing
              assignments remain visible, but new assignments cannot be added.
            </Alert>
          )}

          {canManage && !isSaving && editor.hasConcurrentChanges && (
            <Alert type="warning" header="Assignments changed elsewhere">
              Cancel your staged changes to load the latest assignments before
              making another update.
            </Alert>
          )}

          <AssignmentsManagementTable
            editor={editor}
            canManage={canManage}
            isTerminal={isTerminal}
            isBusy={isBusy || editor.hasConcurrentChanges}
            enablePrincipalSearch={enablePrincipalSearch}
            groupAssignmentMode={groupAssignmentMode}
            permissionSetConfig={permissionSetConfig}
            permissionSetOptions={permissionSetOptions}
          />
        </SpaceBetween>
      </Container>

      {isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">{IN_FLIGHT_MESSAGE[activeLockIntent]}</Alert>
      )}

      {isFrozen && !isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">
          This lease is frozen, so account access is suspended for everyone
          listed. The list is kept so access is restored when the lease is
          unfrozen. Unfreeze the lease to change assignments.
        </Alert>
      )}

      {isTerminal && !isAwaitingBackend && isAuthorizedToManage && (
        <Alert type="info">
          This lease has ended, so account access is revoked for everyone
          listed. The list is kept as a record of who had access to the account.
        </Alert>
      )}

      {showRetry && (
        <Alert
          type="warning"
          header="Some access changes did not apply"
          action={
            <Button
              onClick={saveAssignments}
              loading={isSaving || updateAssignments.isPending}
            >
              Retry
            </Button>
          }
        >
          Retry to reapply the access shown below. No changes to the list are
          required.
        </Alert>
      )}

      {canManage && (
        <Box float="right">
          <SpaceBetween direction="horizontal" size="xs">
            <Button
              onClick={editor.discard}
              disabled={!editor.isDirty || isBusy}
            >
              Cancel
            </Button>
            <Button
              variant="primary"
              onClick={saveAssignments}
              loading={isBusy}
              disabled={
                !editor.isDirty ||
                isBusy ||
                editor.hasConcurrentChanges ||
                editor.isOverCapacity
              }
            >
              Save changes
            </Button>
          </SpaceBetween>
        </Box>
      )}
    </SpaceBetween>
  );
};

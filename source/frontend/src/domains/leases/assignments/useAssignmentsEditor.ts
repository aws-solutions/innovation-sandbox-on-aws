// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import {
  assignmentRefsFingerprint,
  type AssignmentRow,
  type AssignmentRowsById,
  assignmentRowsFromResponse,
  type AssignmentTablePrincipal,
  desiredAssignmentsFingerprint,
  groupAssignmentRows,
  hasAssignmentSyncFailures,
  hasStagedAssignmentChanges,
  isDesiredAssignmentRow,
  sortAssignmentRows,
  toDesiredAssignmentRefs,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorModel";
import {
  addAssignment,
  type AssignmentPermissionSetConfig,
  changeAssignmentPermissionSet,
  removeAssignment,
  restoreAssignment,
  shouldExcludePrincipal,
  undoAssignmentChange,
} from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorTransitions";
import type { GetLeaseAssignmentsResponse } from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import type { IdcPrincipalView } from "@amzn/innovation-sandbox-frontend/domains/principals/model";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";

type UseAssignmentsEditorProps = {
  leaseRouteId: string;
  leaseOwnerEmail: string;
  response: GetLeaseAssignmentsResponse | undefined;
  permissionSetConfig: AssignmentPermissionSetConfig;
  isSaving?: boolean;
};

export const useAssignmentsEditor = ({
  leaseRouteId,
  leaseOwnerEmail,
  response,
  permissionSetConfig,
  isSaving = false,
}: UseAssignmentsEditorProps) => {
  const [rowsById, setRowsById] = useState<AssignmentRowsById>({});
  const [baselineFingerprint, setBaselineFingerprint] = useState<string>();
  const [hasConcurrentChanges, setHasConcurrentChanges] = useState(false);
  const lastAppliedResponseRef = useRef<
    | {
        response: GetLeaseAssignmentsResponse;
        fingerprint: string;
      }
    | undefined
  >(undefined);
  const expectedServerFingerprintRef = useRef<string>();

  const serverFingerprint = useMemo(
    () => (response ? desiredAssignmentsFingerprint(response) : undefined),
    [response],
  );

  const resetEditor = useCallback(() => {
    setRowsById({});
    setBaselineFingerprint(undefined);
    setHasConcurrentChanges(false);
    lastAppliedResponseRef.current = undefined;
    expectedServerFingerprintRef.current = undefined;
  }, []);

  const applyServerState = useCallback(
    (nextResponse: GetLeaseAssignmentsResponse, fingerprint: string) => {
      setRowsById(assignmentRowsFromResponse(nextResponse));
      setBaselineFingerprint(fingerprint);
      setHasConcurrentChanges(false);
      lastAppliedResponseRef.current = {
        response: nextResponse,
        fingerprint,
      };
      expectedServerFingerprintRef.current = undefined;
    },
    [],
  );

  useEffect(() => {
    resetEditor();
  }, [leaseRouteId, resetEditor]);

  useEffect(() => {
    if (!response || serverFingerprint === undefined) return;
    if (hasStagedAssignmentChanges(rowsById)) {
      if (expectedServerFingerprintRef.current === serverFingerprint) {
        applyServerState(response, serverFingerprint);
        return;
      }
      if (!isSaving && baselineFingerprint !== undefined) {
        setHasConcurrentChanges(serverFingerprint !== baselineFingerprint);
      }
      return;
    }

    const lastApplied = lastAppliedResponseRef.current;
    if (
      lastApplied?.response !== response ||
      lastApplied.fingerprint !== serverFingerprint ||
      baselineFingerprint !== serverFingerprint ||
      hasConcurrentChanges
    ) {
      applyServerState(response, serverFingerprint);
    }
  }, [
    applyServerState,
    baselineFingerprint,
    hasConcurrentChanges,
    isSaving,
    response,
    rowsById,
    serverFingerprint,
  ]);

  const rows = useMemo(() => Object.values(rowsById), [rowsById]);
  const desiredAssignments = useMemo(
    () => toDesiredAssignmentRefs(rows),
    [rows],
  );
  const principalRows = useMemo(
    () => groupAssignmentRows(sortAssignmentRows(rows)),
    [rows],
  );
  const isDirty = useMemo(
    () => hasStagedAssignmentChanges(rowsById),
    [rowsById],
  );
  const hasSyncFailures = useMemo(
    () => hasAssignmentSyncFailures(rows),
    [rows],
  );
  const isAtCapacity = desiredAssignments.length >= MAX_ASSIGNMENTS;
  const isOverCapacity = desiredAssignments.length > MAX_ASSIGNMENTS;

  const updateRows = useCallback(
    (update: (current: AssignmentRowsById) => AssignmentRowsById) => {
      expectedServerFingerprintRef.current = undefined;
      setRowsById(update);
    },
    [],
  );

  const addPrincipal = useCallback(
    (principal: IdcPrincipalView) => {
      if (isAtCapacity) return;
      updateRows((current) =>
        addAssignment(current, principal, permissionSetConfig),
      );
    },
    [isAtCapacity, permissionSetConfig, updateRows],
  );

  const remove = useCallback(
    (row: AssignmentRow) => {
      updateRows((current) => removeAssignment(current, row.rowId));
    },
    [updateRows],
  );

  const restore = useCallback(
    (row: AssignmentRow) => {
      updateRows((current) => restoreAssignment(current, row.rowId));
    },
    [updateRows],
  );

  const undo = useCallback(
    (row: AssignmentRow) => {
      updateRows((current) => undoAssignmentChange(current, row.rowId));
    },
    [updateRows],
  );

  const setPermissionSet = useCallback(
    (principal: AssignmentTablePrincipal, permissionSetArn: string) => {
      updateRows((current) =>
        changeAssignmentPermissionSet(
          current,
          principal.assignment.row.rowId,
          permissionSetArn,
          permissionSetConfig,
        ),
      );
    },
    [permissionSetConfig, updateRows],
  );

  const shouldExclude = useCallback(
    (principal: IdcPrincipalView) =>
      shouldExcludePrincipal(rows, principal, leaseOwnerEmail),
    [leaseOwnerEmail, rows],
  );

  const discard = useCallback(() => {
    if (response && serverFingerprint !== undefined) {
      applyServerState(response, serverFingerprint);
    } else {
      resetEditor();
    }
  }, [applyServerState, resetEditor, response, serverFingerprint]);

  const hasServerChanges = useCallback(
    (latestResponse: GetLeaseAssignmentsResponse): boolean =>
      baselineFingerprint !== undefined &&
      desiredAssignmentsFingerprint(latestResponse) !== baselineFingerprint,
    [baselineFingerprint],
  );

  const acceptServerState = useCallback(
    (latestResponse: GetLeaseAssignmentsResponse) =>
      applyServerState(
        latestResponse,
        desiredAssignmentsFingerprint(latestResponse),
      ),
    [applyServerState],
  );
  const expectServerState = useCallback(() => {
    expectedServerFingerprintRef.current = assignmentRefsFingerprint(
      rows.filter(isDesiredAssignmentRow).map((row) => ({
        principalId: row.principalId,
        principalType: row.principalType,
        permissionSetArn: row.permissionSet.permissionSetArn,
      })),
    );
  }, [rows]);
  const markConcurrentChanges = useCallback(
    () => setHasConcurrentChanges(true),
    [],
  );

  return {
    principalRows,
    desiredAssignments,
    isDirty,
    hasSyncFailures,
    hasConcurrentChanges,
    isAtCapacity,
    isOverCapacity,
    addPrincipal,
    remove,
    restore,
    undo,
    setPermissionSet,
    shouldExclude,
    discard,
    hasServerChanges,
    acceptServerState,
    expectServerState,
    markConcurrentChanges,
  };
};

export type AssignmentsEditor = ReturnType<typeof useAssignmentsEditor>;

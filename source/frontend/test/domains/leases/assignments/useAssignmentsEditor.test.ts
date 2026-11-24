// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import type { AssignmentPermissionSetConfig } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentEditorTransitions";
import { useAssignmentsEditor } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/useAssignmentsEditor";
import type {
  GetLeaseAssignmentsResponse,
  LeaseAssignmentView,
} from "@amzn/innovation-sandbox-frontend/domains/leases/model";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const permissionSet = (suffix: string): PermissionSetReference => ({
  permissionSetArn: `arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-${suffix.padEnd(16, "0")}`,
  permissionSetId: `ps-${suffix.padEnd(16, "0")}`,
  name: suffix,
  availability: "AVAILABLE",
});
const permissionSetA = permissionSet("a");
const permissionSetB = permissionSet("b");
const config: AssignmentPermissionSetConfig = {
  defaultPermissionSetArn: permissionSetA.permissionSetArn,
  assignablePermissionSets: [permissionSetA, permissionSetB],
};

const assignment = (
  principalId: string,
  selectedPermissionSet: PermissionSetReference,
): LeaseAssignmentView => ({
  principalId,
  principalType: "USER",
  displayName: principalId,
  assigneeEmail: `${principalId}@example.com`,
  isOwner: false,
  isDesired: true,
  syncStatus: "active",
  permissionSet: selectedPermissionSet,
});

const response = (
  ...assignments: LeaseAssignmentView[]
): GetLeaseAssignmentsResponse => ({ assignments });

describe("useAssignmentsEditor", () => {
  it("accepts its own saved state after a failed refresh recovers", async () => {
    const initialResponse = response(assignment("alice", permissionSetA));
    const savedResponse = response(assignment("alice", permissionSetB));
    const { result, rerender } = renderHook(
      ({ serverResponse }: { serverResponse: GetLeaseAssignmentsResponse }) =>
        useAssignmentsEditor({
          leaseRouteId: "lease-id",
          leaseOwnerEmail: "owner@example.com",
          response: serverResponse,
          permissionSetConfig: config,
        }),
      {
        initialProps: {
          serverResponse: initialResponse,
        },
      },
    );

    await waitFor(() =>
      expect(result.current.principalRows[0]?.displayName).toBe("alice"),
    );
    act(() => {
      result.current.setPermissionSet(
        result.current.principalRows[0],
        permissionSetB.permissionSetArn,
      );
    });
    await waitFor(() => expect(result.current.isDirty).toBe(true));
    act(() => result.current.expectServerState());

    rerender({ serverResponse: savedResponse });

    await waitFor(() => {
      expect(result.current.hasConcurrentChanges).toBe(false);
      expect(result.current.isDirty).toBe(false);
      expect(result.current.desiredAssignments[0]?.permissionSetArn).toBe(
        permissionSetB.permissionSetArn,
      );
    });
  });

  it("applies a deferred server response when local changes become clean", async () => {
    const initialResponse = response(assignment("alice", permissionSetA));
    const concurrentResponse = response(assignment("bob", permissionSetB));
    const { result, rerender } = renderHook(
      ({ serverResponse }) =>
        useAssignmentsEditor({
          leaseRouteId: "lease-id",
          leaseOwnerEmail: "owner@example.com",
          response: serverResponse,
          permissionSetConfig: config,
        }),
      { initialProps: { serverResponse: initialResponse } },
    );

    await waitFor(() =>
      expect(result.current.principalRows[0]?.displayName).toBe("alice"),
    );
    act(() => {
      result.current.remove(result.current.principalRows[0].assignment.row);
    });
    rerender({ serverResponse: concurrentResponse });

    await waitFor(() => expect(result.current.hasConcurrentChanges).toBe(true));
    act(() => {
      result.current.undo(result.current.principalRows[0].assignment.row);
    });

    await waitFor(() => {
      expect(result.current.hasConcurrentChanges).toBe(false);
      expect(result.current.principalRows).toHaveLength(1);
      expect(result.current.principalRows[0].displayName).toBe("bob");
    });
  });

  it("clears a concurrent-change warning when the server returns to the baseline", async () => {
    const initialResponse = response(assignment("alice", permissionSetA));
    const concurrentResponse = response(assignment("bob", permissionSetB));
    const { result, rerender } = renderHook(
      ({ serverResponse }) =>
        useAssignmentsEditor({
          leaseRouteId: "lease-id",
          leaseOwnerEmail: "owner@example.com",
          response: serverResponse,
          permissionSetConfig: config,
        }),
      { initialProps: { serverResponse: initialResponse } },
    );

    await waitFor(() =>
      expect(result.current.principalRows[0]?.displayName).toBe("alice"),
    );
    act(() => {
      result.current.remove(result.current.principalRows[0].assignment.row);
    });
    rerender({ serverResponse: concurrentResponse });
    await waitFor(() => expect(result.current.hasConcurrentChanges).toBe(true));

    rerender({ serverResponse: initialResponse });

    await waitFor(() => {
      expect(result.current.hasConcurrentChanges).toBe(false);
      expect(result.current.isDirty).toBe(true);
    });
  });

  it("does not add a principal when the assignment limit is reached", async () => {
    const assignments = Array.from({ length: MAX_ASSIGNMENTS }, (_, index) =>
      assignment(`user-${index}`, permissionSetA),
    );
    const serverResponse = response(...assignments);
    const { result } = renderHook(() =>
      useAssignmentsEditor({
        leaseRouteId: "lease-id",
        leaseOwnerEmail: "owner@example.com",
        response: serverResponse,
        permissionSetConfig: config,
      }),
    );

    await waitFor(() => {
      expect(result.current.desiredAssignments).toHaveLength(MAX_ASSIGNMENTS);
      expect(result.current.isAtCapacity).toBe(true);
      expect(result.current.isOverCapacity).toBe(false);
    });

    act(() => {
      result.current.addPrincipal({
        principalId: "new-user",
        principalType: "USER",
        displayName: "New user",
        email: "new-user@example.com",
      });
    });

    expect(result.current.desiredAssignments).toHaveLength(MAX_ASSIGNMENTS);
    expect(
      result.current.desiredAssignments.some(
        ({ principalId }) => principalId === "new-user",
      ),
    ).toBe(false);
  });
});

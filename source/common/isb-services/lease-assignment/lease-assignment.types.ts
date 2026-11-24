// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { z } from "zod";

import { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import {
  type LeaseAssignmentWriteSnapshot,
  LeaseStore,
} from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import type {
  PersistedGroupAssignment,
  PersistedUserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import {
  LeaseLockIntentSchema,
  type LeaseResourceLock,
  type DesiredAssignment as SharedDesiredAssignment,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import type { PermissionSetReference } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import type {
  IdcPrincipal,
  PrincipalType,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

export type LeaseLockIntent = z.infer<typeof LeaseLockIntentSchema>;
export type DesiredAssignment = SharedDesiredAssignment;

export interface EnrichedUserAssignment {
  principalId: string;
  principalType: "USER";
  email: string;
  displayName?: string;
  permissionSetArn?: string;
}

export interface EnrichedGroupAssignment {
  principalId: string;
  principalType: "GROUP";
  displayName?: string;
  email?: string;
  permissionSetArn?: string;
}

export type EnrichedAssignment =
  EnrichedUserAssignment | EnrichedGroupAssignment;

export interface UpdateAssignmentsResult {
  desiredCount: number;
}

export interface ProcessAssignmentInput {
  leaseId: string;
  action: "GRANT" | "REVOKE";
  principalId: string;
  principalType: PrincipalType;
  accountId: string;
  permissionSetArn: string;
  leaseOwnerEmail: string;
  displayName?: string;
  email?: string;
  requestedBy?: string;
}

export interface ProcessAssignmentResult {
  status: "SUCCEEDED" | "SKIPPED";
  principalId: string;
  principalType: PrincipalType;
  action: string;
  reason?: string;
}

/** The action to perform for a single principal, decided via a JIT diff. */
export type AssignmentAction = "GRANT" | "REVOKE" | "NO_OP";

export interface ResolveAssignmentActionInput {
  leaseId: string;
  leaseOwnerEmail: string;
  principalId: string;
  principalType: PrincipalType;
  intent: LeaseLockIntent;
  /** Omitted only for legacy callers that reconcile by principal. */
  permissionSetArn?: string;
  /** Effective lease default, used to resolve desired assignments without an ARN. */
  defaultPermissionSetArn?: string;
  /** Immutable IDC user permission set represented by suffix-less legacy records. */
  builtInPermissionSetArn?: string;
}

export interface ResolveAssignmentActionServices {
  principalStore: PrincipalStore;
  leaseStore: LeaseStore;
  logger: Logger;
}

export interface EnrichDesiredAssignmentsServices {
  principalStore: PrincipalStore;
  /** Cache misses are resolved from IDC; USER misses require ISB membership. */
  idcService: IdcService;
  logger: Logger;
  /** Identities already resolved in this operation; reused without cache reads. */
  resolvedPrincipals?: IdcPrincipal[];
}

export interface UpdateAssignmentsServices {
  principalStore: PrincipalStore;
  leaseStore: LeaseStore;
  eventBridgeClient: IsbEventBridgeClient;
  logger: Logger;
}

export interface ProcessAssignmentServices {
  principalStore: PrincipalStore;
  ssoAdminClient: SSOAdminClient;
  idcStackConfigStore: IdcStackConfigStore;
  logger: Logger;
}

export interface TriggerAssignmentProcessingServices {
  leaseStore: LeaseStore;
  eventBridgeClient: IsbEventBridgeClient;
  principalStore?: PrincipalStore;
  idcService?: IdcService;
  tracer: Tracer;
  logger: Logger;
}

/** USER identity returned by resolving the lease's userEmail. */
export type ResolvedLeaseOwner = IdcPrincipal & {
  principalType: "USER";
  email: string;
};

export interface TriggerAssignmentProcessingProps {
  leaseId: string;
  userEmail: string;
  intent: LeaseLockIntent;
  /** Raw desired assignments — enriched internally when provided. */
  desiredAssignments?: DesiredAssignment[];
  /** Concrete lease default used when the owner must be injected. */
  defaultPermissionSetArn?: string;
  /** Owner identity used by the caller to normalize and validate desired tuples. */
  resolvedOwner?: ResolvedLeaseOwner;
  /** Lease snapshot validated by an API caller; omitted by lifecycle operations. */
  expectedLease?: LeaseAssignmentWriteSnapshot;
  /**
   * If true, release the lock when the event publish fails.
   * Defaults based on intent criticality (false for TERMINATE/FREEZE).
   */
  releaseLockOnEventFailure?: boolean;
  /** Who initiated the operation. Defaults to userEmail (lease owner). */
  requestedBy?: string;
}

/**
 * Per-principal reconciliation status.
 *
 * - active:       desired and assigned
 * - granting:     desired, not yet assigned, operation in flight
 * - revoking:     assigned, being revoked
 * - suspended:    unassigned because the lease grants nobody access (frozen or
 *                 terminal) — expected, not a failure
 * - grantFailed:  settled, desired, but unassigned
 * - revokeFailed: settled, but assigned when it should not be
 */
export const AssignmentSyncStatusSchema = z.enum([
  "active",
  "granting",
  "revoking",
  "suspended",
  "grantFailed",
  "revokeFailed",
]);

export type AssignmentSyncStatus = z.infer<typeof AssignmentSyncStatusSchema>;

/**
 * One projected assignment row: the union of the lease's desired set and its
 * live assignments. Rows sourced only from the desired set have no assignment
 * yet, so addedBy/addedDate/assigneeEmail are absent.
 */
export interface AssignmentProjection {
  principalId: string;
  principalType: PrincipalType;
  displayName: string;
  assigneeEmail?: string;
  addedBy?: string;
  addedDate?: string;
  /** True for the lease owner, whose access is implicit and not removable. */
  isOwner: boolean;
  /**
   * Whether this principal is in the lease's desired set. Cannot be inferred
   * from syncStatus: `revoking` means "no longer desired" during an UPDATE but
   * "still desired" during a FREEZE. Clients echoing the view back as the new
   * desired set must honour this, or a pending revoke is silently cancelled.
   */
  isDesired: boolean;
  syncStatus: AssignmentSyncStatus;
  /** Backend-hydrated permission-set metadata. */
  permissionSet: PermissionSetReference;
}

/** The assignment projection plus the operation currently reconciling it. */
export interface LeaseAssignmentsProjection {
  assignments: AssignmentProjection[];
  operationInProgress?: LeaseLockIntent;
}

/**
 * Internal reconciliation row passed to the API response projector. The raw
 * ARN exists only until the projector replaces it with hydrated metadata.
 */
export type UnhydratedAssignmentProjection = Omit<
  AssignmentProjection,
  "permissionSet"
> & {
  permissionSetArn?: string;
};

/** Unhydrated assignments projection returned to the API response projector. */
export interface UnhydratedLeaseAssignmentsProjection {
  assignments: UnhydratedAssignmentProjection[];
  operationInProgress?: LeaseLockIntent;
}

export interface DeriveAssignmentProjectionProps {
  lease: PersistedLease;
  assignments: Array<PersistedUserAssignment | PersistedGroupAssignment>;
  /** Immutable IDC user permission set represented by suffix-less legacy records. */
  builtInPermissionSetArn?: string;
}

/** An acquired lock whose AssignmentRequested event is not yet published. */
export interface AssignmentProcessingLock {
  leaseId: string;
  userEmail: string;
  intent: LeaseLockIntent;
  requestedBy: string;
  lockOwnerId: string;
  /** Total desired assignments persisted with the lock, or 0 when none. */
  desiredCount: number;
  /** The lock as persisted. See LeaseStore.acquireLock. */
  lock: LeaseResourceLock;
  releaseLockOnEventFailure: boolean;
}

export class MaxAssignmentsExceededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MaxAssignmentsExceededError";
  }
}

export class IneligibleAssignmentPrincipalError extends Error {
  constructor(principalType: PrincipalType = "USER") {
    super(
      principalType === "USER"
        ? "A lease assignment includes a user who is not a current Innovation Sandbox member."
        : "A lease assignment includes a group that could not be found in IAM Identity Center.",
    );
    this.name = "IneligibleAssignmentPrincipalError";
  }
}

export class IneligibleLeaseOwnerError extends Error {
  constructor(ownerEmail: string) {
    super(
      `The lease owner ${ownerEmail} is not a current Innovation Sandbox member.`,
    );
    this.name = "IneligibleLeaseOwnerError";
  }
}

export class InvalidDirectLeasePageIdentifierError extends Error {
  constructor() {
    super("The direct lease pagination token is invalid.");
    this.name = "InvalidDirectLeasePageIdentifierError";
  }
}

export interface GetLeasesForUserProps {
  userId: string;
  pageIdentifier?: string;
  pageSize?: number;
}

export interface GetLeasesForUserDirectServices {
  leaseStore: LeaseStore;
  principalStore: PrincipalStore;
  logger: Logger;
}

export interface GetLeasesForUserViaGroupsServices {
  leaseStore: LeaseStore;
  principalStore: PrincipalStore;
  idcService: IdcService;
  logger: Logger;
}

export type SharedLeaseAccessType = "direct" | "group";

export type SharedLease = PersistedLease & {
  accessType: SharedLeaseAccessType;
  sourceGroupName?: string;
};

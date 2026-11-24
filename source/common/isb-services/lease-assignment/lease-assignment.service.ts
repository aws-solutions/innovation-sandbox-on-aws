// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CreateAccountAssignmentCommand,
  DeleteAccountAssignmentCommand,
  ResourceNotFoundException,
  SSOAdminClient,
  TargetType,
} from "@aws-sdk/client-sso-admin";
import { randomUUID } from "node:crypto";
import pMap from "p-map";

import { PaginatedQueryResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  base64DecodeCompositeKey,
  base64EncodeCompositeKey,
} from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { IdcStackConfigStore } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/ssm-idc-stack-config-store.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { type PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  assignmentSk,
  parseAssignmentSk,
  userPk,
} from "@amzn/innovation-sandbox-commons/data/principal/principal-dynamodb-keys.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import {
  PersistedGroupAssignment,
  PersistedUserAssignment,
  PersistedUserAssignmentKeySchema,
  PrincipalSchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { AssignmentRequestedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-requested-event.js";
import { getGroupMemberships } from "@amzn/innovation-sandbox-commons/isb-services/group-membership/index.js";
import {
  assertPermissionSetGrantAllowed,
  assignmentTupleKey,
  type AssignmentTupleKey,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import {
  now,
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  CriticalLockIntents,
  type DesiredAssignmentWithDisplay,
  isExpiredLease,
  isFrozenLease,
  LeaseKey,
  LeaseKeySchema,
  type LeaseResourceLock,
  MAX_ASSIGNMENTS,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { permissionSetIdFromArn } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import type { PrincipalType } from "@amzn/innovation-sandbox-shared/types/principal.js";

import { ItemAlreadyExists } from "@amzn/innovation-sandbox-commons/data/errors.js";
import {
  AssignmentAction,
  AssignmentProcessingLock,
  type AssignmentSyncStatus,
  DeriveAssignmentProjectionProps,
  DesiredAssignment,
  EnrichDesiredAssignmentsServices,
  EnrichedAssignment,
  GetLeasesForUserDirectServices,
  GetLeasesForUserProps,
  GetLeasesForUserViaGroupsServices,
  IneligibleAssignmentPrincipalError,
  IneligibleLeaseOwnerError,
  InvalidDirectLeasePageIdentifierError,
  LeaseLockIntent,
  MaxAssignmentsExceededError,
  ProcessAssignmentInput,
  ProcessAssignmentResult,
  ProcessAssignmentServices,
  ResolveAssignmentActionInput,
  ResolveAssignmentActionServices,
  SharedLease,
  SharedLeaseAccessType,
  TriggerAssignmentProcessingProps,
  TriggerAssignmentProcessingServices,
  type UnhydratedAssignmentProjection,
  type UnhydratedLeaseAssignmentsProjection,
} from "./lease-assignment.types.js";

const CRITICAL_LOCK_TIMEOUT_SECONDS = 900;
const NON_CRITICAL_LOCK_TIMEOUT_SECONDS = 300;
const IDC_ASSIGNMENT_RESOLUTION_CONCURRENCY = 2;
const CRITICAL_INTENTS: readonly string[] = CriticalLockIntents;

/**
 * Acquires a resource lock on a lease and emits an AssignmentRequested event
 * to trigger the Assignment Processor Step Function.
 */
export async function triggerAssignmentProcessing(
  props: TriggerAssignmentProcessingProps,
  services: TriggerAssignmentProcessingServices,
): Promise<{ lockOwnerId: string; desiredCount: number }> {
  const lock = await acquireAssignmentProcessingLock(props, services);
  await publishAssignmentProcessingRequest(lock, services);
  return { lockOwnerId: lock.lockOwnerId, desiredCount: lock.desiredCount };
}

/**
 * Acquires the lease resource lock without publishing the request event.
 *
 * Use this with publishAssignmentProcessingRequest when the caller must mutate
 * lease state between acquiring the lock and dispatching the processor — the
 * lock then gates the mutation, so a conflict leaves the lease untouched. Use
 * triggerAssignmentProcessing instead when no such mutation is needed.
 *
 * Callers that acquire the lock directly own releasing it if their own work
 * fails before publishing; see releaseAssignmentProcessingLock.
 *
 * @throws {ResourceLockConflictError} when a competing lock cannot be preempted
 * @throws {ConcurrentDataModificationException} when validated lease state changed
 * @throws {UnknownItem} when the lease was deleted before a guarded write
 */
export async function acquireAssignmentProcessingLock(
  props: TriggerAssignmentProcessingProps,
  services: TriggerAssignmentProcessingServices,
): Promise<AssignmentProcessingLock> {
  const {
    leaseId,
    userEmail,
    intent,
    desiredAssignments,
    defaultPermissionSetArn,
    resolvedOwner,
    expectedLease,
  } = props;
  const requestedBy = props.requestedBy ?? userEmail;
  const { leaseStore, principalStore, idcService, logger } = services;

  const isCritical = CRITICAL_INTENTS.includes(intent);
  const releaseLockOnEventFailure =
    props.releaseLockOnEventFailure ?? !isCritical;
  const timeoutSeconds = isCritical
    ? CRITICAL_LOCK_TIMEOUT_SECONDS
    : NON_CRITICAL_LOCK_TIMEOUT_SECONDS;

  const lockOwnerId = `${intent.toLowerCase()}-${randomUUID()}`;

  const { desiredCount, lock } = await acquireAssignmentLock(
    {
      leaseId,
      userEmail,
      intent,
      desiredAssignments,
      defaultPermissionSetArn,
      resolvedOwner,
      expectedLease,
      lockOwnerId,
      timeoutSeconds,
    },
    { leaseStore, principalStore, idcService, logger },
  );

  return {
    leaseId,
    userEmail,
    intent,
    requestedBy,
    lockOwnerId,
    desiredCount,
    lock,
    releaseLockOnEventFailure,
  };
}

/**
 * Publishes the AssignmentRequested event for a lock obtained via
 * acquireAssignmentProcessingLock, dispatching the Assignment Processor.
 */
export async function publishAssignmentProcessingRequest(
  lock: AssignmentProcessingLock,
  services: TriggerAssignmentProcessingServices,
): Promise<void> {
  const { leaseStore, eventBridgeClient, tracer, logger } = services;

  await publishAssignmentRequestedEvent(
    {
      leaseId: lock.leaseId,
      userEmail: lock.userEmail,
      intent: lock.intent,
      requestedBy: lock.requestedBy,
      lockOwnerId: lock.lockOwnerId,
      releaseLockOnEventFailure: lock.releaseLockOnEventFailure,
    },
    { leaseStore, eventBridgeClient, tracer, logger },
  );
}

/**
 * Best-effort release of a lock acquired via acquireAssignmentProcessingLock.
 *
 * Used to compensate when the caller's own work fails after acquiring the lock
 * but before publishing. A release failure is logged and swallowed so it never
 * shadows the original error — the lock expires on its own regardless.
 */
export async function releaseAssignmentProcessingLock(
  lock: Pick<AssignmentProcessingLock, "leaseId" | "userEmail" | "lockOwnerId">,
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<void> {
  const { leaseStore, logger } = services;
  await leaseStore
    .releaseLock({
      leaseId: lock.leaseId,
      userEmail: lock.userEmail,
      ownerId: lock.lockOwnerId,
    })
    .catch((error: unknown) => {
      logger.error("Failed to release assignment lock during error cleanup", {
        leaseId: lock.leaseId,
        lockOwnerId: lock.lockOwnerId,
        errorMessage: error instanceof Error ? error.message : String(error),
      });
    });
}

/**
 * Acquires the lease resource lock. When desiredAssignments is provided, the
 * owner is auto-injected, the list is enriched and count-validated, and the
 * lock is written together with the enriched assignments. Returns the total
 * number of desired assignments persisted (including the owner), or 0 when no
 * assignments are provided.
 */
async function acquireAssignmentLock(
  props: {
    leaseId: string;
    userEmail: string;
    intent: LeaseLockIntent;
    desiredAssignments: DesiredAssignment[] | undefined;
    defaultPermissionSetArn?: string;
    resolvedOwner?: TriggerAssignmentProcessingProps["resolvedOwner"];
    expectedLease?: TriggerAssignmentProcessingProps["expectedLease"];
    lockOwnerId: string;
    timeoutSeconds: number;
  },
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    principalStore: TriggerAssignmentProcessingServices["principalStore"];
    idcService: TriggerAssignmentProcessingServices["idcService"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<{ desiredCount: number; lock: LeaseResourceLock }> {
  const {
    leaseId,
    userEmail,
    intent,
    desiredAssignments,
    defaultPermissionSetArn,
    resolvedOwner,
    expectedLease,
    lockOwnerId,
    timeoutSeconds,
  } = props;
  const { leaseStore, principalStore, idcService, logger } = services;

  if (!desiredAssignments) {
    const lock = await leaseStore.acquireLock({
      leaseId,
      userEmail,
      ownerId: lockOwnerId,
      timeoutSeconds,
      meta: { intent },
    });
    logger.info("Resource lock acquired without desiredAssignments", {
      leaseId,
      lockOwnerId,
      intent,
    });
    return { desiredCount: 0, lock };
  }

  const enriched = await enrichWithOwner(
    { desiredAssignments, userEmail, defaultPermissionSetArn, resolvedOwner },
    { principalStore, idcService, logger },
  );

  const lock = await leaseStore.acquireLockWithDesiredAssignments({
    leaseId,
    userEmail,
    ownerId: lockOwnerId,
    timeoutSeconds,
    meta: { intent },
    desiredAssignments: enriched,
    expectedLease,
  });
  logger.info("Resource lock acquired with desiredAssignments", {
    leaseId,
    lockOwnerId,
    intent,
    desiredCount: enriched.length,
  });

  return { desiredCount: enriched.length, lock };
}

/**
 * Auto-injects the lease owner (implicit, like publishLease) into the desired
 * assignments and enriches them with display info. principalStore and
 * idcService are required.
 */
async function enrichWithOwner(
  props: {
    desiredAssignments: DesiredAssignment[];
    userEmail: string;
    defaultPermissionSetArn?: string;
    resolvedOwner?: TriggerAssignmentProcessingProps["resolvedOwner"];
  },
  services: {
    principalStore: TriggerAssignmentProcessingServices["principalStore"];
    idcService: TriggerAssignmentProcessingServices["idcService"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<EnrichedAssignment[]> {
  const {
    desiredAssignments,
    userEmail,
    defaultPermissionSetArn,
    resolvedOwner,
  } = props;
  const { principalStore, idcService, logger } = services;

  if (!principalStore) {
    throw new Error(
      "principalStore is required when desiredAssignments is provided",
    );
  }
  if (!idcService) {
    throw new Error(
      "idcService is required when desiredAssignments is provided",
    );
  }

  const ownerPrincipal =
    resolvedOwner ??
    (await idcService.getCachedPrincipalByAttr(
      "USER",
      userEmail,
      principalStore,
      logger,
    ));
  if (ownerPrincipal?.principalType !== "USER" || !ownerPrincipal.email) {
    throw new IneligibleLeaseOwnerError(userEmail);
  }

  const resolvedDefaultPermissionSetArn =
    defaultPermissionSetArn ??
    (await idcService.getBuiltInUserPermissionSetArn());
  const desiredAssignmentsWithOwner = normalizeAssignmentsWithOwner({
    assignments: desiredAssignments,
    ownerPrincipalId: ownerPrincipal.principalId,
    defaultPermissionSetArn: resolvedDefaultPermissionSetArn,
  });

  return enrichDesiredAssignments(desiredAssignmentsWithOwner, {
    principalStore,
    idcService,
    logger,
    resolvedPrincipals: [ownerPrincipal],
  });
}

/**
 * Converts the flexible API input into the canonical assignment set:
 * omitted owner means one default-profile owner assignment, while an explicit
 * owner assignment is preserved. The owner counts toward MAX_ASSIGNMENTS.
 */
export function normalizeAssignmentsWithOwner(props: {
  assignments: DesiredAssignment[];
  ownerPrincipalId: string;
  defaultPermissionSetArn: string;
}): DesiredAssignment[] {
  const { assignments, ownerPrincipalId, defaultPermissionSetArn } = props;
  let ownerAssignmentPresent = false;
  const normalizedAssignments = assignments.map((assignment) => {
    if (
      assignment.principalType !== "USER" ||
      assignment.principalId !== ownerPrincipalId
    ) {
      return assignment;
    }

    ownerAssignmentPresent = true;
    return {
      ...assignment,
      permissionSetArn: assignment.permissionSetArn ?? defaultPermissionSetArn,
    };
  });

  if (!ownerAssignmentPresent) {
    normalizedAssignments.push({
      principalId: ownerPrincipalId,
      principalType: "USER",
      permissionSetArn: defaultPermissionSetArn,
    });
  }

  validateAssignmentCount(normalizedAssignments);
  return normalizedAssignments;
}

/**
 * Publishes the AssignmentRequested event. On failure, releases the lock when
 * releaseLockOnEventFailure is set (a lock-release failure is logged but never
 * shadows the original publish error), then rethrows.
 */
async function publishAssignmentRequestedEvent(
  props: {
    leaseId: string;
    userEmail: string;
    intent: LeaseLockIntent;
    requestedBy: string;
    lockOwnerId: string;
    releaseLockOnEventFailure: boolean;
  },
  services: {
    leaseStore: TriggerAssignmentProcessingServices["leaseStore"];
    eventBridgeClient: TriggerAssignmentProcessingServices["eventBridgeClient"];
    tracer: TriggerAssignmentProcessingServices["tracer"];
    logger: TriggerAssignmentProcessingServices["logger"];
  },
): Promise<void> {
  const {
    leaseId,
    userEmail,
    intent,
    requestedBy,
    lockOwnerId,
    releaseLockOnEventFailure,
  } = props;
  const { leaseStore, eventBridgeClient, tracer, logger } = services;

  try {
    await eventBridgeClient.sendIsbEvent(
      tracer,
      new AssignmentRequestedEvent({
        intent,
        leaseId,
        requestedBy,
        lockOwnerId,
        leaseOwnerEmail: userEmail,
      }),
    );
    logger.info("AssignmentRequested event published", {
      leaseId,
      lockOwnerId,
      intent,
    });
  } catch (error: unknown) {
    if (releaseLockOnEventFailure) {
      logger.error(
        "Failed to publish AssignmentRequested event, releasing lock",
        {
          leaseId,
          lockOwnerId,
          intent,
          error: error instanceof Error ? error.message : String(error),
        },
      );
      await leaseStore
        .releaseLock({ leaseId, userEmail, ownerId: lockOwnerId })
        .catch((releaseError: unknown) => {
          logger.error("Failed to release lock during error cleanup", {
            leaseId,
            lockOwnerId,
            errorMessage:
              releaseError instanceof Error
                ? releaseError.message
                : String(releaseError),
          });
        });
    }
    throw error;
  }
}

/** Status for a principal that currently holds an access assignment. */
function statusForAssigned(props: {
  shouldNotBeAssigned: boolean;
  isInFlight: boolean;
}): AssignmentSyncStatus {
  if (!props.shouldNotBeAssigned) return "active";
  if (props.isInFlight) return "revoking";
  return "revokeFailed";
}

/** Status for a desired principal that holds no access assignment. */
function statusForUnassigned(props: {
  noAccessExpected: boolean;
  isInFlight: boolean;
}): AssignmentSyncStatus {
  if (props.noAccessExpected) return "suspended";
  if (props.isInFlight) return "granting";
  return "grantFailed";
}

interface AssignmentProjectionState {
  operationInProgress?: LeaseLockIntent;
  isInFlight: boolean;
  noAccessExpected: boolean;
}

interface IndexedPersistedAssignment {
  assignment: PersistedUserAssignment | PersistedGroupAssignment;
  principalId: string;
  isTupleKeyed: boolean;
  effectivePermissionSetArn?: string;
}

/**
 * Normalizes the pre-1.3 implicit-owner model into the explicit desired-state
 * shape used by the assignment projection. This is projection-only and maps
 * an omitted legacy ARN to the built-in permission set when context is present.
 */
function resolveDesiredAssignmentsForProjection(props: {
  lease: PersistedLease;
  assignments: Array<PersistedUserAssignment | PersistedGroupAssignment>;
  builtInPermissionSetArn?: string;
}): DesiredAssignmentWithDisplay[] {
  const { lease, assignments, builtInPermissionSetArn } = props;
  const desiredAssignments = lease.desiredAssignments ?? [];
  if (desiredAssignments.length > 0) {
    return desiredAssignments;
  }

  return assignments
    .filter(
      (assignment): assignment is PersistedUserAssignment =>
        assignment.principalType === "USER" &&
        assignment.assigneeEmail === lease.userEmail,
    )
    .map((assignment) => ({
      principalId: assignment.userId,
      principalType: "USER",
      displayName: assignment.displayName,
      email: assignment.assigneeEmail,
      permissionSetArn: assignment.permissionSetArn ?? builtInPermissionSetArn,
    }));
}

function resolveDesiredPermissionSetArn(props: {
  assignment: DesiredAssignmentWithDisplay;
  leaseDefaultPermissionSetArn?: string;
  fallbackPermissionSetArn?: string;
}): string | undefined {
  const { assignment, leaseDefaultPermissionSetArn, fallbackPermissionSetArn } =
    props;
  return (
    assignment.permissionSetArn ??
    leaseDefaultPermissionSetArn ??
    fallbackPermissionSetArn
  );
}

function resolvePersistedPermissionSetArn(props: {
  assignment: PersistedUserAssignment | PersistedGroupAssignment;
  builtInPermissionSetArn?: string;
}): string | undefined {
  const { assignment, builtInPermissionSetArn } = props;
  return assignment.permissionSetArn ?? builtInPermissionSetArn;
}

function principalIdForAssignment(
  assignment: PersistedUserAssignment | PersistedGroupAssignment,
): string {
  return assignment.principalType === "USER"
    ? assignment.userId
    : assignment.groupId;
}

function isTupleKeyedAssignment(
  assignment: PersistedUserAssignment | PersistedGroupAssignment,
): boolean {
  return parseAssignmentSk(assignment.sk)?.permissionSetId !== undefined;
}

function deriveAssignmentProjectionState(
  lease: PersistedLease,
): AssignmentProjectionState {
  const { resourceLock } = lease;
  const operationInProgress =
    resourceLock && parseDatetime(resourceLock.expiresAt) > now()
      ? resourceLock.meta?.intent
      : undefined;

  return {
    operationInProgress,
    isInFlight: operationInProgress !== undefined,
    noAccessExpected:
      operationInProgress === "FREEZE" ||
      operationInProgress === "TERMINATE" ||
      (isFrozenLease(lease) && operationInProgress !== "UNFREEZE") ||
      isExpiredLease(lease),
  };
}

function indexDesiredAssignments(
  props: DeriveAssignmentProjectionProps,
): Map<AssignmentTupleKey, DesiredAssignmentWithDisplay> {
  const { lease, assignments, builtInPermissionSetArn } = props;
  const desiredAssignments = resolveDesiredAssignmentsForProjection({
    lease,
    assignments,
    builtInPermissionSetArn,
  });

  return new Map(
    desiredAssignments.map((assignment) => [
      assignmentTupleKey({
        principalType: assignment.principalType,
        principalId: assignment.principalId,
        permissionSetArn: resolveDesiredPermissionSetArn({
          assignment,
          leaseDefaultPermissionSetArn: lease.defaultPermissionSetArn,
          fallbackPermissionSetArn: builtInPermissionSetArn,
        }),
      }),
      assignment,
    ]),
  );
}

/**
 * During tuple-key rollout or repair, both physical key formats may be
 * observed for the same effective built-in assignment. Collapse them,
 * preferring the explicit tuple-keyed record.
 */
function indexPersistedAssignments(props: {
  assignments: Array<PersistedUserAssignment | PersistedGroupAssignment>;
  builtInPermissionSetArn?: string;
}): Map<AssignmentTupleKey, IndexedPersistedAssignment> {
  const { assignments, builtInPermissionSetArn } = props;
  const assignmentsByTuple = new Map<
    AssignmentTupleKey,
    IndexedPersistedAssignment
  >();

  for (const assignment of assignments) {
    const principalId = principalIdForAssignment(assignment);
    const effectivePermissionSetArn = resolvePersistedPermissionSetArn({
      assignment,
      builtInPermissionSetArn,
    });
    const key = assignmentTupleKey({
      principalType: assignment.principalType,
      principalId,
      permissionSetArn: effectivePermissionSetArn,
    });
    const candidate = {
      assignment,
      principalId,
      isTupleKeyed: isTupleKeyedAssignment(assignment),
      effectivePermissionSetArn,
    };
    const existing = assignmentsByTuple.get(key);

    if (
      existing === undefined ||
      (candidate.isTupleKeyed && !existing.isTupleKeyed)
    ) {
      assignmentsByTuple.set(key, candidate);
    }
  }

  return assignmentsByTuple;
}

/** Builds a projection row for a desired principal with no live assignment. */
function projectionFromDesiredAssignment(props: {
  lease: PersistedLease;
  desiredAssignment: DesiredAssignmentWithDisplay;
  effectivePermissionSetArn?: string;
  state: AssignmentProjectionState;
}): UnhydratedAssignmentProjection {
  const {
    desiredAssignment: d,
    effectivePermissionSetArn,
    lease,
    state,
  } = props;
  return {
    principalId: d.principalId,
    principalType: d.principalType,
    displayName: d.displayName ?? d.email ?? d.principalId,
    assigneeEmail: d.principalType === "USER" ? d.email : undefined,
    isOwner: d.principalType === "USER" && d.email === lease.userEmail,
    isDesired: true,
    syncStatus: statusForUnassigned({
      noAccessExpected: state.noAccessExpected,
      isInFlight: state.isInFlight,
    }),
    permissionSetArn: effectivePermissionSetArn,
  };
}

/** Builds a projection row for a principal with a live assignment. */
function projectionFromAssignment(props: {
  lease: PersistedLease;
  current: IndexedPersistedAssignment;
  desiredAssignment?: DesiredAssignmentWithDisplay;
  state: AssignmentProjectionState;
}): UnhydratedAssignmentProjection {
  const { current, lease, desiredAssignment, state } = props;
  const { assignment, principalId } = current;
  const assigneeEmail =
    "assigneeEmail" in assignment ? assignment.assigneeEmail : undefined;
  const isOwner =
    assignment.principalType === "USER" && assigneeEmail === lease.userEmail;
  const isDesired = desiredAssignment !== undefined;

  const shouldNotBeAssigned = state.noAccessExpected || !isDesired;

  return {
    principalId,
    principalType: assignment.principalType,
    displayName:
      desiredAssignment?.displayName ??
      assignment.displayName ??
      assigneeEmail ??
      principalId,
    assigneeEmail,
    addedBy: assignment.addedBy,
    addedDate: assignment.addedDate,
    isOwner,
    isDesired,
    syncStatus: statusForAssigned({
      shouldNotBeAssigned,
      isInFlight: state.isInFlight,
    }),
    permissionSetArn: current.effectivePermissionSetArn,
  };
}

/**
 * Builds the assignments projection for a lease: the union of its desired set
 * and its live access assignments, each annotated with a reconciliation status.
 *
 * Status depends on the direction of the in-flight operation, not just on
 * presence/absence: a missing assignment is a pending grant during
 * UPDATE/UNFREEZE but an already-completed revoke during FREEZE/TERMINATE. It
 * mirrors resolveAssignmentAction, which applies the same rule when the worker
 * acts.
 */
export function deriveAssignmentProjection(
  props: DeriveAssignmentProjectionProps,
): UnhydratedLeaseAssignmentsProjection {
  const { lease, assignments, builtInPermissionSetArn } = props;
  const state = deriveAssignmentProjectionState(lease);
  const desiredByTuple = indexDesiredAssignments(props);
  const assignedByTuple = indexPersistedAssignments({
    assignments,
    builtInPermissionSetArn,
  });

  // Preserve current-assignment order, then append desired-only tuples in the
  // order persisted on the lease.
  const assignedProjections = [...assignedByTuple].map(([key, current]) =>
    projectionFromAssignment({
      current,
      lease,
      desiredAssignment: desiredByTuple.get(key),
      state,
    }),
  );
  const desiredOnlyProjections = [...desiredByTuple]
    .filter(([key]) => !assignedByTuple.has(key))
    .map(([, desiredAssignment]) =>
      projectionFromDesiredAssignment({
        desiredAssignment,
        effectivePermissionSetArn: resolveDesiredPermissionSetArn({
          assignment: desiredAssignment,
          leaseDefaultPermissionSetArn: lease.defaultPermissionSetArn,
          fallbackPermissionSetArn: builtInPermissionSetArn,
        }),
        lease,
        state,
      }),
    );

  return {
    assignments: [...assignedProjections, ...desiredOnlyProjections],
    operationInProgress: state.operationInProgress,
  };
}

/**
 * Determines the IDC action for a single principal at execution time (JIT diff)
 * from the lease intent, whether the principal is in the lease's desired
 * assignments, and whether an assignment record currently exists.
 *
 * FREEZE/TERMINATE revoke any existing access (desired state is effectively
 * empty), so the lease is not read for those intents.
 */
export async function resolveAssignmentAction(
  props: ResolveAssignmentActionInput,
  services: ResolveAssignmentActionServices,
): Promise<AssignmentAction> {
  const { principalStore, leaseStore, logger } = services;

  const recordExists = await assignmentRecordExists(principalStore, props);
  const shouldHaveAccess = await shouldPrincipalHaveAccess(leaseStore, props);
  const action = determineAction({
    intent: props.intent,
    isDesired: shouldHaveAccess,
    recordExists,
  });

  logger.info("Resolved assignment action", {
    leaseId: props.leaseId,
    principalId: props.principalId,
    principalType: props.principalType,
    intent: props.intent,
    recordExists,
    shouldHaveAccess,
    action,
  });

  return action;
}

function determineAction(props: {
  intent: LeaseLockIntent;
  isDesired: boolean;
  recordExists: boolean;
}): AssignmentAction {
  if (CRITICAL_INTENTS.includes(props.intent)) {
    return props.recordExists ? "REVOKE" : "NO_OP";
  }
  if (props.isDesired && !props.recordExists) return "GRANT";
  if (!props.isDesired && props.recordExists) return "REVOKE";
  return "NO_OP";
}

async function assignmentRecordExists(
  principalStore: PrincipalStore,
  props: ResolveAssignmentActionInput,
): Promise<boolean> {
  const existing = await principalStore.findAssignment({
    principalId: props.principalId,
    principalType: props.principalType,
    leaseId: props.leaseId,
    permissionSetArn: props.permissionSetArn,
    builtInPermissionSetArn: props.builtInPermissionSetArn,
  });
  return existing !== undefined;
}

async function shouldPrincipalHaveAccess(
  leaseStore: LeaseStore,
  props: ResolveAssignmentActionInput,
): Promise<boolean> {
  // FREEZE/TERMINATE revoke all access — desired state is effectively empty,
  // so there is no need to read the lease.
  if (CRITICAL_INTENTS.includes(props.intent)) {
    return false;
  }

  const leaseResult = await leaseStore.get(
    {
      userEmail: props.leaseOwnerEmail,
      uuid: props.leaseId,
    },
    { consistentRead: true },
  );
  const lease = leaseResult.result;

  if (!lease || isFrozenLease(lease) || isExpiredLease(lease)) {
    return false;
  }

  const desiredAssignments = lease.desiredAssignments ?? [];
  return desiredAssignments.some((desired) => {
    if (
      desired.principalId !== props.principalId ||
      desired.principalType !== props.principalType
    ) {
      return false;
    }
    if (props.permissionSetArn === undefined) {
      return true;
    }
    const effectivePermissionSetArn = resolveDesiredPermissionSetArn({
      assignment: desired,
      leaseDefaultPermissionSetArn: lease.defaultPermissionSetArn,
      fallbackPermissionSetArn: props.defaultPermissionSetArn,
    });
    return effectivePermissionSetArn === props.permissionSetArn;
  });
}

/**
 * Persists the grant record to the Principal Table after a successful IDC assignment.
 * ItemAlreadyExists is treated as success (idempotent).
 */
async function persistGrantRecord(
  input: ProcessAssignmentInput,
  permissionSetId: string,
  principalStore: PrincipalStore,
  logger: ProcessAssignmentServices["logger"],
): Promise<void> {
  const { leaseId, principalId, principalType } = input;
  const timestamp = nowAsIsoDatetimeString();
  const sk = assignmentSk(leaseId, permissionSetId);
  const meta = {
    createdTime: timestamp,
    lastEditTime: timestamp,
    schemaVersion: PrincipalSchemaVersion,
  };
  try {
    if (principalType === "USER") {
      await principalStore.createUserAssignment({
        pk: `user#${principalId}`,
        sk,
        userId: principalId,
        principalType: "USER",
        leaseId,
        displayName: input.displayName,
        assigneeEmail: input.email ?? "", // Enriched by Processor from SQS message
        leaseOwnerEmail: input.leaseOwnerEmail ?? "",
        accountId: input.accountId,
        permissionSetArn: input.permissionSetArn,
        addedBy: input.requestedBy ?? "",
        addedDate: timestamp,
        meta,
      });
    } else {
      await principalStore.createGroupAssignment({
        pk: `group#${principalId}`,
        sk,
        leaseId,
        groupId: principalId,
        principalType: "GROUP",
        displayName: input.displayName ?? principalId,
        leaseOwnerEmail: input.leaseOwnerEmail ?? "",
        accountId: input.accountId,
        permissionSetArn: input.permissionSetArn,
        addedBy: input.requestedBy ?? "",
        addedDate: timestamp,
        meta,
      });
    }
  } catch (error: unknown) {
    // ItemAlreadyExists means the record exists — that's fine (idempotent).
    if (error instanceof ItemAlreadyExists) {
      logger.info("Assignment record already exists (idempotent success)", {
        leaseId,
        principalId,
      });
    } else {
      throw error;
    }
  }
}

/**
 * Processes a single IDC assignment operation.
 *
 * - GRANT: calls CreateAccountAssignment, then writes assignment record to Principal Table
 * - REVOKE: calls DeleteAccountAssignment, then deletes the assignment record from Principal Table
 *
 * @throws on IDC API failure (caller reports failure to Step Function)
 */
export async function processAssignment(
  input: ProcessAssignmentInput,
  context: ProcessAssignmentServices,
): Promise<ProcessAssignmentResult> {
  const { leaseId, action, principalId, principalType } = input;
  const { principalStore, ssoAdminClient, idcStackConfigStore, logger } =
    context;

  if (action === "GRANT") {
    const permissionSetId = resolvePermissionSetId(input);
    await executeGrant(
      input,
      ssoAdminClient,
      idcStackConfigStore,
      principalStore,
    );
    logger.info("IDC CreateAccountAssignment succeeded", {
      leaseId,
      principalId,
      principalType,
    });

    // After IDC success, write the record to Principal Table.
    // ItemAlreadyExists is treated as success (idempotent).
    await persistGrantRecord(input, permissionSetId, principalStore, logger);
  } else {
    await executeRevoke(
      input,
      ssoAdminClient,
      idcStackConfigStore,
      principalStore,
    );
    logger.info("IDC DeleteAccountAssignment succeeded, record removed", {
      leaseId,
      principalId,
      principalType,
    });
    // Record deleted by executeRevoke
  }

  return { status: "SUCCEEDED", principalId, principalType, action };
}

function resolvePermissionSetId(input: ProcessAssignmentInput): string {
  const permissionSetId = permissionSetIdFromArn(input.permissionSetArn);
  if (!permissionSetId) {
    throw new Error(
      `Unable to derive permission set ID from ARN ${input.permissionSetArn}`,
    );
  }
  return permissionSetId;
}

/**
 * Enriches desired assignments with displayName and email. Reuses
 * already-resolved principals, batch-checks the cache, then JIT-resolves
 * misses. USER misses must be current ISB members; GROUP misses may be any IDC
 * group. Hard-fails if a required field is still missing after resolution.
 */
export async function enrichDesiredAssignments(
  assignments: DesiredAssignment[],
  services: EnrichDesiredAssignmentsServices,
): Promise<EnrichedAssignment[]> {
  if (assignments.length === 0) return [];

  const { principalStore, idcService, logger } = services;
  const principalKey = (principal: {
    principalId: string;
    principalType: PrincipalType;
  }) => `${principal.principalType}#${principal.principalId}`;

  const uniquePrincipals = [
    ...new Map(
      assignments.map((assignment) => {
        const principal = {
          principalId: assignment.principalId,
          principalType: assignment.principalType,
        };
        return [principalKey(principal), principal] as const;
      }),
    ).values(),
  ];

  const cacheMap = new Map(
    (services.resolvedPrincipals ?? []).map((principal) => [
      principalKey(principal),
      { email: principal.email, displayName: principal.displayName },
    ]),
  );

  // 1. Batch cache check only for identities not already resolved by the caller.
  const unresolved = uniquePrincipals.filter(
    (principal) => !cacheMap.has(principalKey(principal)),
  );
  if (unresolved.length > 0) {
    const cacheItems = await principalStore.batchGetCacheItems(unresolved);
    for (const item of cacheItems) {
      if (!cacheMap.has(principalKey(item))) {
        cacheMap.set(principalKey(item), {
          email: item.email,
          displayName: item.displayName,
        });
      }
    }
  }

  // 2. Identify cache misses and JIT-resolve via IDC.
  const misses = uniquePrincipals.filter(
    (principal) => !cacheMap.has(principalKey(principal)),
  );

  // A USER miss makes at least a DescribeUser and membership request. Bound
  // per-request concurrency to protect the shared IDC quota; this is not a
  // global rate limit.
  const resolved = await pMap(
    misses,
    async (miss) => ({
      miss,
      principal: await idcService.getCachedPrincipalById(
        miss.principalType,
        miss.principalId,
        principalStore,
        logger,
      ),
    }),
    { concurrency: IDC_ASSIGNMENT_RESOLUTION_CONCURRENCY },
  );

  for (const { miss, principal } of resolved) {
    if (!principal) {
      throw new IneligibleAssignmentPrincipalError(miss.principalType);
    }
    cacheMap.set(principalKey(principal), {
      email: principal.email,
      displayName: principal.displayName,
    });
  }

  // 3. Enrich assignments from the (now-populated) cache map
  return assignments.map((a): EnrichedAssignment => {
    const cached = cacheMap.get(principalKey(a));
    const metadata = {
      ...(cached?.displayName ? { displayName: cached.displayName } : {}),
      ...(a.permissionSetArn ? { permissionSetArn: a.permissionSetArn } : {}),
    };
    if (a.principalType === "USER") {
      if (!cached?.email) {
        throw new Error(
          `Principal cache missing email for user ${a.principalId}`,
        );
      }
      return {
        principalId: a.principalId,
        principalType: a.principalType,
        email: cached.email,
        ...metadata,
      };
    }
    if (!cached) {
      throw new Error(
        `Principal cache missing entry for group ${a.principalId}`,
      );
    }
    return {
      principalId: a.principalId,
      principalType: a.principalType,
      ...(cached.email ? { email: cached.email } : {}),
      ...metadata,
    };
  });
}

/**
 * Validates that the total number of principals (including the owner)
 * does not exceed MAX_ASSIGNMENTS.
 */
export function validateAssignmentCount(
  assignments: Array<{ principalType: string; email?: string }>,
): void {
  if (assignments.length > MAX_ASSIGNMENTS) {
    throw new MaxAssignmentsExceededError(
      `Maximum of ${MAX_ASSIGNMENTS} total assignments allowed.`,
    );
  }
}

async function executeGrant(
  input: ProcessAssignmentInput,
  ssoAdminClient: SSOAdminClient,
  idcStackConfigStore: IdcStackConfigStore,
  principalStore: PrincipalStore,
): Promise<void> {
  const config = await idcStackConfigStore.get();
  // Executed inside the worker throttle: do not authorize from an earlier API,
  // queue, or warm-container snapshot. Revokes never depend on this cache.
  const cacheItem =
    input.permissionSetArn === config.userPermissionSetArn
      ? undefined
      : await principalStore.getPermissionSetCacheItem(
          resolvePermissionSetId(input),
        );
  assertPermissionSetGrantAllowed(input.permissionSetArn, config, cacheItem);
  await ssoAdminClient.send(
    new CreateAccountAssignmentCommand({
      InstanceArn: config.ssoInstanceArn,
      PermissionSetArn: input.permissionSetArn,
      PrincipalId: input.principalId,
      PrincipalType: input.principalType,
      TargetId: input.accountId,
      TargetType: TargetType.AWS_ACCOUNT,
    }),
  );
}

async function executeRevoke(
  input: ProcessAssignmentInput,
  ssoAdminClient: SSOAdminClient,
  idcStackConfigStore: IdcStackConfigStore,
  principalStore: PrincipalStore,
): Promise<void> {
  const config = await idcStackConfigStore.get();

  // Treat ResourceNotFoundException as idempotent success —
  // the assignment was already removed (e.g. by a concurrent revocation).
  await ssoAdminClient
    .send(
      new DeleteAccountAssignmentCommand({
        InstanceArn: config.ssoInstanceArn,
        PermissionSetArn: input.permissionSetArn,
        PrincipalId: input.principalId,
        PrincipalType: input.principalType,
        TargetId: input.accountId,
        TargetType: TargetType.AWS_ACCOUNT,
      }),
    )
    .catch((error: unknown) => {
      if (error instanceof ResourceNotFoundException) {
        return undefined;
      }
      throw error;
    });

  await principalStore.deleteAssignmentsByLeasePrincipal({
    principalId: input.principalId,
    principalType: input.principalType,
    leaseId: input.leaseId,
    permissionSetArn: input.permissionSetArn,
    builtInPermissionSetArn: config.userPermissionSetArn,
  });
}

const DEFAULT_LEASES_FOR_USER_PAGE_SIZE = 50;

interface DirectLeasePageAccumulator {
  entriesByLease: Map<string, SharedLeaseInput>;
  resumePageIdentifier: string | null;
  rawAssignmentCount: number;
  leaseIdAtPreviousPageBoundary?: string;
}

interface DirectLeaseDiscoveryPage {
  entries: SharedLeaseInput[];
  nextPageIdentifier: string | null;
  rawAssignmentCount: number;
}

function directLeaseInput(
  assignment: PersistedUserAssignment,
): SharedLeaseInput {
  return {
    key: {
      userEmail: assignment.leaseOwnerEmail,
      uuid: assignment.leaseId,
    },
    accessType: "direct",
  };
}

function directLeaseIdentity(entry: SharedLeaseInput): string {
  return JSON.stringify([entry.key.userEmail, entry.key.uuid]);
}

function pageIdentifierAfterAssignment(
  assignment: PersistedUserAssignment,
): string | null {
  return base64EncodeCompositeKey({
    pk: assignment.pk,
    sk: assignment.sk,
  });
}

function leaseIdAtPreviousPageBoundary(props: {
  userId: string;
  pageIdentifier: string | undefined;
}): string | undefined {
  const { userId, pageIdentifier } = props;
  if (pageIdentifier === undefined) {
    return undefined;
  }

  try {
    const encodedKey = base64DecodeCompositeKey(pageIdentifier, (decoded) =>
      PersistedUserAssignmentKeySchema.parse(decoded),
    );
    const parsedSk = parseAssignmentSk(encodedKey.sk);
    const isCanonical = base64EncodeCompositeKey(encodedKey) === pageIdentifier;

    if (
      encodedKey.pk !== userPk(userId) ||
      parsedSk === undefined ||
      !isCanonical
    ) {
      throw new InvalidDirectLeasePageIdentifierError();
    }
    return parsedSk.leaseId;
  } catch {
    throw new InvalidDirectLeasePageIdentifierError();
  }
}

/**
 * Consumes one physical assignment page. Returns true without consuming the
 * first assignment belonging to the next unique lease when the result is full.
 */
function consumeDirectAssignmentPage(props: {
  assignments: PersistedUserAssignment[];
  accumulator: DirectLeasePageAccumulator;
  pageSize: number;
}): boolean {
  const { assignments, accumulator, pageSize } = props;

  for (const assignment of assignments) {
    if (accumulator.leaseIdAtPreviousPageBoundary !== undefined) {
      if (assignment.leaseId === accumulator.leaseIdAtPreviousPageBoundary) {
        accumulator.rawAssignmentCount += 1;
        accumulator.resumePageIdentifier =
          pageIdentifierAfterAssignment(assignment);
        continue;
      }
      accumulator.leaseIdAtPreviousPageBoundary = undefined;
    }

    const entry = directLeaseInput(assignment);
    const identity = directLeaseIdentity(entry);
    const alreadySeen = accumulator.entriesByLease.has(identity);

    if (!alreadySeen && accumulator.entriesByLease.size === pageSize) {
      return true;
    }

    accumulator.rawAssignmentCount += 1;
    accumulator.resumePageIdentifier =
      pageIdentifierAfterAssignment(assignment);
    if (!alreadySeen) {
      accumulator.entriesByLease.set(identity, entry);
    }
  }

  return false;
}

async function discoverDirectLeasePage(props: {
  userId: string;
  pageIdentifier?: string;
  pageSize: number;
  principalStore: PrincipalStore;
}): Promise<DirectLeaseDiscoveryPage> {
  const { userId, pageIdentifier, pageSize, principalStore } = props;
  const accumulator: DirectLeasePageAccumulator = {
    entriesByLease: new Map(),
    resumePageIdentifier: pageIdentifier ?? null,
    rawAssignmentCount: 0,
    leaseIdAtPreviousPageBoundary: leaseIdAtPreviousPageBoundary({
      userId,
      pageIdentifier,
    }),
  };
  let physicalPageIdentifier = pageIdentifier;

  // Read a bounded physical page, then continue until enough unique leases
  // have been collected. MAX_ASSIGNMENTS avoids a query per tuple for small
  // logical pages without multiplying large client page sizes by the cap.
  const physicalPageSize = Math.max(pageSize, MAX_ASSIGNMENTS);

  while (true) {
    const queryResult = await principalStore.getDirectAssignmentsForUser({
      userId,
      pageIdentifier: physicalPageIdentifier,
      pageSize: physicalPageSize,
    });
    const resultIsFull = consumeDirectAssignmentPage({
      assignments: queryResult.result,
      accumulator,
      pageSize,
    });

    if (resultIsFull || queryResult.nextPageIdentifier === null) {
      return {
        entries: [...accumulator.entriesByLease.values()],
        nextPageIdentifier: resultIsFull
          ? accumulator.resumePageIdentifier
          : null,
        rawAssignmentCount: accumulator.rawAssignmentCount,
      };
    }

    physicalPageIdentifier = queryResult.nextPageIdentifier;
  }
}

/**
 * DIRECT shared leases — tuple assignment records are collapsed to one lease
 * while retaining the Principal Table's opaque DynamoDB cursor.
 */
export async function getLeasesForUserDirect(
  props: GetLeasesForUserProps,
  services: GetLeasesForUserDirectServices,
): Promise<PaginatedQueryResult<SharedLease>> {
  const {
    userId,
    pageIdentifier,
    pageSize = DEFAULT_LEASES_FOR_USER_PAGE_SIZE,
  } = props;
  const { leaseStore, principalStore, logger } = services;

  if (pageSize <= 0) {
    throw new Error(`pageSize must be > 0, got ${pageSize}`);
  }

  const discoveryPage = await discoverDirectLeasePage({
    userId,
    pageIdentifier,
    pageSize,
    principalStore,
  });

  const sharedLeases = await fetchAndShapeSharedLeases(
    discoveryPage.entries,
    leaseStore,
    logger,
  );

  logger.debug("Direct shared leases discovery", {
    userId,
    rawAssignmentCount: discoveryPage.rawAssignmentCount,
    dedupedLeaseCount: discoveryPage.entries.length,
  });

  return {
    result: sharedLeases,
    nextPageIdentifier: discoveryPage.nextPageIdentifier,
  };
}

interface GroupSharedLeaseEntry {
  key: LeaseKey;
  displayName: string;
}

/**
 * GROUP shared leases — `Scan` `GroupIndex` GSI + filter + `BatchGetItem`
 * hydration. Three DynamoDB calls regardless of how many groups the user
 * belongs to. Cross-group dedup is in-memory; alphabetically first
 * `groupId` wins.
 */
export async function getLeasesForUserViaGroups(
  props: GetLeasesForUserProps,
  services: GetLeasesForUserViaGroupsServices,
): Promise<PaginatedQueryResult<SharedLease>> {
  const {
    userId,
    pageIdentifier,
    pageSize = DEFAULT_LEASES_FOR_USER_PAGE_SIZE,
  } = props;
  const { leaseStore, principalStore, logger } = services;

  if (pageSize <= 0) {
    throw new Error(`pageSize must be > 0, got ${pageSize}`);
  }

  const lastKey = pageIdentifier
    ? base64DecodeCompositeKey(pageIdentifier, (decoded) =>
        LeaseKeySchema.parse(decoded),
      )
    : undefined;

  // 1. Resolve user's group memberships.
  const userGroupIds = await getGroupMemberships(userId, services);
  const userGroupSet = new Set(userGroupIds);

  // 2. Single Scan on the sparse GroupIndex GSI returns all
  //    (groupId, leaseId) pairs table-wide.
  const allKeys = await principalStore.getAllGroupAssignmentKeys();

  // 3. Filter in memory to keys for groups the user belongs to.
  const matchingKeys = allKeys.filter((k) => userGroupSet.has(k.groupId));

  // 4. Single BatchGetItem hydrates the matching assignment records.
  //    Empty input is short-circuited by the store.
  const allGroupAssignments = await principalStore.batchGetGroupAssignments(
    matchingKeys.map(({ groupId, sk }) => ({ groupId, sk })),
  );

  // 5. Sort by groupId so that cross-group duplicates resolve
  //    deterministically (alphabetically first group wins).
  allGroupAssignments.sort((a, b) => {
    if (a.groupId === b.groupId) return 0;
    return a.groupId < b.groupId ? -1 : 1;
  });
  const dedupedByLease = new Map<string, GroupSharedLeaseEntry>();
  for (const a of allGroupAssignments) {
    const key: LeaseKey = { userEmail: a.leaseOwnerEmail, uuid: a.leaseId };
    const mapKey = JSON.stringify([key.userEmail, key.uuid]);
    if (!dedupedByLease.has(mapKey)) {
      dedupedByLease.set(mapKey, { key, displayName: a.displayName });
    }
  }

  // 6. Stable order for pagination.
  const entries = Array.from(dedupedByLease.values()).sort((a, b) =>
    compareLeaseKeys(a.key, b.key),
  );

  logger.debug("Group-based shared leases discovery", {
    userId,
    userGroupCount: userGroupIds.length,
    rawAssignmentCount: allGroupAssignments.length,
    dedupedLeaseCount: entries.length,
  });

  // 7. Apply in-memory pagination. The cursor is "strictly greater than"
  //    semantics: if the cursor lease has been deleted between pages, we
  //    advance to the next entry in sort order rather than restarting.
  const startIndex = resolveGroupSharedLeasePageStart(entries, lastKey);
  const pageEntries = entries.slice(startIndex, startIndex + pageSize);
  const nextStartIndex = startIndex + pageEntries.length;
  const lastPagedEntry = pageEntries.at(-1);
  const nextPageIdentifier =
    nextStartIndex < entries.length && lastPagedEntry !== undefined
      ? base64EncodeCompositeKey(lastPagedEntry.key)
      : null;

  // 8. BatchGet lease details for the current page only. Empty input is
  //    short-circuited by the helper.
  const sharedLeases = await fetchAndShapeSharedLeases(
    pageEntries.map((e) => ({
      key: e.key,
      accessType: "group" as const,
      sourceGroupName: e.displayName,
    })),
    leaseStore,
    logger,
  );

  return { result: sharedLeases, nextPageIdentifier };
}

interface SharedLeaseInput {
  key: LeaseKey;
  accessType: SharedLeaseAccessType;
  sourceGroupName?: string;
}

async function fetchAndShapeSharedLeases(
  inputs: SharedLeaseInput[],
  leaseStore: GetLeasesForUserDirectServices["leaseStore"],
  logger: GetLeasesForUserDirectServices["logger"],
): Promise<SharedLease[]> {
  if (inputs.length === 0) return [];

  const leases = await leaseStore.batchGet(inputs.map((i) => i.key));
  const leasesByKey = new Map(
    leases.map((l) => [JSON.stringify([l.userEmail, l.uuid]), l] as const),
  );

  const result: SharedLease[] = [];
  for (const input of inputs) {
    const lease = leasesByKey.get(
      JSON.stringify([input.key.userEmail, input.key.uuid]),
    );
    if (!lease) {
      logger.warn("Shared lease assignment refers to a missing lease record", {
        uuid: input.key.uuid,
        accessType: input.accessType,
      });
      continue;
    }
    result.push({
      ...lease,
      accessType: input.accessType,
      ...(input.sourceGroupName === undefined
        ? {}
        : { sourceGroupName: input.sourceGroupName }),
    });
  }
  return result;
}

function compareLeaseKeys(a: LeaseKey, b: LeaseKey): number {
  if (a.userEmail !== b.userEmail) {
    return a.userEmail < b.userEmail ? -1 : 1;
  }
  if (a.uuid === b.uuid) return 0;
  return a.uuid < b.uuid ? -1 : 1;
}

/**
 * Index of the first entry strictly after `lastKey`, or `entries.length`
 * if none. Strictly-greater-than semantics keeps pagination correct even
 * when the cursor lease has been deleted between pages.
 */
function resolveGroupSharedLeasePageStart(
  entries: GroupSharedLeaseEntry[],
  lastKey: LeaseKey | undefined,
): number {
  if (!lastKey) return 0;
  const firstAfterCursor = entries.findIndex(
    (e) => compareLeaseKeys(e.key, lastKey) > 0,
  );
  return firstAfterCursor === -1 ? entries.length : firstAfterCursor;
}

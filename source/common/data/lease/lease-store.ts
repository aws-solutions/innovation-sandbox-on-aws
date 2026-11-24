// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  OptionalItem,
  PaginatedQueryResult,
  PutResult,
  SingleItemResult,
} from "@amzn/innovation-sandbox-commons/data/common-types.js";
import {
  PersistedLease,
  PersistedMonitoredLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import {
  DesiredAssignmentWithDisplay,
  ExpiredLeaseStatus,
  LeaseKey,
  type LeaseLifecycleDispatch,
  type LeaseLockMeta,
  type LeaseResourceLock,
  LeaseStatus,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-shared/types/lease.js";

export interface LeaseAcquireLockProps {
  leaseId: string;
  userEmail: string;
  ownerId: string;
  timeoutSeconds: number;
  meta?: LeaseLockMeta;
}

const LeaseAssignmentWriteSnapshotFields = [
  "status",
  "defaultPermissionSetArn",
  "allowedPermissionSetArns",
  "allowOwnerToShareLease",
  "desiredAssignments",
] as const;

export type LeaseAssignmentWriteSnapshot = Pick<
  PersistedLease,
  (typeof LeaseAssignmentWriteSnapshotFields)[number]
>;

/** Preserve undefined fields so conditional writes check their absence. */
export function getLeaseAssignmentWriteSnapshot(
  lease: LeaseAssignmentWriteSnapshot,
): LeaseAssignmentWriteSnapshot {
  return Object.fromEntries(
    LeaseAssignmentWriteSnapshotFields.map((field) => [field, lease[field]]),
  ) as LeaseAssignmentWriteSnapshot;
}

export interface LeaseAcquireLockWithDesiredAssignmentsProps extends LeaseAcquireLockProps {
  desiredAssignments: DesiredAssignmentWithDisplay[];
  /** Snapshot against which the API authorized and validated this write. */
  expectedLease?: LeaseAssignmentWriteSnapshot;
}

export interface LeaseReleaseLockProps {
  leaseId: string;
  userEmail: string;
  ownerId: string;
}

// Scoped writes bypass the whole-item schema validation, so each validates the
// fields it sets against the same lease schema before they reach the table.
// The de-duplication fields are optional on the lease because older rows lack
// them; a write must still supply them, hence required(). Each props type
// below is derived from its schema, so the two cannot drift apart.
export const TokenPollOwnedFieldsSchema = PersistedMonitoredLeaseSchema.pick({
  lastEvaluatedSpend: true,
  lastPredictedSpend: true,
  lastEvaluatedHourlySpendRate: true,
  lastEvaluatedDailySpendRate: true,
}).required();

export const MonitoringCostFieldsSchema = PersistedMonitoredLeaseSchema.pick({
  totalCostAccrued: true,
  lastCheckedDate: true,
});

// Lease Monitoring always has a figure to compare against next run, so unlike
// the token poll it never writes a null lastEvaluatedSpend.
export const MonitoringOwnedFieldsSchema = MonitoringCostFieldsSchema.extend({
  lastEvaluatedSpend: z.number(),
});

export const MonitoringProjectionFieldsSchema =
  PersistedMonitoredLeaseSchema.pick({
    lastPredictedSpend: true,
    lastEvaluatedHourlySpendRate: true,
    lastEvaluatedDailySpendRate: true,
  }).required();

interface LeaseFieldsKey {
  leaseId: string;
  userEmail: string;
}

export type LeaseUpdateTokenPollOwnedFieldsProps = LeaseFieldsKey &
  z.infer<typeof TokenPollOwnedFieldsSchema>;

export type LeaseUpdateMonitoringCostFieldsProps = LeaseFieldsKey &
  z.infer<typeof MonitoringCostFieldsSchema>;

export type LeaseUpdateMonitoringOwnedFieldsProps = LeaseFieldsKey &
  z.infer<typeof MonitoringOwnedFieldsSchema> & {
    /** Set only when the run projected; when omitted the stored rates are kept. */
    projection?: z.infer<typeof MonitoringProjectionFieldsSchema>;
  };

export interface LeaseRecordLifecycleDispatchProps {
  leaseId: string;
  userEmail: string;
  intent: LeaseLifecycleDispatch["intent"];
}

export abstract class LeaseStore {
  /**
   * Acquires a resource lock on a lease. Succeeds if:
   * - No lock exists
   * - The existing lock is owned by the same ownerId (idempotent re-acquire)
   * - The existing lock has expired
   * - The intent is critical (TERMINATE/FREEZE) and the existing lock is non-critical
   *
   * @throws {ResourceLockConflictError} if the lock is held by another owner and cannot be overridden
   */
  abstract acquireLock(
    props: LeaseAcquireLockProps,
  ): Promise<LeaseResourceLock>;

  /**
   * Atomically acquires a resource lock AND writes desiredAssignments on the lease record
   * in a single DynamoDB conditional write. This is the declarative model entry point:
   * the API persists intent (desired state + lock) atomically, then emits an event.
   *
   * Same lock acquisition semantics as acquireLock. When expectedLease is
   * supplied, atomically checks the validated profile/lifecycle/sharing state
   * and desired assignments, independently of unrelated monitoring metadata.
   *
   * @throws {ConcurrentDataModificationException} if validated state changed
   * @throws {ResourceLockConflictError} if another operation blocks the lock
   * @throws {UnknownItem} if the lease was deleted before a guarded write
   */
  abstract acquireLockWithDesiredAssignments(
    props: LeaseAcquireLockWithDesiredAssignmentsProps,
  ): Promise<LeaseResourceLock>;

  /**
   * Releases a resource lock on a lease. Succeeds if:
   * - The lease exists and no lock is held (idempotent)
   * - The lease exists and the lock is owned by the given ownerId
   * - The lock is held by a different owner (e.g., critical override took ownership)
   * - The lease does not exist
   *
   * This makes releaseLock safe for defensive cleanup in catch blocks and
   * overridden Step Functions whose lock was taken by a critical operation.
   */
  abstract releaseLock(props: LeaseReleaseLockProps): Promise<void>;

  /**
   * Writes only the cost scalars the Bedrock token poll owns, plus meta.lastEditTime,
   * leaving every other attribute untouched.
   *
   * On a lease with Bedrock token monitoring enabled the poll and Lease Monitoring write
   * the same record on different schedules. The whole-item `update` would carry a stale
   * copy of the other writer's fields and revert them, so each writer sets only the
   * attributes it owns and the two sets stay disjoint.
   *
   * @throws {UnknownItem} if the lease does not exist
   * @throws {ZodError} if a scalar does not satisfy the lease schema
   */
  abstract updateTokenPollOwnedFields(
    props: LeaseUpdateTokenPollOwnedFieldsProps,
  ): Promise<void>;

  /**
   * Writes only the cost scalars Lease Monitoring owns, plus meta.lastEditTime, leaving
   * the poll-owned scalars untouched. Intended for leases with Bedrock token monitoring
   * enabled; where it is off use `updateMonitoringOwnedFields`.
   *
   * @throws {UnknownItem} if the lease does not exist
   * @throws {ZodError} if a scalar does not satisfy the lease schema
   */
  abstract updateMonitoringCostFields(
    props: LeaseUpdateMonitoringCostFieldsProps,
  ): Promise<void>;

  /**
   * Writes the cost scalars and de-duplication scalars Lease Monitoring owns on a lease
   * with Bedrock token monitoring off, plus meta.lastEditTime, leaving every other
   * attribute untouched.
   *
   * Lease Monitoring writes each lease from a copy read at scan start. A whole-item
   * `update` would revert a freeze, termination, lock or admin edit committed since
   * that read, so it sets only the attributes it owns.
   *
   * @throws {UnknownItem} if the lease does not exist
   * @throws {ZodError} if a scalar does not satisfy the lease schema
   */
  abstract updateMonitoringOwnedFields(
    props: LeaseUpdateMonitoringOwnedFieldsProps,
  ): Promise<void>;

  /**
   * Marks a terminate or freeze as finished: an attribute-scoped write, so it
   * never overwrites the resource lock or other fields written meanwhile.
   *
   * @throws {UnknownItem} if the lease does not exist
   */
  abstract recordLifecycleDispatch(
    props: LeaseRecordLifecycleDispatchProps,
  ): Promise<void>;

  abstract create<T extends PersistedLease>(lease: T): Promise<T>;

  abstract update<T extends PersistedLease>(
    lease: T,
    expected?: T, //fail the update if the lease has been modified from the expected (uses lastEdit meta)
  ): Promise<PutResult<T>>;

  transactionalUpdate<T extends PersistedLease>(
    lease: T,
  ): Transaction<PutResult<T>> {
    return new Transaction({
      beginTransaction: async () => {
        return this.update(lease);
      },
      rollbackTransaction: async (putResult) => {
        await this.update(
          putResult.oldItem as PersistedLease,
          putResult.newItem,
        );
      },
    });
  }

  abstract delete(key: LeaseKey): Promise<OptionalItem>;

  abstract get(
    key: LeaseKey,
    options?: { consistentRead?: boolean },
  ): Promise<SingleItemResult<PersistedLease>>;

  abstract batchGet(keys: LeaseKey[]): Promise<PersistedLease[]>;

  abstract findAll(props: {
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>>;

  abstract findByUserEmail(props: {
    userEmail: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>>;

  abstract findByLeaseTemplateUuid(props: {
    status: LeaseStatus;
    uuid: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>>;

  abstract findByStatus(props: {
    status: LeaseStatus;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>>;

  abstract findByStatusAndAccountID(props: {
    status: MonitoredLeaseStatus | ExpiredLeaseStatus;
    awsAccountId: string;
    pageIdentifier?: string;
    pageSize?: number;
  }): Promise<PaginatedQueryResult<PersistedLease>>;
}

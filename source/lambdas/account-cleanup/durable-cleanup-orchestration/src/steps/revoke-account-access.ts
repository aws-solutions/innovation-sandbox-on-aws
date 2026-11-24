// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  now,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import { updateCleanupStatus } from "../utils/update-cleanup-status.js";
import { cleanupAccountAccess } from "./cleanup-account-access.js";
import { hasPendingAccountGrants } from "./pending-account-grants.js";
import { CleanupStepError, runStep } from "./run-step.js";
import type { CleanupContext } from "./types.js";

// Lease-lock polling uses bounded exponential backoff before falling through
// to the authoritative sweep.
const MAX_LEASE_LOCK_POLL_ATTEMPTS = 20;
const LEASE_LOCK_INITIAL_DELAY_SECONDS = 5;
const LEASE_LOCK_MAX_DELAY_SECONDS = 60;
const GRANT_POLL_INTERVAL_SECONDS = 15;
const MAX_GRANT_POLL_ATTEMPTS = 20;

interface LeaseLockPollState {
  cleared: boolean;
  reason?: string;
}

/**
 * Validates that assignment cleanup has completed by polling the lease
 * resourceLock until it is released. Reported as a single
 * "revoke-access" step in the cleanup report.
 *
 * The assignment revocation Step Function (fired immediately by terminateLease)
 * releases the lease's resourceLock in HANDLE_COMPLETION. This step polls
 * for that release using `waitForCondition` with exponential backoff — no
 * cross-component coupling, no callback coordination, no shared state.
 *
 * Conditions that resolve immediately (first poll):
 *  - Account has no currentLease (pre-v1.3.0 records)
 *  - Lease has no resourceLock (Step Function already completed)
 *  - Lease resourceLock is expired (orphaned from a crashed Step Function)
 *
 * On max attempts reached, the step proceeds (does NOT quarantine) — the
 * authoritative sweep (cleanupAccountAccess) is the backstop.
 *
 * After the lease lock poll, wait for reported pending IDC creations on the
 * account before taking the sweep's assignment snapshot. Pending creations
 * that exceed the bounded wait, status lookup errors, and sweep failures
 * quarantine the account.
 */
export async function revokeAccess(ctx: CleanupContext): Promise<void> {
  const {
    durableContext,
    accountStore,
    accountId,
    executionArn,
    cleanupReason,
    reportWriter,
    reportKey,
    env,
  } = ctx;

  // Append the report step and set status (runs on first invocation, idempotent on replay)
  await runStep(
    ctx,
    "revoke-access",
    async () => {
      await reportWriter.appendStep(reportKey, "revoke-access");
      await updateCleanupStatus(ctx, "REVOKING_ACCESS");
    },
    { skipReport: true },
  );

  // Poll until the lease lock is released (or max attempts / immediate resolution)
  const accountResult = await accountStore.get(accountId);
  const currentLease = accountResult.result?.currentLease;

  if (currentLease) {
    await durableContext
      .waitForCondition<LeaseLockPollState>(
        "wait-for-lease-lock-release",
        async (state) => {
          // Renew our account lock each iteration. This poll can run for many
          // minutes; without renewal the 300s account lock would expire
          // mid-poll and a concurrent retry could steal it. Re-acquiring with
          // the same ownerId refreshes the TTL.
          await accountStore.acquireLock(accountId, executionArn, 300, {
            step: "revoke-access",
            reason: cleanupReason,
          });

          const leaseResult = await IsbServices.leaseStore(env).get(
            {
              userEmail: currentLease.ownerEmail,
              uuid: currentLease.leaseId,
            },
            { consistentRead: true },
          );
          const leaseLock = leaseResult.result?.resourceLock;

          if (!leaseLock) {
            return { cleared: true, reason: "lock_released" };
          }
          if (parseDatetime(leaseLock.expiresAt) < now()) {
            return { cleared: true, reason: "lock_expired" };
          }
          return state;
        },
        {
          initialState: { cleared: false },
          // Exponential backoff capped at LEASE_LOCK_MAX_DELAY_SECONDS.
          // Total backoff is ~17 minutes (exceeds 15-min lock TTL).
          waitStrategy: (state, attempt) => {
            if (state.cleared) {
              return { shouldContinue: false };
            }
            if (attempt >= MAX_LEASE_LOCK_POLL_ATTEMPTS) {
              return { shouldContinue: false };
            }
            const delay = Math.min(
              LEASE_LOCK_INITIAL_DELAY_SECONDS * Math.pow(2, attempt),
              LEASE_LOCK_MAX_DELAY_SECONDS,
            );
            return { shouldContinue: true, delay: { seconds: delay } };
          },
        },
      )
      .then((finalState) => {
        if (finalState.cleared) {
          durableContext.logger.info(
            "Assignment processing confirmed complete",
            { accountId, reason: finalState.reason },
          );
        } else {
          durableContext.logger.warn(
            "Max poll attempts reached waiting for lease lock release; proceeding to sweep",
            { accountId },
          );
        }
      });
  } else {
    durableContext.logger.info(
      "No currentLease on account; skipping lease lock poll",
      { accountId },
    );
  }

  // A worker's successful callback only means IDC accepted its request. Wait
  // for accepted creations to finish before taking the assignment snapshot.
  // Use durable polling so the wait survives replay and Lambda timeouts.
  try {
    const pending = await durableContext.waitForCondition<boolean>(
      "wait-for-pending-idc-grants",
      async () => {
        await accountStore.acquireLock(accountId, executionArn, 300, {
          step: "revoke-access",
          reason: cleanupReason,
        });
        return hasPendingAccountGrants(ctx);
      },
      {
        initialState: true,
        waitStrategy: (pending, attempt) => ({
          shouldContinue: pending && attempt < MAX_GRANT_POLL_ATTEMPTS,
          delay: { seconds: GRANT_POLL_INTERVAL_SECONDS },
        }),
      },
    );
    if (pending) {
      throw new Error(
        `IDC account assignment creations are still pending for account ${accountId}`,
      );
    }
  } catch (error) {
    throw new CleanupStepError("revoke-access", error);
  }

  // Authoritative sweep: revoke assignments after accepted grants have settled.
  // Part of the same report step (skipReport). Quarantines on failure.
  await runStep(ctx, "revoke-access-sweep", () => cleanupAccountAccess(ctx), {
    skipReport: true,
  });
}

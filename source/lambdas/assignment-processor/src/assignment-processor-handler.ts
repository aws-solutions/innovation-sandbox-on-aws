// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { z } from "zod";

import type {
  PersistedGroupAssignment,
  PersistedUserAssignment,
} from "@amzn/innovation-sandbox-commons/data/principal/principal.js";
import { AssignmentCreatedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-created-event.js";
import { AssignmentRemovedEvent } from "@amzn/innovation-sandbox-commons/events/assignment-removed-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AssignmentProcessorEnvironment,
  AssignmentProcessorEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-processor-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  addCorrelationContext,
  searchableAssignmentProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import {
  CriticalLockIntents,
  DesiredAssignmentWithDisplay,
  LeaseLockIntentSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  PrincipalTypeSchema,
  type PrincipalType,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

const serviceName = "AssignmentProcessor";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

const FannedOutPrincipalSchema = z.object({
  principalId: z.string(),
  principalType: PrincipalTypeSchema,
});

const FannedOutTupleSchema = FannedOutPrincipalSchema.extend({
  permissionSetArn: z.string(),
});

const FanOutInputSchema = z.object({
  action: z.literal("FAN_OUT"),
  leaseId: z.string(),
  intent: LeaseLockIntentSchema,
  lockOwnerId: z.string(),
  leaseOwnerEmail: z.email(),
  requestedBy: z.email(),
  executionArn: z.string(),
});

const HandleCompletionInputSchema = z.object({
  action: z.literal("HANDLE_COMPLETION"),
  leaseId: z.string(),
  intent: LeaseLockIntentSchema,
  lockOwnerId: z.string(),
  leaseOwnerEmail: z.email(),
  requestedBy: z.email(),
  accountId: AwsAccountIdSchema,
  executionArn: z.string(),
  fannedOutPrincipals: z.array(FannedOutTupleSchema).optional(),
  preExistingPrincipals: z.array(FannedOutPrincipalSchema).optional(),
});

const AssignmentProcessorInputSchema = z.discriminatedUnion("action", [
  FanOutInputSchema,
  HandleCompletionInputSchema,
]);

type ProcessorContext = IsbLambdaContext<AssignmentProcessorEnvironment>;

type PrincipalIdentity = {
  principalId: string;
  principalType: PrincipalType;
};

type AssignmentTuple = PrincipalIdentity & {
  permissionSetArn: string;
};

function principalKey(principal: PrincipalIdentity): string {
  return `${principal.principalType}|${principal.principalId}`;
}

function tupleKey(
  principal: PrincipalIdentity,
  permissionSetArn: string,
): string {
  return `${principalKey(principal)}|${permissionSetArn}`;
}

function principalFromRecord(
  record: PersistedUserAssignment | PersistedGroupAssignment,
): PrincipalIdentity {
  return {
    principalId:
      record.principalType === "USER" ? record.userId : record.groupId,
    principalType: record.principalType,
  };
}

function uniquePrincipals<T extends PrincipalIdentity>(
  principals: readonly T[],
): T[] {
  return [...new Map(principals.map((p) => [principalKey(p), p])).values()];
}

function uniqueTuples<T extends AssignmentTuple>(tuples: readonly T[]): T[] {
  return [
    ...new Map(
      tuples.map((tuple) => [tupleKey(tuple, tuple.permissionSetArn), tuple]),
    ).values(),
  ];
}

/**
 * A single (principal, permission set) tuple emitted by FAN_OUT for the Step
 * Function Map state.
 *
 * The permission set ARN is concrete, while unknown display values use the
 * empty string because JSON serialization drops `undefined`, which would make
 * the Step Function ItemSelector fail with States.Runtime.
 */
type FanOutWorkItem = Omit<
  DesiredAssignmentWithDisplay,
  "displayName" | "email"
> & {
  displayName: string;
  email: string;
  permissionSetArn: string;
};

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AssignmentProcessorEnvironmentSchema,
  moduleName: "assignment-processor",
}).handler(handleAssignmentProcessor);

/**
 * Assignment Processor Lambda — invoked by the Assignment Processor Step Function.
 *
 * Actions:
 * - FAN_OUT: Read desiredAssignments from the lease record and current assignment records
 *   from the Principal Table (LeaseIndex GSI). Union all unique principal-permission-set
 *   tuples and return them for the Map state to fan out. No diff computation, no action
 *   determination — workers decide GRANT/REVOKE/NO-OP at execution time via JIT diff.
 * - HANDLE_COMPLETION: Publish AssignmentCreated/AssignmentRemoved events based on
 *   pre/post state comparison, emit OrphanedAccessDetected metric when TERMINATE intent
 *   has lingering records, then clear resourceLock on the lease record.
 *
 * Worker-exhausted assignments (after SQS maxReceiveCount) land in the DLQ for alarming
 * and manual investigation. The Step Function Map branch is unblocked either by the
 * worker calling SendTaskFailure on its last attempt or by the SendAssignmentToSQS
 * heartbeat timeout — the processor does not drain the DLQ.
 */
async function handleAssignmentProcessor(
  event: unknown,
  context: ProcessorContext,
) {
  const validatedEvent = AssignmentProcessorInputSchema.parse(event);

  switch (validatedEvent.action) {
    case "FAN_OUT":
      return handleFanOut(validatedEvent, context);
    case "HANDLE_COMPLETION":
      return handleCompletion(validatedEvent, context);
    default:
      assertNever(validatedEvent);
  }
}

async function handleFanOut(
  input: z.infer<typeof FanOutInputSchema>,
  context: ProcessorContext,
): Promise<{
  workItems: FanOutWorkItem[];
  accountId: string;
  preExistingPrincipals: PrincipalIdentity[];
}> {
  const { env } = context;
  const leaseStore = IsbServices.leaseStore(env);
  const principalStore = IsbServices.principalStore(env);
  const idcStackConfigStore = IsbServices.idcStackConfigStore(env);

  addCorrelationContext(
    logger,
    searchableAssignmentProperties({
      leaseId: input.leaseId,
      intent: input.intent,
    }),
  );

  logger.info("Processing FAN_OUT", {
    executionArn: input.executionArn,
  });

  const leaseResult = await leaseStore.get({
    userEmail: input.leaseOwnerEmail,
    uuid: input.leaseId,
  });

  if (!leaseResult.result) {
    throw new Error(
      `Lease not found during FAN_OUT: ${input.leaseId} (owner: ${input.leaseOwnerEmail})`,
    );
  }

  const lease = leaseResult.result;
  const desiredAssignments = lease.desiredAssignments ?? [];

  const accountId = "awsAccountId" in lease ? lease.awsAccountId : undefined;
  if (!accountId) {
    throw new Error(
      `Lease ${input.leaseId} has no awsAccountId — cannot process assignments`,
    );
  }

  const currentRecords = await principalStore.getAssignmentsForLease({
    leaseId: input.leaseId,
  });

  const { workItems, preExistingPrincipals } = await buildWorkItems(
    desiredAssignments,
    currentRecords.result,
    idcStackConfigStore,
    lease.defaultPermissionSetArn,
  );

  logger.info("FAN_OUT complete", {
    desiredCount: desiredAssignments.length,
    currentRecordCount: currentRecords.result.length,
    workItemCount: workItems.length,
  });

  return { workItems, accountId, preExistingPrincipals };
}

async function handleCompletion(
  input: z.infer<typeof HandleCompletionInputSchema>,
  context: ProcessorContext,
): Promise<{ status: string; eventsPublished: number }> {
  const { env } = context;
  const leaseStore = IsbServices.leaseStore(env);
  const principalStore = IsbServices.principalStore(env);
  const eventBridgeClient = IsbServices.isbEventBridge(env);
  const idcStackConfigStore = IsbServices.idcStackConfigStore(env);

  addCorrelationContext(
    logger,
    searchableAssignmentProperties({
      leaseId: input.leaseId,
      intent: input.intent,
      accountId: input.accountId,
    }),
  );

  logger.info("Processing HANDLE_COMPLETION", {
    executionArn: input.executionArn,
    lockOwnerId: input.lockOwnerId,
  });

  try {
    // Read lease to get desiredAssignments
    const leaseResult = await leaseStore.get({
      userEmail: input.leaseOwnerEmail,
      uuid: input.leaseId,
    });

    const desiredAssignments = leaseResult.result?.desiredAssignments ?? [];
    // For critical intents (TERMINATE/FREEZE), desired state is effectively empty —
    // all access should be revoked regardless of what desiredAssignments contains.
    // This mirrors the worker's JIT diff behavior (shouldPrincipalHaveAccess returns
    // false for critical intents) and prevents stale desiredAssignments from poisoning
    // the completion metric (which would otherwise classify successful revocations as
    // "failed grants" because principals remain in stale desiredAssignments).
    const isCriticalIntent = (
      CriticalLockIntents as readonly string[]
    ).includes(input.intent);
    const desiredPrincipalKeys = new Set(
      isCriticalIntent ? [] : desiredAssignments.map(principalKey),
    );

    // Read current assignment records (post-processing state)
    const currentRecords = await principalStore.getAssignmentsForLease({
      leaseId: input.leaseId,
    });

    const currentPrincipalKeys = new Set(
      currentRecords.result.map((record) =>
        principalKey(principalFromRecord(record)),
      ),
    );

    // Derive events: only emit for principals that were actually processed in this execution
    const fannedOutPrincipals = uniquePrincipals(
      input.fannedOutPrincipals ?? [],
    );
    const fannedOutKeys = new Set(fannedOutPrincipals.map(principalKey));
    const preExistingKeys = new Set(
      (input.preExistingPrincipals ?? []).map(principalKey),
    );

    // AssignmentCreated: was fanned out, is in desired, has a record, AND was NOT pre-existing
    const createdEvents = [
      ...new Map(
        currentRecords.result.map((record) => [
          principalKey(principalFromRecord(record)),
          record,
        ]),
      ).values(),
    ]
      .filter((record) => {
        const principal = principalFromRecord(record);
        return (
          fannedOutKeys.has(principalKey(principal)) &&
          desiredPrincipalKeys.has(principalKey(principal)) &&
          !preExistingKeys.has(principalKey(principal))
        );
      })
      .map((record) => {
        const { principalId } = principalFromRecord(record);
        return new AssignmentCreatedEvent({
          leaseId: input.leaseId,
          principalId,
          principalType: record.principalType,
          assigneeEmail:
            record.principalType === "USER" ? record.assigneeEmail : undefined,
          accountId: input.accountId,
          addedBy: input.requestedBy,
          leaseOwner: input.leaseOwnerEmail,
        });
      });

    // AssignmentRemoved: was fanned out, NOT in desired, AND no longer has a record (confirmed revoke)
    const removedEvents = fannedOutPrincipals
      .filter(
        (p) =>
          preExistingKeys.has(principalKey(p)) &&
          !currentPrincipalKeys.has(principalKey(p)) &&
          !desiredPrincipalKeys.has(principalKey(p)),
      )
      .map(
        (p) =>
          new AssignmentRemovedEvent({
            leaseId: input.leaseId,
            principalId: p.principalId,
            principalType: p.principalType,
            accountId: input.accountId,
            removedBy: input.requestedBy,
            leaseOwner: input.leaseOwnerEmail,
          }),
      );

    const events = [...createdEvents, ...removedEvents];

    // Publish events
    if (events.length > 0) {
      await eventBridgeClient.sendIsbEvents(tracer, ...events);
      logger.info("Completion events published", {
        created: createdEvents.length,
        removed: removedEvents.length,
      });
    } else {
      logger.info("No completion events to publish (no state changes)");
    }

    await emitCompletionMetrics({
      input,
      desiredAssignments: isCriticalIntent ? [] : desiredAssignments,
      currentRecords: currentRecords.result,
      leaseDefaultPermissionSetArn: leaseResult.result?.defaultPermissionSetArn,
      idcStackConfigStore,
    });

    return { status: "SUCCESS", eventsPublished: events.length };
  } finally {
    // Always release lock — even if event publishing or DAO operations above throw.
    // releaseLock failure is non-fatal; the lease self-heals via the lock TTL.
    await leaseStore
      .releaseLock({
        leaseId: input.leaseId,
        userEmail: input.leaseOwnerEmail,
        ownerId: input.lockOwnerId,
      })
      .then(() => {
        logger.info("Resource lock cleared", {
          lockOwnerId: input.lockOwnerId,
        });
      })
      .catch((error: unknown) => {
        logger.error("Failed to clear resource lock (non-fatal)", {
          lockOwnerId: input.lockOwnerId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }
}

/**
 * Maps a current assignment record to an enriched work item, resolving the
 * USER/GROUP-specific principal id and denormalized display fields.
 */
function recordToWorkItem(
  record: PersistedUserAssignment | PersistedGroupAssignment,
  permissionSetArn: string,
): FanOutWorkItem {
  const { principalId } = principalFromRecord(record);
  return {
    principalId,
    principalType: record.principalType,
    displayName:
      record.principalType === "USER"
        ? (record.displayName ?? record.assigneeEmail)
        : record.displayName,
    email: record.principalType === "USER" ? record.assigneeEmail : "",
    permissionSetArn,
  };
}

async function resolveEffectivePermissionSetArns(
  desiredAssignments: DesiredAssignmentWithDisplay[],
  currentRecords: Array<PersistedUserAssignment | PersistedGroupAssignment>,
  leaseDefaultPermissionSetArn: string | undefined,
  idcStackConfigStore: {
    get: () => Promise<{ userPermissionSetArn: string }>;
  },
): Promise<{
  desiredDefaultPermissionSetArn?: string;
  builtInPermissionSetArn?: string;
}> {
  const needsBuiltInPermissionSetArn =
    currentRecords.some((record) => record.permissionSetArn === undefined) ||
    (leaseDefaultPermissionSetArn === undefined &&
      desiredAssignments.some(
        (assignment) => assignment.permissionSetArn === undefined,
      ));

  if (!needsBuiltInPermissionSetArn) {
    return {
      desiredDefaultPermissionSetArn: leaseDefaultPermissionSetArn,
    };
  }

  const builtInPermissionSetArn = (await idcStackConfigStore.get())
    .userPermissionSetArn;
  return {
    desiredDefaultPermissionSetArn:
      leaseDefaultPermissionSetArn ?? builtInPermissionSetArn,
    builtInPermissionSetArn,
  };
}

/**
 * Unions desired + current assignment tuples into enriched work items for the
 * Map state. Desired is iterated first so its display values win for an
 * identical tuple.
 */
async function buildWorkItems(
  desiredAssignments: DesiredAssignmentWithDisplay[],
  currentRecords: Array<PersistedUserAssignment | PersistedGroupAssignment>,
  idcStackConfigStore: { get: () => Promise<{ userPermissionSetArn: string }> },
  leaseDefaultPermissionSetArn?: string,
): Promise<{
  workItems: FanOutWorkItem[];
  preExistingPrincipals: PrincipalIdentity[];
}> {
  if (desiredAssignments.length === 0 && currentRecords.length === 0) {
    return {
      workItems: [],
      preExistingPrincipals: [],
    };
  }

  const { desiredDefaultPermissionSetArn, builtInPermissionSetArn } =
    await resolveEffectivePermissionSetArns(
      desiredAssignments,
      currentRecords,
      leaseDefaultPermissionSetArn,
      idcStackConfigStore,
    );

  const workItemMap = new Map<string, FanOutWorkItem>();

  for (const desired of desiredAssignments) {
    const permissionSetArn =
      desired.permissionSetArn ?? desiredDefaultPermissionSetArn!;
    const key = tupleKey(desired, permissionSetArn);
    if (!workItemMap.has(key)) {
      workItemMap.set(key, {
        principalId: desired.principalId,
        principalType: desired.principalType,
        displayName: desired.displayName ?? "",
        email: desired.email ?? "",
        permissionSetArn,
      });
    }
  }

  for (const record of currentRecords) {
    const permissionSetArn =
      record.permissionSetArn ?? builtInPermissionSetArn!;
    const workItem = recordToWorkItem(record, permissionSetArn);
    const key = tupleKey(workItem, permissionSetArn);
    if (!workItemMap.has(key)) {
      workItemMap.set(key, workItem);
    }
  }

  const workItems = Array.from(workItemMap.values());
  const preExistingPrincipals = uniquePrincipals(
    currentRecords.map(principalFromRecord),
  );

  return { workItems, preExistingPrincipals };
}

/**
 * Emits completion metrics for the assignment execution. Called once per
 * Step Function run from HANDLE_COMPLETION.
 */
async function emitCompletionMetrics(props: {
  input: z.infer<typeof HandleCompletionInputSchema>;
  desiredAssignments: DesiredAssignmentWithDisplay[];
  currentRecords: Array<PersistedUserAssignment | PersistedGroupAssignment>;
  leaseDefaultPermissionSetArn?: string;
  idcStackConfigStore: {
    get: () => Promise<{ userPermissionSetArn: string }>;
  };
}): Promise<void> {
  const {
    input,
    desiredAssignments,
    currentRecords,
    leaseDefaultPermissionSetArn,
    idcStackConfigStore,
  } = props;
  const fannedOutTuples = uniqueTuples(input.fannedOutPrincipals ?? []);
  const fannedOutPrincipals = uniquePrincipals(fannedOutTuples);
  const principalsProcessed = fannedOutPrincipals.length;

  if (principalsProcessed === 0) {
    return;
  }

  try {
    const { desiredDefaultPermissionSetArn, builtInPermissionSetArn } =
      await resolveEffectivePermissionSetArns(
        desiredAssignments,
        currentRecords,
        leaseDefaultPermissionSetArn,
        idcStackConfigStore,
      );
    const desiredTupleKeys = new Set(
      desiredAssignments.map((desired) =>
        tupleKey(
          desired,
          desired.permissionSetArn ?? desiredDefaultPermissionSetArn!,
        ),
      ),
    );
    const currentTupleKeys = new Set(
      currentRecords.map((record) =>
        tupleKey(
          principalFromRecord(record),
          record.permissionSetArn ?? builtInPermissionSetArn!,
        ),
      ),
    );
    const failedPrincipalKeys = new Set<string>();

    for (const tuple of fannedOutTuples) {
      const key = tupleKey(tuple, tuple.permissionSetArn);
      if (desiredTupleKeys.has(key) !== currentTupleKeys.has(key)) {
        failedPrincipalKeys.add(principalKey(tuple));
      }
    }

    const failed = failedPrincipalKeys.size;
    logger.info("Assignment execution completed", {
      logDetailType: "AssignmentExecutionCompleted",
      leaseId: input.leaseId,
      accountId: input.accountId,
      intent: input.intent,
      principalsProcessed,
      succeeded: principalsProcessed - failed,
      failed,
    } satisfies SubscribableLog);
  } catch (error: unknown) {
    // Completion events and lock release must not fail because an operational
    // metric could not be calculated.
    logger.error("Failed to calculate tuple-aware completion metrics", {
      executionArn: input.executionArn,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

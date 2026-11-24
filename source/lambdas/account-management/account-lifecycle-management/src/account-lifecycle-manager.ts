// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SQSEvent } from "aws-lambda";

import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import { PersistedLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountCleanupSuccessfulEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-successful-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { BlueprintDeploymentFailedEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-failed-event.js";
import { BlueprintDeploymentSucceededEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-succeeded-event.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseFrozenReasonInput } from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  AccountLifecycleManagementEnvironment,
  AccountLifecycleManagementEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/account-lifecycle-management-lambda-environment.js";
import baseMiddlewareBundle, {
  IsbLambdaContext,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import {
  ContextWithConfig,
  isbConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/lambda/middleware/isb-config-middleware.js";
import {
  logTaggingFailure,
  searchableLeaseProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { AwsConsoleLink } from "@amzn/innovation-sandbox-commons/utils/aws-console-links.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  now,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  isActiveLease,
  isExpiredLease,
  isMonitoredLease,
  LeaseKey,
  MonitoredLease,
  type Lease,
  type LeaseLifecycleDispatch,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { DateTime } from "luxon";

const serviceName = "AccountLifecycleManager";
const tracer = new Tracer({ serviceName });
const logger = new Logger({ serviceName });

export namespace AccountLifecycleManager {
  //list of events that will be subscribed to and passed to this handler
  export const trackedLeaseEvents = [
    EventDetailTypes.LeaseBudgetExceededAlert,
    EventDetailTypes.LeaseExpiredAlert,
    EventDetailTypes.AccountCleanupSuccessful,
    EventDetailTypes.AccountCleanupFailure,
    EventDetailTypes.AccountDriftDetected,
    EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
    EventDetailTypes.BlueprintDeploymentSucceeded,
    EventDetailTypes.BlueprintDeploymentFailed,
  ];
}

type SupportedLeaseEvent =
  (typeof AccountLifecycleManager.trackedLeaseEvents)[number];

function isSupportedLeaseEvent(
  detailType: string,
): detailType is SupportedLeaseEvent {
  return AccountLifecycleManager.trackedLeaseEvents.includes(
    detailType as SupportedLeaseEvent,
  );
}

type AccountLifecycleManagerContext = ContextWithConfig &
  IsbLambdaContext<AccountLifecycleManagementEnvironment>;

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: AccountLifecycleManagementEnvironmentSchema,
  moduleName: "account-management",
})
  .use(isbConfigMiddleware())
  .handler(handleAccountLifeCycleEvent);

async function handleAccountLifeCycleEvent(
  sqsEvent: SQSEvent,
  context: AccountLifecycleManagerContext,
) {
  if (sqsEvent.Records.length > 1) {
    throw new Error(
      "Only one event is supported per invocation, please check your event source mapping.",
    );
  }
  const body = sqsEvent.Records[0]!.body;
  const event = JSON.parse(body);

  const eventDetailType = event["detail-type"];
  if (!isSupportedLeaseEvent(eventDetailType)) {
    throw new Error(`Unsupported event detail type: ${eventDetailType}.`);
  }
  const isbAlert = event.detail;
  switch (eventDetailType) {
    case EventDetailTypes.LeaseBudgetExceededAlert:
      await handleLeaseBudgetExceeded(
        LeaseBudgetExceededAlert.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.LeaseExpiredAlert:
      await handleLeaseExpired(LeaseExpiredAlert.parse(isbAlert), context);
      break;
    case EventDetailTypes.AccountCleanupSuccessful:
      await handleAccountCleanupSuccessful(
        AccountCleanupSuccessfulEvent.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.AccountCleanupFailure:
      await handleAccountCleanupFailure(
        AccountCleanupFailureEvent.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.AccountDriftDetected:
      await handleAccountDrift(
        AccountDriftDetectedAlert.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.LeaseFreezingThresholdBreachedAlert:
      await handleLeaseFreezingAlert(
        LeaseFreezingThresholdBreachedAlert.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.BlueprintDeploymentSucceeded:
      await handleBlueprintDeploymentSucceeded(
        BlueprintDeploymentSucceededEvent.parse(isbAlert),
        context,
      );
      break;
    case EventDetailTypes.BlueprintDeploymentFailed:
      await handleBlueprintDeploymentFailed(
        BlueprintDeploymentFailedEvent.parse(isbAlert),
        context,
      );
      break;
    default:
      assertNever(eventDetailType);
  }
}

/**
 * For an event whose outcome the lease already shows. The status write commits
 * before the follow-up work (assignment processing, CleanAccountRequest,
 * LeaseTerminated), so the status alone does not prove the transition
 * finished; its dispatch marker does. With the marker, the event is a
 * duplicate (the hourly job and token poll each resend a breach on every run
 * until the lease ends) and is dropped. Without it, the earlier attempt may
 * not have finished, so this throws and the message reaches the DLQ.
 */
function skipAlreadyHandled(
  eventName: string,
  lease: Lease,
  dispatchedIntent: LeaseLifecycleDispatch["intent"],
): void {
  const dispatch =
    "lifecycleDispatch" in lease ? lease.lifecycleDispatch : undefined;
  if (dispatch?.intent !== dispatchedIntent) {
    throw new Error(
      `${eventName} for lease ${lease.uuid}, which is already ${lease.status} but has no ` +
        `${dispatchedIntent} dispatch marker: the earlier attempt may not have finished its follow-up work.`,
    );
  }
  logger.info(
    `Ignoring duplicate ${eventName} for lease ${lease.uuid}: lease is already ${lease.status}`,
    { leaseId: lease.uuid, status: lease.status },
  );
}

async function handleLeaseBudgetExceeded(
  event: LeaseBudgetExceededAlert,
  context: AccountLifecycleManagerContext,
) {
  logger.debug("Processing LeaseBudgetExceededAlert");

  const leaseStore = IsbServices.leaseStore(context.env);
  const lease = await readAlertLease(leaseStore, event.Detail.leaseId);

  if (isExpiredLease(lease)) {
    skipAlreadyHandled("LeaseBudgetExceededAlert", lease, "TERMINATE");
    return;
  }
  if (!isMonitoredLease(lease)) {
    throw new Error(
      `LeaseBudgetExceededEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId.uuid}.`,
    );
  }

  if (
    lease.maxSpend === undefined ||
    event.Detail.totalSpend < lease.maxSpend
  ) {
    logStaleAlert(
      "LeaseBudgetExceededAlert",
      lease,
      `the alert reported ${event.Detail.totalSpend} and maxSpend is now ${lease.maxSpend ?? "unset"}`,
    );
    return;
  }

  await InnovationSandbox.terminateLease(
    {
      lease: lease,
      expiredStatus: "BudgetExceeded",
      budgetExceededBy: event.Detail.detectedBy,
      budgetTotalSpend: event.Detail.totalSpend,
    },
    {
      leaseStore,
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
      globalConfig: context.globalConfig,
      blueprintStore: IsbServices.blueprintStore(context.env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(
        context.env,
      ),
      sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(context.env),
      logger,
      tracer,
    },
  );
}

async function handleLeaseExpired(
  event: LeaseExpiredAlert,
  context: AccountLifecycleManagerContext,
) {
  logger.debug("Processing LeaseExpiredAlert");

  const leaseStore = IsbServices.leaseStore(context.env);
  const lease = await readAlertLease(leaseStore, event.Detail.leaseId);

  if (isExpiredLease(lease)) {
    skipAlreadyHandled("LeaseExpiredAlert", lease, "TERMINATE");
    return;
  }
  if (!isMonitoredLease(lease)) {
    throw new Error(
      `LeaseExpiredEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId.uuid}.`,
    );
  }

  if (!isPastExpiration(lease)) {
    logStaleAlert(
      "LeaseExpiredAlert",
      lease,
      `the expiration is now ${lease.expirationDate ?? "unset"}`,
    );
    return;
  }

  await InnovationSandbox.terminateLease(
    {
      lease: lease,
      expiredStatus: "Expired",
    },
    {
      leaseStore,
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
      globalConfig: context.globalConfig,
      blueprintStore: IsbServices.blueprintStore(context.env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(
        context.env,
      ),
      sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(context.env),
      logger,
      tracer,
    },
  );
}

async function handleAccountCleanupSuccessful(
  event: AccountCleanupSuccessfulEvent,
  context: AccountLifecycleManagerContext,
) {
  const minutesSinceCleanupStarted = minutesSinceStarted(event);
  const executionArn = event.Detail.cleanupExecutionContext.executionArn;

  logger.info(
    `Account cleanup succeeded for account (${event.Detail.accountId}) after ${minutesSinceCleanupStarted.toFixed(1)} minutes. CleanupExecutionId: ${event.Detail.cleanupExecutionContext.executionArn}`,
    {
      accountId: event.Detail.accountId,
      durationMinutes: minutesSinceCleanupStarted,
      executionArn: executionArn,
      executionURL: AwsConsoleLink.executionConsoleUrl(executionArn),
      reason: event.Detail.reason,
    },
  );

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const sandboxAccountStore = IsbServices.sandboxAccountStore(context.env);
  const organizationsTaggingService = IsbServices.organizationsTaggingService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const cleanSandboxAccountResponse = await sandboxAccountStore.get(
    event.Detail.accountId,
  );
  const cleanSandboxAccount = cleanSandboxAccountResponse.result;

  if (cleanSandboxAccountResponse.error) {
    logger.warn(
      `Error retrieving account ${event.Detail.accountId}: ${cleanSandboxAccountResponse.error}`,
    );
  }
  if (!cleanSandboxAccount) {
    throw new Error(`Sandbox account not found: ${event.Detail.accountId}.`);
  }

  if (cleanSandboxAccount.status != "CleanUp") {
    throw new Error(
      `AccountCleanupSuccessfulEvent incorrectly raised for an account whose status is not CleanUp: (ActualStatus = ${cleanSandboxAccount.status}).`,
    );
  }

  await orgsService
    .transactionalMoveAccount(cleanSandboxAccount, "CleanUp", "Available")
    .complete();

  await organizationsTaggingService
    .updateStatusTag(cleanSandboxAccount.awsAccountId, "Available")
    .catch((error) =>
      logTaggingFailure(
        logger,
        cleanSandboxAccount.awsAccountId,
        ["Status"],
        error,
      ),
    );
}

async function handleAccountCleanupFailure(
  event: AccountCleanupFailureEvent,
  context: AccountLifecycleManagerContext,
) {
  const minutesSinceCleanupStarted = minutesSinceStarted(event);
  const executionArn = event.Detail.cleanupExecutionContext.executionArn;

  logger.info(
    `Account cleanup failed for account (${event.Detail.accountId}) after ${minutesSinceCleanupStarted.toFixed(1)} minutes. CleanupExecutionId: ${event.Detail.cleanupExecutionContext.executionArn}`,
    {
      accountId: event.Detail.accountId,
      durationMinutes: minutesSinceCleanupStarted,
      executionArn: executionArn,
      executionURL: AwsConsoleLink.executionConsoleUrl(executionArn),
      reason: event.Detail.reason,
    },
  );

  await InnovationSandbox.quarantineAccount(
    {
      accountId: event.Detail.accountId,
      reason: "Cleanup Failed",
      currentOu: "CleanUp",
      reasonForQuarantine: "CLEANUP_FAILED",
    },
    {
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
      leaseStore: IsbServices.leaseStore(context.env),
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      globalConfig: context.globalConfig,
      blueprintStore: IsbServices.blueprintStore(context.env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(
        context.env,
      ),
      sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(context.env),
      logger,
      tracer,
    },
  );
}

async function handleAccountDrift(
  event: AccountDriftDetectedAlert,
  context: AccountLifecycleManagerContext,
) {
  logger.debug("Processing AccountDriftDetectedAlert");

  if (event.Detail.actualOu === undefined) {
    const accountStore = IsbServices.sandboxAccountStore(context.env);
    await accountStore.delete(event.Detail.accountId);
    logger.warn(`Account ${event.Detail.accountId} deleted from SandboxAccountStore: Account was expected to be in the ${event.Detail.expectedOu} OU,
    but has been removed from InnovationSandbox completely`);
    return; //no account to quarantine
  }

  await InnovationSandbox.quarantineAccount(
    {
      accountId: event.Detail.accountId,
      reason: `Drift Detected: {expectedOU: ${event.Detail.expectedOu}, actualOU: ${event.Detail.actualOu}}`,
      currentOu: event.Detail.actualOu,
      reasonForQuarantine: "DRIFT",
    },
    {
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
      leaseStore: IsbServices.leaseStore(context.env),
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      globalConfig: context.globalConfig,
      blueprintStore: IsbServices.blueprintStore(context.env),
      blueprintDeploymentService: IsbServices.blueprintDeploymentService(
        context.env,
      ),
      sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(context.env),
      logger,
      tracer,
    },
  );
}

async function handleLeaseFreezingAlert(
  event: LeaseFreezingThresholdBreachedAlert,
  context: AccountLifecycleManagerContext,
) {
  logger.debug("Processing LeaseFreezingThresholdBreachedAlert");

  const leaseStore = IsbServices.leaseStore(context.env);
  const lease = await readAlertLease(leaseStore, event.Detail.leaseId);

  // Compared directly rather than through isFrozenLease, which narrows to every
  // monitored status and would leave the Active lease below typed as never.
  if (lease.status === "Frozen" || isExpiredLease(lease)) {
    // A termination that overtook the freeze satisfies it too.
    skipAlreadyHandled(
      "LeaseFreezingThresholdBreachedAlert",
      lease,
      lease.status === "Frozen" ? "FREEZE" : "TERMINATE",
    );
    return;
  }
  if (!isActiveLease(lease)) {
    throw new Error(
      `LeaseFreezingEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId.uuid}.`,
    );
  }

  if (!isFreezeStillRequested(lease, event.Detail.reason)) {
    logStaleAlert(
      "LeaseFreezingThresholdBreachedAlert",
      lease,
      `no current freeze threshold is reached by what it reports (${JSON.stringify(event.Detail.reason)}), with the expiration ${lease.expirationDate ?? "unset"}`,
    );
    return;
  }

  await InnovationSandbox.freezeLease(
    {
      lease: lease,
      reason: event.Detail.reason,
    },
    {
      leaseStore,
      orgsService: IsbServices.orgsService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      eventBridgeClient: IsbServices.isbEventBridge(context.env),
      sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
      logger,
      tracer,
    },
  );
}

/** The alert's lease, read consistently so the re-checks see the latest edit. */
async function readAlertLease(
  leaseStore: LeaseStore,
  leaseId: LeaseKey,
): Promise<PersistedLease> {
  const leaseResponse = await leaseStore.get(leaseId, { consistentRead: true });
  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${leaseId.uuid}: ${leaseResponse.error}`,
    );
  }
  if (!leaseResponse.result) {
    throw new Error(`Lease not found: ${leaseId.uuid}.`);
  }
  return leaseResponse.result;
}

/**
 * A monitor decides an alert from a copy of the lease it read earlier, so an
 * admin may have raised maxSpend or moved the expiration or a threshold since.
 * A wrong termination cannot be undone and a wrong freeze locks the lease
 * holder out until an admin unfreezes it, so each handler checks the alert
 * against a consistent read first and drops one the current lease no longer
 * supports. Lease Monitoring sends maxSpend and expiry alerts again on every
 * run; a freeze threshold fires again only on a new crossing.
 */
function logStaleAlert(
  alertType: string,
  lease: MonitoredLease,
  reason: string,
): void {
  logger.info(
    `Dropping a ${alertType} for lease ${lease.uuid}: ${reason}`,
    searchableLeaseProperties(lease),
  );
}

function isPastExpiration(lease: MonitoredLease): boolean {
  return (
    lease.expirationDate !== undefined &&
    parseDatetime(lease.expirationDate) < now()
  );
}

/**
 * Whether any of the lease's current freeze thresholds is reached by what the
 * alert reports. The current thresholds are checked rather than the one that
 * fired: the monitors' stored figure has already moved past the crossing, so a
 * line an admin lowered meanwhile would never fire again. A spend-rate freeze
 * is re-checked against the current rate limits of its basis. A freeze for any
 * other reason is not re-checked.
 */
function isFreezeStillRequested(
  lease: MonitoredLease,
  reason: LeaseFrozenReasonInput,
): boolean {
  if (reason.type === "BudgetExceeded") {
    // The compared cost reached both the line that fired and the billed
    // spend, which can leave out estimated Sandbox Spaces token cost. A
    // predicted crossing proves only
    // the billed spend for a line that freezes on the bill.
    const reached = Math.max(
      reason.triggeredBudgetThreshold,
      reason.totalSpend,
    );
    const billReached =
      reason.triggeredBy === "PREDICTED" ? reason.totalSpend : reached;
    return (lease.budgetThresholds ?? []).some(
      (threshold) =>
        threshold.action === "FREEZE_ACCOUNT" &&
        threshold.dollarsSpent <=
          (threshold.triggerOn === "PREDICTED" ? reached : billReached),
    );
  }
  if (reason.type === "SpendRateExceeded") {
    // Rate limits are evaluated only while predictive controls are on, and
    // only a FREEZE_ACCOUNT limit of the same basis at or below the measured
    // rate still asks for this freeze. A removed, raised or re-based limit, or
    // one switched to ALERT, leaves the alert stale.
    return (
      lease.predictiveBudgetEnabled === true &&
      (lease.rateLimits ?? []).some(
        (limit) =>
          limit.action === "FREEZE_ACCOUNT" &&
          limit.basis === reason.rateBasis &&
          limit.rate <= reason.measuredRate,
      )
    );
  }
  if (reason.type === "Expired") {
    const { expirationDate } = lease;
    return (
      expirationDate !== undefined &&
      (lease.durationThresholds ?? []).some(
        (threshold) =>
          threshold.action === "FREEZE_ACCOUNT" &&
          parseDatetime(expirationDate).minus({
            hours: threshold.hoursRemaining,
          }) <= now(),
      )
    );
  }
  return true;
}

async function handleBlueprintDeploymentSucceeded(
  event: BlueprintDeploymentSucceededEvent,
  context: AccountLifecycleManagerContext,
) {
  const leaseStore = IsbServices.leaseStore(context.env);
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId.uuid}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId.uuid}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `BlueprintDeploymentSucceededEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId.uuid}.`,
    );
  }

  await InnovationSandbox.publishLease(
    { lease },
    {
      leaseStore,
      principalStore: IsbServices.principalStore(context.env),
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      organizationsTaggingService: IsbServices.organizationsTaggingService(
        context.env,
        fromTemporaryIsbOrgManagementCredentials(context.env),
      ),
      isbEventBridgeClient: IsbServices.isbEventBridge(context.env),
      logger,
      tracer,
    },
  );

  logger.info(
    `Blueprint deployment succeeded. Lease published for user ${lease.userEmail}`,
    {
      blueprintId: event.Detail.blueprintId,
      leaseId: lease.uuid,
      accountId: lease.awsAccountId,
    },
  );
}

async function handleBlueprintDeploymentFailed(
  event: BlueprintDeploymentFailedEvent,
  context: AccountLifecycleManagerContext,
) {
  logger.error("Processing BlueprintDeploymentFailedEvent", {
    blueprintId: event.Detail.blueprintId,
    leaseId: event.Detail.leaseId,
    errorType: event.Detail.errorType,
    errorMessage: event.Detail.errorMessage,
  });

  const leaseStore = IsbServices.leaseStore(context.env);
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId.uuid}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId.uuid}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `BlueprintDeploymentFailedEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId.uuid}.`,
    );
  }

  // CRITICAL: Different handling based on approval type
  if (lease.approvedBy === "AUTO_APPROVED") {
    // Path A: Auto-approved lease - terminate permanently
    logger.info(
      "Auto-approved lease failed blueprint deployment. Terminating lease.",
      {
        leaseId: lease.uuid,
        blueprintId: event.Detail.blueprintId,
      },
    );

    await InnovationSandbox.terminateLease(
      {
        lease,
        expiredStatus: "ProvisioningFailed",
      },
      {
        leaseStore,
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        organizationsTaggingService: IsbServices.organizationsTaggingService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        eventBridgeClient: IsbServices.isbEventBridge(context.env),
        sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
        globalConfig: context.globalConfig,
        blueprintStore: IsbServices.blueprintStore(context.env),
        blueprintDeploymentService: IsbServices.blueprintDeploymentService(
          context.env,
        ),
        sandboxSpacesUsageStore: IsbServices.sandboxSpacesUsageStore(
          context.env,
        ),
        logger,
        tracer,
      },
    );
  } else {
    // Path B: Manual approval lease - reset for retry
    logger.info(
      "Manual approval lease failed blueprint deployment. Resetting lease to PendingApproval.",
      {
        leaseId: lease.uuid,
        blueprintId: event.Detail.blueprintId,
        approvedBy: lease.approvedBy,
      },
    );

    // Use denormalized blueprint name from lease (populated during lease creation from template)
    const blueprintName = lease.blueprintName || "Unknown Blueprint";

    await InnovationSandbox.resetLease(
      {
        lease,
        blueprintName,
      },
      {
        leaseStore,
        sandboxAccountStore: IsbServices.sandboxAccountStore(context.env),
        orgsService: IsbServices.orgsService(
          context.env,
          fromTemporaryIsbOrgManagementCredentials(context.env),
        ),
        isbEventBridgeClient: IsbServices.isbEventBridge(context.env),
        blueprintStore: IsbServices.blueprintStore(context.env),
        blueprintDeploymentService: IsbServices.blueprintDeploymentService(
          context.env,
        ),
        logger,
        tracer,
      },
    );
  }
}

function minutesSinceStarted(
  cleanupEvent: AccountCleanupFailureEvent | AccountCleanupSuccessfulEvent,
): number {
  try {
    const startTime = DateTime.fromISO(
      cleanupEvent.Detail.cleanupExecutionContext.executionStartTime,
    );
    const now = DateTime.now();
    const duration = now.diff(startTime);
    return duration.as("minutes");
  } catch (error) {
    console.error("Error calculating duration of account cleanup:", error);
    return -1;
  }
}

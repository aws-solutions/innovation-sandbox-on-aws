// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { SQSEvent } from "aws-lambda";

import {
  isActiveLease,
  isMonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { AccountCleanupFailureEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-failure-event.js";
import { AccountCleanupSuccessfulEvent } from "@amzn/innovation-sandbox-commons/events/account-cleanup-successful-event.js";
import { AccountDriftDetectedAlert } from "@amzn/innovation-sandbox-commons/events/account-drift-detected-alert.js";
import { BlueprintDeploymentFailedEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-failed-event.js";
import { BlueprintDeploymentSucceededEvent } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-succeeded-event.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
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
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import { assertNever } from "@amzn/innovation-sandbox-commons/types/type-guards.js";
import { AwsConsoleLink } from "@amzn/innovation-sandbox-commons/utils/aws-console-links.js";
import {
  fromTemporaryIsbIdcCredentials,
  fromTemporaryIsbOrgManagementCredentials,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
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

async function handleLeaseBudgetExceeded(
  event: LeaseBudgetExceededAlert,
  context: AccountLifecycleManagerContext,
) {
  logger.debug("Processing LeaseBudgetExceededAlert");

  const leaseStore = IsbServices.leaseStore(context.env);
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `LeaseBudgetExceededEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId}.`,
    );
  }

  await InnovationSandbox.terminateLease(
    {
      lease: lease,
      expiredStatus: "BudgetExceeded",
    },
    {
      leaseStore,
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      orgsService: IsbServices.orgsService(
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
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId}: ${leaseResponse.error}`,
    );
  }

  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `LeaseExpiredEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId}.`,
    );
  }

  await InnovationSandbox.terminateLease(
    {
      lease: lease,
      expiredStatus: "Expired",
    },
    {
      leaseStore,
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      orgsService: IsbServices.orgsService(
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
  const stateMachineExecutionArn =
    event.Detail.cleanupExecutionContext.stateMachineExecutionArn;

  logger.info(
    `Account cleanup succeeded for account (${event.Detail.accountId}) after ${minutesSinceCleanupStarted.toFixed(1)} minutes. CleanupExecutionId: ${event.Detail.cleanupExecutionContext.stateMachineExecutionArn}`,
    {
      logDetailType: "AccountCleanupSuccess",
      accountId: event.Detail.accountId,
      durationMinutes: minutesSinceCleanupStarted,
      stateMachineExecutionArn: stateMachineExecutionArn,
      stateMachineExecutionURL: AwsConsoleLink.stateMachineExecution(
        stateMachineExecutionArn,
      ),
      reason: event.Detail.reason,
    } satisfies SubscribableLog,
  );

  const orgsService = IsbServices.orgsService(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const sandboxAccountStore = IsbServices.sandboxAccountStore(context.env);
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
}

async function handleAccountCleanupFailure(
  event: AccountCleanupFailureEvent,
  context: AccountLifecycleManagerContext,
) {
  const minutesSinceCleanupStarted = minutesSinceStarted(event);
  const stateMachineExecutionArn =
    event.Detail.cleanupExecutionContext.stateMachineExecutionArn;

  logger.info(
    `Account cleanup failed for account (${event.Detail.accountId}) after ${minutesSinceCleanupStarted.toFixed(1)} minutes. CleanupExecutionId: ${event.Detail.cleanupExecutionContext.stateMachineExecutionArn}`,
    {
      logDetailType: "AccountCleanupFailure",
      accountId: event.Detail.accountId,
      durationMinutes: minutesSinceCleanupStarted,
      stateMachineExecutionArn: stateMachineExecutionArn,
      stateMachineExecutionURL: AwsConsoleLink.stateMachineExecution(
        stateMachineExecutionArn,
      ),
      reason: event.Detail.reason,
    } satisfies SubscribableLog,
  );

  await InnovationSandbox.quarantineAccount(
    {
      accountId: event.Detail.accountId,
      reason: "Cleanup Failed",
      currentOu: "CleanUp",
    },
    {
      orgsService: IsbServices.orgsService(
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
    },
    {
      orgsService: IsbServices.orgsService(
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
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId}.`);
  }

  if (!isActiveLease(lease)) {
    throw new Error(
      `LeaseFreezingEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId}.`,
    );
  }

  await InnovationSandbox.freezeLease(
    {
      lease: lease,
      reason: event.Detail.reason,
    },
    {
      leaseStore,
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
      ),
      orgsService: IsbServices.orgsService(
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

async function handleBlueprintDeploymentSucceeded(
  event: BlueprintDeploymentSucceededEvent,
  context: AccountLifecycleManagerContext,
) {
  const leaseStore = IsbServices.leaseStore(context.env);
  const leaseResponse = await leaseStore.get(event.Detail.leaseId);
  const lease = leaseResponse.result;

  if (leaseResponse.error) {
    logger.warn(
      `Error retrieving lease ${event.Detail.leaseId}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `BlueprintDeploymentSucceededEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId}.`,
    );
  }

  await InnovationSandbox.publishLease(
    { lease },
    {
      leaseStore,
      idcService: IsbServices.idcService(
        context.env,
        fromTemporaryIsbIdcCredentials(context.env),
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
      `Error retrieving lease ${event.Detail.leaseId}: ${leaseResponse.error}`,
    );
  }
  if (!lease) {
    throw new Error(`Lease not found: ${event.Detail.leaseId}.`);
  }

  if (!isMonitoredLease(lease)) {
    throw new Error(
      `BlueprintDeploymentFailedEvent incorrectly raised for an inactive lease: ${event.Detail.leaseId}.`,
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
        idcService: IsbServices.idcService(
          context.env,
          fromTemporaryIsbIdcCredentials(context.env),
        ),
        orgsService: IsbServices.orgsService(
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
      cleanupEvent.Detail.cleanupExecutionContext
        .stateMachineExecutionStartTime,
    );
    const now = DateTime.now();
    const duration = now.diff(startTime);
    return duration.as("minutes");
  } catch (error) {
    console.error("Error calculating duration of account cleanup:", error);
    return -1;
  }
}

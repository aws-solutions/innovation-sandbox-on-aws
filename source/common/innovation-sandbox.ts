// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { PutResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { PersistedLeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  PersistedLease,
  PersistedMonitoredLease,
  PersistedPendingLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { PrincipalStore } from "@amzn/innovation-sandbox-commons/data/principal/principal-store.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import { PersistedSandboxAccount } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { SandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { AccountQuarantinedEvent } from "@amzn/innovation-sandbox-commons/events/account-quarantined-event.js";
import { BlueprintDeploymentRequest } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-request.js";
import {
  CleanAccountRequest,
  CleanupReasonSchema,
} from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { BudgetExceededDetectedBy } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import {
  LeaseFrozenEvent,
  LeaseFrozenReasonInput,
} from "@amzn/innovation-sandbox-commons/events/lease-frozen-event.js";
import { LeaseProvisioningFailedEvent } from "@amzn/innovation-sandbox-commons/events/lease-provisioning-failed-event.js";
import { LeaseRequestedEvent } from "@amzn/innovation-sandbox-commons/events/lease-requested-event.js";
import {
  getLeaseTerminatedReason,
  LeaseTerminatedEvent,
} from "@amzn/innovation-sandbox-commons/events/lease-terminated-event.js";
import { LeaseUnfrozenEvent } from "@amzn/innovation-sandbox-commons/events/lease-unfrozen-event.js";
import { BlueprintDeploymentService } from "@amzn/innovation-sandbox-commons/isb-services/blueprint-deployment-service.js";
import { IdcService } from "@amzn/innovation-sandbox-commons/isb-services/idc-service.js";
import {
  acquireAssignmentProcessingLock,
  enrichDesiredAssignments,
  IneligibleLeaseOwnerError,
  normalizeAssignmentsWithOwner,
  publishAssignmentProcessingRequest,
  releaseAssignmentProcessingLock,
  triggerAssignmentProcessing,
} from "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import type { ResolvedPermissionSetConfig } from "@amzn/innovation-sandbox-commons/isb-services/permission-set/index.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { getLeaseSandboxSpacesEstimatedTokenCost } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-spaces-usage/index.js";
import {
  ReasonForQuarantine,
  SubscribableLog,
} from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  addCorrelationContext,
  logTaggingFailure,
  logUntaggingFailure,
  searchableAccountProperties,
  searchableLeaseProperties,
  searchableLeaseTemplateProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  IsbEvent,
  IsbEventBridgeClient,
} from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { ISB_ACCOUNT_TAG_SUFFIXES } from "@amzn/innovation-sandbox-commons/utils/isb-account-tags.js";
import {
  calculateTtlInEpochSeconds,
  datetimeAsString,
  now,
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { resolveBedrockTokenMonitoringEnabled } from "@amzn/innovation-sandbox-shared/types/configuration.js";
import {
  DesiredAssignment,
  ExpiredLeaseStatus,
  isActiveLease,
  isFrozenLease,
  isMonitoredLease,
  LeaseKeySchema,
  LeaseStatus,
  MonitoredLeaseStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import { IsbOu } from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";
import {
  type IsbUser,
  getUserEmail,
  getUserLabel,
  isIdcUser,
  isSyntheticM2mEmail,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { randomUUID } from "node:crypto";

export class InnovationSandboxError extends Error {}
export class NoAccountsAvailableError extends InnovationSandboxError {}
export class MaxNumberOfLeasesExceededError extends InnovationSandboxError {}
export class LeaseRequestRateLimitExceededError extends InnovationSandboxError {
  constructor(
    message: string,
    public readonly retryAt: string,
  ) {
    super(message);
  }
}
export class AccountNotInQuarantineError extends InnovationSandboxError {}
export class AccountInCleanUpError extends InnovationSandboxError {}
export class AccountNotInActiveError extends InnovationSandboxError {}
export class AccountNotInFrozenError extends InnovationSandboxError {}
export class CouldNotFindAccountError extends InnovationSandboxError {}
export class CouldNotRetrieveUserError extends InnovationSandboxError {}
/**
 * An M2M-assignee lease reached an IDC-grant code path. The entry guard in
 * `postLeaseHandler` should make this unreachable; if it throws, it signals
 * legacy data or a path that bypassed the API. Maps to HTTP 500.
 */
export class M2mAssigneeNotAllowedError extends InnovationSandboxError {}

export type IsbContext<T extends { [key: string]: any }> = T & {
  logger: Logger;
  tracer: Tracer;
};

export class InnovationSandbox {
  private constructor() {
    //static Facade
  }

  @logErrors
  public static async registerAccount(
    accountId: string,
    context: IsbContext<{
      eventBridgeClient: IsbEventBridgeClient;
      orgsService: SandboxOuService;
      idcService: IdcService;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ): Promise<PersistedSandboxAccount> {
    const { logger, eventBridgeClient, orgsService, idcService } = context;

    const account = await orgsService.describeAccount({ accountId });
    if (account === undefined) {
      throw new CouldNotFindAccountError("Could not find account to register.");
    }
    let newSandboxAccount: PersistedSandboxAccount = {
      awsAccountId: accountId,
      email: account.email,
      name: account.name,
      driftAtLastScan: false,
      status: "CleanUp",
    };
    addCorrelationContext(
      logger,
      searchableAccountProperties(newSandboxAccount),
    );

    const onBoardingResult = await new Transaction(
      orgsService.transactionalMoveAccount(
        newSandboxAccount,
        "Entry",
        "CleanUp",
      ),
      idcService.transactionalAssignGroupAccess(accountId, "Manager"),
      idcService.transactionalAssignGroupAccess(accountId, "Admin"),
    ).complete();

    newSandboxAccount = onBoardingResult.newItem; //get updated meta after initial put
    addCorrelationContext(
      logger,
      searchableAccountProperties(newSandboxAccount),
    );

    try {
      await context.organizationsTaggingService.updateStatusTag(
        newSandboxAccount.awsAccountId,
        "CleanUp",
      );
    } catch (error) {
      logTaggingFailure(
        logger,
        newSandboxAccount.awsAccountId,
        ["Status"],
        error,
      );
    }

    logger.info(
      `Registered new SandboxAccount (${newSandboxAccount.awsAccountId}). Awaiting Cleanup...`,
    );

    await eventBridgeClient.sendIsbEvents(
      context.tracer,
      new CleanAccountRequest({
        accountId: newSandboxAccount.awsAccountId,
        reason: CleanupReasonSchema.enum.ACCOUNT_REGISTRATION,
      }),
    );

    return newSandboxAccount;
  }

  @logErrors
  public static async requestLease(
    props: {
      leaseTemplate: PersistedLeaseTemplate;
      comments?: string;
      targetUser: IsbUser;
      createdBy?: string;
      assignments?: DesiredAssignment[];
      permissionSetConfig: ResolvedPermissionSetConfig;
    },
    context: IsbContext<{
      globalConfig: GlobalConfig;
      leaseStore: LeaseStore;
      principalStore: PrincipalStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      isbEventBridgeClient: IsbEventBridgeClient;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      leaseTemplateStore: LeaseTemplateStore;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ) {
    const {
      leaseTemplate,
      comments,
      targetUser,
      createdBy,
      assignments = [],
      permissionSetConfig,
    } = props;
    const {
      logger,
      tracer,
      leaseStore,
      isbEventBridgeClient,
      globalConfig,
      principalStore,
    } = context;

    addCorrelationContext(
      logger,
      searchableLeaseTemplateProperties(leaseTemplate),
    );

    const numOfActiveLeases = (
      await collect(
        stream(leaseStore, leaseStore.findByUserEmail, {
          userEmail: getUserEmail(targetUser),
        }),
      )
    ).filter((lease) =>
      (
        ["Active", "PendingApproval", "Frozen", "Provisioning"] as LeaseStatus[]
      ).includes(lease.status),
    ).length;

    if (numOfActiveLeases >= context.globalConfig.leases.maxLeasesPerUser) {
      throw new MaxNumberOfLeasesExceededError(
        `This user has reached the maximum number of active/pending leases (${globalConfig.leases.maxLeasesPerUser}).`,
      );
    }

    // Always include the owner in desiredAssignments from creation time. Use
    // the default only when the caller did not explicitly choose an owner
    // assignment.
    if (!isIdcUser(targetUser)) {
      throw new Error("Target user must be an IDC user.");
    }
    const { defaultPermissionSetArn } = permissionSetConfig;
    const normalizedAssignments = assignments.map((assignment) => ({
      ...assignment,
      permissionSetArn: assignment.permissionSetArn ?? defaultPermissionSetArn,
    }));
    const assignmentsWithOwner = normalizeAssignmentsWithOwner({
      assignments: normalizedAssignments,
      ownerPrincipalId: targetUser.userId,
      defaultPermissionSetArn,
    });

    const enrichedAssignments = await enrichDesiredAssignments(
      assignmentsWithOwner,
      {
        principalStore,
        idcService: context.idcService,
        logger: context.logger,
      },
    );

    let newLease: PersistedLease = await leaseStore.create({
      userEmail: getUserEmail(targetUser),
      uuid: randomUUID(),
      status: "PendingApproval",
      originalLeaseTemplateUuid: leaseTemplate.uuid,
      originalLeaseTemplateName: leaseTemplate.name,
      maxSpend: leaseTemplate.maxSpend,
      costReportGroup: leaseTemplate.costReportGroup,
      budgetThresholds: leaseTemplate.budgetThresholds,
      durationThresholds: leaseTemplate.durationThresholds,
      leaseDurationInHours: leaseTemplate.leaseDurationInHours,
      comments,
      createdBy: createdBy || getUserEmail(targetUser),
      blueprintId: leaseTemplate.blueprintId,
      blueprintName: leaseTemplate.blueprintName,
      allowOwnerToShareLease: leaseTemplate.allowOwnerToShareLease,
      rateLimits: leaseTemplate.rateLimits,
      predictiveBudgetEnabled: leaseTemplate.predictiveBudgetEnabled,
      // Token polling selects leases by this snapshot, so a lease with a
      // Sandbox Space is always monitored; the template's saved preference is
      // left unchanged.
      bedrockTokenMonitoringEnabled: resolveBedrockTokenMonitoringEnabled({
        configured: leaseTemplate.bedrockTokenMonitoringEnabled,
        sandboxSpacesEnabled: leaseTemplate.sandboxSpacesEnabled,
      }),
      sandboxSpacesEnabled: leaseTemplate.sandboxSpacesEnabled,
      allowedModelIds: leaseTemplate.allowedModelIds,
      defaultModelId: leaseTemplate.defaultModelId,
      defaultPermissionSetArn,
      allowedPermissionSetArns: permissionSetConfig.allowedPermissionSetArns
        ? [...permissionSetConfig.allowedPermissionSetArns]
        : undefined,
      desiredAssignments: enrichedAssignments,
      totalCostAccrued: 0,
      approvedBy: null,
      awsAccountId: null,
    });

    // Determine if lease should be auto-approved
    const isLeaseAssignment = createdBy !== undefined;

    if (!leaseTemplate.requiresApproval || isLeaseAssignment) {
      try {
        newLease = (
          await InnovationSandbox.approveLease(
            {
              lease: newLease,
              approver: "AUTO_APPROVED",
            },
            context,
          )
        ).newItem;
      } catch (e) {
        await leaseStore.delete(LeaseKeySchema.parse(newLease));
        throw e;
      }
    } else {
      await isbEventBridgeClient.sendIsbEvent(
        tracer,
        new LeaseRequestedEvent({
          leaseId: {
            userEmail: newLease.userEmail,
            uuid: newLease.uuid,
          },
          requiresManualApproval: leaseTemplate.requiresApproval,
          comments: newLease.comments,
          userEmail: newLease.userEmail,
        }),
      );
    }

    const actionType = isLeaseAssignment ? "assigned" : "requested";
    const actionBy = isLeaseAssignment ? `by ${createdBy}` : "";

    logger.info(
      `Lease of type (${leaseTemplate.name}) (${leaseTemplate.uuid}) ${actionType} for (${getUserEmail(targetUser)}) ${actionBy}`,
      {
        ...searchableLeaseProperties(newLease),
      },
    );

    return newLease;
  }

  @logErrors
  public static async freezeLease(
    props: {
      lease: PersistedLease;
      reason: LeaseFrozenReasonInput;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ) {
    const { lease, reason } = props;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      orgsService,
      eventBridgeClient,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    if (!isActiveLease(lease)) {
      throw new AccountNotInActiveError("Only active leases can be frozen.");
    }

    const accountResponse = await sandboxAccountStore.get(lease.awsAccountId);
    const account = accountResponse.result;
    if (accountResponse.error) {
      logger.warn(
        `Error retrieving account ${lease.awsAccountId}: ${accountResponse.error}`,
      );
    }
    if (!account) {
      throw new CouldNotFindAccountError(
        "Unable to retrieve SandboxAccount information.",
      );
    }

    // Acquire the assignment lock BEFORE mutating the lease. A conflict must
    // leave the lease untouched — acquiring afterwards allowed the status/OU
    // change to commit while the caller was told the operation failed.
    const assignmentLock = await acquireAssignmentProcessingLock(
      { leaseId: lease.uuid, userEmail: lease.userEmail, intent: "FREEZE" },
      { leaseStore, eventBridgeClient, tracer, logger },
    );

    try {
      await new Transaction(
        orgsService.transactionalMoveAccount(account, "Active", "Frozen"),
        leaseStore.transactionalUpdate({
          ...lease,
          status: "Frozen",
          // A new transition: the marker is written again once it finishes.
          lifecycleDispatch: null,
          // `lease` was read before the lock was taken and this is a full-item
          // put, so the lock must be carried through or the write erases it.
          resourceLock: assignmentLock.lock,
        }),
      ).complete();
    } catch (error) {
      // Nothing was dispatched, so give the lock back.
      await releaseAssignmentProcessingLock(assignmentLock, {
        leaseStore,
        logger,
      });
      throw error;
    }

    try {
      await context.organizationsTaggingService.updateStatusTag(
        account.awsAccountId,
        "Frozen",
      );
    } catch (error) {
      logTaggingFailure(logger, account.awsAccountId, ["Status"], error);
    }

    await publishAssignmentProcessingRequest(assignmentLock, {
      leaseStore,
      eventBridgeClient,
      tracer,
      logger,
    });

    logger.info(
      `Lease ${lease.uuid} owned by ${lease.userEmail} frozen: ${reason.type}`,
      {
        ...searchableAccountProperties(account),
        ...searchableLeaseProperties(lease),
      },
    );
    await eventBridgeClient.sendIsbEvent(
      tracer,
      new LeaseFrozenEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: account.awsAccountId,
        reason: reason,
      }),
    );
    // Last: records that the follow-up work above was dispatched (see LeaseLifecycleDispatchSchema).
    await leaseStore.recordLifecycleDispatch({
      leaseId: lease.uuid,
      userEmail: lease.userEmail,
      intent: "FREEZE",
    });
  }

  @logErrors
  public static async terminateLease(
    props: {
      lease: PersistedMonitoredLease;
      expiredStatus: ExpiredLeaseStatus;
      autoCleanup?: boolean; //default true
      budgetExceededBy?: BudgetExceededDetectedBy;
      budgetTotalSpend?: number;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      globalConfig: GlobalConfig;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      organizationsTaggingService: OrganizationsTaggingService;
      sandboxSpacesUsageStore: SandboxSpacesUsageStore;
    }>,
  ) {
    const { lease, expiredStatus, budgetExceededBy, budgetTotalSpend } = props;
    const autoCleanup = props.autoCleanup ?? true;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      orgsService,
      eventBridgeClient,
      globalConfig,
      sandboxSpacesUsageStore,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    const eventsToSend: IsbEvent[] = [];

    const accountResponse = await sandboxAccountStore.get(lease.awsAccountId);
    const account = accountResponse.result;
    if (accountResponse.error) {
      logger.warn(
        `Error retrieving account ${lease.awsAccountId}: ${accountResponse.error}`,
      );
    }
    if (!account) {
      throw new CouldNotFindAccountError(
        "Unable to retrieve SandboxAccount information.",
      );
    }

    addCorrelationContext(logger, searchableAccountProperties(account));

    // Clean up stack instance metadata before account cleanup (fire-and-forget)
    if (lease.blueprintId) {
      await context.blueprintDeploymentService.deleteStackInstancesMetadata(
        lease.blueprintId,
        lease.awsAccountId,
        context.blueprintStore,
      );
    }

    if (autoCleanup) {
      await orgsService
        .transactionalMoveAccount(account, account.status, "CleanUp")
        .complete();

      try {
        await context.organizationsTaggingService.updateStatusTag(
          account.awsAccountId,
          "CleanUp",
        );
      } catch (error) {
        logTaggingFailure(logger, account.awsAccountId, ["Status"], error);
      }

      eventsToSend.push(
        new CleanAccountRequest({
          accountId: account.awsAccountId,
          reason: CleanupReasonSchema.enum.LEASE_TERMINATION,
        }),
      );
    }

    const agentSpend = await getLeaseSandboxSpacesEstimatedTokenCost(
      { leaseId: lease.uuid },
      { sandboxSpacesUsageStore, logger },
    ).catch((error: unknown) => {
      logger.warn("Failed to read Sandbox Spaces usage for lease", {
        ...searchableLeaseProperties(lease),
        error,
      });
      return undefined;
    });

    const leaseTtl = calculateTtlInEpochSeconds(globalConfig.leases.ttl);
    await leaseStore.update({
      ...lease,
      status: expiredStatus,
      endDate: nowAsIsoDatetimeString(),
      ttl: leaseTtl,
      // A new transition: the marker is written again once it finishes.
      lifecycleDispatch: null,
    });
    await sandboxSpacesUsageStore
      .stampLeaseTtl(lease.uuid, leaseTtl)
      .catch((error: unknown) => {
        logger.warn(
          "Failed to stamp TTL on Sandbox Spaces usage items for lease",
          {
            ...searchableLeaseProperties(lease),
            error,
          },
        );
      });

    await triggerAssignmentProcessing(
      { leaseId: lease.uuid, userEmail: lease.userEmail, intent: "TERMINATE" },
      { leaseStore, eventBridgeClient, tracer, logger },
    );

    eventsToSend.push(
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: account.awsAccountId,
        reason: getLeaseTerminatedReason(
          expiredStatus,
          lease,
          budgetTotalSpend,
        ),
      }),
    );

    logger.info(
      `Lease ${lease.uuid} owned by ${lease.userEmail} terminated: ${expiredStatus}`,
      {
        ...searchableAccountProperties(account),
        ...searchableLeaseProperties(lease),
        startDate: lease.startDate,
        terminationDate: datetimeAsString(now()),
        logDetailType: "LeaseTerminated",
        maxBudget: lease.maxSpend,
        actualSpend: lease.totalCostAccrued,
        maxDurationHours: lease.leaseDurationInHours,
        actualDurationHours: now().diff(parseDatetime(lease.startDate), "hours")
          .hours,
        reasonForTermination: expiredStatus,
        agentSpend,
        budgetExceededBy,
        budgetTotalSpend,
      } satisfies SubscribableLog,
    );

    await eventBridgeClient.sendIsbEvents(tracer, ...eventsToSend);
    // Last: records that the follow-up work above was dispatched (see LeaseLifecycleDispatchSchema).
    await leaseStore.recordLifecycleDispatch({
      leaseId: lease.uuid,
      userEmail: lease.userEmail,
      intent: "TERMINATE",
    });
  }

  @logErrors
  public static async unfreezeLease(
    props: {
      lease: PersistedLease;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ): Promise<PutResult<PersistedLease>> {
    const { lease } = props;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      orgsService,
      eventBridgeClient,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    if (!isFrozenLease(lease)) {
      throw new AccountNotInFrozenError("Only frozen leases can be unfrozen");
    }

    const accountResponse = await sandboxAccountStore.get(lease.awsAccountId);
    const account = accountResponse.result;
    if (!account || accountResponse.error) {
      logger.error(
        `Error retrieving account ${lease.awsAccountId}: ${accountResponse.error}`,
      );
      throw new CouldNotFindAccountError(
        "Unable to retrieve SandboxAccount information.",
      );
    }

    // Acquire the assignment lock BEFORE mutating the lease. UNFREEZE is
    // non-critical, so any live lock rejects it; acquiring afterwards let the
    // lease flip Frozen -> Active while an in-flight FREEZE was still revoking
    // access, leaving desired assignments with no records behind them.
    const assignmentLock = await acquireAssignmentProcessingLock(
      { leaseId: lease.uuid, userEmail: lease.userEmail, intent: "UNFREEZE" },
      { leaseStore, eventBridgeClient, tracer, logger },
    );

    let transactionResult: PutResult<PersistedLease>;
    try {
      transactionResult = await new Transaction(
        leaseStore.transactionalUpdate({
          ...lease,
          status: "Active",
          // See freezeLease.
          resourceLock: assignmentLock.lock,
        }),
        orgsService.transactionalMoveAccount(account, "Frozen", "Active"),
      ).complete();
    } catch (error) {
      // Nothing was dispatched, so give the lock back.
      await releaseAssignmentProcessingLock(assignmentLock, {
        leaseStore,
        logger,
      });
      throw error;
    }

    try {
      await context.organizationsTaggingService.updateStatusTag(
        account.awsAccountId,
        "Active",
      );
    } catch (error) {
      logTaggingFailure(logger, account.awsAccountId, ["Status"], error);
    }

    await publishAssignmentProcessingRequest(assignmentLock, {
      leaseStore,
      eventBridgeClient,
      tracer,
      logger,
    });

    logger.info(`Lease ${lease.uuid} owned by ${lease.userEmail} unfrozen`, {
      ...searchableAccountProperties(account),
      ...searchableLeaseProperties(lease),
      logDetailType: "LeaseUnfrozen",
    } satisfies SubscribableLog);

    await eventBridgeClient.sendIsbEvent(
      tracer,
      new LeaseUnfrozenEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: account.awsAccountId,
        maxBudget: lease.maxSpend,
        leaseDurationInHours: lease.leaseDurationInHours,
        reason: "Manually unfrozen",
      }),
    );

    return transactionResult;
  }

  @logErrors
  public static async retryCleanup(
    props: {
      sandboxAccount: PersistedSandboxAccount;
      initiatedBy?: string;
    },
    context: IsbContext<{
      sandboxAccountStore: SandboxAccountStore;
      eventBridgeClient: IsbEventBridgeClient;
      orgsService: SandboxOuService;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ) {
    const { sandboxAccount, initiatedBy } = props;
    const { logger, tracer, orgsService, eventBridgeClient } = context;

    addCorrelationContext(logger, searchableAccountProperties(sandboxAccount));

    if (
      sandboxAccount.status != "Quarantine" &&
      sandboxAccount.status != "CleanUp"
    ) {
      throw new AccountNotInQuarantineError(
        "Can only retry cleanup on quarantined accounts and those already in Cleanup.",
      );
    }

    // Reject if a cleanup execution is already running (a non-expired lock).
    // Dispatching a second CleanAccountRequest would let two executions race
    // on the same account. An expired lock is the stuck-execution case this
    // retry exists to recover, so it is allowed through.
    const activeLock = sandboxAccount.resourceLock;
    if (activeLock && parseDatetime(activeLock.expiresAt) > now()) {
      throw new AccountInCleanUpError(
        "A cleanup execution is already running for this account. Wait for it to finish before retrying.",
      );
    }

    if (sandboxAccount.status != "CleanUp") {
      await orgsService
        .transactionalMoveAccount(sandboxAccount, "Quarantine", "CleanUp")
        .complete();

      try {
        await context.organizationsTaggingService.updateStatusTag(
          sandboxAccount.awsAccountId,
          "CleanUp",
        );
      } catch (error) {
        logTaggingFailure(
          logger,
          sandboxAccount.awsAccountId,
          ["Status"],
          error,
        );
      }
    }

    await eventBridgeClient.sendIsbEvents(
      tracer,
      new CleanAccountRequest({
        accountId: sandboxAccount.awsAccountId,
        reason: CleanupReasonSchema.enum.MANUALLY_INITIATED,
        initiatedBy,
      }),
    );

    logger.info(
      `Retry cleanup initiated for account (${sandboxAccount.awsAccountId})`,
    );
  }

  /**
   * Approve a lease request and provision the account.
   *
   * For leases with blueprints, sets status to "Provisioning" and delegates to Step Functions.
   * For leases without blueprints, grants access immediately via publishLease().
   *
   * @param props - Lease to approve and approver information
   * @param context - ISB context with required services
   */
  @logErrors
  public static async approveLease(
    props: {
      lease: PersistedLease;
      approver: string;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      principalStore: PrincipalStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      isbEventBridgeClient: IsbEventBridgeClient;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      leaseTemplateStore: LeaseTemplateStore;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ): Promise<PutResult<PersistedLease>> {
    const { lease, approver } = props;
    const {
      logger,
      tracer,
      leaseStore,
      idcService,
      orgsService,
      isbEventBridgeClient,
      blueprintStore,
      blueprintDeploymentService,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    InnovationSandbox.assertAssigneeNotM2m(lease, logger);

    // Acquire an available account from the pool and get user info
    const [freeAccount, leaseUser] = await Promise.all([
      InnovationSandbox.acquireAvailableAccount(context),
      idcService.getIsbMemberFromEmail(lease.userEmail),
    ]);

    if (!leaseUser) {
      throw new IneligibleLeaseOwnerError(lease.userEmail);
    }

    // Simple conditional: no blueprint vs has blueprint
    if (lease.blueprintId) {
      // Has blueprint: validate, move account, set Provisioning status, initiate deployment
      logger.info(
        `Lease has blueprint attached (${lease.blueprintId}). Validating blueprint before approval.`,
        searchableLeaseProperties(lease),
      );

      const validatedBlueprint =
        await blueprintDeploymentService.validateBlueprintForDeployment(
          lease.blueprintId,
          blueprintStore,
        );

      const approvedLease: PersistedMonitoredLease = {
        ...lease,
        approvedBy: approver,
        awsAccountId: freeAccount.awsAccountId,
        status: "Provisioning",
        startDate: nowAsIsoDatetimeString(), // Placeholder - will be set in publishLease()
        totalCostAccrued: 0,
        lastCheckedDate: nowAsIsoDatetimeString(),
      };

      const transactionResult = await new Transaction(
        leaseStore.transactionalUpdate(approvedLease),
        orgsService.transactionalMoveAccount(
          {
            ...freeAccount,
            currentLease: {
              leaseId: lease.uuid,
              ownerEmail: lease.userEmail,
            },
          },
          "Available",
          "Active",
        ),
      ).complete();

      logger.info(
        "Lease approved with blueprint. Status: Provisioning. Account moved to Active OU. User access will be granted after deployment.",
        {
          ...searchableLeaseProperties(approvedLease),
          ...searchableAccountProperties(freeAccount),
          blueprintId: lease.blueprintId,
        },
      );

      // Publish BlueprintDeploymentRequest event to trigger Step Functions
      const stackSet = validatedBlueprint.stackSets[0]!;

      await isbEventBridgeClient.sendIsbEvent(
        tracer,
        new BlueprintDeploymentRequest({
          blueprintId: lease.blueprintId,
          leaseId: approvedLease.uuid,
          userEmail: approvedLease.userEmail,
          accountId: approvedLease.awsAccountId,
          blueprintName: validatedBlueprint.blueprint.name,
          stackSetId: stackSet.stackSetId,
          regions: stackSet.regions,
          regionConcurrencyType:
            validatedBlueprint.blueprint.regionConcurrencyType,
          deploymentTimeoutMinutes:
            validatedBlueprint.blueprint.deploymentTimeoutMinutes,
          maxConcurrentPercentage: stackSet.maxConcurrentPercentage,
          failureTolerancePercentage: stackSet.failureTolerancePercentage,
          concurrencyMode: stackSet.concurrencyMode,
        }),
      );

      logger.info(
        `Blueprint deployment request published for lease (${approvedLease.uuid})`,
        {
          ...searchableLeaseProperties(approvedLease),
          blueprintId: validatedBlueprint.blueprint.blueprintId,
          blueprintName: validatedBlueprint.blueprint.name,
          stackSetId: stackSet.stackSetId,
        },
      );

      // publishLease() called by Step Functions after successful deployment
      return transactionResult;
    } else {
      // No blueprint: move account and grant access immediately
      const approvedLease: PersistedMonitoredLease = {
        ...lease,
        approvedBy: approver,
        awsAccountId: freeAccount.awsAccountId,
        status: "Active",
        startDate: nowAsIsoDatetimeString(), // Placeholder - will be set in publishLease()
        totalCostAccrued: 0,
        lastCheckedDate: nowAsIsoDatetimeString(),
      };

      const transactionResult = await new Transaction(
        leaseStore.transactionalUpdate(approvedLease),
        orgsService.transactionalMoveAccount(
          {
            ...freeAccount,
            currentLease: {
              leaseId: lease.uuid,
              ownerEmail: lease.userEmail,
            },
          },
          "Available",
          "Active",
        ),
      ).complete();

      logger.info(
        "Lease approved without blueprint. Status: Active. Granting user access immediately.",
        {
          ...searchableLeaseProperties(approvedLease),
          ...searchableAccountProperties(freeAccount),
        },
      );

      await InnovationSandbox.publishLease(
        { lease: transactionResult.newItem },
        context,
      );

      return transactionResult;
    }
  }

  /**
   * Complete lease provisioning by persisting desired assignment state and
   * requesting asynchronous IDC access provisioning, then publish LeaseApprovedEvent.
   *
   * Called by approveLease() for non-blueprint leases, or by Account Lifecycle Manager
   * after successful blueprint deployment.
   *
   * @param props - Contains the lease object to publish
   * @param context - ISB context with required services
   */
  @logErrors
  public static async publishLease(
    props: {
      lease: PersistedMonitoredLease;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      principalStore: PrincipalStore;
      idcService: IdcService;
      isbEventBridgeClient: IsbEventBridgeClient;
      organizationsTaggingService: OrganizationsTaggingService;
    }>,
  ): Promise<void> {
    const { lease } = props;
    const {
      logger,
      tracer,
      leaseStore,
      principalStore,
      idcService,
      isbEventBridgeClient,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    InnovationSandbox.assertAssigneeNotM2m(lease, logger);

    const leaseUser = await idcService.getIsbMemberFromEmail(lease.userEmail);
    if (!leaseUser) {
      throw new IneligibleLeaseOwnerError(lease.userEmail);
    }

    // Set lease to Active and set startDate/expirationDate when user gets access
    const startDate = nowAsIsoDatetimeString();
    const updatedLease: PersistedMonitoredLease = {
      ...lease,
      status: "Active",
      startDate,
      expirationDate: lease.leaseDurationInHours
        ? parseDatetime(startDate)
            .plus({ hour: lease.leaseDurationInHours })
            .toISO()!
        : undefined,
    };

    await leaseStore.update(updatedLease, lease);
    logger.info(
      `Lease published: status set to Active, start time set for lease (${lease.uuid})`,
      searchableLeaseProperties(updatedLease),
    );

    const preApprovalAssignments = updatedLease.desiredAssignments ?? [];

    await triggerAssignmentProcessing(
      {
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        intent: "PUBLISH",
        desiredAssignments: preApprovalAssignments,
        // Reuse the owner validated above instead of resolving it again.
        resolvedOwner: {
          principalId: leaseUser.userId,
          principalType: "USER",
          displayName: getUserLabel(leaseUser),
          email: leaseUser.email,
        },
      },
      {
        leaseStore,
        eventBridgeClient: isbEventBridgeClient,
        principalStore,
        idcService,
        tracer,
        logger,
      },
    );

    try {
      await context.organizationsTaggingService.applyLeaseTags(
        updatedLease,
        leaseUser.userId,
      );
    } catch (error) {
      logTaggingFailure(
        logger,
        updatedLease.awsAccountId,
        [...ISB_ACCOUNT_TAG_SUFFIXES],
        error,
      );
    }

    logger.info(
      `Published lease for (${lease.userEmail}). User access granted to account (${lease.awsAccountId})`,
      {
        ...searchableLeaseProperties(updatedLease),
        accountId: updatedLease.awsAccountId,
        logDetailType: "LeasePublished",
        maxBudget: updatedLease.maxSpend,
        maxDurationHours: updatedLease.leaseDurationInHours,
        autoApproved: updatedLease.approvedBy === "AUTO_APPROVED",
        hasBlueprint: !!updatedLease.blueprintId,
        creationMethod:
          !updatedLease.createdBy ||
          updatedLease.createdBy === updatedLease.userEmail
            ? "REQUESTED"
            : "ASSIGNED",
        numDesiredAssignments: updatedLease.desiredAssignments?.length ?? 0,
      } satisfies SubscribableLog,
    );
    await isbEventBridgeClient.sendIsbEvent(
      tracer,
      new LeaseApprovedEvent({
        leaseId: updatedLease.uuid,
        userEmail: updatedLease.userEmail,
        approvedBy: updatedLease.approvedBy,
      }),
    );
  }

  /**
   * Reset a lease after blueprint deployment failure (manual approval only).
   *
   * Returns lease to "PendingApproval" status so manager can retry.
   * Unlike terminateLease(), this allows lease approval retry rather than permanent termination.
   * User access is not revoked because it was never granted.
   *
   * @param props - Lease to reset and blueprint name for logging
   * @param context - ISB context with required services
   */
  @logErrors
  public static async resetLease(
    props: {
      lease: PersistedMonitoredLease;
      blueprintName: string;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      orgsService: SandboxOuService;
      isbEventBridgeClient: IsbEventBridgeClient;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
    }>,
  ): Promise<void> {
    const { lease, blueprintName } = props;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      orgsService,
      isbEventBridgeClient,
    } = context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    const accountResponse = await sandboxAccountStore.get(lease.awsAccountId);
    const account = accountResponse.result;
    if (accountResponse.error) {
      logger.warn(
        `Error retrieving account ${lease.awsAccountId}: ${accountResponse.error}`,
      );
    }
    if (!account) {
      throw new CouldNotFindAccountError(
        `Unable to retrieve SandboxAccount information.`,
      );
    }

    addCorrelationContext(logger, searchableAccountProperties(account));

    // Clean up stack instance metadata before account cleanup (fire-and-forget)
    if (lease.blueprintId) {
      await context.blueprintDeploymentService.deleteStackInstancesMetadata(
        lease.blueprintId,
        lease.awsAccountId,
        context.blueprintStore,
      );
    }

    // Account must be cleaned before reuse
    await orgsService
      .transactionalMoveAccount(account, account.status, "CleanUp")
      .complete();

    logger.info(
      `Moved account (${account.awsAccountId}) from ${account.status} OU to CleanUp OU for lease reset`,
      searchableAccountProperties(account),
    );

    const updatedLease = await leaseStore.update({
      ...lease,
      status: "PendingApproval",
      awsAccountId: null,
      approvedBy: null,
      startDate: undefined,
      expirationDate: undefined,
      lastCheckedDate: undefined,
      totalCostAccrued: 0,
    });

    logger.info(
      `Reset lease (${lease.uuid}) to PendingApproval status. Blueprint: ${blueprintName}`,
      {
        ...searchableLeaseProperties(updatedLease.newItem),
        logDetailType: "LeaseReset",
        accountId: account.awsAccountId,
        blueprintId: lease.blueprintId,
        blueprintName,
        reasonForReset: "ProvisioningFailed",
      } satisfies SubscribableLog,
    );

    // Send events to trigger cleanup and notify about provisioning failure
    await isbEventBridgeClient.sendIsbEvents(
      tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: CleanupReasonSchema.enum.LEASE_RESET,
      }),
      new LeaseProvisioningFailedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: account.awsAccountId,
        blueprintName,
      }),
    );

    logger.info(
      `Lease reset complete for (${lease.uuid}). Manager can retry approval. Account (${account.awsAccountId}) sent for cleanup.`,
      {
        ...searchableLeaseProperties(updatedLease.newItem),
        ...searchableAccountProperties(account),
        blueprintName,
      },
    );
  }

  @logErrors
  public static async denyLease(
    props: {
      lease: PersistedPendingLease;
      denier: IsbUser;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      isbEventBridgeClient: IsbEventBridgeClient;
      globalConfig: GlobalConfig;
    }>,
  ) {
    const { lease, denier } = props;
    const { logger, tracer, leaseStore, isbEventBridgeClient, globalConfig } =
      context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    await leaseStore.update({
      ...lease,
      status: "ApprovalDenied",
      approvedBy: getUserEmail(denier),
      ttl: calculateTtlInEpochSeconds(globalConfig.leases.ttl),
    });

    logger.info(
      `(${getUserEmail(denier)}) denied lease request for (${lease.userEmail})`,
    );

    await isbEventBridgeClient.sendIsbEvent(
      tracer,
      new LeaseDeniedEvent({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        deniedBy: getUserEmail(denier),
      }),
    );
  }

  /**
   * Eject an account from the solution. This will remove the account from the AccountPool WITHOUT passing it
   * through any additional cleanup steps. The account will be placed into the Exit OU EXACTLY AS IS
   *
   * Any active lease associated with the account will be terminated with a status of "Ejected"
   */
  @logErrors
  public static async ejectAccount(
    props: {
      sandboxAccount: PersistedSandboxAccount;
    },
    context: IsbContext<{
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      sandboxAccountStore: SandboxAccountStore;
      leaseStore: LeaseStore;
      idcService: IdcService;
      globalConfig: GlobalConfig;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      organizationsTaggingService: OrganizationsTaggingService;
      sandboxSpacesUsageStore: SandboxSpacesUsageStore;
    }>,
  ) {
    const { sandboxAccount } = props;
    const { logger, orgsService, sandboxAccountStore, idcService } = context;

    addCorrelationContext(logger, searchableAccountProperties(sandboxAccount));

    if (sandboxAccount.status == "CleanUp") {
      throw new AccountInCleanUpError(
        "Accounts cannot be ejected while in the CleanUp state.",
      );
    }

    await InnovationSandbox.terminateLeasesAssociatedWithAccount(context, {
      awsAccountId: sandboxAccount.awsAccountId,
      reason: "Ejected",
    }).catch(() =>
      logger.error(
        `Error terminating leases associated with account (${sandboxAccount.awsAccountId})`,
        { ...searchableAccountProperties(sandboxAccount) },
      ),
    );

    try {
      await context.organizationsTaggingService.untagAccount(
        sandboxAccount.awsAccountId,
        [...ISB_ACCOUNT_TAG_SUFFIXES],
      );
    } catch (error) {
      logUntaggingFailure(
        logger,
        sandboxAccount.awsAccountId,
        [...ISB_ACCOUNT_TAG_SUFFIXES],
        error,
      );
    }

    await orgsService.performAccountMoveAction(
      sandboxAccount.awsAccountId,
      sandboxAccount.status,
      "Exit",
    );
    await idcService.revokeGroupAccess(sandboxAccount.awsAccountId, "Manager");
    await idcService.revokeGroupAccess(sandboxAccount.awsAccountId, "Admin");
    await sandboxAccountStore.delete(sandboxAccount.awsAccountId);

    logger.info(`Account (${sandboxAccount.awsAccountId}) ejected)`, {
      ...searchableAccountProperties(sandboxAccount),
    });
  }

  /**
   * force quarantine an account found within the Sandbox OUs. This account will be moved to the Quarantine OU and
   * updated in the account table.
   *
   * If any active leases are associated with the account, they will be terminated with a status of "AccountQuarantined"
   * no notifications will be sent to the owner of the lease
   *
   * note: in order to move the account, the OU that the account currently resides in must be provided
   */
  @logErrors
  public static async quarantineAccount(
    props: {
      accountId: string;
      currentOu: IsbOu;
      reason: string;
      reasonForQuarantine: ReasonForQuarantine;
    },
    context: IsbContext<{
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      leaseStore: LeaseStore;
      globalConfig: GlobalConfig;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      organizationsTaggingService: OrganizationsTaggingService;
      sandboxSpacesUsageStore: SandboxSpacesUsageStore;
    }>,
  ) {
    const { accountId, currentOu, reason, reasonForQuarantine } = props;
    const {
      logger,
      tracer,
      orgsService,
      eventBridgeClient,
      sandboxAccountStore,
    } = context;

    //find account record if exists, otherwise create a new one
    const accountResponse = await sandboxAccountStore.get(accountId);
    if (accountResponse.error) {
      logger.warn(
        `Error retrieving account ${accountId}: ${accountResponse.error}`,
      );
    }

    const accountRecord: PersistedSandboxAccount = accountResponse.result ?? {
      awsAccountId: accountId,
      status: "Quarantine",
      driftAtLastScan: true,
    };

    addCorrelationContext(logger, searchableAccountProperties(accountRecord));
    await InnovationSandbox.terminateLeasesAssociatedWithAccount(context, {
      awsAccountId: accountId,
      reason: "AccountQuarantined",
    });

    await orgsService
      .transactionalMoveAccount(accountRecord, currentOu, "Quarantine")
      .complete();

    try {
      await context.organizationsTaggingService.updateStatusTag(
        accountId,
        "Quarantine",
      );
    } catch (error) {
      logTaggingFailure(logger, accountId, ["Status"], error);
    }

    logger.warn(`Account (${accountId}) quarantined: ${reason}`, {
      ...searchableAccountProperties(accountRecord),
      logDetailType: "AccountQuarantined",
      accountId,
      reasonForQuarantine,
    } satisfies SubscribableLog);

    await eventBridgeClient.sendIsbEvent(
      tracer,
      new AccountQuarantinedEvent({
        awsAccountId: accountId,
        reason,
      }),
    );
  }

  private static async terminateLeasesAssociatedWithAccount(
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      globalConfig: GlobalConfig;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      organizationsTaggingService: OrganizationsTaggingService;
      sandboxSpacesUsageStore: SandboxSpacesUsageStore;
    }>,
    props: {
      awsAccountId: string;
      reason: ExpiredLeaseStatus;
    },
  ): Promise<void> {
    const { logger, leaseStore } = context;
    const { awsAccountId, reason } = props;

    for (const monitoredStatus of MonitoredLeaseStatusSchema.options) {
      for await (const monitoredLease of stream(
        leaseStore,
        leaseStore.findByStatusAndAccountID,
        {
          status: monitoredStatus,
          awsAccountId,
        },
      )) {
        // if it's already a monitored lease why do we want this check
        if (!isMonitoredLease(monitoredLease)) {
          logger.warn(
            `leaseStore.findByStatusAndAccountID(${monitoredStatus}) returned an inactive lease! Returned leaseStatus ${monitoredLease.status}`,
            {
              ...searchableLeaseProperties(monitoredLease),
            },
          );
          continue;
        }

        await InnovationSandbox.terminateLease(
          {
            lease: monitoredLease,
            autoCleanup: false,
            expiredStatus: reason,
          },
          context,
        ).catch((error) => {
          logger.error(
            `Error while terminating lease (${monitoredLease.uuid}) associated with account (${awsAccountId}).`,
            { awsAccountId, ...searchableLeaseProperties(monitoredLease) },
          );
          throw error;
        });

        logger.info(
          `Lease (${monitoredLease.uuid}) associated with account (${awsAccountId}) terminated. Reason: ${reason}`,
          {
            ...searchableLeaseProperties(monitoredLease),
          },
        );
      }
    }
  }

  /**
   * Defense-in-depth: an IDC-grant path (approveLease/publishLease) must never
   * run for an M2M-assignee lease. The postLeaseHandler entry guard makes this
   * unreachable in normal operation, so reaching it signals legacy data or a
   * bypass path — log loudly and fail (maps to HTTP 500).
   */
  private static assertAssigneeNotM2m(
    lease: PersistedLease,
    logger: Logger,
  ): void {
    if (isSyntheticM2mEmail(lease.userEmail)) {
      logger.error(
        "M2M-assignee lease reached an IDC-grant code path — should be impossible",
        { leaseId: lease.uuid },
      );
      throw new M2mAssigneeNotAllowedError(
        "Lease assignee is an M2M client; this lease cannot be processed by the IDC grant flow. This indicates a data integrity issue.",
      );
    }
  }

  private static async acquireAvailableAccount(
    context: IsbContext<{
      sandboxAccountStore: SandboxAccountStore;
    }>,
  ): Promise<PersistedSandboxAccount> {
    const { sandboxAccountStore, logger } = context;

    const availableAccounts = await collect(
      stream(sandboxAccountStore, sandboxAccountStore.findByStatus, {
        status: "Available",
      }),
    );

    if (availableAccounts.length === 0) {
      throw new NoAccountsAvailableError(
        "No new sandbox accounts are currently available.",
      );
    }

    // Implement soft cooldown: separate accounts by 24-hour usage threshold
    const twentyFourHoursAgo = now().minus({ hours: 24 });
    const preferredAccounts: PersistedSandboxAccount[] = [];
    const fallbackAccounts: PersistedSandboxAccount[] = [];

    for (const account of availableAccounts) {
      const lastCleanupTime = account.lastCleanupCompletedAt;

      if (!lastCleanupTime) {
        // No timestamp - preferred (never used or no recent cleanup history)
        preferredAccounts.push(account);
      } else if (parseDatetime(lastCleanupTime) <= twentyFourHoursAgo) {
        // Timestamp > 24 hours old - preferred
        preferredAccounts.push(account);
      } else {
        // Timestamp < 24 hours old - fallback only
        fallbackAccounts.push(account);
      }
    }

    let selectedAccount: PersistedSandboxAccount;

    if (preferredAccounts.length > 0) {
      // Randomly select from preferred accounts (no timestamp or > 24 hours old)
      selectedAccount =
        preferredAccounts[
          Math.floor(Math.random() * preferredAccounts.length) // NOSONAR typescript:S2245 - pseudorandom number generator is used to introduce randomization to the account selection process
        ]!;
    } else {
      // Fallback: randomly select from recently used accounts (< 24 hours old)
      selectedAccount =
        fallbackAccounts[
          Math.floor(Math.random() * fallbackAccounts.length) // NOSONAR typescript:S2245 - pseudorandom number generator is used to introduce randomization to the account selection process
        ]!;

      const lastCleanupTime = selectedAccount.lastCleanupCompletedAt;
      if (lastCleanupTime) {
        const lastLeaseDate = parseDatetime(lastCleanupTime);

        logger.warn(
          "The account acquired for the lease has been used within the last 24 hours and may result in inaccurate cost data",
          {
            ...searchableAccountProperties(selectedAccount),
            lastCleanupTime,
            hoursSinceLastUse: now().diff(lastLeaseDate, "hours").hours,
            totalAvailableAccounts: availableAccounts.length,
            preferredAccountsAvailable: preferredAccounts.length,
          },
        );
      }
    }

    return selectedAccount;
  }
}

/**
 * decorator function for automatically logging any errors thrown by the function to the provided logger using
 * logger.error() before re-throwing the error back to the context
 *
 * this decorator expects to wrap a 2-argument function whose second argument is an IsbContext<> (or any other object with {logger: Logger})
 */
function logErrors<
  T extends { logger: Logger },
  This,
  Args extends [any, T],
  Return,
>(
  originalMethod: (props: any, context: T) => any,
  decoratorContext: ClassMethodDecoratorContext<
    This,
    (this: This, ...args: Args) => Return
  >,
) {
  async function decoratedMethod(this: This, ...args: Args) {
    try {
      return await originalMethod.call(this, ...args);
    } catch (error) {
      args[1].logger.error(
        `An error occurred performing action (${decoratorContext.name.toString()}): ${error}`,
      );
      throw error;
    }
  }

  return decoratedMethod;
}

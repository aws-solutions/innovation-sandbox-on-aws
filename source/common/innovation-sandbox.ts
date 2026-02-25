// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";

import { BlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint-store.js";
import { PutResult } from "@amzn/innovation-sandbox-commons/data/common-types.js";
import { GlobalConfig } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { LeaseTemplateStore } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template-store.js";
import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  ExpiredLeaseStatus,
  isActiveLease,
  isFrozenLease,
  isMonitoredLease,
  Lease,
  LeaseKeySchema,
  LeaseStatus,
  MonitoredLease,
  MonitoredLeaseStatusSchema,
  PendingLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { SandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account-store.js";
import {
  IsbOu,
  SandboxAccount,
} from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { AccountQuarantinedEvent } from "@amzn/innovation-sandbox-commons/events/account-quarantined-event.js";
import { BlueprintDeploymentRequest } from "@amzn/innovation-sandbox-commons/events/blueprint-deployment-request.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { LeaseApprovedEvent } from "@amzn/innovation-sandbox-commons/events/lease-approved-event.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import {
  LeaseFrozenEvent,
  LeaseFrozenReason,
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
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { SubscribableLog } from "@amzn/innovation-sandbox-commons/observability/log-types.js";
import {
  addCorrelationContext,
  searchableAccountProperties,
  searchableLeaseProperties,
  searchableLeaseTemplateProperties,
} from "@amzn/innovation-sandbox-commons/observability/logging.js";
import {
  IsbEvent,
  IsbEventBridgeClient,
} from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbUser } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import {
  calculateTtlInEpochSeconds,
  datetimeAsString,
  now,
  nowAsIsoDatetimeString,
  parseDatetime,
} from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Transaction } from "@amzn/innovation-sandbox-commons/utils/transactions.js";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { randomUUID } from "crypto";

export class InnovationSandboxError extends Error {}
export class NoAccountsAvailableError extends InnovationSandboxError {}
export class MaxNumberOfLeasesExceededError extends InnovationSandboxError {}
export class AccountNotInQuarantineError extends InnovationSandboxError {}
export class AccountInCleanUpError extends InnovationSandboxError {}
export class AccountNotInActiveError extends InnovationSandboxError {}
export class AccountNotInFrozenError extends InnovationSandboxError {}
export class CouldNotFindAccountError extends InnovationSandboxError {}
export class CouldNotRetrieveUserError extends InnovationSandboxError {}

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
    }>,
  ): Promise<SandboxAccount> {
    const { logger, eventBridgeClient, orgsService, idcService } = context;

    const account = await orgsService.describeAccount({ accountId });
    if (account === undefined) {
      throw new CouldNotFindAccountError("Could not find account to register.");
    }
    let newSandboxAccount: SandboxAccount = {
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

    logger.info(
      `Registered new SandboxAccount (${newSandboxAccount.awsAccountId}). Awaiting Cleanup...`,
    );

    await eventBridgeClient.sendIsbEvents(
      context.tracer,
      new CleanAccountRequest({
        accountId: newSandboxAccount.awsAccountId,
        reason: "ACCOUNT_REGISTRATION",
      }),
    );

    return newSandboxAccount;
  }

  @logErrors
  public static async requestLease(
    props: {
      leaseTemplate: LeaseTemplate;
      comments?: string;
      targetUser: IsbUser;
      createdBy?: string;
    },
    context: IsbContext<{
      globalConfig: GlobalConfig;
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      isbEventBridgeClient: IsbEventBridgeClient;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      leaseTemplateStore: LeaseTemplateStore;
    }>,
  ) {
    const { leaseTemplate, comments, targetUser, createdBy } = props;
    const { logger, tracer, leaseStore, isbEventBridgeClient, globalConfig } =
      context;

    addCorrelationContext(
      logger,
      searchableLeaseTemplateProperties(leaseTemplate),
    );

    const numOfActiveLeases = (
      await collect(
        stream(leaseStore, leaseStore.findByUserEmail, {
          userEmail: targetUser.email,
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

    let newLease: Lease = await leaseStore.create({
      userEmail: targetUser.email,
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
      createdBy: createdBy || targetUser.email,
      blueprintId: leaseTemplate.blueprintId,
      blueprintName: leaseTemplate.blueprintName,
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
      `Lease of type (${leaseTemplate.name}) (${leaseTemplate.uuid}) ${actionType} for (${targetUser.email}) ${actionBy}`,
      {
        ...searchableLeaseProperties(newLease),
      },
    );

    return newLease;
  }

  @logErrors
  public static async freezeLease(
    props: {
      lease: Lease;
      reason: LeaseFrozenReason;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
    }>,
  ) {
    const { lease, reason } = props;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      idcService,
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

    const user = await idcService.getUserFromEmail(lease.userEmail);
    if (!user) {
      throw new CouldNotRetrieveUserError(
        "Unable to retrieve user information.",
      );
    }

    await idcService.revokeAllUserAccess(account.awsAccountId);

    await new Transaction(
      orgsService.transactionalMoveAccount(account, "Active", "Frozen"),
      leaseStore.transactionalUpdate({
        ...lease,
        status: "Frozen",
      }),
    ).complete();

    logger.info(
      `Lease of type (${lease.originalLeaseTemplateName}) for (${user.email}) frozen. Account (${account.awsAccountId}) Frozen: ${reason.type}`,
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
  }

  @logErrors
  public static async terminateLease(
    props: {
      lease: MonitoredLease;
      expiredStatus: ExpiredLeaseStatus;
      autoCleanup?: boolean; //default true
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
      globalConfig: GlobalConfig;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
    }>,
  ) {
    const { lease, expiredStatus } = props;
    const autoCleanup = props.autoCleanup ?? true;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      idcService,
      orgsService,
      eventBridgeClient,
      globalConfig,
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

    const user = await idcService.getUserFromEmail(lease.userEmail);
    if (!user) {
      throw new CouldNotRetrieveUserError(
        "Unable to retrieve user information.",
      );
    }

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
      eventsToSend.push(
        new CleanAccountRequest({
          accountId: account.awsAccountId,
          reason: "LEASE_TERMINATION",
        }),
      );
    }

    await leaseStore.update({
      ...lease,
      status: expiredStatus,
      endDate: nowAsIsoDatetimeString(),
      ttl: calculateTtlInEpochSeconds(globalConfig.leases.ttl),
    });

    await idcService.revokeAllUserAccess(account.awsAccountId);

    eventsToSend.push(
      new LeaseTerminatedEvent({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: account.awsAccountId,
        reason: getLeaseTerminatedReason(expiredStatus, lease),
      }),
    );

    logger.info(
      `Lease of type (${lease.originalLeaseTemplateName}) for (${user.email}) terminated. Reason: ${expiredStatus}. ${autoCleanup && `SandboxAccount (${account.awsAccountId}) sent for cleanup.`}`, //NOSONAR
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
      } satisfies SubscribableLog,
    );

    await eventBridgeClient.sendIsbEvents(tracer, ...eventsToSend);
  }

  @logErrors
  public static async unfreezeLease(
    props: {
      lease: Lease;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      eventBridgeClient: IsbEventBridgeClient;
    }>,
  ): Promise<PutResult<Lease>> {
    const { lease } = props;
    const {
      logger,
      tracer,
      leaseStore,
      sandboxAccountStore,
      idcService,
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

    const user = await idcService.getUserFromEmail(lease.userEmail);
    if (!user) {
      throw new CouldNotRetrieveUserError(
        "Unable to retrieve user information.",
      );
    }
    const transactionResult = await new Transaction(
      leaseStore.transactionalUpdate({
        ...lease,
        status: "Active",
      }),
      orgsService.transactionalMoveAccount(account, "Frozen", "Active"),
      idcService.transactionalGrantUserAccess(account.awsAccountId, user),
    ).complete();

    logger.info(
      `Lease of type (${lease.originalLeaseTemplateName}) for (${user.email}) unfrozen. Account (${account.awsAccountId}) Active`,
      {
        ...searchableAccountProperties(account),
        ...searchableLeaseProperties(lease),
        logDetailType: "LeaseUnfrozen",
      } satisfies SubscribableLog,
    );

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
      sandboxAccount: SandboxAccount;
    },
    context: IsbContext<{
      sandboxAccountStore: SandboxAccountStore;
      eventBridgeClient: IsbEventBridgeClient;
      orgsService: SandboxOuService;
    }>,
  ) {
    const { sandboxAccount } = props;
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

    if (sandboxAccount.status != "CleanUp")
      await orgsService
        .transactionalMoveAccount(sandboxAccount, "Quarantine", "CleanUp")
        .complete();

    await eventBridgeClient.sendIsbEvents(
      tracer,
      new CleanAccountRequest({
        accountId: sandboxAccount.awsAccountId,
        reason: "RETRY_FAILED_CLEANUP",
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
      lease: Lease;
      approver: string;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      sandboxAccountStore: SandboxAccountStore;
      idcService: IdcService;
      orgsService: SandboxOuService;
      isbEventBridgeClient: IsbEventBridgeClient;
      blueprintStore: BlueprintStore;
      blueprintDeploymentService: BlueprintDeploymentService;
      leaseTemplateStore: LeaseTemplateStore;
    }>,
  ): Promise<PutResult<Lease>> {
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

    // Acquire an available account from the pool and get user info
    const [freeAccount, leaseUser] = await Promise.all([
      InnovationSandbox.acquireAvailableAccount(context),
      idcService.getUserFromEmail(lease.userEmail),
    ]);

    if (!leaseUser) {
      throw new CouldNotRetrieveUserError(
        "Unable to retrieve user information.",
      );
    }

    // Simple conditional: no blueprint vs has blueprint
    if (!lease.blueprintId) {
      // No blueprint: move account and grant access immediately
      const approvedLease: MonitoredLease = {
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
          freeAccount,
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

      await InnovationSandbox.publishLease({ lease: approvedLease }, context);

      return transactionResult;
    } else {
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

      const approvedLease: MonitoredLease = {
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
          freeAccount,
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
    }
  }

  /**
   * Complete lease provisioning by granting user access and sending LeaseApprovedEvent.
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
      lease: MonitoredLease;
    },
    context: IsbContext<{
      leaseStore: LeaseStore;
      idcService: IdcService;
      isbEventBridgeClient: IsbEventBridgeClient;
    }>,
  ): Promise<void> {
    const { lease } = props;
    const { logger, tracer, leaseStore, idcService, isbEventBridgeClient } =
      context;

    addCorrelationContext(logger, searchableLeaseProperties(lease));

    const leaseUser = await idcService.getUserFromEmail(lease.userEmail);
    if (!leaseUser) {
      throw new CouldNotRetrieveUserError(
        "Unable to retrieve user information.",
      );
    }

    // Set lease to Active and set startDate/expirationDate when user gets access
    const updatedLease: MonitoredLease = {
      ...lease,
      status: "Active",
      startDate: nowAsIsoDatetimeString(),
      expirationDate: lease.leaseDurationInHours
        ? now().plus({ hour: lease.leaseDurationInHours }).toISO()
        : undefined,
    };

    await leaseStore.update(updatedLease);
    logger.info(
      `Lease published: status set to Active, start time set for lease (${lease.uuid})`,
      searchableLeaseProperties(updatedLease),
    );

    await idcService
      .transactionalGrantUserAccess(lease.awsAccountId, leaseUser)
      .complete();

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
      lease: MonitoredLease;
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
        reason: "LEASE_RESET",
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
      lease: PendingLease;
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
      approvedBy: denier.email,
      ttl: calculateTtlInEpochSeconds(globalConfig.leases.ttl),
    });

    logger.info(
      `(${denier.email}) denied lease request for (${lease.userEmail})`,
    );

    await isbEventBridgeClient.sendIsbEvent(
      tracer,
      new LeaseDeniedEvent({
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        deniedBy: denier.email,
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
      sandboxAccount: SandboxAccount;
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
    }>,
  ) {
    const { accountId, currentOu, reason } = props;
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

    const accountRecord: SandboxAccount = accountResponse.result ?? {
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

    logger.warn(`Account (${accountId}) quarantined: ${reason}`, {
      ...searchableAccountProperties(accountRecord),
    });

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

  private static async acquireAvailableAccount(
    context: IsbContext<{
      sandboxAccountStore: SandboxAccountStore;
    }>,
  ): Promise<SandboxAccount> {
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
    const preferredAccounts: SandboxAccount[] = [];
    const fallbackAccounts: SandboxAccount[] = [];

    for (const account of availableAccounts) {
      const lastCleanupTime =
        account.cleanupExecutionContext?.stateMachineExecutionStartTime;

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

    let selectedAccount: SandboxAccount;

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

      const lastCleanupTime =
        selectedAccount.cleanupExecutionContext
          ?.stateMachineExecutionStartTime!;
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

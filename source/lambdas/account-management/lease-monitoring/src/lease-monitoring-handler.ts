// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";
import { DateTime } from "luxon";

import { PersistedMonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import {
  AccountsCostReport,
  CostExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  LeaseMonitoringEnvironment,
  LeaseMonitoringEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/lease-monitoring-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { searchableLeaseProperties } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import { IsbEvent } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  BudgetThreshold,
  DurationThreshold,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";

const serviceName = "LeaseMonitoring";
const tracer = new Tracer();

type BreachedDurationThreshold = DurationThreshold & {
  leaseExpirationDate: string;
};
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: LeaseMonitoringEnvironmentSchema,
  moduleName: "lease-monitoring",
}).handler(performAccountMonitoringScan);

export async function performAccountMonitoringScan(
  _event: EventBridgeEvent<string, unknown>,
  context: Context & ValidatedEnvironment<LeaseMonitoringEnvironment>,
): Promise<string> {
  const isbEventBridge = IsbServices.isbEventBridge(context.env);
  const costExplorerService = IsbServices.costExplorer(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const leaseStore = IsbServices.leaseStore(context.env);

  const monitoredLeases = [
    ...(await collect(
      stream(leaseStore, leaseStore.findByStatus, {
        status: "Active",
      }),
    )),
    ...(await collect(
      stream(leaseStore, leaseStore.findByStatus, {
        status: "Frozen",
      }),
    )),
  ] as PersistedMonitoredLease[];
  logger.debug(
    `Running cost monitoring for ${JSON.stringify(
      monitoredLeases.map((lease) => [lease.awsAccountId, lease.uuid]),
    )}`,
  );

  const currentDateTime = now();
  const latestCostReport = await getLatestCostReport(
    costExplorerService,
    monitoredLeases,
    currentDateTime,
  );

  const eventsToSend = [];

  for (const lease of monitoredLeases) {
    const leaseEvents = determineLeaseEvents({
      lease,
      latestCostReport,
      currentDateTime,
    });
    if (leaseEvents.length == 0) {
      logger.info(`no new lease events detected for lease ${lease.uuid}`, {
        ...searchableLeaseProperties(lease),
      });
    } else {
      eventsToSend.push(...leaseEvents);
    }
  }

  //send events
  await isbEventBridge.sendIsbEvents(tracer, ...eventsToSend);

  //update db values
  for (const lease of monitoredLeases) {
    await leaseStore.update({
      ...lease,
      totalCostAccrued: latestCostReport.getCost(lease.awsAccountId),
      lastCheckedDate: currentDateTime.toISO(),
    });
  }

  return `completed lease monitoring scan for ${monitoredLeases.length} leases and generated ${eventsToSend.length} events`;
}

/**
 * Queries `getCostForLeasesByTag` for the lease-tagged spend, then routes any leases
 * absent from the tag report to the legacy `getCostForLeases` fallback. The
 * tag report is keyed by lease UUID; the merged report is keyed by AWS
 * account ID so the existing `determineLeaseEvents` and DB-update code can
 * look up cost by `lease.awsAccountId` unchanged.
 **/
async function getLatestCostReport(
  costExplorerService: CostExplorerService,
  monitoredLeases: PersistedMonitoredLease[],
  currentDateTime: DateTime<true>,
): Promise<AccountsCostReport> {
  if (monitoredLeases.length === 0) {
    return new AccountsCostReport();
  }

  const earliestStart = DateTime.fromMillis(
    Math.min(
      ...monitoredLeases.map((lease) =>
        DateTime.fromISO(lease.startDate, { zone: "utc" }).toMillis(),
      ),
    ),
    { zone: "utc" },
  );

  const tagReport = await costExplorerService.getCostForLeasesByTag(
    monitoredLeases.map((l) => l.uuid),
    earliestStart,
    currentDateTime,
  );

  const fallbackLeases = monitoredLeases.filter(
    (l) => !(l.uuid in tagReport.costMap),
  );

  // Tag-only path: every lease covered by the tag report. One CE call total.
  if (fallbackLeases.length === 0) {
    const accountKeyed = new AccountsCostReport();
    for (const lease of monitoredLeases) {
      accountKeyed.addCost(lease.awsAccountId, tagReport.getCost(lease.uuid));
    }
    return accountKeyed;
  }

  const fallbackReport = await costExplorerService.getCostForLeases(
    Object.fromEntries(
      fallbackLeases.map((l) => [
        l.awsAccountId,
        DateTime.fromISO(l.startDate, { zone: "utc" }),
      ]),
    ),
    currentDateTime,
  );

  // Fallback-only path: no tag coverage at all. Return the fallback report
  // directly so it preserves identity for legacy callers/tests.
  if (Object.keys(tagReport.costMap).length === 0) {
    return fallbackReport;
  }

  // Mixed path: rekey tag report from lease UUID → account ID, then merge.
  const merged = new AccountsCostReport();
  for (const lease of monitoredLeases) {
    if (lease.uuid in tagReport.costMap) {
      merged.addCost(lease.awsAccountId, tagReport.getCost(lease.uuid));
    }
  }
  merged.merge(fallbackReport);
  return merged;
}

function determineLeaseEvents(props: {
  lease: PersistedMonitoredLease;
  latestCostReport: AccountsCostReport;
  currentDateTime: DateTime<true>;
}): IsbEvent[] {
  const { lease, latestCostReport, currentDateTime } = props;
  //max budget/duration events clobber all other events
  if (maxBudgetExceeded(lease, latestCostReport)) {
    logger.info(
      `Lease (${lease.uuid}) budget exceeded, sending message to ISB bus`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    return [
      new LeaseBudgetExceededAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        budget: lease.maxSpend,
        totalSpend: latestCostReport.getCost(lease.awsAccountId),
      }),
    ];
  }

  if (isExpired(lease, currentDateTime)) {
    logger.info(`Lease (${lease.uuid}) expired, sending message to ISB bus`, {
      ...searchableLeaseProperties(lease),
    });
    return [
      new LeaseExpiredAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        leaseExpirationDate: lease.expirationDate,
      }),
    ];
  }

  //report threshold breaches if and only if the lease has not expired/exceeded budget
  const leaseEvents: IsbEvent[] = [];

  const breachedBudgetThresholds = detectNewlyBreachedBudgetThresholds(
    lease,
    latestCostReport,
  );
  const breachedDurationThresholds = detectNewlyBreachedDurationThresholds(
    lease,
    currentDateTime,
  );
  const totalCostSpent = latestCostReport.getCost(lease.awsAccountId);
  const canFreeze = lease.status === "Active";
  const eligibleBudgetThresholds = canFreeze
    ? breachedBudgetThresholds
    : breachedBudgetThresholds.filter(
        (threshold) => threshold.action !== "FREEZE_ACCOUNT",
      );
  const largestBreachedBudgetThreshold = getLargestBudgetThreshold(
    eligibleBudgetThresholds,
  );
  const budgetFreezeThreshold = canFreeze
    ? breachedBudgetThresholds.find(
        (threshold) => threshold.action === "FREEZE_ACCOUNT",
      )
    : undefined;
  const eligibleDurationThresholds = canFreeze
    ? breachedDurationThresholds
    : breachedDurationThresholds.filter(
        (threshold) => threshold.action !== "FREEZE_ACCOUNT",
      );
  const latestBreachedDurationTheshold = getLatestDurationThreshold(
    eligibleDurationThresholds,
  );
  const durationFreezeThreshold = canFreeze
    ? breachedDurationThresholds.find(
        (threshold) => threshold.action === "FREEZE_ACCOUNT",
      )
    : undefined;

  // Only Active leases can transition to Frozen. A Frozen lease still has its
  // corrected cost persisted and can still be terminated by maxSpend above.
  if (budgetFreezeThreshold) {
    logger.info(
      `Lease (${lease.uuid}) budget freeze threshold crossed ` +
        `(threshold: $${budgetFreezeThreshold.dollarsSpent}, costAccrued: $${totalCostSpent}) ` +
        `requesting freeze`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    leaseEvents.push(
      new LeaseFreezingThresholdBreachedAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: budgetFreezeThreshold.dollarsSpent,
          budget: lease.maxSpend,
          totalSpend: totalCostSpent,
        },
      }),
    );
  } else if (durationFreezeThreshold) {
    logger.info(
      `Lease (${lease.uuid}) freezing duration threshold crossed ` +
        `(threshold: ${durationFreezeThreshold.hoursRemaining} hours remaining) ` +
        `requesting freeze`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    leaseEvents.push(
      new LeaseFreezingThresholdBreachedAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        reason: {
          type: "Expired",
          triggeredDurationThreshold: durationFreezeThreshold.hoursRemaining,
          leaseDurationInHours: lease.leaseDurationInHours!,
        },
      }),
    );
  }

  //get latest budget/duration alerts (freeze has already been dealt with above)
  if (
    largestBreachedBudgetThreshold &&
    largestBreachedBudgetThreshold.action != "FREEZE_ACCOUNT"
  ) {
    logger.info(
      `Lease (${lease.uuid}) budget threshold crossed ` +
        `(threshold: $${largestBreachedBudgetThreshold.dollarsSpent}, costAccrued: $${totalCostSpent}) ` +
        `sending message to ISB bus`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    leaseEvents.push(
      new LeaseBudgetThresholdBreachedAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        budget: lease.maxSpend,
        budgetThresholdTriggered: largestBreachedBudgetThreshold.dollarsSpent,
        totalSpend: totalCostSpent,
        actionRequested: largestBreachedBudgetThreshold.action,
      }),
    );
  }

  if (
    latestBreachedDurationTheshold &&
    latestBreachedDurationTheshold.action != "FREEZE_ACCOUNT"
  ) {
    logger.info(
      `Lease (${lease.uuid}) duration threshold crossed ` +
        `(threshold: ${latestBreachedDurationTheshold.hoursRemaining} hours remaining) ` +
        `sending message to ISB bus`,
      {
        ...searchableLeaseProperties(lease),
      },
    );
    leaseEvents.push(
      new LeaseDurationThresholdBreachedAlert({
        leaseId: {
          userEmail: lease.userEmail,
          uuid: lease.uuid,
        },
        accountId: lease.awsAccountId,
        triggeredDurationThreshold:
          latestBreachedDurationTheshold.hoursRemaining,
        leaseDurationInHours: Math.round(
          DateTime.fromISO(latestBreachedDurationTheshold.leaseExpirationDate, {
            zone: "utc",
          }).diff(DateTime.fromISO(lease.startDate, { zone: "utc" }), "hour")
            .hours,
        ),
        actionRequested: latestBreachedDurationTheshold.action,
      }),
    );
  }

  return leaseEvents;
}

function isExpired(
  lease: PersistedMonitoredLease,
  currentDate: DateTime,
): lease is PersistedMonitoredLease & { expirationDate: string } {
  return (
    lease.expirationDate !== undefined &&
    DateTime.fromISO(lease.expirationDate, { zone: "utc" }) < currentDate
  );
}

function maxBudgetExceeded(
  lease: PersistedMonitoredLease,
  costs: AccountsCostReport,
): lease is PersistedMonitoredLease & { maxSpend: number } {
  return (
    lease.maxSpend !== undefined &&
    costs.getCost(lease.awsAccountId) >= lease.maxSpend
  );
}

function detectNewlyBreachedBudgetThresholds(
  lease: PersistedMonitoredLease,
  costs: AccountsCostReport,
) {
  const newlyExceededThresholds = [];

  for (const budgetThreshold of lease.budgetThresholds ?? []) {
    if (
      lease.totalCostAccrued < budgetThreshold.dollarsSpent && //newly exceeded
      budgetThreshold.dollarsSpent <= costs.getCost(lease.awsAccountId)
    ) {
      newlyExceededThresholds.push(budgetThreshold);
    }
  }

  return newlyExceededThresholds;
}

function detectNewlyBreachedDurationThresholds(
  lease: PersistedMonitoredLease,
  currentDate: DateTime,
) {
  const leaseExpirationDate = lease.expirationDate;
  if (leaseExpirationDate === undefined) {
    return [];
  }
  const newlyExceededThresholds: BreachedDurationThreshold[] = [];
  const expirationDate = DateTime.fromISO(leaseExpirationDate, {
    zone: "utc",
  });
  const lastCheckedDate = DateTime.fromISO(lease.lastCheckedDate, {
    zone: "utc",
  });

  for (const durationThreshold of lease.durationThresholds ?? []) {
    const thresholdDate = expirationDate.minus({
      hours: durationThreshold.hoursRemaining,
    });

    if (
      lastCheckedDate < thresholdDate && //newly exceeded
      thresholdDate <= currentDate
    ) {
      newlyExceededThresholds.push({
        ...durationThreshold,
        leaseExpirationDate,
      });
    }
  }

  return newlyExceededThresholds;
}

function getLargestBudgetThreshold(budgetThresholds: BudgetThreshold[]) {
  const [firstThreshold, ...remainingThresholds] = budgetThresholds;
  if (firstThreshold === undefined) return undefined;
  return remainingThresholds.reduce(
    (prev, current) =>
      prev.dollarsSpent > current.dollarsSpent ? prev : current,
    firstThreshold,
  );
}

function getLatestDurationThreshold(
  durationThresholds: BreachedDurationThreshold[],
) {
  const [firstThreshold, ...remainingThresholds] = durationThresholds;
  if (firstThreshold === undefined) return undefined;
  return remainingThresholds.reduce(
    (prev, current) =>
      prev.hoursRemaining < current.hoursRemaining ? prev : current,
    firstThreshold,
  );
}

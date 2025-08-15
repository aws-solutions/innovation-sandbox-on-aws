// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { Context, EventBridgeEvent } from "aws-lambda";
import { DateTime } from "luxon";

import {
  BudgetThreshold,
  DurationThreshold,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { MonitoredLease } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { AccountsCostReport } from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
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

const serviceName = "LeaseMonitoring";
const tracer = new Tracer();
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
  ] as MonitoredLease[];
  const accountsWithStartDates = Object.fromEntries(
    monitoredLeases.map((lease) => [
      lease.awsAccountId,
      DateTime.fromISO(lease.startDate, { zone: "utc" }),
    ]),
  ) as Record<string, DateTime>;
  logger.debug(
    `Running cost monitoring for ${JSON.stringify(
      monitoredLeases.map((lease) => [lease.awsAccountId, lease.uuid]),
    )}`,
  );

  const currentDateTime = now();
  logger.info("Starting Cost Explorer data retrieval", {
    accountsWithStartDates: Object.fromEntries(
      Object.entries(accountsWithStartDates).map(([accountId, date]) => [
        accountId,
        date.toISO(),
      ])
    ),
    currentDateTime: currentDateTime.toISO(),
  });

  const latestCostReport = await costExplorerService.getCostForLeases(
    accountsWithStartDates,
    currentDateTime,
  );

  logger.info("Cost Explorer data retrieved successfully (NetUnblendedCost->UnblendedCost)", {
    totalCostReportValue: latestCostReport.totalCost(),
    costMapDetails: latestCostReport.costMap,
    numberOfAccounts: Object.keys(latestCostReport.costMap).length,
    metricsUsed: "UnblendedCost", // After our modification
    note: "This now includes credit usage charges (before credit discount application)",
  });

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
    const currentCost = latestCostReport.getCost(lease.awsAccountId);
    const previousCost = lease.totalCostAccrued || 0;
    const costDifference = currentCost - previousCost;

    logger.info("Updating lease cost data", {
      leaseId: lease.uuid,
      accountId: lease.awsAccountId,
      endUser: lease.userEmail,
      previousTotalCostAccrued: previousCost,
      newTotalCostAccrued: currentCost,
      costDifference: costDifference,
      leaseStartDate: lease.startDate,
      budgetLimit: lease.maxSpend,
      budgetUsagePercentage: lease.maxSpend ? (currentCost / lease.maxSpend) * 100 : null,
    });

    await leaseStore.update({
      ...lease,
      totalCostAccrued: currentCost,
      lastCheckedDate: currentDateTime.toISO(),
    });
  }

  return `completed lease monitoring scan for ${monitoredLeases.length} leases and generated ${eventsToSend.length} events`;
}

function determineLeaseEvents(props: {
  lease: MonitoredLease;
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
  const largestBreachedBudgetThreshold = getLargestBudgetThreshold(
    breachedBudgetThresholds,
  );
  const budgetFreezeThreshold = breachedBudgetThresholds.find(
    (threshold) => threshold.action === "FREEZE_ACCOUNT",
  );
  const latestBreachedDurationTheshold = getLatestDurationThreshold(
    breachedDurationThresholds,
  );
  const durationFreezeThreshold = breachedDurationThresholds.find(
    (threshold) => threshold.action === "FREEZE_ACCOUNT",
  );
  //check for freeze actions, don't need to send a freeze event twice
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
          DateTime.fromISO(lease.expirationDate!, { zone: "utc" }).diff(
            DateTime.fromISO(lease.startDate, { zone: "utc" }),
            "hour",
          ).hours,
        ),
        actionRequested: latestBreachedDurationTheshold.action,
      }),
    );
  }

  return leaseEvents;
}

function isExpired(
  lease: MonitoredLease,
  currentDate: DateTime,
): lease is MonitoredLease & { expirationDate: string } {
  return (
    lease.expirationDate !== undefined &&
    DateTime.fromISO(lease.expirationDate, { zone: "utc" }) < currentDate
  );
}

function maxBudgetExceeded(
  lease: MonitoredLease,
  costs: AccountsCostReport,
): lease is MonitoredLease & { maxSpend: number } {
  return (
    lease.maxSpend !== undefined &&
    costs.getCost(lease.awsAccountId) >= lease.maxSpend
  );
}

function detectNewlyBreachedBudgetThresholds(
  lease: MonitoredLease,
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
  lease: MonitoredLease,
  currentDate: DateTime,
) {
  if (lease.expirationDate === undefined) {
    return [];
  }
  const newlyExceededThresholds = [];
  const expirationDate = DateTime.fromISO(lease.expirationDate, {
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
      newlyExceededThresholds.push(durationThreshold);
    }
  }

  return newlyExceededThresholds;
}

function getLargestBudgetThreshold(budgetThresholds: BudgetThreshold[]) {
  if (budgetThresholds.length == 0) return undefined;
  return budgetThresholds.reduce((prev, current) =>
    prev.dollarsSpent > current.dollarsSpent ? prev : current,
  );
}

function getLatestDurationThreshold(durationThresholds: DurationThreshold[]) {
  if (durationThresholds.length == 0) return undefined;
  return durationThresholds.reduce((prev, current) =>
    prev.hoursRemaining < current.hoursRemaining ? prev : current,
  );
}

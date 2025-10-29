// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { LeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  ExpiredLease,
  ExpiredLeaseStatus,
  isExpiredLease,
  MonitoredLease,
  MonitoredLeaseStatus,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import {
  collect,
  stream,
} from "@amzn/innovation-sandbox-commons/data/utils.js";
import { GroupCostReportGeneratedEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-event.js";
import { GroupCostReportGeneratedFailureEvent } from "@amzn/innovation-sandbox-commons/events/group-cost-report-generated-failure-event.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  GroupCostReportingLambdaEnvironment,
  GroupCostReportingLambdaEnvironmentSchema,
} from "@amzn/innovation-sandbox-commons/lambda/environments/group-cost-reporting-lambda-environment.js";
import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";
import { ValidatedEnvironment } from "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { fromTemporaryIsbOrgManagementCredentials } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { PutObjectCommand, S3Client } from "@aws-sdk/client-s3";
import { Context, EventBridgeEvent } from "aws-lambda";
import { backOff } from "exponential-backoff";
import { DateTime } from "luxon";

interface CostReportEvent {
  reportMonth?: string;
}

interface RelevantLeaseData {
  readonly costReportGroup: string | undefined;
  readonly awsAccountId: string;
  readonly startDate: DateTime;
  readonly endDate: DateTime;
}

const GROUP_COST_REPORT_CONFIG = {
  DEFAULT_CURRENCY: "USD",
  STARTING_DELAY: 1000,
  MAX_ATTEMPTS: 5,
};

const serviceName = "GroupCostReporting";
const tracer = new Tracer();
const logger = new Logger({ serviceName });

export const handler = baseMiddlewareBundle({
  logger,
  tracer,
  environmentSchema: GroupCostReportingLambdaEnvironmentSchema,
  moduleName: "group-cost-reporting",
}).handler(generateReport);

export async function generateReport(
  _event: EventBridgeEvent<string, unknown>,
  context: Context & ValidatedEnvironment<GroupCostReportingLambdaEnvironment>,
) {
  logger.debug(`Running last month's cost report on ${DateTime.now().toISO()}`);
  const eventBridgeClient = IsbServices.isbEventBridge(context.env);
  const leaseStore = IsbServices.leaseStore(context.env);
  const costExplorerService = IsbServices.costExplorer(
    context.env,
    fromTemporaryIsbOrgManagementCredentials(context.env),
  );
  const s3Client = IsbClients.s3({
    USER_AGENT_EXTRA: context.env.USER_AGENT_EXTRA,
  });
  const { startOfMonth, endOfMonth } = getReportPeriod(_event.detail);

  try {
    const leases = await fetchRelevantLeases(
      leaseStore,
      startOfMonth,
      endOfMonth,
    );

    const uniqueAccountIds = [
      ...new Set(leases.map((lease) => lease.awsAccountId)),
    ];
    const dailyCostsByAccount =
      await costExplorerService.getDailyCostsByAccount(
        uniqueAccountIds,
        startOfMonth,
        endOfMonth,
      );

    const costReportGroupTotals = calculateCostsByGroup(
      leases,
      dailyCostsByAccount,
    );

    const fileName = await uploadReportToS3(
      s3Client,
      costReportGroupTotals,
      startOfMonth,
      endOfMonth,
      GROUP_COST_REPORT_CONFIG.DEFAULT_CURRENCY,
      context.env.REPORT_BUCKET_NAME,
    );

    await eventBridgeClient.sendIsbEvent(
      tracer,
      new GroupCostReportGeneratedEvent({
        reportMonth: startOfMonth.toFormat("yyyy-MM"),
        fileName: fileName,
        bucketName: context.env.REPORT_BUCKET_NAME,
        timestamp: DateTime.now().toISO(),
      }),
    );
  } catch (error) {
    logger.error("Cost report generation failed", {
      reportMonth: startOfMonth.toFormat("yyyy-MM"),
      reportPeriod: {
        start: startOfMonth.toISO(),
        end: endOfMonth.toISO(),
      },
      bucketName: context.env.REPORT_BUCKET_NAME,
      error:
        error instanceof Error
          ? {
              name: error.name,
              message: error.message,
              stack: error.stack,
            }
          : error,
    });

    await eventBridgeClient.sendIsbEvent(
      tracer,
      new GroupCostReportGeneratedFailureEvent({
        reportMonth: startOfMonth.toFormat("yyyy-MM"),
        timestamp: DateTime.now().toISO(),
        logName: context.logGroupName,
      }),
    );
    throw error;
  }
}

async function fetchRelevantLeases(
  leaseStore: LeaseStore,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
) {
  const statuses: (MonitoredLeaseStatus | ExpiredLeaseStatus)[] = [
    "Active",
    "Frozen",
    "AccountQuarantined",
    "BudgetExceeded",
    "Ejected",
    "Expired",
    "ManuallyTerminated",
  ];

  const leases: (MonitoredLease | ExpiredLease)[] = (
    await Promise.all(
      statuses.map((status) =>
        backOff(
          () =>
            collect(stream(leaseStore, leaseStore.findByStatus, { status })),
          {
            numOfAttempts: GROUP_COST_REPORT_CONFIG.MAX_ATTEMPTS,
            jitter: "full",
            startingDelay: GROUP_COST_REPORT_CONFIG.STARTING_DELAY,
            retry(error) {
              if (
                error.name === "ThrottlingException" ||
                error.name === "ProvisionedThroughputExceededException" ||
                error.name === "ServiceUnavailableException" ||
                error.name === "InternalServerError"
              ) {
                logger.warn("Retrying lease scan due to error", {
                  error: error.message,
                });
                return true;
              }
              return false;
            },
          },
        ),
      ),
    )
  ).flat() as (MonitoredLease | ExpiredLease)[];

  return leases
    .filter((lease) =>
      isLeaseInReportPeriod(lease, startOfLastMonth, endOfLastMonth),
    )
    .map((lease) => ({
      costReportGroup: lease.costReportGroup,
      awsAccountId: lease.awsAccountId,
      startDate: DateTime.fromISO(lease.startDate),
      endDate: isExpiredLease(lease) ? DateTime.fromISO(lease.endDate) : now(),
    }));
}

function isLeaseInReportPeriod(
  lease: MonitoredLease | ExpiredLease,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
) {
  const leaseStart = DateTime.fromISO(lease.startDate);
  const leaseEnd = isExpiredLease(lease)
    ? DateTime.fromISO(lease.endDate)
    : now();
  return leaseStart <= endOfLastMonth && leaseEnd >= startOfLastMonth;
}

function calculateCostsByGroup(
  relevantLeaseData: RelevantLeaseData[],
  dailyCostsByAccount: Record<string, Record<string, number>>,
) {
  const costReportGroupTotals = relevantLeaseData.reduce(
    (totals, lease) => {
      const leaseTotalCost = calculateLeaseCost(lease, dailyCostsByAccount);
      const groupName = lease.costReportGroup ?? "No cost report group";

      totals[groupName] = (totals[groupName] || 0) + leaseTotalCost;
      return totals;
    },
    {} as Record<string, number>,
  );

  return costReportGroupTotals;
}

function calculateLeaseCost(
  lease: RelevantLeaseData,
  dailyCostsByAccount: Record<string, Record<string, number>>,
) {
  const accountCosts = dailyCostsByAccount[lease.awsAccountId] ?? {};
  const leaseTotalCost = Object.entries(accountCosts)
    .map(([dateStr, cost]) => ({
      date: DateTime.fromFormat(dateStr, "yyyy-MM-dd"),
      cost,
    }))
    .filter(({ date }) => date >= lease.startDate && date <= lease.endDate)
    .reduce((total, { cost }) => total + cost, 0);

  return leaseTotalCost;
}

async function uploadReportToS3(
  s3Client: S3Client,
  costReportGroupTotals: Record<string, number>,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
  currency: string,
  bucketName: string,
) {
  const costReportCSV = generateCSV(
    costReportGroupTotals,
    startOfLastMonth,
    endOfLastMonth,
    currency,
  );

  const fileName = `${startOfLastMonth.toFormat("yyyy")}/${startOfLastMonth.toFormat("MM")}/cost-report-${now().toFormat("yyyyMMdd-HHmmss")}.csv`;

  const s3PutCommand = new PutObjectCommand({
    Bucket: bucketName,
    Key: fileName,
    Body: costReportCSV,
    ContentType: "text/csv",
    ContentDisposition: `attachment; filename="${fileName.split("/").pop()}"`,
  });

  await s3Client.send(s3PutCommand);
  return fileName;
}

function generateCSV(
  costReportGroupTotals: Record<string, number>,
  startOfLastMonth: DateTime,
  endOfLastMonth: DateTime,
  currency: string,
): string {
  const headers = [
    "CostReportGroup",
    "StartDate",
    "EndDate",
    "Cost",
    "Currency",
  ];

  const rows = Object.entries(costReportGroupTotals).map(([group, cost]) => [
    group,
    startOfLastMonth.toFormat("yyyy-MM-dd"),
    endOfLastMonth.toFormat("yyyy-MM-dd"),
    cost.toFixed(2),
    currency,
  ]);
  return [headers, ...rows].map((row) => row.join(",")).join("\n");
}

//this allows user to manually invoke lambda with custom month on the AWS console
function getReportPeriod(eventDetail: unknown) {
  const event = eventDetail as CostReportEvent;
  if (event && event.reportMonth) {
    const targetDate = DateTime.fromFormat(event.reportMonth, "yyyy-MM");
    if (targetDate.isValid) {
      return {
        startOfMonth: targetDate.startOf("month"),
        endOfMonth: targetDate.endOf("month"),
      };
    }
  }

  return {
    startOfMonth: now().minus({ months: 1 }).startOf("month"),
    endOfMonth: now().minus({ months: 1 }).endOf("month"),
  };
}

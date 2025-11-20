// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  BudgetThreshold,
  DurationThreshold,
} from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  Lease,
  LeaseStatus,
  MonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import {
  AccountsCostReport,
  CostExplorerService,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import { LeaseMonitoringEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-monitoring-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { performAccountMonitoringScan } from "@amzn/innovation-sandbox-lease-monitoring/lease-monitoring-handler.js";

const costsMock = {
  ...new AccountsCostReport(),
  getCost: (_accountId: string) => 120,
  totalCost: () => 1000,
  addCost: vi.fn(),
  merge: vi.fn(),
};

const mockSendIsbEvents = vi.fn();

const testEnv = generateSchemaData(LeaseMonitoringEnvironmentSchema);

beforeEach(() => {
  bulkStubEnv(testEnv);

  vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents").mockImplementation(
    mockSendIsbEvents,
  );
  vi.spyOn(IsbClients, "costExplorer").mockReturnValue({} as any);
  vi.spyOn(DynamoLeaseStore.prototype, "update").mockReturnValue(
    undefined as any,
  );
  vi.spyOn(CostExplorerService.prototype, "getCostForLeases").mockResolvedValue(
    costsMock,
  );
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function leaseStore() {
  return {
    findByStatus: {
      returns: (leases: Partial<{ [key in LeaseStatus]: Lease[] }>) => {
        vi.spyOn(DynamoLeaseStore.prototype, "findByStatus").mockImplementation(
          async (props: { status: LeaseStatus }) => {
            return {
              result: leases[props.status] ?? [],
              nextPageIdentifier: null,
            };
          },
        );
      },
    },
  };
}

describe("performAccountMonitoringScan", () => {
  const monitoredLeasesBase: MonitoredLease[] = [
    {
      userEmail: "test@example.com",
      uuid: "testLease101",
      originalLeaseTemplateUuid: "testleaseTemplate101",
      originalLeaseTemplateName: "testleaseTemplate101",
      leaseDurationInHours: 24,
      comments: "test",
      approvedBy: "testApprover",
      status: "Active",
      awsAccountId: "123456789012",
      startDate: now().minus({ days: 30 }).toString(),
      expirationDate: now().plus({ days: 30 }).toString(),
      maxSpend: 160,
      totalCostAccrued: 80,
      lastCheckedDate: now().minus({ days: 1 }).toString(),
      budgetThresholds: [
        { dollarsSpent: 60, action: "ALERT" },
        { dollarsSpent: 80, action: "FREEZE_ACCOUNT" },
      ],
      durationThresholds: [
        { hoursRemaining: 10 * 24, action: "ALERT" },
        { hoursRemaining: 2 * 24, action: "FREEZE_ACCOUNT" },
      ],
    },
    {
      userEmail: "test2@example.com",
      uuid: "testLease102",
      originalLeaseTemplateUuid: "testleaseTemplate102",
      originalLeaseTemplateName: "testleaseTemplate102",
      leaseDurationInHours: 24,
      comments: "test",
      approvedBy: "testApprover2",
      status: "Active",
      awsAccountId: "111111111111",
      startDate: now().minus({ days: 30 }).toString(),
      expirationDate: now().plus({ days: 30 }).toString(),
      maxSpend: 160,
      totalCostAccrued: 80,
      lastCheckedDate: now().minus({ days: 1 }).toString(),
      budgetThresholds: [
        { dollarsSpent: 60, action: "ALERT" },
        { dollarsSpent: 80, action: "FREEZE_ACCOUNT" },
      ],
      durationThresholds: [
        { hoursRemaining: 10 * 24, action: "ALERT" },
        { hoursRemaining: 2 * 24, action: "FREEZE_ACCOUNT" },
      ],
    },
  ];

  describe("Budget thresholds", () => {
    it("should always trigger LeaseBudgetExceeded if cost exceeds max spend, even the event has already been triggered", async () => {
      const monitoredLeases = [
        {
          ...monitoredLeasesBase[0]!,
          durationThresholds: [],
          maxSpend: 100,
          totalCostAccrued: 80,
        },
        {
          ...monitoredLeasesBase[1]!,
          durationThresholds: [],
          maxSpend: 100,
          totalCostAccrued: 110,
        },
      ];

      leaseStore().findByStatus.returns({
        Active: monitoredLeases,
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: monitoredLeases[0]!.userEmail,
            uuid: monitoredLeases[0]!.uuid,
          },
          accountId: monitoredLeases[0]!.awsAccountId!,
          budget: monitoredLeases[0]!.maxSpend,
          totalSpend: costsMock.getCost(monitoredLeases[0]!.awsAccountId!),
        }),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: monitoredLeases[1]!.userEmail,
            uuid: monitoredLeases[1]!.uuid,
          },
          accountId: monitoredLeases[1]!.awsAccountId!,
          budget: monitoredLeases[1]!.maxSpend,
          totalSpend: costsMock.getCost(monitoredLeases[1]!.awsAccountId!),
        }),
      );
    });

    it("should trigger LeaseBudgetThresholdBreachedAlert when a threshold is breached, LeaseBudgetExceeded if cost exceeds max spend", async () => {
      const overBudgetLease = {
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        maxSpend: 100,
        totalCostAccrued: 80,
      };

      const willAlertLease = {
        ...monitoredLeasesBase[1]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 80,
        budgetThresholds: [
          { dollarsSpent: 120, action: "ALERT" },
          { dollarsSpent: 150, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
      };

      leaseStore().findByStatus.returns({
        Active: [overBudgetLease, willAlertLease],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: overBudgetLease.userEmail,
            uuid: overBudgetLease.uuid,
          },
          accountId: overBudgetLease.awsAccountId!,
          budget: overBudgetLease.maxSpend,
          totalSpend: costsMock.getCost(overBudgetLease.awsAccountId!),
        }),
        new LeaseBudgetThresholdBreachedAlert({
          leaseId: {
            userEmail: willAlertLease.userEmail,
            uuid: willAlertLease.uuid,
          },
          accountId: willAlertLease.awsAccountId!,
          budget: willAlertLease.maxSpend,
          budgetThresholdTriggered: 120,
          totalSpend: costsMock.getCost(willAlertLease.awsAccountId!),
          actionRequested: "ALERT",
        }),
      );
    });

    it("should trigger only most expensive budget alert when multiple are crossed at once", async () => {
      const lease = {
        ...monitoredLeasesBase[1]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 40, //going from 40 -> 120 in one scan
        budgetThresholds: [
          { dollarsSpent: 60, action: "ALERT" },
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
      };

      leaseStore().findByStatus.returns({
        Active: [lease],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseFreezingThresholdBreachedAlert({
          leaseId: {
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          },
          accountId: lease.awsAccountId!,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 100,
            budget: lease.maxSpend,
            totalSpend: costsMock.getCost(lease.awsAccountId!),
          },
        }),
      );
    });

    it("should trigger both freeze and budget alert when both occur in the same interval", async () => {
      const lease = {
        ...monitoredLeasesBase[1]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 40, //going from 40 -> 120 in one scan
        budgetThresholds: [
          { dollarsSpent: 60, action: "FREEZE_ACCOUNT" },
          { dollarsSpent: 100, action: "ALERT" },
        ] as BudgetThreshold[],
      };

      leaseStore().findByStatus.returns({
        Active: [lease],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseFreezingThresholdBreachedAlert({
          leaseId: {
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          },
          accountId: lease.awsAccountId!,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 60,
            budget: lease.maxSpend,
            totalSpend: costsMock.getCost(lease.awsAccountId!),
          },
        }),
        new LeaseBudgetThresholdBreachedAlert({
          leaseId: {
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          },
          accountId: lease.awsAccountId!,
          budget: lease.maxSpend,
          budgetThresholdTriggered: 100,
          totalSpend: costsMock.getCost(lease.awsAccountId!),
          actionRequested: "ALERT",
        }),
      );
    });
  });

  describe("Duration thresholds", () => {
    it("should trigger LeaseExpired if date past expiration date, even if message already sent", async () => {
      const expiredLease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        expirationDate: now().minus({ days: 5 }).toString(),
        lastCheckedDate: now().minus({ days: 1 }).toString(),
        durationThresholds: [
          { hoursRemaining: 10 * 24, action: "ALERT" },
          { hoursRemaining: 2 * 24, action: "FREEZE_ACCOUNT" },
        ] as DurationThreshold[],
      };

      leaseStore().findByStatus.returns({
        Active: [expiredLease],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseExpiredAlert({
          leaseId: {
            userEmail: expiredLease.userEmail,
            uuid: expiredLease.uuid,
          },
          accountId: expiredLease.awsAccountId!,
          leaseExpirationDate: expiredLease.expirationDate!,
        }),
      );
    });

    it("should trigger LeaseDurationThresholdBreachedAlert when a threshold is breached, LeaseExpired if past expiration date", async () => {
      const expiredLease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        expirationDate: now().minus({ days: 1 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        durationThresholds: [
          { hoursRemaining: 10 * 24, action: "ALERT" },
          { hoursRemaining: 20 * 24, action: "FREEZE_ACCOUNT" },
        ] as DurationThreshold[],
      };

      const alertingLease = {
        ...monitoredLeasesBase[1]!,
        budgetThresholds: [],
        expirationDate: now().plus({ days: 13 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        durationThresholds: [
          { hoursRemaining: 14 * 24, action: "ALERT" }, //alert at 14 days remaining (only 13 days remaining)
          { hoursRemaining: 7 * 24, action: "FREEZE_ACCOUNT" }, //freeze at 7 days remaining
        ] as DurationThreshold[],
      };

      leaseStore().findByStatus.returns({
        Active: [expiredLease, alertingLease],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseExpiredAlert({
          leaseId: {
            userEmail: expiredLease.userEmail,
            uuid: expiredLease.uuid,
          },
          accountId: expiredLease.awsAccountId!,
          leaseExpirationDate: expiredLease.expirationDate!,
        }),
        new LeaseDurationThresholdBreachedAlert({
          leaseId: {
            userEmail: alertingLease.userEmail,
            uuid: alertingLease.uuid,
          },
          accountId: alertingLease.awsAccountId!,
          triggeredDurationThreshold: 14 * 24,
          leaseDurationInHours: Math.round(
            DateTime.fromISO(alertingLease.expirationDate!, {
              zone: "utc",
            }).diff(
              DateTime.fromISO(alertingLease.startDate!, { zone: "utc" }),
              "hour",
            ).hours,
          ),
          actionRequested: "ALERT",
        }),
      );
    });

    it("should trigger LeaseDurationThresholdBreachedAlert when a threshold is breached, no alert when below thresholds", async () => {
      const monitoredLeases = [
        {
          ...monitoredLeasesBase[0]!,
          budgetThresholds: [],
          expirationDate: now().plus({ days: 10 }).toString(),
          lastCheckedDate: now().minus({ days: 5 }).toString(),
          durationThresholds: [
            { hoursRemaining: 15 * 24, action: "ALERT" },
            { hoursRemaining: 12 * 24, action: "FREEZE_ACCOUNT" },
          ] as DurationThreshold[],
        },
        {
          ...monitoredLeasesBase[1]!,
          budgetThresholds: [],
          expirationDate: now().plus({ days: 10 }).toString(),
          lastCheckedDate: now().minus({ days: 5 }).toString(),
          durationThresholds: [
            { hoursRemaining: 5 * 24, action: "ALERT" },
            { hoursRemaining: 2 * 24, action: "FREEZE_ACCOUNT" },
          ] as DurationThreshold[],
        },
      ];

      leaseStore().findByStatus.returns({
        Active: monitoredLeases,
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseFreezingThresholdBreachedAlert({
          leaseId: {
            userEmail: monitoredLeases[0]!.userEmail,
            uuid: monitoredLeases[0]!.uuid,
          },
          accountId: monitoredLeases[0]!.awsAccountId!,
          reason: {
            type: "Expired",
            triggeredDurationThreshold:
              monitoredLeases[0]!.durationThresholds[1]!.hoursRemaining,
            leaseDurationInHours: monitoredLeases[0]!.leaseDurationInHours!,
          },
        }),
      );
    });
  });
});

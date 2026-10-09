// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  PersistedLease,
  PersistedMonitoredLease,
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
import type {
  BudgetThreshold,
  DurationThreshold,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseStatus } from "@amzn/innovation-sandbox-shared/types/lease.js";

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
  // Default: tag query returns empty so existing tests fall through to the
  // legacy `getCostForLeases` fallback (which returns `costsMock`). Specific
  // tests below override this to exercise the tag-first partition.
  vi.spyOn(
    CostExplorerService.prototype,
    "getCostForLeasesByTag",
  ).mockResolvedValue(new AccountsCostReport());
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
});

function leaseStore() {
  return {
    findByStatus: {
      returns: (
        leases: Partial<{ [key in LeaseStatus]: PersistedLease[] }>,
      ) => {
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
  const monitoredLeasesBase: PersistedMonitoredLease[] = [
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

    it("triggers LeaseBudgetExceeded when spend returned only on page 2 crosses max spend", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        budgetThresholds: [],
        maxSpend: 100,
        totalCostAccrued: 80,
      };
      leaseStore().findByStatus.returns({ Active: [lease] });

      vi.spyOn(CostExplorerService.prototype, "getCostForLeases").mockRestore();
      const sendSpy = vi
        .fn()
        .mockResolvedValueOnce({
          NextPageToken: "page-2",
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [lease.awsAccountId],
                  Metrics: {
                    UnblendedCost: { Amount: "80.00", Unit: "USD" },
                  },
                },
              ],
              TimePeriod: {
                Start: now().minus({ days: 2 }).toFormat("yyyy-MM-dd"),
                End: now().minus({ days: 1 }).toFormat("yyyy-MM-dd"),
              },
            },
          ],
        })
        .mockResolvedValueOnce({
          ResultsByTime: [
            {
              Groups: [
                {
                  Keys: [lease.awsAccountId],
                  Metrics: {
                    UnblendedCost: { Amount: "40.00", Unit: "USD" },
                  },
                },
              ],
              TimePeriod: {
                Start: now().minus({ days: 1 }).toFormat("yyyy-MM-dd"),
                End: now().toFormat("yyyy-MM-dd"),
              },
            },
          ],
        });
      vi.spyOn(IsbClients, "costExplorer").mockReturnValue({
        send: sendSpy,
      } as any);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sendSpy).toHaveBeenCalledTimes(2);
      expect(sendSpy.mock.calls[1]![0].input.NextPageToken).toBe("page-2");
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: lease.userEmail,
            uuid: lease.uuid,
          },
          accountId: lease.awsAccountId,
          budget: lease.maxSpend,
          totalSpend: 120,
        }),
      );
    });

    it("handles a mixed Active and Frozen catch-up cohort safely", async () => {
      function cohortLease(
        suffix: number,
        status: "Active" | "Frozen",
        maxSpend: number,
        budgetThresholds: BudgetThreshold[],
      ): PersistedMonitoredLease & { maxSpend: number } {
        return {
          ...monitoredLeasesBase[0]!,
          userEmail: `cohort-${suffix}@example.com`,
          uuid: `cohort-lease-${suffix}`,
          awsAccountId: `12345678900${suffix}`,
          status,
          maxSpend,
          totalCostAccrued: 80,
          budgetThresholds,
          durationThresholds: [],
        };
      }

      const activeUnderThreshold = cohortLease(1, "Active", 200, [
        { dollarsSpent: 100, action: "ALERT" },
      ]);
      const activePastAlert = cohortLease(2, "Active", 200, [
        { dollarsSpent: 100, action: "ALERT" },
      ]);
      const activePastFreeze = cohortLease(3, "Active", 200, [
        { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
      ]);
      const activeOverMaxSpend = cohortLease(4, "Active", 100, []);
      const frozenPastFreeze = {
        ...cohortLease(5, "Frozen", 200, [
          { dollarsSpent: 90, action: "ALERT" },
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ]),
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        durationThresholds: [
          { hoursRemaining: 14 * 24, action: "ALERT" },
          { hoursRemaining: 12 * 24, action: "FREEZE_ACCOUNT" },
        ] as DurationThreshold[],
      };
      const frozenOverMaxSpend = cohortLease(6, "Frozen", 100, []);
      const activeLeases = [
        activeUnderThreshold,
        activePastAlert,
        activePastFreeze,
        activeOverMaxSpend,
      ];
      const frozenLeases = [frozenPastFreeze, frozenOverMaxSpend];
      const correctedCosts = new Map([
        [activeUnderThreshold.awsAccountId, 90],
        [activePastAlert.awsAccountId, 120],
        [activePastFreeze.awsAccountId, 120],
        [activeOverMaxSpend.awsAccountId, 120],
        [frozenPastFreeze.awsAccountId, 120],
        [frozenOverMaxSpend.awsAccountId, 120],
      ]);
      const correctedReport = new AccountsCostReport();
      for (const [accountId, cost] of correctedCosts) {
        correctedReport.addCost(accountId, cost);
      }

      leaseStore().findByStatus.returns({
        Active: activeLeases,
        Frozen: frozenLeases,
      });
      vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      ).mockResolvedValue(correctedReport);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(
        expect.any(Tracer),
        new LeaseBudgetThresholdBreachedAlert({
          leaseId: {
            userEmail: activePastAlert.userEmail,
            uuid: activePastAlert.uuid,
          },
          accountId: activePastAlert.awsAccountId,
          budget: activePastAlert.maxSpend,
          budgetThresholdTriggered: 100,
          totalSpend: 120,
          actionRequested: "ALERT",
        }),
        new LeaseFreezingThresholdBreachedAlert({
          leaseId: {
            userEmail: activePastFreeze.userEmail,
            uuid: activePastFreeze.uuid,
          },
          accountId: activePastFreeze.awsAccountId,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 100,
            budget: activePastFreeze.maxSpend,
            totalSpend: 120,
          },
        }),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: activeOverMaxSpend.userEmail,
            uuid: activeOverMaxSpend.uuid,
          },
          accountId: activeOverMaxSpend.awsAccountId,
          budget: activeOverMaxSpend.maxSpend,
          totalSpend: 120,
        }),
        new LeaseBudgetThresholdBreachedAlert({
          leaseId: {
            userEmail: frozenPastFreeze.userEmail,
            uuid: frozenPastFreeze.uuid,
          },
          accountId: frozenPastFreeze.awsAccountId,
          budget: frozenPastFreeze.maxSpend,
          budgetThresholdTriggered: 90,
          totalSpend: 120,
          actionRequested: "ALERT",
        }),
        new LeaseDurationThresholdBreachedAlert({
          leaseId: {
            userEmail: frozenPastFreeze.userEmail,
            uuid: frozenPastFreeze.uuid,
          },
          accountId: frozenPastFreeze.awsAccountId,
          triggeredDurationThreshold: 14 * 24,
          leaseDurationInHours: 40 * 24,
          actionRequested: "ALERT",
        }),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: frozenOverMaxSpend.userEmail,
            uuid: frozenOverMaxSpend.uuid,
          },
          accountId: frozenOverMaxSpend.awsAccountId,
          budget: frozenOverMaxSpend.maxSpend,
          totalSpend: 120,
        }),
      );

      const updates = vi
        .mocked(DynamoLeaseStore.prototype.update)
        .mock.calls.map(([lease]) => lease as PersistedMonitoredLease);
      expect(updates).toHaveLength(6);
      expect(
        Object.fromEntries(
          updates.map((lease) => [lease.awsAccountId, lease.totalCostAccrued]),
        ),
      ).toEqual(Object.fromEntries(correctedCosts));
    });

    it("does not emit redundant freeze events for a Frozen lease with only freeze thresholds", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        status: "Frozen" as const,
        maxSpend: 200,
        totalCostAccrued: 80,
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        budgetThresholds: [
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
        durationThresholds: [
          { hoursRemaining: 12 * 24, action: "FREEZE_ACCOUNT" },
        ] as DurationThreshold[],
      };
      const correctedReport = new AccountsCostReport();
      correctedReport.addCost(lease.awsAccountId, 120);

      leaseStore().findByStatus.returns({ Frozen: [lease] });
      vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      ).mockResolvedValue(correctedReport);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(mockSendIsbEvents).toHaveBeenCalledWith(expect.any(Tracer));
      expect(DynamoLeaseStore.prototype.update).toHaveBeenCalledWith(
        expect.objectContaining({
          uuid: lease.uuid,
          status: "Frozen",
          totalCostAccrued: 120,
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

  describe("Tag-first cost attribution (Task 4.2 partition)", () => {
    function buildTagReport(
      entries: Record<string, number>,
    ): AccountsCostReport {
      const report = new AccountsCostReport();
      for (const [leaseId, amount] of Object.entries(entries)) {
        report.addCost(leaseId, amount);
      }
      return report;
    }

    it("does not call CostExplorer when no leases are being monitored", async () => {
      leaseStore().findByStatus.returns({ Active: [], Frozen: [] });

      const tagSpy = vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeasesByTag",
      );
      const fallbackSpy = vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      );

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toBeDefined();
      expect(tagSpy).not.toHaveBeenCalled();
      expect(fallbackSpy).not.toHaveBeenCalled();
    });

    it("uses tag-only path when every lease is covered by the tag report (no fallback CE call)", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });

      const tagSpy = vi
        .spyOn(CostExplorerService.prototype, "getCostForLeasesByTag")
        .mockResolvedValue(
          buildTagReport({
            [monitoredLeases[0]!.uuid]: 90,
            [monitoredLeases[1]!.uuid]: 110,
          }),
        );
      const fallbackSpy = vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(tagSpy).toHaveBeenCalledTimes(1);
      expect(fallbackSpy).not.toHaveBeenCalled();
      // The lease store update should record the tag-derived costs against
      // each lease's account ID — confirming the lease-UUID → account-ID
      // re-keying happened.
      const updateSpy = vi.spyOn(DynamoLeaseStore.prototype, "update");
      const updates = updateSpy.mock.calls.map(
        (c) => c[0],
      ) as PersistedMonitoredLease[];
      const account0Update = updates.find(
        (u) => u.awsAccountId === monitoredLeases[0]!.awsAccountId,
      );
      const account1Update = updates.find(
        (u) => u.awsAccountId === monitoredLeases[1]!.awsAccountId,
      );
      expect(account0Update?.totalCostAccrued).toBe(90);
      expect(account1Update?.totalCostAccrued).toBe(110);
    });

    it("falls back entirely to legacy path when no leases are tag-covered", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });

      const tagSpy = vi
        .spyOn(CostExplorerService.prototype, "getCostForLeasesByTag")
        .mockResolvedValue(new AccountsCostReport());
      const fallbackSpy = vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(tagSpy).toHaveBeenCalledTimes(1);
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      const fallbackArg = fallbackSpy.mock.calls[0]![0]!;
      expect(Object.keys(fallbackArg).sort()).toEqual(
        monitoredLeases.map((l) => l.awsAccountId).sort(),
      );
    });

    it("partitions correctly when some leases are tag-covered and others are not", async () => {
      const monitoredLeases = monitoredLeasesBase;
      const taggedLease = monitoredLeases[0]!;
      const untaggedLease = monitoredLeases[1]!;

      leaseStore().findByStatus.returns({ Active: monitoredLeases });

      vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeasesByTag",
      ).mockResolvedValue(buildTagReport({ [taggedLease.uuid]: 95 }));

      const fallbackSpy = vi
        .spyOn(CostExplorerService.prototype, "getCostForLeases")
        .mockResolvedValue(costsMock);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      const fallbackArg = fallbackSpy.mock.calls[0]![0]!;
      expect(Object.keys(fallbackArg)).toEqual([untaggedLease.awsAccountId]);
    });

    it("propagates tag-query CE failure without falling back (no silent masking)", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });

      const ceError = new Error("CE service unavailable");
      vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeasesByTag",
      ).mockRejectedValue(ceError);
      const fallbackSpy = vi.spyOn(
        CostExplorerService.prototype,
        "getCostForLeases",
      );

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).rejects.toThrow("CE service unavailable");
      expect(fallbackSpy).not.toHaveBeenCalled();
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

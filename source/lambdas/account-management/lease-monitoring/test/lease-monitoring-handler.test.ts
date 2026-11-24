// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamoLeaseCostHistoryStore } from "@amzn/innovation-sandbox-commons/data/lease-cost-history/dynamo-lease-cost-history-store.js";
import {
  BreachRecord,
  BreachRecordSchema,
  CostObservation,
  LeaseCostHistorySchemaVersion,
} from "@amzn/innovation-sandbox-commons/data/lease-cost-history/lease-cost-history.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import type { LeaseUpdateMonitoringOwnedFieldsProps } from "@amzn/innovation-sandbox-commons/data/lease/lease-store.js";
import {
  PersistedLease,
  PersistedMonitoredLease,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseBudgetExceededAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-exceeded-alert.js";
import { LeaseBudgetThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-budget-threshold-breached-alert.js";
import { LeaseDurationThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-duration-threshold-breached-alert.js";
import { LeaseExpiredAlert } from "@amzn/innovation-sandbox-commons/events/lease-expired-alert.js";
import { LeaseFreezingThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-freezing-threshold-breached-alert.js";
import { LeaseSpendRateThresholdBreachedAlert } from "@amzn/innovation-sandbox-commons/events/lease-spend-rate-threshold-breached-alert.js";
import { NewBreachRecord } from "@amzn/innovation-sandbox-commons/isb-services/budget-threshold/index.js";
import {
  AccountsCostReport,
  BedrockTokenCostReport,
  CostExplorerService,
  LeaseDailyCostReport,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-explorer-service.js";
import {
  getRecentObservations,
  recordCostObservation,
} from "@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js";
import { LeaseMonitoringEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-monitoring-environment.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  futureTtl,
  mockContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import {
  handler,
  performAccountMonitoringScan,
} from "@amzn/innovation-sandbox-lease-monitoring/lease-monitoring-handler.js";
import type {
  BudgetThreshold,
  DurationThreshold,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import { LeaseStatus } from "@amzn/innovation-sandbox-shared/types/lease.js";

vi.mock("@amzn/innovation-sandbox-commons/isb-services/cost-history/index.js", {
  spy: true,
});

/** What the legacy account query reports for every account it is asked about. */
const FALLBACK_COST = 120;

const mockSendIsbEvents = vi.fn();

const testEnv = generateSchemaData(LeaseMonitoringEnvironmentSchema);

const noHistory = { complete: true as const, result: undefined };

/**
 * The breach history for this test: the rows the handler appends plus the rows
 * a test adds directly. The store's breach read returns them.
 */
let appendedBreachRows: NewBreachRecord[] = [];

/** The leases the scan reads, by uuid, so a scoped write can be read back. */
let scannedLeases = new Map<string, PersistedLease>();

beforeEach(() => {
  appendedBreachRows = [];
  scannedLeases = new Map();
  bulkStubEnv(testEnv);

  vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvents").mockImplementation(
    mockSendIsbEvents,
  );
  vi.spyOn(IsbClients, "costExplorer").mockReturnValue({} as any);
  vi.spyOn(DynamoLeaseStore.prototype, "update").mockResolvedValue(
    undefined as any,
  );
  vi.spyOn(
    DynamoLeaseStore.prototype,
    "updateMonitoringCostFields",
  ).mockResolvedValue(undefined);
  vi.spyOn(
    DynamoLeaseStore.prototype,
    "updateMonitoringOwnedFields",
  ).mockResolvedValue(undefined);
  vi.spyOn(
    DynamoLeaseCostHistoryStore.prototype,
    "getNewestCostObservation",
  ).mockResolvedValue(noHistory);
  vi.spyOn(
    DynamoLeaseCostHistoryStore.prototype,
    "getRecentCostObservations",
  ).mockResolvedValue({ complete: true, result: [] });
  vi.spyOn(
    DynamoLeaseCostHistoryStore.prototype,
    "appendCostObservation",
  ).mockImplementation(async (row) => row as CostObservation);
  vi.spyOn(
    DynamoLeaseCostHistoryStore.prototype,
    "appendBreachRecord",
  ).mockImplementation(async (row) => {
    appendedBreachRows.push(row);
    return row as any;
  });
  vi.spyOn(
    DynamoLeaseCostHistoryStore.prototype,
    "listBreachRecords",
  ).mockImplementation(async (leaseUuid) => ({
    result: appendedBreachRows.filter(
      (row) => row.leaseUuid === leaseUuid,
    ) as BreachRecord[],
    droppedRecordCount: 0,
    droppedRecordReason: null,
  }));
  // Default: the tag query covers no lease, so every lease is served by the
  // legacy account query at FALLBACK_COST. Tests that exercise the tag path
  // override the daily report.
  vi.spyOn(
    CostExplorerService.prototype,
    "getDailyCostForLeasesByTag",
  ).mockResolvedValue(new LeaseDailyCostReport(false));
  vi.spyOn(
    CostExplorerService.prototype,
    "getBedrockTokenCostByLease",
  ).mockResolvedValue(new BedrockTokenCostReport());
  vi.spyOn(
    CostExplorerService.prototype,
    "getBedrockTokenCostByAccount",
  ).mockResolvedValue(new BedrockTokenCostReport());
  vi.spyOn(
    CostExplorerService.prototype,
    "getCostForLeases",
  ).mockImplementation(async (accountsWithStartDates) => {
    const report = new AccountsCostReport();
    for (const accountId of Object.keys(accountsWithStartDates)) {
      report.addCost(accountId, FALLBACK_COST);
    }
    return report;
  });
});
afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetAllMocks();
  vi.restoreAllMocks();
});

function leaseStore() {
  return {
    findByStatus: {
      returns: (
        leases: Partial<{ [key in LeaseStatus]: PersistedLease[] }>,
      ) => {
        for (const lease of Object.values(leases).flat()) {
          scannedLeases.set(lease.uuid, lease);
        }
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

/** Every event published this scan, in order, across the per-lease calls. */
function sentEvents(): unknown[] {
  return mockSendIsbEvents.mock.calls.flatMap((call) => call.slice(1));
}

/** Every breach row appended this test, in order. */
function appendedBreaches(): NewBreachRecord[] {
  return vi
    .mocked(DynamoLeaseCostHistoryStore.prototype.appendBreachRecord)
    .mock.calls.map(([row]) => row);
}

/** A scoped lease write laid over a row, as DynamoDB applies it. */
function applyScopedWrite<T extends object>(
  row: T,
  write: LeaseUpdateMonitoringOwnedFieldsProps,
): T {
  const { totalCostAccrued, lastCheckedDate, lastEvaluatedSpend, projection } =
    write;
  return {
    ...row,
    totalCostAccrued,
    lastCheckedDate,
    lastEvaluatedSpend,
    ...projection,
  };
}

/** Every lease written this test, as the row stands after its scoped write. */
function updates(): PersistedMonitoredLease[] {
  return vi
    .mocked(DynamoLeaseStore.prototype.updateMonitoringOwnedFields)
    .mock.calls.map(([write]) =>
      applyScopedWrite(
        scannedLeases.get(write.leaseId) as PersistedMonitoredLease,
        write,
      ),
    );
}

function dailyReport(
  entries: Record<string, Record<string, number>>,
  includeServiceBreakdown = false,
): LeaseDailyCostReport {
  const report = new LeaseDailyCostReport(includeServiceBreakdown);
  for (const [leaseId, days] of Object.entries(entries)) {
    for (const [day, amount] of Object.entries(days)) {
      report.addCost(leaseId, day, amount);
    }
  }
  return report;
}

function storedRow(
  leaseUuid: string,
  observedAt: DateTime,
  overrides: Partial<CostObservation> = {},
): CostObservation {
  return {
    leaseUuid,
    sk: `COST#${observedAt.toISO()}`,
    billedCostAccrued: 60,
    billedCostDelta: 28,
    predictedCostAtRefresh: null,
    latestPeriodStart: observedAt.toFormat("yyyy-MM-dd"),
    latestPeriodAmount: 5,
    billedBedrockTokenCost: null,
    ttl: futureTtl(),
    meta: { schemaVersion: LeaseCostHistorySchemaVersion },
    ...overrides,
  };
}

function loggedRecords(logDetailType: string): Record<string, unknown>[] {
  return vi
    .mocked(Logger.prototype.info)
    .mock.calls.map((call) => call[1] as Record<string, unknown> | undefined)
    .filter(
      (extra): extra is Record<string, unknown> =>
        extra !== undefined && extra.logDetailType === logDetailType,
    );
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
      sandboxSpacesEnabled: false,
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
      sandboxSpacesEnabled: false,
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

  /** The fields a v1.3 budget alert carried; the extended fields are asserted separately. */
  function legacyAlert(
    lease: PersistedMonitoredLease,
    budgetThresholdTriggered: number,
    actionRequested: "ALERT" | "FREEZE_ACCOUNT",
  ) {
    return expect.objectContaining({
      Detail: expect.objectContaining({
        leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
        accountId: lease.awsAccountId,
        budget: lease.maxSpend,
        budgetThresholdTriggered,
        totalSpend: FALLBACK_COST,
        actionRequested,
        triggeredBy: "REPORTED",
      }),
    });
  }

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
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(2);
      expect(sentEvents()).toEqual([
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: monitoredLeases[0]!.userEmail,
            uuid: monitoredLeases[0]!.uuid,
          },
          accountId: monitoredLeases[0]!.awsAccountId!,
          budget: monitoredLeases[0]!.maxSpend,
          totalSpend: FALLBACK_COST,
          detectedBy: "LEASE_MONITORING",
        }),
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: monitoredLeases[1]!.userEmail,
            uuid: monitoredLeases[1]!.uuid,
          },
          accountId: monitoredLeases[1]!.awsAccountId!,
          budget: monitoredLeases[1]!.maxSpend,
          totalSpend: FALLBACK_COST,
          detectedBy: "LEASE_MONITORING",
        }),
      ]);
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

      expect(mockSendIsbEvents).toHaveBeenCalledTimes(5);
      const events = sentEvents() as Array<{
        Detail: {
          leaseId: { uuid: string };
          actionRequested?: string;
          budgetThresholdTriggered?: number;
          triggeredDurationThreshold?: number;
        };
      }>;
      expect(events).toHaveLength(6);
      expect(
        events.filter(
          (event) => event instanceof LeaseFreezingThresholdBreachedAlert,
        ),
      ).toHaveLength(1);
      expect(
        events.some(
          (event) =>
            event instanceof LeaseFreezingThresholdBreachedAlert &&
            event.Detail.leaseId.uuid === frozenPastFreeze.uuid,
        ),
      ).toBe(false);
      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            Detail: expect.objectContaining({
              leaseId: expect.objectContaining({
                uuid: frozenPastFreeze.uuid,
              }),
              budgetThresholdTriggered: 90,
              actionRequested: "ALERT",
            }),
          }),
          expect.objectContaining({
            Detail: expect.objectContaining({
              leaseId: expect.objectContaining({
                uuid: frozenPastFreeze.uuid,
              }),
              triggeredDurationThreshold: 14 * 24,
              actionRequested: "ALERT",
            }),
          }),
        ]),
      );

      const written = updates();
      expect(written).toHaveLength(6);
      expect(
        Object.fromEntries(
          written.map((lease) => [lease.awsAccountId, lease.totalCostAccrued]),
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

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      expect(updates()).toEqual([
        expect.objectContaining({
          uuid: lease.uuid,
          status: "Frozen",
          totalCostAccrued: 120,
        }),
      ]);
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
      expect(sentEvents()).toEqual([
        new LeaseBudgetExceededAlert({
          leaseId: {
            userEmail: overBudgetLease.userEmail,
            uuid: overBudgetLease.uuid,
          },
          accountId: overBudgetLease.awsAccountId!,
          budget: overBudgetLease.maxSpend,
          totalSpend: FALLBACK_COST,
          detectedBy: "LEASE_MONITORING",
        }),
        legacyAlert(willAlertLease, 120, "ALERT"),
      ]);
    });

    describe("after Bedrock token monitoring is switched off", () => {
      function billOf(amount: number) {
        vi.spyOn(
          CostExplorerService.prototype,
          "getCostForLeases",
        ).mockImplementation(async (accountsWithStartDates) => {
          const report = new AccountsCostReport();
          for (const accountId of Object.keys(accountsWithStartDates)) {
            report.addCost(accountId, amount);
          }
          return report;
        });
      }

      // The token poll compared 70 and fired the 68 alert while the bill
      // Lease Monitoring stored beside it read 60.
      const handedOver: PersistedMonitoredLease = {
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        maxSpend: 200,
        predictiveBudgetEnabled: false,
        bedrockTokenMonitoringEnabled: false,
        totalCostAccrued: 60,
        lastEvaluatedSpend: 70,
        budgetThresholds: [
          { dollarsSpent: 68, action: "ALERT" },
          { dollarsSpent: 80, action: "ALERT" },
        ],
      };

      it("keeps the poll's figure until the bill passes it, so a threshold the poll fired does not fire again", async () => {
        billOf(67);
        leaseStore().findByStatus.returns({ Active: [handedOver] });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(mockSendIsbEvents).not.toHaveBeenCalled();
        const [written] = updates();
        expect(written).toMatchObject({
          totalCostAccrued: 67,
          lastEvaluatedSpend: 70,
        });

        // The bill passes 68 and 80; only 80 is above what the poll compared.
        billOf(85);
        leaseStore().findByStatus.returns({ Active: [written!] });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(appendedBreaches().map((row) => row.thresholdDollars)).toEqual([
          80,
        ]);
        expect(updates().at(-1)).toMatchObject({
          totalCostAccrued: 85,
          lastEvaluatedSpend: 85,
        });
      });

      it("stores a bill that falls below its own last figure, re-arming the thresholds above it", async () => {
        billOf(67);
        leaseStore().findByStatus.returns({
          Active: [
            { ...handedOver, totalCostAccrued: 70, lastEvaluatedSpend: 70 },
          ],
        });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(updates()[0]).toMatchObject({
          totalCostAccrued: 67,
          lastEvaluatedSpend: 67,
        });
      });
    });

    describe("maxSpend breach row", () => {
      const overBudgetLease = () => ({
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        maxSpend: 100,
        // 80.00 stood after the previous run; this run reads 120.00
        totalCostAccrued: 80,
      });

      it("writes one MAX_SPEND row on the run that reaches maxSpend, before sending the termination", async () => {
        vi.spyOn(Logger.prototype, "info");
        const lease = overBudgetLease();
        leaseStore().findByStatus.returns({ Active: [lease] });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(sentEvents()).toEqual([
          expect.objectContaining({
            Detail: expect.objectContaining({ budget: 100 }),
          }),
        ]);
        expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
        expect(appendedBreaches()).toEqual([
          {
            leaseUuid: lease.uuid,
            triggeredBy: "MAX_SPEND",
            action: "TERMINATE",
            thresholdDollars: 100,
            thresholdRate: null,
            thresholdRateBasis: null,
            thresholdHoursRemaining: null,
            billedCostAtFire: FALLBACK_COST,
            predictedCostAtFire: null,
            evaluatedBy: "LEASE_MONITORING",
            evaluatedSpendAtFire: null,
            monitoredBedrockTokenCostAtFire: null,
            rateAtFire: null,
            rateSourceAtFire: null,
            insight: null,
            ttl: Math.floor(
              DateTime.fromISO(lease.expirationDate!, { zone: "utc" })
                .plus({ days: mockGlobalConfig().leases.ttl })
                .toSeconds(),
            ),
          },
        ]);
        // the row the store would be handed parses as a stored row, under a
        // real lease UUID in place of the fixture's
        expect(() =>
          BreachRecordSchema.parse({
            ...appendedBreaches()[0],
            leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
            sk: "BREACH#2026-08-11T11:00:00.000Z",
            meta: { schemaVersion: LeaseCostHistorySchemaVersion },
          }),
        ).not.toThrow();
        expect(
          vi.mocked(DynamoLeaseCostHistoryStore.prototype.appendBreachRecord)
            .mock.invocationCallOrder[0],
        ).toBeLessThan(mockSendIsbEvents.mock.invocationCallOrder[0]!);
        expect(loggedRecords("BudgetThresholdFired")).toEqual([]);
      });

      it("sends the termination again on a later run still over maxSpend, but writes no second row", async () => {
        leaseStore().findByStatus.returns({ Active: [overBudgetLease()] });
        await performAccountMonitoringScan({} as any, mockContext(testEnv));
        const [written] = updates();
        expect(written!.totalCostAccrued).toBe(FALLBACK_COST);
        // A terminal run checks no threshold, so with no figure stored the
        // billed 80.00 from before the run stands for the next check.
        expect(written!.lastEvaluatedSpend).toBe(80);

        leaseStore().findByStatus.returns({ Active: [written!] });
        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(sentEvents()).toHaveLength(2);
        expect(
          sentEvents().every(
            (event) => event instanceof LeaseBudgetExceededAlert,
          ),
        ).toBe(true);
        expect(appendedBreaches()).toHaveLength(1);
      });

      it("writes the row where this run's bill lands exactly on maxSpend", async () => {
        leaseStore().findByStatus.returns({
          Active: [{ ...overBudgetLease(), maxSpend: FALLBACK_COST }],
        });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(sentEvents()).toHaveLength(1);
        expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
        expect(appendedBreaches()).toHaveLength(1);
      });

      it("still sends the termination where the row cannot be written", async () => {
        vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
        vi.mocked(
          DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
        ).mockRejectedValue(new Error("table unavailable"));
        const lease = overBudgetLease();
        leaseStore().findByStatus.returns({ Active: [lease] });

        await performAccountMonitoringScan({} as any, mockContext(testEnv));

        expect(sentEvents()).toHaveLength(1);
        expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
        expect(updates()[0]!.totalCostAccrued).toBe(FALLBACK_COST);
        expect(Logger.prototype.error).toHaveBeenCalledWith(
          `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
          expect.objectContaining({ leaseId: lease.uuid }),
        );
      });
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
      expect(sentEvents()).toEqual([
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
            totalSpend: FALLBACK_COST,
            triggeredBy: "REPORTED",
          },
        }),
      ]);
      // Every crossing is recorded even though only one is published.
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledTimes(2);
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
      expect(sentEvents()).toEqual([
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
            totalSpend: FALLBACK_COST,
            triggeredBy: "REPORTED",
          },
        }),
        legacyAlert(lease, 100, "ALERT"),
      ]);
    });

    it("sends no freeze for a lease that is already Frozen, and the freeze does not suppress the alert below it", async () => {
      const frozenLease = {
        ...monitoredLeasesBase[1]!,
        status: "Frozen" as const,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 40,
        budgetThresholds: [
          { dollarsSpent: 60, action: "ALERT" },
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({ Frozen: [frozenLease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      // Only an Active lease can be frozen, so the alert at 60 is sent instead.
      expect(sentEvents()).toEqual([legacyAlert(frozenLease, 60, "ALERT")]);
      // Both crossings are still recorded without reading breach history.
      expect(
        appendedBreaches().map((row) => [row.thresholdDollars, row.action]),
      ).toEqual([
        [60, "ALERT"],
        [100, "FREEZE_ACCOUNT"],
      ]);
      expect(
        DynamoLeaseCostHistoryStore.prototype.listBreachRecords,
      ).not.toHaveBeenCalled();
    });

    it("emits one BudgetThresholdFired record per newly breached threshold, with the hours since the last refresh", async () => {
      vi.spyOn(Logger.prototype, "info");
      const anchoredAt = now().minus({ hours: 3 });
      const lease = {
        ...monitoredLeasesBase[1]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 40,
        budgetThresholds: [
          { dollarsSpent: 60, action: "ALERT" },
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({
        complete: true,
        result: storedRow(lease.uuid, anchoredAt, { billedCostAccrued: 40 }),
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const fired = loggedRecords("BudgetThresholdFired");
      expect(fired).toHaveLength(2);
      expect(fired).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            thresholdDollars: 60,
            action: "ALERT",
            triggeredBy: "REPORTED",
            evaluatedBy: "LEASE_MONITORING",
            spendAtFire: FALLBACK_COST,
            billedCostAtFire: FALLBACK_COST,
          }),
          expect.objectContaining({
            thresholdDollars: 100,
            action: "FREEZE_ACCOUNT",
            costAtFreezeDecision: FALLBACK_COST,
          }),
        ]),
      );
      // The fallback total moved, so the row appended this run is the newest.
      expect(fired[0]!.hoursSinceLastRefresh).toBeCloseTo(0, 2);
    });
  });

  describe("Cost attribution", () => {
    const today = now().toFormat("yyyy-MM-dd");

    it("does not call CostExplorer when no leases are being monitored", async () => {
      leaseStore().findByStatus.returns({ Active: [], Frozen: [] });

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toBeDefined();
      expect(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).not.toHaveBeenCalled();
      expect(
        CostExplorerService.prototype.getCostForLeases,
      ).not.toHaveBeenCalled();
    });

    it("serves every lease from the tag report when it covers them all, with no fallback call", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [monitoredLeases[0]!.uuid]: { [today]: 90 },
          [monitoredLeases[1]!.uuid]: { [today]: 110 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        CostExplorerService.prototype.getCostForLeases,
      ).not.toHaveBeenCalled();
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: monitoredLeases[0],
          source: { kind: "TAG", buckets: { [today]: { amount: 90 } } },
        }),
        expect.anything(),
      );
      const byAccount = Object.fromEntries(
        updates().map((update) => [
          update.awsAccountId,
          update.totalCostAccrued,
        ]),
      );
      expect(byAccount).toEqual({
        [monitoredLeases[0]!.awsAccountId]: 90,
        [monitoredLeases[1]!.awsAccountId]: 110,
      });
    });

    it("queries from the earliest resume day across leases and passes the breakdown setting", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockImplementation(async (leaseUuid) =>
        leaseUuid === monitoredLeases[0]!.uuid
          ? {
              complete: true,
              result: storedRow(leaseUuid, now().minus({ days: 2 })),
            }
          : noHistory,
      );
      const globalConfig = mockGlobalConfig();
      globalConfig.leases.serviceBreakdownEnabled = true;

      await performAccountMonitoringScan(
        {} as any,
        mockContext(testEnv, globalConfig),
      );

      const [leases, start, , options] = vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mock.calls[0]!;
      expect(leases).toEqual(monitoredLeases);
      // The second lease has no observation, so its start date opens the window.
      expect(start.toISODate()).toBe(
        DateTime.fromISO(monitoredLeases[1]!.startDate, {
          zone: "utc",
        }).toISODate(),
      );
      expect(options).toEqual({ includeServiceBreakdown: true });
    });

    it("falls back entirely to the account query when no lease is tag-covered", async () => {
      const monitoredLeases = monitoredLeasesBase;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).toHaveBeenCalledTimes(1);
      const fallbackSpy = vi.mocked(
        CostExplorerService.prototype.getCostForLeases,
      );
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(Object.keys(fallbackSpy.mock.calls[0]![0]!).sort()).toEqual(
        monitoredLeases.map((l) => l.awsAccountId).sort(),
      );
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { kind: "FALLBACK", billedCostAccrued: FALLBACK_COST },
        }),
        expect.anything(),
      );
    });

    it("partitions correctly when some leases are tag-covered and others are not", async () => {
      const monitoredLeases = monitoredLeasesBase;
      const taggedLease = monitoredLeases[0]!;
      const untaggedLease = monitoredLeases[1]!;
      leaseStore().findByStatus.returns({ Active: monitoredLeases });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({ [taggedLease.uuid]: { [today]: 95 } }));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const fallbackSpy = vi.mocked(
        CostExplorerService.prototype.getCostForLeases,
      );
      expect(fallbackSpy).toHaveBeenCalledTimes(1);
      expect(Object.keys(fallbackSpy.mock.calls[0]![0]!)).toEqual([
        untaggedLease.awsAccountId,
      ]);
      const byAccount = Object.fromEntries(
        updates().map((update) => [
          update.awsAccountId,
          update.totalCostAccrued,
        ]),
      );
      expect(byAccount).toEqual({
        [taggedLease.awsAccountId]: 95,
        [untaggedLease.awsAccountId]: FALLBACK_COST,
      });
    });

    it("propagates a tag-query failure without falling back", async () => {
      leaseStore().findByStatus.returns({ Active: monitoredLeasesBase });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockRejectedValue(new Error("CE service unavailable"));

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).rejects.toThrow("CE service unavailable");
      expect(
        CostExplorerService.prototype.getCostForLeases,
      ).not.toHaveBeenCalled();
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).not.toHaveBeenCalled();
    });
  });

  describe("Per-lease processing", () => {
    it("leaves earlier leases fully persisted and later ones untouched when a lease throws part-way", async () => {
      const third: PersistedMonitoredLease = {
        ...monitoredLeasesBase[0]!,
        uuid: "testLease103",
        userEmail: "test3@example.com",
        awsAccountId: "222222222222",
      };
      // Leases 1 and 3 cross a threshold at the fallback figure; lease 2 throws
      // on its record write.
      const leases = [...monitoredLeasesBase, third].map((lease, index) => ({
        ...lease,
        durationThresholds: [],
        budgetThresholds:
          index === 1
            ? []
            : ([{ dollarsSpent: 100, action: "ALERT" }] as BudgetThreshold[]),
      }));
      leaseStore().findByStatus.returns({ Active: leases });
      vi.mocked(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).mockImplementation(async ({ leaseId }) => {
        if (leaseId === leases[1]!.uuid) {
          throw new Error("table unavailable");
        }
      });

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).rejects.toThrow("table unavailable");

      const attempted = updates().map((update) => update.uuid);
      expect(attempted).toEqual([leases[0]!.uuid, leases[1]!.uuid]);
      expect(recordCostObservation).toHaveBeenCalledTimes(2);
      // Lease 1 was published and audited before lease 2 threw; lease 3 never was.
      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      expect(sentEvents()).toEqual([legacyAlert(leases[0]!, 100, "ALERT")]);
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledTimes(1);
    });

    it("fails open: a cost-history error on one lease stops neither its own reported enforcement nor the rest of the scan", async () => {
      const leases = monitoredLeasesBase.map((lease) => ({
        ...lease,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 80,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT" },
        ] as BudgetThreshold[],
      }));
      leaseStore().findByStatus.returns({ Active: leases });
      vi.mocked(recordCostObservation).mockRejectedValueOnce(
        new Error("cost history unavailable"),
      );

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toContain("2 leases");

      expect(recordCostObservation).toHaveBeenCalledTimes(2);
      expect(sentEvents()).toEqual([
        legacyAlert(leases[0]!, 100, "ALERT"),
        legacyAlert(leases[1]!, 100, "ALERT"),
      ]);
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).toHaveBeenCalledTimes(2);
    });

    it("fails open on a tag-served lease: a failed append still enforces on the fresh figure and writes it", async () => {
      const today = now().toFormat("yyyy-MM-dd");
      const lease = {
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 80,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({ [lease.uuid]: { [today]: 130 } }));
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).mockRejectedValueOnce(new Error("cost history unavailable"));

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toContain("1 leases");

      const [alert] = sentEvents() as LeaseBudgetThresholdBreachedAlert[];
      expect(alert!.Detail).toMatchObject({
        budgetThresholdTriggered: 100,
        totalSpend: 130,
        triggeredBy: "REPORTED",
      });
      expect(updates()[0]!.totalCostAccrued).toBe(130);
    });

    it("continues past a lease whose anchor read fails, enforcing it on the Cost Explorer figure alone", async () => {
      const leases = monitoredLeasesBase.map((lease) => ({
        ...lease,
        durationThresholds: [],
        budgetThresholds: [],
      }));
      leaseStore().findByStatus.returns({ Active: leases });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockImplementation(async (leaseUuid) => {
        if (leaseUuid === leases[0]!.uuid) {
          throw new Error("table unavailable");
        }
        return noHistory;
      });

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toContain("2 leases");

      expect(recordCostObservation).toHaveBeenCalledTimes(1);
      const byUuid = Object.fromEntries(
        updates().map((update) => [update.uuid, update.totalCostAccrued]),
      );
      expect(byUuid).toEqual({
        [leases[0]!.uuid]: FALLBACK_COST,
        [leases[1]!.uuid]: FALLBACK_COST,
      });
    });

    it("publishes the event and writes the lease even when the breach record cannot be written", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        durationThresholds: [],
        maxSpend: 200,
        totalCostAccrued: 80,
        budgetThresholds: [
          { dollarsSpent: 100, action: "FREEZE_ACCOUNT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({
        Active: [lease, monitoredLeasesBase[1]!],
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).mockRejectedValue(new Error("table unavailable"));

      await expect(
        performAccountMonitoringScan({} as any, mockContext(testEnv)),
      ).resolves.toContain("2 leases");

      expect(sentEvents()[0]).toEqual(
        expect.objectContaining({
          Detail: expect.objectContaining({
            reason: expect.objectContaining({
              type: "BudgetExceeded",
              triggeredBudgetThreshold: 100,
            }),
          }),
        }),
      );
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).toHaveBeenCalledTimes(2);
    });

    it("still advances lastCheckedDate and writes the reported total when the observation is unchanged", async () => {
      const lease = { ...monitoredLeasesBase[0]!, durationThresholds: [] };
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(recordCostObservation).mockResolvedValueOnce({
        status: "UNCHANGED",
        billedCostAccrued: 80,
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const [update] = updates();
      expect(update!.totalCostAccrued).toBe(80);
      expect(
        DateTime.fromISO(update!.lastCheckedDate) >
          DateTime.fromISO(lease.lastCheckedDate),
      ).toBe(true);
      expect(mockSendIsbEvents).not.toHaveBeenCalled();
    });

    it("keeps a lease frozen after the scan read it, as it writes only its own fields", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        durationThresholds: [],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      const freeze = {
        status: "Frozen",
        resourceLock: {
          ownerId: "freeze-execution",
          acquiredAt: now().toISO(),
          expiresAt: now().plus({ minutes: 15 }).toISO(),
          meta: { intent: "FREEZE" },
        },
      };
      let row: object = lease;
      // Another writer freezes the lease while the scan reads Cost Explorer.
      vi.mocked(
        CostExplorerService.prototype.getCostForLeases,
      ).mockImplementation(async (accountsWithStartDates) => {
        row = { ...row, ...freeze };
        const report = new AccountsCostReport();
        for (const accountId of Object.keys(accountsWithStartDates)) {
          report.addCost(accountId, FALLBACK_COST);
        }
        return report;
      });
      vi.mocked(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).mockImplementation(async (write) => {
        row = applyScopedWrite(row, write);
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(DynamoLeaseStore.prototype.update).not.toHaveBeenCalled();
      expect(row).toMatchObject({
        ...freeze,
        totalCostAccrued: FALLBACK_COST,
      });
    });

    it("processes a lease once when both status queries return it, as most recently edited", async () => {
      const active: PersistedMonitoredLease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        durationThresholds: [],
        meta: { schemaVersion: 5, lastEditTime: "2026-10-20T00:00:00.000Z" },
      };
      const frozen: PersistedMonitoredLease = {
        ...active,
        status: "Frozen",
        meta: { schemaVersion: 5, lastEditTime: "2026-10-20T00:00:01.000Z" },
      };
      leaseStore().findByStatus.returns({ Active: [active], Frozen: [frozen] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).toHaveBeenCalledTimes(1);
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({ lease: frozen }),
        expect.anything(),
      );
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).toHaveBeenCalledTimes(1);
    });
  });

  describe("Predictive budget opt-in", () => {
    // Pinned so the elapsed hours, and therefore every projected figure, are
    // exact rather than off by the milliseconds between fixture and run.
    const frozenNow = DateTime.fromISO("2026-09-09T12:00:00.000Z", {
      zone: "utc",
    });
    const anchoredAt = frozenNow.minus({ hours: 3 });
    const earlierAt = frozenNow.minus({ hours: 11 });

    beforeEach(() => {
      vi.useFakeTimers();
      vi.setSystemTime(frozenNow.toJSDate());
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const optedInLease: PersistedMonitoredLease = {
      ...monitoredLeasesBase[0]!,
      predictiveBudgetEnabled: true,
      durationThresholds: [],
      maxSpend: 200,
      totalCostAccrued: 60,
      lastPredictedSpend: 60,
      budgetThresholds: [
        { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
        { dollarsSpent: 150, action: "ALERT" },
      ] as BudgetThreshold[],
    };

    /** Two stored readings, $32 at T-11h and $60 at T-3h, so the hourly rate is $3.50. */
    function storeSeries(
      lease: PersistedMonitoredLease,
      newestOverrides: Partial<CostObservation> = {},
    ) {
      const newest = storedRow(lease.uuid, anchoredAt, {
        billedCostAccrued: 60,
        ...newestOverrides,
      });
      const older = storedRow(lease.uuid, earlierAt, {
        billedCostAccrued: 32,
        billedCostDelta: 32,
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({ complete: true, result: [newest, older] });
      return newest;
    }

    it("records the observation but skips prediction for a non-opted-in lease", async () => {
      leaseStore().findByStatus.returns({
        Active: [{ ...optedInLease, predictiveBudgetEnabled: false }],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).toHaveBeenCalledTimes(1);
      expect(getRecentObservations).not.toHaveBeenCalled();
      const [update] = updates();
      expect(update).not.toHaveProperty("lastEvaluatedHourlySpendRate");
    });

    it("passes the lease's last projection and the configured retention into the observation", async () => {
      leaseStore().findByStatus.returns({
        Active: [
          {
            ...optedInLease,
            lastPredictedSpend: 95,
            lastEvaluatedHourlySpendRate: 3.5,
          },
        ],
      });
      const globalConfig = mockGlobalConfig();
      globalConfig.leases.ttl = 45;

      await performAccountMonitoringScan(
        {} as any,
        mockContext(testEnv, globalConfig),
      );

      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          source: { kind: "FALLBACK", billedCostAccrued: FALLBACK_COST },
          anchor: noHistory,
          predictedCostAtRefresh: 95,
          bedrockTokens: null,
          retentionDays: 45,
        }),
        expect.anything(),
      );
    });

    it("runs the Bedrock token query only for monitored leases, over the main query's window, and records their slice", async () => {
      const monitored = {
        ...optedInLease,
        uuid: "monitored-lease",
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [optedInLease, monitored] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({ [monitored.uuid]: { "2026-09-09": 5 } }),
      );
      const report = new BedrockTokenCostReport();
      report.addCost(monitored.uuid, "2026-09-09", 0.8);
      report.addCost(monitored.uuid, "2026-09-10", 0.1);
      vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      ).mockResolvedValue(report);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const tokenQuery = vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      );
      const mainQuery = vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      );
      expect(tokenQuery).toHaveBeenCalledTimes(1);
      expect(tokenQuery.mock.calls[0]![0]).toEqual([monitored]);
      expect(tokenQuery.mock.calls[0]![1]).toEqual(mainQuery.mock.calls[0]![1]);
      expect(tokenQuery.mock.calls[0]![2]).toEqual(mainQuery.mock.calls[0]![2]);

      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ uuid: optedInLease.uuid }),
          bedrockTokens: null,
        }),
        expect.anything(),
      );
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ uuid: monitored.uuid }),
          bedrockTokens: {
            costByDay: { "2026-09-09": 0.8, "2026-09-10": 0.1 },
          },
        }),
        expect.anything(),
      );
    });

    it("starts the Bedrock token query at the lease's start for a lease whose anchor was written with monitoring off", async () => {
      // Monitoring was switched on after this row. The slice is re-summed from
      // the lease's start, where the token poll's count also starts.
      const monitored = {
        ...optedInLease,
        uuid: "switched-on-lease",
        startDate: "2026-09-01T15:00:00.000Z",
        bedrockTokenMonitoringEnabled: true,
      };
      const anchor = storedRow(monitored.uuid, anchoredAt, {
        billedBedrockTokenCost: null,
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: anchor });
      // An unmonitored lease never carries a slice, so it must not widen the
      // token query to its earlier start.
      const unmonitored = {
        ...optedInLease,
        uuid: "unmonitored-lease",
        awsAccountId: "222222222222",
        startDate: "2026-08-20T00:00:00.000Z",
      };
      leaseStore().findByStatus.returns({ Active: [monitored, unmonitored] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({ [monitored.uuid]: { [anchor.latestPeriodStart]: 5 } }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const [, mainStart] = vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mock.calls[0]!;
      const [, tokenStart] = vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      ).mock.calls[0]!;
      expect(mainStart.toISODate()).toBe(anchor.latestPeriodStart);
      expect(tokenStart.toISODate()).toBe("2026-09-01");
    });

    it("skips the account-grouped token query when only unmonitored leases fall back", async () => {
      const monitored = {
        ...optedInLease,
        uuid: "monitored-lease",
        awsAccountId: "222222222222",
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [optedInLease, monitored] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({ [monitored.uuid]: { "2026-09-09": 5 } }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        CostExplorerService.prototype.getCostForLeases,
      ).toHaveBeenCalledTimes(1);
      expect(
        CostExplorerService.prototype.getBedrockTokenCostByAccount,
      ).not.toHaveBeenCalled();
    });

    it("reads a fallback-served monitored lease's slice from one account-grouped query from the earliest start day, and writes 0.00 rather than null with nothing billed", async () => {
      const early = {
        ...optedInLease,
        uuid: "early-lease",
        awsAccountId: "222222222222",
        startDate: "2026-09-05T03:00:00.000Z",
        bedrockTokenMonitoringEnabled: true,
      };
      const late = {
        ...optedInLease,
        uuid: "late-lease",
        awsAccountId: "333333333333",
        startDate: "2026-09-08T15:00:00.000Z",
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [early, late] });
      const accountReport = new BedrockTokenCostReport();
      // A previous tenant's spend on the day before the lease started.
      accountReport.addCost(late.awsAccountId, "2026-09-07", 9);
      accountReport.addCost(late.awsAccountId, "2026-09-08", 0.5);
      accountReport.addCost(late.awsAccountId, "2026-09-09", 0.25);
      vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByAccount,
      ).mockResolvedValue(accountReport);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const accountQuery = vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByAccount,
      );
      expect(accountQuery).toHaveBeenCalledTimes(1);
      const [accounts, start, end] = accountQuery.mock.calls[0]!;
      expect(accounts).toEqual([early.awsAccountId, late.awsAccountId]);
      expect(start.toISO()).toBe("2026-09-05T00:00:00.000Z");
      expect(end.toISO()).toBe(frozenNow.toISO());
      // Both leases fell back, so the tag-grouped query has nothing to find
      // and is not sent.
      expect(
        vi.mocked(CostExplorerService.prototype.getBedrockTokenCostByLease),
      ).not.toHaveBeenCalled();

      const appended = vi
        .mocked(DynamoLeaseCostHistoryStore.prototype.appendCostObservation)
        .mock.calls.map(([row]) => row);
      expect(appended).toEqual([
        expect.objectContaining({
          leaseUuid: early.uuid,
          billedCostAccrued: FALLBACK_COST,
          billedBedrockTokenCost: 0,
          latestPeriodBedrockTokenAmount: 0,
        }),
        expect.objectContaining({
          leaseUuid: late.uuid,
          billedCostAccrued: FALLBACK_COST,
          billedBedrockTokenCost: 0.75,
          latestPeriodBedrockTokenAmount: 0.75,
        }),
      ]);
    });

    it("withholds a fallback-served monitored lease's row when the account-grouped query fails, leaving a tag-served one unaffected", async () => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const tagged = {
        ...optedInLease,
        uuid: "tagged-lease",
        bedrockTokenMonitoringEnabled: true,
      };
      const fallback = {
        ...optedInLease,
        uuid: "fallback-lease",
        awsAccountId: "222222222222",
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [tagged, fallback] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({ [tagged.uuid]: { "2026-09-09": 5 } }));
      const tagReport = new BedrockTokenCostReport();
      tagReport.addCost(tagged.uuid, "2026-09-09", 0.8);
      vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      ).mockResolvedValue(tagReport);
      vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByAccount,
      ).mockRejectedValueOnce(new Error("Cost Explorer down"));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).toHaveBeenCalledTimes(1);
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ uuid: tagged.uuid }),
          bedrockTokens: { costByDay: { "2026-09-09": 0.8 } },
        }),
        expect.anything(),
      );
      expect(Logger.prototype.error).toHaveBeenCalledTimes(1);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("Bedrock token cost query by account failed"),
        expect.objectContaining({ leaseIds: [fallback.uuid] }),
      );
      // Both lease records are still updated from the reported figure.
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseId: fallback.uuid,
          totalCostAccrued: FALLBACK_COST,
        }),
      );
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ leaseId: tagged.uuid, totalCostAccrued: 5 }),
      );
    });

    it("sends the tag-grouped token query only for tag-served leases, and none when every monitored lease fell back", async () => {
      const tagged = {
        ...optedInLease,
        uuid: "tagged-lease",
        bedrockTokenMonitoringEnabled: true,
      };
      const fallback = {
        ...optedInLease,
        uuid: "fallback-lease",
        awsAccountId: "222222222222",
        bedrockTokenMonitoringEnabled: true,
      };
      const tokenQuery = vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      );

      leaseStore().findByStatus.returns({ Active: [tagged, fallback] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({ [tagged.uuid]: { "2026-09-09": 5 } }));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(tokenQuery).toHaveBeenCalledTimes(1);
      expect(tokenQuery.mock.calls[0]![0]).toEqual([tagged]);

      // Every monitored lease fell back: the tag-grouped query has nothing to
      // find, so it is not sent, and the fallback lease is still recorded.
      tokenQuery.mockClear();
      vi.mocked(recordCostObservation).mockClear();
      leaseStore().findByStatus.returns({ Active: [fallback] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({}));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(tokenQuery).not.toHaveBeenCalled();
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ uuid: fallback.uuid }),
          bedrockTokens: { costByDay: {} },
        }),
        expect.anything(),
      );
    });

    it("still records a fallback-served monitored lease when the tag-grouped token query fails, and names only the leases it withholds", async () => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      const tagged = {
        ...optedInLease,
        uuid: "tagged-lease",
        bedrockTokenMonitoringEnabled: true,
      };
      const fallback = {
        ...optedInLease,
        uuid: "fallback-lease",
        awsAccountId: "222222222222",
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [tagged, fallback] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(dailyReport({ [tagged.uuid]: { "2026-09-09": 5 } }));
      vi.mocked(
        CostExplorerService.prototype.getBedrockTokenCostByLease,
      ).mockRejectedValueOnce(new Error("Cost Explorer down"));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).toHaveBeenCalledTimes(1);
      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({
          lease: expect.objectContaining({ uuid: fallback.uuid }),
          bedrockTokens: { costByDay: {} },
        }),
        expect.anything(),
      );
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        expect.stringContaining("Bedrock token cost query failed"),
        expect.objectContaining({ leaseIds: [tagged.uuid] }),
      );
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).toHaveBeenCalledWith(expect.objectContaining({ leaseId: tagged.uuid }));
    });

    it("records no prior projection on the row when the stored figure had no rate behind it", async () => {
      leaseStore().findByStatus.returns({
        Active: [
          {
            ...optedInLease,
            lastPredictedSpend: 120,
            lastEvaluatedHourlySpendRate: null,
            lastEvaluatedDailySpendRate: null,
          },
        ],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).toHaveBeenCalledWith(
        expect.objectContaining({ predictedCostAtRefresh: null }),
        expect.anything(),
      );
    });

    it("fires a PREDICTED threshold the projection crosses while the reported total is flat, records the breach, and writes the scalars with the total", async () => {
      vi.spyOn(Logger.prototype, "info");
      storeSeries(optedInLease);
      leaseStore().findByStatus.returns({ Active: [optedInLease] });
      // The tag report re-reads the anchor day unchanged: no new row this run.
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      const [alert] = sentEvents() as LeaseBudgetThresholdBreachedAlert[];
      expect(alert!.Detail).toMatchObject({
        triggeredBy: "PREDICTED",
        budgetThresholdTriggered: 70,
        totalSpend: 60,
        rateSource: "HOURLY",
        rate: 3.5,
        lastReportedAt: anchoredAt.toISO(),
      });
      expect(alert!.Detail.predictedCost).toBeCloseTo(70.5, 2);
      expect(alert!.Detail.hoursToBudgetExhaustion).toBeCloseTo(
        (200 - 70.5) / 3.5,
        1,
      );
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          leaseUuid: optedInLease.uuid,
          triggeredBy: "PREDICTED",
          thresholdDollars: 70,
          evaluatedBy: "LEASE_MONITORING",
        }),
      );

      const [update] = updates();
      expect(update!.totalCostAccrued).toBe(60);
      expect(update!.lastPredictedSpend).toBeCloseTo(70.5, 2);
      expect(update!.lastEvaluatedHourlySpendRate).toBe(3.5);
      expect(update!.lastEvaluatedDailySpendRate).toBeNull();
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).not.toHaveBeenCalled();

      const [fired] = loggedRecords("BudgetThresholdFired");
      expect(fired).toMatchObject({
        triggeredBy: "PREDICTED",
        thresholdDollars: 70,
        billedCostAtFire: 60,
      });
      expect(fired!.hoursSinceLastRefresh).toBeCloseTo(3, 2);
      expect(loggedRecords("SpendRateComputed")).toEqual([
        expect.objectContaining({
          hourlyRate: 3.5,
          dailyRate: null,
          rateUnavailable: false,
          costExplorerRefreshed: false,
        }),
      ]);
      expect(loggedRecords("ProjectionAccuracy")).toEqual([]);
    });

    it("reports rates as unavailable for a lease with no series and falls the projection back to the reported total", async () => {
      vi.spyOn(Logger.prototype, "info");
      leaseStore().findByStatus.returns({ Active: [optedInLease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(loggedRecords("SpendRateComputed")).toEqual([
        expect.objectContaining({
          hourlyRate: null,
          dailyRate: null,
          rateUnavailable: true,
          costExplorerRefreshed: true,
        }),
      ]);
      expect(loggedRecords("ProjectionAccuracy")).toEqual([]);
      const [update] = updates();
      expect(update!.lastPredictedSpend).toBe(FALLBACK_COST);
      expect(update!.lastEvaluatedHourlySpendRate).toBeNull();
    });

    it("emits a ProjectionAccuracy record with zero error on a monitored lease whose rate carried forward exactly", async () => {
      vi.spyOn(Logger.prototype, "info");
      // A monitored lease's stored projection carries the measured Bedrock term,
      // so differencing it against the billed total would read high even here.
      const monitored = {
        ...optedInLease,
        bedrockTokenMonitoringEnabled: true,
        lastPredictedSpend: 80,
      };
      const anchor = storeSeries(monitored);
      leaseStore().findByStatus.returns({ Active: [monitored] });
      // The anchor day fills by exactly 3.5/h over the 3 elapsed hours.
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [monitored.uuid]: {
            [anchor.latestPeriodStart]: anchor.latestPeriodAmount + 10.5,
          },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const [accuracy] = loggedRecords("ProjectionAccuracy");
      expect(accuracy).toMatchObject({
        predictedCost: 70.5,
        billedCostAccrued: 70.5,
        rateSource: "HOURLY",
        algorithmId: "linear-max-v1",
      });
      expect(accuracy!.errorDollars as number).toBeCloseTo(0, 3);
      expect(accuracy!.intervalHours as number).toBeCloseTo(3, 2);
      expect(loggedRecords("SpendRateComputed")[0]).toMatchObject({
        costExplorerRefreshed: true,
      });
    });

    it("compares against the stored figures, records the billed total alone on the breach row, and stores this run's figures for the next scan", async () => {
      vi.spyOn(Logger.prototype, "info");
      // the figures the last scan compared
      const lease = {
        ...optedInLease,
        lastEvaluatedSpend: 60,
        lastPredictedSpend: 65,
      };
      storeSeries(lease);
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      // the stored predicted figure was 65.00, and 70.50 crosses the predicted
      // 70
      const [alert] = sentEvents() as LeaseBudgetThresholdBreachedAlert[];
      expect(alert!.Detail).toMatchObject({
        triggeredBy: "PREDICTED",
        budgetThresholdTriggered: 70,
        totalSpend: 60,
      });
      expect(alert!.Detail.predictedCost).toBeCloseTo(70.5, 2);
      // the breach row and the log both keep billedCostAtFire at the billed
      // total, and the row carries no evaluated-spend figure
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          billedCostAtFire: 60,
          evaluatedSpendAtFire: null,
        }),
      );
      expect(loggedRecords("BudgetThresholdFired")[0]).toMatchObject({
        billedCostAtFire: 60,
      });
      expect(alert!.Detail.hoursToBudgetExhaustion).toBeCloseTo(
        (200 - 70.5) / 3.5,
        1,
      );
      const [update] = updates();
      expect(update!.totalCostAccrued).toBe(60);
      expect(update!.lastEvaluatedSpend).toBe(60);
      expect(update!.lastPredictedSpend).toBeCloseTo(70.5, 2);
    });

    it("stores the compared figure for a lease without predictive controls too, so the next scan does not raise the same crossing", async () => {
      const lease: PersistedMonitoredLease = {
        ...optedInLease,
        predictiveBudgetEnabled: false,
        budgetThresholds: [
          { dollarsSpent: 150, action: "ALERT" },
        ] as BudgetThreshold[],
      };
      storeSeries(lease);
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 100 },
        }),
      );

      // The anchor day fills from $5 to $100: the total moves 60 -> 155 and
      // crosses 150 with no projection.
      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).toHaveBeenCalledTimes(1);
      const [written] = updates();
      expect(written!.lastEvaluatedSpend).toBe(155);

      // The next scan starts from the record this one wrote.
      mockSendIsbEvents.mockClear();
      leaseStore().findByStatus.returns({ Active: [written!] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
    });

    it("raises nothing for a threshold the stored figures were already past", async () => {
      // the figures the last scan compared
      const lease = {
        ...optedInLease,
        lastEvaluatedSpend: 80,
        lastPredictedSpend: 80,
      };
      storeSeries(lease);
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      // the stored 80.00 was already above the predicted 70 before this run
      expect(mockSendIsbEvents).not.toHaveBeenCalled();
    });

    /** Scans `lease` over the $3.50-an-hour series with $5 reported today. */
    async function scanRateLease(lease: PersistedMonitoredLease) {
      storeSeries(lease);
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );
      await performAccountMonitoringScan({} as any, mockContext(testEnv));
    }

    const rateFired = (thresholdRate: number, action: string) => ({
      rateBasis: "HOURLY",
      thresholdRate,
      measuredRate: 3.5,
      action,
    });
    const loggedRateFired = () =>
      loggedRecords("SpendRateThresholdFired").map(
        ({ rateBasis, thresholdRate, measuredRate, action }) => ({
          rateBasis,
          thresholdRate,
          measuredRate,
          action,
        }),
      );
    const rateFreezeReason = (thresholdRate: number) => ({
      type: "SpendRateExceeded",
      rateBasis: "HOURLY",
      thresholdRate,
      measuredRate: 3.5,
      budget: 200,
      totalSpend: 60,
    });

    it("records and logs every crossed rate limit but requests one freeze, for the highest freeze line", async () => {
      vi.spyOn(Logger.prototype, "info");
      // The measured 3.50 an hour crosses all three lines above the stored 2.00.
      await scanRateLease({
        ...optedInLease,
        budgetThresholds: [],
        rateLimits: [
          { basis: "HOURLY", rate: 2.5, action: "ALERT" },
          { basis: "HOURLY", rate: 3, action: "FREEZE_ACCOUNT" },
          { basis: "HOURLY", rate: 3.2, action: "FREEZE_ACCOUNT" },
        ],
        lastEvaluatedHourlySpendRate: 2,
      });

      expect(
        appendedBreaches().map(({ triggeredBy, thresholdRate, action }) => ({
          triggeredBy,
          thresholdRate,
          action,
        })),
      ).toEqual([
        { triggeredBy: "RATE", thresholdRate: 2.5, action: "ALERT" },
        { triggeredBy: "RATE", thresholdRate: 3, action: "FREEZE_ACCOUNT" },
        { triggeredBy: "RATE", thresholdRate: 3.2, action: "FREEZE_ACCOUNT" },
      ]);
      // One record per crossed limit, the suppressed ALERT included.
      expect(loggedRecords("BudgetThresholdFired")).toEqual([]);
      expect(loggedRateFired()).toEqual([
        rateFired(2.5, "ALERT"),
        rateFired(3, "FREEZE_ACCOUNT"),
        rateFired(3.2, "FREEZE_ACCOUNT"),
      ]);
      for (const record of loggedRecords("SpendRateThresholdFired")) {
        expect(record).toMatchObject({ billedCostAtFire: 60 });
        expect(record).not.toHaveProperty("thresholdDollars");
        expect(record).not.toHaveProperty("triggeredBy");
        if (record.action === "FREEZE_ACCOUNT") {
          expect(record.costAtFreezeDecision).toBe(60);
        } else {
          expect(record).not.toHaveProperty("costAtFreezeDecision");
        }
      }
      // One freeze request; the freeze at or above the alert suppresses it.
      const events = sentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(LeaseFreezingThresholdBreachedAlert);
      expect(
        (events[0] as LeaseFreezingThresholdBreachedAlert).Detail.reason,
      ).toEqual(rateFreezeReason(3.2));
      const [update] = updates();
      expect(update!.lastEvaluatedHourlySpendRate).toBe(3.5);
    });

    it("logs a dollar crossing as BudgetThresholdFired and each crossed rate limit as SpendRateThresholdFired, publishing at most one alert and one freeze", async () => {
      vi.spyOn(Logger.prototype, "info");
      // The projected 70.50 crosses the predicted 70; the measured 3.50 an
      // hour crosses both rate limits above the stored 2.00.
      await scanRateLease({
        ...optedInLease,
        budgetThresholds: [
          { dollarsSpent: 70, action: "ALERT", triggerOn: "PREDICTED" },
        ] as BudgetThreshold[],
        rateLimits: [
          { basis: "HOURLY", rate: 2.5, action: "ALERT" },
          { basis: "HOURLY", rate: 3, action: "FREEZE_ACCOUNT" },
        ],
        lastEvaluatedHourlySpendRate: 2,
      });

      const dollarFired = loggedRecords("BudgetThresholdFired");
      expect(dollarFired).toHaveLength(1);
      expect(dollarFired[0]).toMatchObject({
        thresholdDollars: 70,
        triggeredBy: "PREDICTED",
        action: "ALERT",
        billedCostAtFire: 60,
      });
      expect(dollarFired[0]).not.toHaveProperty("thresholdRate");
      expect(dollarFired[0]).not.toHaveProperty("thresholdRateBasis");
      expect(loggedRateFired()).toEqual([
        rateFired(2.5, "ALERT"),
        rateFired(3, "FREEZE_ACCOUNT"),
      ]);

      // The dollar alert outranks the rate alert; the rate freeze stands.
      const events = sentEvents();
      expect(events).toHaveLength(2);
      const alerts = events.filter(
        (event) =>
          event instanceof LeaseBudgetThresholdBreachedAlert ||
          event instanceof LeaseSpendRateThresholdBreachedAlert,
      );
      expect(alerts).toHaveLength(1);
      expect(alerts[0]).toBeInstanceOf(LeaseBudgetThresholdBreachedAlert);
      expect(
        (alerts[0] as LeaseBudgetThresholdBreachedAlert).Detail,
      ).toMatchObject({
        triggeredBy: "PREDICTED",
        budgetThresholdTriggered: 70,
      });
      const freezes = events.filter(
        (event) => event instanceof LeaseFreezingThresholdBreachedAlert,
      ) as LeaseFreezingThresholdBreachedAlert[];
      expect(freezes).toHaveLength(1);
      expect(freezes[0]!.Detail.reason).toEqual(rateFreezeReason(3));
    });

    it("raises a crossed ALERT spend-rate limit as a LeaseSpendRateThresholdBreachedAlert with rate-native detail", async () => {
      vi.spyOn(Logger.prototype, "info");
      const lease: PersistedMonitoredLease = {
        ...optedInLease,
        budgetThresholds: [],
        rateLimits: [{ basis: "HOURLY", rate: 3, action: "ALERT" }],
        lastEvaluatedHourlySpendRate: 2,
      };
      await scanRateLease(lease);

      const events = sentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(LeaseSpendRateThresholdBreachedAlert);
      const alert = events[0] as LeaseSpendRateThresholdBreachedAlert;
      expect(alert.DetailType).toBe("LeaseSpendRateThresholdAlert");
      expect(alert.Detail).toMatchObject({
        leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
        accountId: lease.awsAccountId,
        rateBasis: "HOURLY",
        thresholdRate: 3,
        measuredRate: 3.5,
        budget: 200,
        totalSpend: 60,
      });
      expect(alert.Detail).not.toHaveProperty("triggeredBy");
      expect(alert.Detail).not.toHaveProperty("budgetThresholdTriggered");
      expect(loggedRateFired()).toEqual([rateFired(3, "ALERT")]);
      expect(loggedRecords("BudgetThresholdFired")).toEqual([]);
    });

    it("freezes on a crossed DAILY rate limit, recording the daily basis and rate and storing the daily rate", async () => {
      vi.spyOn(Logger.prototype, "info");
      const lease: PersistedMonitoredLease = {
        ...optedInLease,
        budgetThresholds: [],
        rateLimits: [{ basis: "DAILY", rate: 40, action: "FREEZE_ACCOUNT" }],
        lastEvaluatedHourlySpendRate: 2,
        lastEvaluatedDailySpendRate: 30,
      };
      // A third reading 24 hours before the newest: $12 at T-27h, so the
      // daily rate is (60 - 12) over 24 hours, $48 a day.
      const newest = storedRow(lease.uuid, anchoredAt, {
        billedCostAccrued: 60,
      });
      const older = storedRow(lease.uuid, earlierAt, {
        billedCostAccrued: 32,
        billedCostDelta: 20,
      });
      const dayEarlier = storedRow(
        lease.uuid,
        anchoredAt.minus({ hours: 24 }),
        {
          billedCostAccrued: 12,
          billedCostDelta: 12,
        },
      );
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({
        complete: true,
        result: [newest, older, dayEarlier],
      });
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(appendedBreaches()).toEqual([
        expect.objectContaining({
          triggeredBy: "RATE",
          action: "FREEZE_ACCOUNT",
          thresholdRate: 40,
          thresholdRateBasis: "DAILY",
          rateAtFire: 48,
        }),
      ]);
      expect(loggedRecords("SpendRateThresholdFired")).toEqual([
        expect.objectContaining({
          rateBasis: "DAILY",
          thresholdRate: 40,
          measuredRate: 48,
          action: "FREEZE_ACCOUNT",
        }),
      ]);
      const events = sentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(LeaseFreezingThresholdBreachedAlert);
      expect(
        (events[0] as LeaseFreezingThresholdBreachedAlert).Detail.reason,
      ).toEqual({
        type: "SpendRateExceeded",
        rateBasis: "DAILY",
        thresholdRate: 40,
        measuredRate: 48,
        budget: 200,
        totalSpend: 60,
      });
      // Stored through the scoped write's nested projection, then read back.
      expect(
        vi.mocked(DynamoLeaseStore.prototype.updateMonitoringOwnedFields).mock
          .calls[0]![0].projection,
      ).toMatchObject({
        lastEvaluatedDailySpendRate: 48,
        lastEvaluatedHourlySpendRate: 3.5,
      });
      const [update] = updates();
      expect(update!.lastEvaluatedDailySpendRate).toBe(48);
      expect(update!.lastEvaluatedHourlySpendRate).toBe(3.5);
    });

    it("records only the maxSpend breach when termination outranks crossed rate limits", async () => {
      await scanRateLease({
        ...optedInLease,
        maxSpend: 55,
        budgetThresholds: [],
        rateLimits: [{ basis: "HOURLY", rate: 3, action: "FREEZE_ACCOUNT" }],
        lastEvaluatedHourlySpendRate: 2,
      });

      const events = sentEvents();
      expect(events).toHaveLength(1);
      expect(events[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
      const appended = appendedBreaches();
      expect(appended).toHaveLength(1);
      expect(appended[0]).toMatchObject({
        triggeredBy: "MAX_SPEND",
        action: "TERMINATE",
        thresholdDollars: 55,
        thresholdRate: null,
        thresholdRateBasis: null,
        billedCostAtFire: 60,
        evaluatedSpendAtFire: null,
      });
    });

    it("differences the accuracy record on the prior run's rate, not the rate the new row produced", async () => {
      vi.spyOn(Logger.prototype, "info");
      const anchor = storeSeries(optedInLease);
      leaseStore().findByStatus.returns({ Active: [optedInLease] });
      // The anchor day fills by $14 over 3 hours where the prior rate said $10.50.
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: {
            [anchor.latestPeriodStart]: anchor.latestPeriodAmount + 14,
          },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const [accuracy] = loggedRecords("ProjectionAccuracy");
      expect(accuracy).toMatchObject({
        predictedCost: 70.5,
        billedCostAccrued: 74,
        errorDollars: -3.5,
        errorPercent: (-3.5 / 74) * 100,
        intervalHours: 3,
        rateSource: "HOURLY",
      });
    });

    it("scores an overdue refresh on the capped projection the thresholds saw", async () => {
      vi.spyOn(Logger.prototype, "info");
      // $10 at 00:00 and $14 at 04:00 give $1/h with a 4-hour cap; the next
      // bill, $22, arrives at 12:00.
      const fourAm = frozenNow.minus({ hours: 8 });
      const midnight = frozenNow.minus({ hours: 12 });
      const anchor = storedRow(optedInLease.uuid, fourAm, {
        billedCostAccrued: 14,
      });
      const older = storedRow(optedInLease.uuid, midnight, {
        billedCostAccrued: 10,
        billedCostDelta: 10,
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: anchor });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({ complete: true, result: [anchor, older] });
      leaseStore().findByStatus.returns({ Active: [optedInLease] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: {
            [anchor.latestPeriodStart]: anchor.latestPeriodAmount + 8,
          },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      const [accuracy] = loggedRecords("ProjectionAccuracy");
      expect(accuracy).toMatchObject({
        predictedCost: 18,
        billedCostAccrued: 22,
        errorDollars: -4,
        intervalHours: 8,
        rateSource: "HOURLY",
      });
    });

    it("skips REPORTED thresholds on a Bedrock-monitored lease even when the total crosses one", async () => {
      vi.spyOn(Logger.prototype, "info");
      storeSeries(optedInLease);
      const monitored = {
        ...optedInLease,
        bedrockTokenMonitoringEnabled: true,
        budgetThresholds: [
          { dollarsSpent: 100, action: "ALERT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [monitored] });
      // The anchor day fills from $5 to $75: the total moves 60 -> 130.
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [monitored.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 75 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).not.toHaveBeenCalled();
      expect(loggedRecords("BudgetThresholdFired")).toEqual([]);
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).not.toHaveBeenCalled();
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ totalCostAccrued: 130 }),
      );
    });

    it("still terminates a Bedrock-monitored lease on maxSpend", async () => {
      storeSeries(optedInLease);
      const monitored = {
        ...optedInLease,
        bedrockTokenMonitoringEnabled: true,
        maxSpend: 125,
      };
      leaseStore().findByStatus.returns({ Active: [monitored] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [monitored.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 75 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toEqual([
        new LeaseBudgetExceededAlert({
          leaseId: { userEmail: monitored.userEmail, uuid: monitored.uuid },
          accountId: monitored.awsAccountId,
          budget: 125,
          // 130.00 billed is over the cap
          totalSpend: 130,
          detectedBy: "LEASE_MONITORING",
        }),
      ]);
      expect(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ totalCostAccrued: 130 }),
      );
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          triggeredBy: "MAX_SPEND",
          billedCostAtFire: 130,
          evaluatedSpendAtFire: null,
        }),
      );
    });

    it("holds the stored scalars and appends no row when the anchor read throws", async () => {
      vi.spyOn(Logger.prototype, "info");
      const lease = {
        ...optedInLease,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockRejectedValue(new Error("table unavailable"));

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(recordCostObservation).not.toHaveBeenCalled();
      expect(loggedRecords("SpendRateComputed")).toEqual([]);
      expect(updates()[0]).toMatchObject({
        totalCostAccrued: FALLBACK_COST,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      });
    });

    it("still appends the row and enforces on the fresh figure when the series read throws", async () => {
      const lease = {
        ...optedInLease,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
        budgetThresholds: [
          { dollarsSpent: 65, action: "ALERT" },
        ] as BudgetThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      const newest = storedRow(lease.uuid, anchoredAt, {
        billedCostAccrued: 60,
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockRejectedValue(new Error("table unavailable"));
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 15.5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ billedCostAccrued: 70.5 }),
      );
      const [alert] = sentEvents() as LeaseBudgetThresholdBreachedAlert[];
      expect(alert!.Detail).toMatchObject({
        triggeredBy: "REPORTED",
        budgetThresholdTriggered: 65,
        totalSpend: 70.5,
      });
      expect(updates()[0]).toMatchObject({
        totalCostAccrued: 70.5,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      });
    });

    it("names the largest mover between the newest two stored rows when no row is appended", async () => {
      const newest = storedRow(optedInLease.uuid, anchoredAt, {
        billedCostAccrued: 60,
        serviceBreakdown: {
          "Amazon Elastic Compute Cloud - Compute": 50,
          "Amazon Bedrock": 10,
        },
        latestPeriodServiceAmounts: {
          "Amazon Elastic Compute Cloud - Compute": 4,
          "Amazon Bedrock": 1,
        },
      });
      const older = storedRow(optedInLease.uuid, earlierAt, {
        billedCostAccrued: 32,
        serviceBreakdown: {
          "Amazon Elastic Compute Cloud - Compute": 30,
          "Amazon Bedrock": 2,
        },
        latestPeriodServiceAmounts: {
          "Amazon Elastic Compute Cloud - Compute": 3,
          "Amazon Bedrock": 1,
        },
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({ complete: true, result: [newest, older] });
      leaseStore().findByStatus.returns({ Active: [optedInLease] });
      const report = new LeaseDailyCostReport(true);
      report.addCost(
        optedInLease.uuid,
        anchoredAt.toFormat("yyyy-MM-dd"),
        4,
        "Amazon Elastic Compute Cloud - Compute",
      );
      report.addCost(
        optedInLease.uuid,
        anchoredAt.toFormat("yyyy-MM-dd"),
        1,
        "Amazon Bedrock",
      );
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(report);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).not.toHaveBeenCalled();
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          insight: expect.objectContaining({
            kind: "CHANGE",
            service: "Amazon Elastic Compute Cloud - Compute",
          }),
        }),
      );
    });

    it("names the largest mover between the appended row and its anchor when a row is appended", async () => {
      const lease = {
        ...optedInLease,
        budgetThresholds: [
          { dollarsSpent: 65, action: "ALERT" },
        ] as BudgetThreshold[],
      };
      const anchor = storedRow(lease.uuid, anchoredAt, {
        billedCostAccrued: 60,
        serviceBreakdown: {
          "Amazon Elastic Compute Cloud - Compute": 50,
          "Amazon Bedrock": 10,
        },
        latestPeriodServiceAmounts: {
          "Amazon Elastic Compute Cloud - Compute": 4,
          "Amazon Bedrock": 1,
        },
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: anchor });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({ complete: true, result: [anchor] });
      leaseStore().findByStatus.returns({ Active: [lease] });
      const report = new LeaseDailyCostReport(true);
      report.addCost(
        lease.uuid,
        anchoredAt.toFormat("yyyy-MM-dd"),
        4,
        "Amazon Elastic Compute Cloud - Compute",
      );
      report.addCost(
        lease.uuid,
        anchoredAt.toFormat("yyyy-MM-dd"),
        11.5,
        "Amazon Bedrock",
      );
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(report);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          billedCostAccrued: 70.5,
          serviceBreakdown: {
            "Amazon Elastic Compute Cloud - Compute": 50,
            "Amazon Bedrock": 20.5,
          },
        }),
      );
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          insight: expect.objectContaining({
            kind: "CHANGE",
            service: "Amazon Bedrock",
          }),
        }),
      );
    });

    it("names the bill's own change in the insight, and alerts with the rate that carried the projection alone", async () => {
      const newest = storedRow(optedInLease.uuid, anchoredAt, {
        billedCostAccrued: 60,
        serviceBreakdown: {
          "Amazon Elastic Compute Cloud - Compute": 50,
          "Amazon Bedrock": 10,
        },
      });
      const older = storedRow(optedInLease.uuid, earlierAt, {
        billedCostAccrued: 32,
        serviceBreakdown: {
          "Amazon Elastic Compute Cloud - Compute": 30,
          "Amazon Bedrock": 2,
        },
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({ complete: true, result: [newest, older] });
      leaseStore().findByStatus.returns({ Active: [optedInLease] });
      // the bill the newest row already holds, so no row is appended
      const report = new LeaseDailyCostReport(true);
      report.addCost(
        optedInLease.uuid,
        anchoredAt.toFormat("yyyy-MM-dd"),
        5,
        "Amazon Elastic Compute Cloud - Compute",
      );
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(report);

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).not.toHaveBeenCalled();
      // the insight is the bill's own: EC2's change since the older row
      const insight = {
        kind: "CHANGE",
        service: "Amazon Elastic Compute Cloud - Compute",
        amount: 50,
        changePercent: ((50 - 30) / 30) * 100,
      };
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          triggeredBy: "PREDICTED",
          rateAtFire: 3.5,
          insight,
        }),
      );
      const [alert] = sentEvents() as LeaseBudgetThresholdBreachedAlert[];
      expect(alert!.Detail).toMatchObject({
        triggeredBy: "PREDICTED",
        rate: 3.5,
        rateSource: "HOURLY",
        insight,
      });
      expect(alert!.Detail.countdownRate).toBeUndefined();
      expect(alert!.Detail.unbilledBedrockTokenCost).toBeUndefined();
    });

    it("suppresses predicted evaluation on a frozen lease while still writing its scalars", async () => {
      storeSeries(optedInLease);
      leaseStore().findByStatus.returns({
        Frozen: [{ ...optedInLease, status: "Frozen" }],
      });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      const [update] = updates();
      expect(update!.lastPredictedSpend).toBeCloseTo(70.5, 2);
    });

    it("writes only its own fields through the scoped write on a Bedrock-monitored lease and evaluates no thresholds", async () => {
      vi.spyOn(Logger.prototype, "info");
      // Monitored from the start, so the stored row already carries a slice.
      storeSeries(optedInLease, {
        billedBedrockTokenCost: 0,
        latestPeriodBedrockTokenAmount: 0,
      });
      const monitored = {
        ...optedInLease,
        bedrockTokenMonitoringEnabled: true,
      };
      leaseStore().findByStatus.returns({ Active: [monitored] });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [optedInLease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).not.toHaveBeenCalled();
      expect(
        DynamoLeaseStore.prototype.updateMonitoringOwnedFields,
      ).not.toHaveBeenCalled();
      const scoped = vi.mocked(
        DynamoLeaseStore.prototype.updateMonitoringCostFields,
      );
      expect(scoped).toHaveBeenCalledTimes(1);
      const written = scoped.mock.calls[0]![0];
      expect(Object.keys(written).sort()).toEqual(
        ["lastCheckedDate", "leaseId", "totalCostAccrued", "userEmail"].sort(),
      );
      expect(written).toMatchObject({
        leaseId: monitored.uuid,
        userEmail: monitored.userEmail,
        totalCostAccrued: 60,
      });
      // The rates and projection are still computed for the row and the metrics.
      expect(loggedRecords("SpendRateComputed")).toEqual([
        expect.objectContaining({
          hourlyRate: 3.5,
          rateUnavailable: false,
          costExplorerRefreshed: false,
        }),
      ]);
    });

    it("enforces on the fresh Cost Explorer figure but appends no row and holds the stored scalars when the anchor row is unreadable", async () => {
      vi.spyOn(Logger.prototype, "info");
      const lease = {
        ...optedInLease,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({
        complete: false,
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VALIDATION",
      });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [frozenNow.toFormat("yyyy-MM-dd")]: 65 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      expect(
        DynamoLeaseCostHistoryStore.prototype.appendCostObservation,
      ).not.toHaveBeenCalled();
      expect(loggedRecords("SpendRateComputed")).toEqual([]);
      const [update] = updates();
      expect(update).toMatchObject({
        totalCostAccrued: 65,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      });
    });

    it("holds the stored scalars when the observation series is withheld", async () => {
      const lease = {
        ...optedInLease,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      };
      leaseStore().findByStatus.returns({ Active: [lease] });
      const newest = storedRow(lease.uuid, anchoredAt, {
        billedCostAccrued: 60,
      });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getNewestCostObservation,
      ).mockResolvedValue({ complete: true, result: newest });
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.getRecentCostObservations,
      ).mockResolvedValue({
        complete: false,
        droppedRecordCount: 1,
        droppedRecordReason: "SCHEMA_VERSION_UNSUPPORTED",
      });
      vi.mocked(
        CostExplorerService.prototype.getDailyCostForLeasesByTag,
      ).mockResolvedValue(
        dailyReport({
          [lease.uuid]: { [anchoredAt.toFormat("yyyy-MM-dd")]: 5 },
        }),
      );

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(mockSendIsbEvents).not.toHaveBeenCalled();
      const [update] = updates();
      expect(update).toMatchObject({
        totalCostAccrued: 60,
        lastPredictedSpend: 72,
        lastEvaluatedHourlySpendRate: 3.5,
        lastEvaluatedDailySpendRate: 80,
      });
    });
  });

  describe("Duration thresholds", () => {
    const breachRowTtl = (lease: PersistedMonitoredLease) =>
      Math.floor(
        DateTime.fromISO(lease.expirationDate!, { zone: "utc" })
          .plus({ days: mockGlobalConfig().leases.ttl })
          .toSeconds(),
      );
    // Measured in time, so every cost and rate field but the bill is null.
    const timeRow = (lease: PersistedMonitoredLease) => ({
      leaseUuid: lease.uuid,
      thresholdDollars: null,
      thresholdRate: null,
      thresholdRateBasis: null,
      billedCostAtFire: FALLBACK_COST,
      predictedCostAtFire: null,
      evaluatedBy: "LEASE_MONITORING",
      evaluatedSpendAtFire: null,
      monitoredBedrockTokenCostAtFire: null,
      rateAtFire: null,
      rateSourceAtFire: null,
      insight: null,
      ttl: breachRowTtl(lease),
    });
    const leasePastEnd = () => ({
      ...monitoredLeasesBase[0]!,
      budgetThresholds: [],
      durationThresholds: [],
      expirationDate: now().minus({ hours: 2 }).toString(),
      lastCheckedDate: now().minus({ hours: 3 }).toString(),
    });

    it("writes one DURATION row per threshold the run reaches, before sending the events", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 6 }).toString(),
        durationThresholds: [
          { hoursRemaining: 15 * 24, action: "ALERT" },
          { hoursRemaining: 12 * 24, action: "FREEZE_ACCOUNT" },
          { hoursRemaining: 2 * 24, action: "ALERT" },
        ] as DurationThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      // the freeze is the one event, but both thresholds reached are recorded
      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(
        LeaseFreezingThresholdBreachedAlert,
      );
      expect(appendedBreaches()).toEqual([
        {
          ...timeRow(lease),
          triggeredBy: "DURATION",
          action: "ALERT",
          thresholdHoursRemaining: 15 * 24,
        },
        {
          ...timeRow(lease),
          triggeredBy: "DURATION",
          action: "FREEZE_ACCOUNT",
          thresholdHoursRemaining: 12 * 24,
        },
      ]);
      for (const row of appendedBreaches()) {
        expect(() =>
          BreachRecordSchema.parse({
            ...row,
            leaseUuid: "750e8400-e29b-41d4-a716-446655440002",
            sk: "BREACH#2026-08-11T11:00:00.000Z",
            meta: { schemaVersion: LeaseCostHistorySchemaVersion },
          }),
        ).not.toThrow();
      }
      expect(
        vi.mocked(DynamoLeaseCostHistoryStore.prototype.appendBreachRecord).mock
          .invocationCallOrder[1],
      ).toBeLessThan(mockSendIsbEvents.mock.invocationCallOrder[0]!);
    });

    it("writes the duration rows beside the budget rows where one run crosses both", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [{ dollarsSpent: 100, action: "ALERT" }],
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 6 }).toString(),
        durationThresholds: [
          { hoursRemaining: 12 * 24, action: "ALERT" },
        ] as DurationThreshold[],
      } as PersistedMonitoredLease;
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(
        appendedBreaches().map((row) => [
          row.triggeredBy,
          row.thresholdDollars,
          row.thresholdHoursRemaining,
        ]),
      ).toEqual([
        ["DURATION", null, 12 * 24],
        ["REPORTED", 100, null],
      ]);
      expect(sentEvents()).toEqual([
        expect.any(LeaseBudgetThresholdBreachedAlert),
        expect.any(LeaseDurationThresholdBreachedAlert),
      ]);
    });

    it("writes no row on a run that reaches no duration threshold", async () => {
      leaseStore().findByStatus.returns({
        Active: [{ ...monitoredLeasesBase[0]!, budgetThresholds: [] }],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toEqual([]);
      expect(appendedBreaches()).toEqual([]);
    });

    it("still sends the duration alert where its row cannot be written", async () => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).mockRejectedValue(new Error("table unavailable"));
      const lease = {
        ...monitoredLeasesBase[0]!,
        budgetThresholds: [],
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        durationThresholds: [
          { hoursRemaining: 12 * 24, action: "ALERT" },
        ] as DurationThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(
        LeaseDurationThresholdBreachedAlert,
      );
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
        expect.objectContaining({ leaseId: lease.uuid }),
      );
    });

    it("writes one EXPIRY row on the run that finds the lease's end passed, before sending the expiry", async () => {
      const lease = leasePastEnd();
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(LeaseExpiredAlert);
      expect(appendedBreaches()).toEqual([
        {
          ...timeRow(lease),
          triggeredBy: "EXPIRY",
          action: "TERMINATE",
          thresholdHoursRemaining: null,
        },
      ]);
      // An earlier expiry counts only from the lease's current end, so one
      // recorded before an extension does not hide this one.
      expect(
        DynamoLeaseCostHistoryStore.prototype.listBreachRecords,
      ).toHaveBeenCalledWith(lease.uuid, {
        from: lease.expirationDate,
        to: expect.any(String),
      });
      expect(
        vi.mocked(DynamoLeaseCostHistoryStore.prototype.appendBreachRecord).mock
          .invocationCallOrder[0],
      ).toBeLessThan(mockSendIsbEvents.mock.invocationCallOrder[0]!);
    });

    it("sends the expiry again on a later run, but writes no second row", async () => {
      leaseStore().findByStatus.returns({ Active: [leasePastEnd()] });
      await performAccountMonitoringScan({} as any, mockContext(testEnv));
      const [written] = updates();

      leaseStore().findByStatus.returns({ Active: [written!] });
      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(2);
      expect(
        sentEvents().every((event) => event instanceof LeaseExpiredAlert),
      ).toBe(true);
      expect(appendedBreaches()).toHaveLength(1);
    });

    it("records only the expiry where the run also reaches a duration threshold, as only the expiry is sent", async () => {
      leaseStore().findByStatus.returns({
        Active: [
          {
            ...leasePastEnd(),
            // last checked before the lease's last hour began
            lastCheckedDate: now().minus({ hours: 4 }).toString(),
            durationThresholds: [{ hoursRemaining: 1, action: "ALERT" }],
          },
        ],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(LeaseExpiredAlert);
      expect(appendedBreaches()).toEqual([
        expect.objectContaining({ triggeredBy: "EXPIRY" }),
      ]);
    });

    it("records the maxSpend breach, not the expiry, where the lease is over both", async () => {
      leaseStore().findByStatus.returns({
        Active: [{ ...leasePastEnd(), maxSpend: 100 }],
      });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(LeaseBudgetExceededAlert);
      expect(appendedBreaches()).toEqual([
        expect.objectContaining({ triggeredBy: "MAX_SPEND" }),
      ]);
    });

    it("still sends the expiry where its row cannot be written", async () => {
      vi.spyOn(Logger.prototype, "error").mockImplementation(() => {});
      vi.mocked(
        DynamoLeaseCostHistoryStore.prototype.appendBreachRecord,
      ).mockRejectedValue(new Error("table unavailable"));
      const lease = leasePastEnd();
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toHaveLength(1);
      expect(sentEvents()[0]).toBeInstanceOf(LeaseExpiredAlert);
      expect(Logger.prototype.error).toHaveBeenCalledWith(
        `breach record write failed for lease ${lease.uuid}; publishing without an audit row`,
        expect.objectContaining({ leaseId: lease.uuid }),
      );
    });

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
      expect(sentEvents()).toEqual([
        new LeaseExpiredAlert({
          leaseId: {
            userEmail: expiredLease.userEmail,
            uuid: expiredLease.uuid,
          },
          accountId: expiredLease.awsAccountId!,
          leaseExpirationDate: expiredLease.expirationDate!,
        }),
      ]);
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
      expect(sentEvents()).toEqual([
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
      ]);
    });

    it("still checks the duration thresholds where the token poll checks the budget thresholds", async () => {
      const lease = {
        ...monitoredLeasesBase[0]!,
        bedrockTokenMonitoringEnabled: true,
        budgetThresholds: [],
        expirationDate: now().plus({ days: 10 }).toString(),
        lastCheckedDate: now().minus({ days: 5 }).toString(),
        durationThresholds: [
          { hoursRemaining: 12 * 24, action: "FREEZE_ACCOUNT" },
        ] as DurationThreshold[],
      };
      leaseStore().findByStatus.returns({ Active: [lease] });

      await performAccountMonitoringScan({} as any, mockContext(testEnv));

      expect(sentEvents()).toEqual([
        new LeaseFreezingThresholdBreachedAlert({
          leaseId: { userEmail: lease.userEmail, uuid: lease.uuid },
          accountId: lease.awsAccountId,
          reason: {
            type: "Expired",
            triggeredDurationThreshold: 12 * 24,
            leaseDurationInHours: lease.leaseDurationInHours!,
          },
        }),
      ]);
      expect(appendedBreaches()).toEqual([
        expect.objectContaining({
          triggeredBy: "DURATION",
          action: "FREEZE_ACCOUNT",
          thresholdHoursRemaining: 12 * 24,
        }),
      ]);
    });
  });
});

// Through the exported middy `handler`, not `performAccountMonitoringScan`: the
// tests above hand the inner function a context that already carries
// `globalConfig`, so they pass whether or not the middleware is wired.
describe("lease monitoring handler middleware", () => {
  it("populates context.globalConfig from the config table", async () => {
    const storedConfig = mockGlobalConfig();
    storedConfig.leases.serviceBreakdownEnabled = true;
    mockAppConfigMiddleware(storedConfig);
    leaseStore().findByStatus.returns({ Active: [] });

    // The baseline fixture leaves this off, so a passing assertion can only come
    // from the middleware overwriting the context.
    const context = mockContext(testEnv);
    expect(context.globalConfig.leases.serviceBreakdownEnabled).toBe(false);

    await handler({} as any, context);

    expect(context.globalConfig.leases.serviceBreakdownEnabled).toBe(true);
  });
});

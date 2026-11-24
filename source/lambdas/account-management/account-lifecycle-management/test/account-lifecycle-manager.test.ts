// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { SQSEvent } from "aws-lambda";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import {
  PersistedExpiredLeaseSchema,
  PersistedMonitoredLeaseSchema,
  PersistedPendingLeaseSchema,
} from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { DynamoSandboxAccountStore } from "@amzn/innovation-sandbox-commons/data/sandbox-account/dynamo-sandbox-account-store.js";
import { DynamoSandboxSpacesUsageStore } from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/dynamo-sandbox-spaces-usage-store.js";
import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { OrganizationsTaggingService } from "@amzn/innovation-sandbox-commons/isb-services/organizations-tagging-service.js";
import { SandboxOuService } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-ou-service.js";
import { AccountLifecycleManagementEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-lifecycle-management-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockContext,
  mockGlobalConfig,
} from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import {
  bulkStubEnv,
  mockAppConfigMiddleware,
} from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import { now } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";

import {
  AccountLifecycleManager,
  handler,
} from "@amzn/innovation-sandbox-account-lifecycle-management/account-lifecycle-manager.js";

const testEnv = generateSchemaData(AccountLifecycleManagementEnvironmentSchema);

// Stub envs at module-load time so the lambda's baseMiddlewareBundle and
// isbConfigMiddleware see them before any request fires.
bulkStubEnv(testEnv);
mockAppConfigMiddleware(mockGlobalConfig());

function sqsEvent(detailType: string, detail: unknown): SQSEvent {
  return {
    Records: [
      {
        body: JSON.stringify({ "detail-type": detailType, detail }),
      } as SQSEvent["Records"][number],
    ],
  };
}

describe("AccountLifecycleManager handler", () => {
  beforeEach(() => {
    bulkStubEnv(testEnv);
    mockAppConfigMiddleware(mockGlobalConfig());
  });

  afterEach(() => {
    vi.restoreAllMocks();
    vi.resetAllMocks();
  });

  describe("event dispatch", () => {
    it("rejects multi-record SQS payloads", async () => {
      const event: SQSEvent = {
        Records: [
          { body: "{}" } as SQSEvent["Records"][number],
          { body: "{}" } as SQSEvent["Records"][number],
        ],
      };
      await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
        /Only one event is supported/,
      );
    });

    it("rejects unsupported detail-type", async () => {
      await expect(
        handler(sqsEvent("NotARealEvent", {}), mockContext(testEnv)),
      ).rejects.toThrow(/Unsupported event detail type: NotARealEvent/);
    });

    it("tracks the freezing threshold type and not the budget alert type", () => {
      // Freezes (dollar or spend-rate) arrive on the freezing type; ALERT
      // limits publish on alert types this handler must never track, which
      // keeps an alert an email and never a freeze.
      expect(AccountLifecycleManager.trackedLeaseEvents).toContain(
        EventDetailTypes.LeaseFreezingThresholdBreachedAlert,
      );
      expect(AccountLifecycleManager.trackedLeaseEvents).not.toContain(
        EventDetailTypes.LeaseBudgetThresholdBreachedAlert,
      );
      expect(AccountLifecycleManager.trackedLeaseEvents).not.toContain(
        EventDetailTypes.LeaseSpendRateThresholdBreachedAlert,
      );
    });

    it("deletes the account record when drift reports that the account left Innovation Sandbox", async () => {
      const deleteSpy = vi
        .spyOn(DynamoSandboxAccountStore.prototype, "delete")
        .mockResolvedValue(undefined);

      await handler(
        sqsEvent(EventDetailTypes.AccountDriftDetected, {
          accountId: "111111111111",
          expectedOu: "Available",
        }),
        mockContext(testEnv),
      );

      expect(deleteSpy).toHaveBeenCalledWith("111111111111");
    });

    it("routes a successful blueprint deployment to publishLease", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        status: "Provisioning",
      });
      const getSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({ result: lease });
      const publishSpy = vi
        .spyOn(InnovationSandbox, "publishLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.BlueprintDeploymentSucceeded, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          blueprintId: "00000000-0000-4000-8000-000000000001",
          accountId: lease.awsAccountId,
          operationId: "operation-1",
          duration: 1,
        }),
        mockContext(testEnv),
      );

      expect(getSpy).toHaveBeenCalledWith({
        uuid: lease.uuid,
        userEmail: lease.userEmail,
      });
      expect(publishSpy).toHaveBeenCalledWith(
        { lease },
        expect.objectContaining({
          organizationsTaggingService: expect.any(OrganizationsTaggingService),
        }),
      );
    });
  });

  describe("LeaseBudgetExceededAlert", () => {
    it("loads the lease and routes to InnovationSandbox.terminateLease with BudgetExceeded status", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        maxSpend: 100,
        status: "Active",
      });
      const getSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({ result: lease });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "stampLeaseTtl",
      ).mockResolvedValue();
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "listLeaseUserUsage",
      ).mockResolvedValue({ usage: [] });

      await handler(
        sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          budget: 100,
          totalSpend: 110,
          detectedBy: "LEASE_MONITORING",
        }),
        mockContext(testEnv),
      );

      expect(getSpy).toHaveBeenCalledWith(
        { uuid: lease.uuid, userEmail: lease.userEmail },
        { consistentRead: true },
      );
      expect(terminateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          lease,
          expiredStatus: "BudgetExceeded",
          budgetExceededBy: "LEASE_MONITORING",
        }),
        expect.objectContaining({
          organizationsTaggingService: expect.any(OrganizationsTaggingService),
        }),
      );
    });

    it.each([
      { name: "raised above the reported spend", maxSpend: 500 },
      { name: "unset", maxSpend: undefined },
    ])("drops the alert when maxSpend is now $name", async ({ maxSpend }) => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        maxSpend,
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          budget: 100,
          totalSpend: 110,
          detectedBy: "LEASE_MONITORING",
        }),
        mockContext(testEnv),
      );

      expect(terminateSpy).not.toHaveBeenCalled();
    });

    it("passes the alert's detectedBy through to terminateLease", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        maxSpend: 100,
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          budget: 100,
          // Exactly at maxSpend, which every sender treats as exceeded.
          totalSpend: 100,
          detectedBy: "TOKEN_POLL",
        }),
        mockContext(testEnv),
      );

      expect(terminateSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          budgetExceededBy: "TOKEN_POLL",
          // The total the detector compared, which totalCostAccrued may not reach.
          budgetTotalSpend: 100,
        }),
        expect.anything(),
      );
    });

    it("throws when the lease cannot be found", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: {
              uuid: "00000000-0000-0000-0000-000000000000",
              userEmail: "u@example.com",
            },
            accountId: "111111111111",
            budget: 100,
            totalSpend: 110,
            detectedBy: "LEASE_MONITORING",
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(
        "Lease not found: 00000000-0000-0000-0000-000000000000",
      );
    });

    it("ignores a duplicate alert for a lease that is already terminated", async () => {
      // The hourly job and the token poll can both report the same breach;
      // the first terminates, and the second must not retry into the DLQ.
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: {
          intent: "TERMINATE",
          dispatchedAt: "2026-10-01T00:00:00.000Z",
        },
        status: "BudgetExceeded",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi.spyOn(InnovationSandbox, "terminateLease");

      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
            accountId: lease.awsAccountId,
            budget: 100,
            totalSpend: 110,
            detectedBy: "LEASE_MONITORING",
          }),
          mockContext(testEnv),
        ),
      ).resolves.not.toThrow();
      expect(terminateSpy).not.toHaveBeenCalled();
    });

    it("throws for a terminated lease with no dispatch marker, since the earlier attempt may not have finished", async () => {
      // terminateLease writes the terminal status before assignment processing
      // and the final events, so a retry must not be treated as done.
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: undefined,
        status: "BudgetExceeded",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi.spyOn(InnovationSandbox, "terminateLease");

      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
            accountId: lease.awsAccountId,
            budget: 100,
            totalSpend: 110,
            detectedBy: "LEASE_MONITORING",
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/may not have finished/);
      expect(terminateSpy).not.toHaveBeenCalled();
    });

    it("throws when the lease is not monitored", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedPendingLeaseSchema, {
          status: "PendingApproval",
        }),
      });
      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseBudgetExceededAlert, {
            leaseId: {
              uuid: "11111111-1111-4111-8111-111111111111",
              userEmail: "u@example.com",
            },
            accountId: "111111111111",
            budget: 100,
            totalSpend: 110,
            detectedBy: "LEASE_MONITORING",
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/incorrectly raised for an inactive lease/);
    });
  });

  describe("LeaseExpiredAlert", () => {
    it("routes to InnovationSandbox.terminateLease with Expired status", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        expirationDate: now().minus({ hours: 1 }).toISO(),
        status: "Active",
      });
      const getSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({ result: lease });
      const terminateSpy = vi
        .spyOn(InnovationSandbox, "terminateLease")
        .mockResolvedValue();
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "stampLeaseTtl",
      ).mockResolvedValue();
      // terminateLease reads the lease's Sandbox Spaces usage for its metric.
      vi.spyOn(
        DynamoSandboxSpacesUsageStore.prototype,
        "listLeaseUserUsage",
      ).mockResolvedValue({ usage: [] });

      await handler(
        sqsEvent(EventDetailTypes.LeaseExpiredAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          leaseExpirationDate: new Date().toISOString(),
        }),
        mockContext(testEnv),
      );

      expect(getSpy).toHaveBeenCalledWith(
        { uuid: lease.uuid, userEmail: lease.userEmail },
        { consistentRead: true },
      );
      expect(terminateSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lease, expiredStatus: "Expired" }),
        expect.anything(),
      );
    });

    it("ignores an expiry alert for a lease that is already terminated", async () => {
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: {
          intent: "TERMINATE",
          dispatchedAt: "2026-10-01T00:00:00.000Z",
        },
        status: "BudgetExceeded",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const terminateSpy = vi.spyOn(InnovationSandbox, "terminateLease");

      await handler(
        sqsEvent(EventDetailTypes.LeaseExpiredAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          leaseExpirationDate: new Date().toISOString(),
        }),
        mockContext(testEnv),
      );

      expect(terminateSpy).not.toHaveBeenCalled();
    });

    it("throws on an expiry alert for a terminated lease with no dispatch marker", async () => {
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: undefined,
        status: "Expired",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });

      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseExpiredAlert, {
            leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
            accountId: lease.awsAccountId,
            leaseExpirationDate: new Date().toISOString(),
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/may not have finished/);
    });

    it.each([
      {
        name: "in the future",
        expirationDate: now().plus({ days: 1 }).toISO(),
      },
      { name: "unset", expirationDate: undefined },
    ])(
      "drops the alert when the expiration is now $name",
      async ({ expirationDate }) => {
        const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          rateLimits: [],
          expirationDate,
          status: "Active",
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: lease,
        });
        const terminateSpy = vi
          .spyOn(InnovationSandbox, "terminateLease")
          .mockResolvedValue();

        await handler(
          sqsEvent(EventDetailTypes.LeaseExpiredAlert, {
            leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
            accountId: lease.awsAccountId,
            leaseExpirationDate: now().minus({ hours: 1 }).toISO(),
          }),
          mockContext(testEnv),
        );

        expect(terminateSpy).not.toHaveBeenCalled();
      },
    );
  });

  describe("LeaseFreezingThresholdBreachedAlert", () => {
    it.each([
      {
        type: "BudgetExceeded",
        triggeredBudgetThreshold: 90,
        triggeredBy: "REPORTED",
        budget: 200,
        totalSpend: 100,
      },
      {
        type: "SpendRateExceeded",
        rateBasis: "HOURLY",
        thresholdRate: 3.2,
        measuredRate: 3.5,
        budget: 200,
        totalSpend: 60,
      },
    ] as const)(
      "freezes through InnovationSandbox.freezeLease with a $type reason passed through unchanged",
      async (reason) => {
        // The current lease still asks for either freeze.
        const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
          predictiveBudgetEnabled: true,
          budgetThresholds: [{ dollarsSpent: 90, action: "FREEZE_ACCOUNT" }],
          rateLimits: [
            { basis: "HOURLY", rate: 3.2, action: "FREEZE_ACCOUNT" },
          ],
          status: "Active",
        });
        vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
          result: lease,
        });
        const freezeSpy = vi
          .spyOn(InnovationSandbox, "freezeLease")
          .mockResolvedValue();

        await handler(
          sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
            leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
            accountId: lease.awsAccountId,
            reason,
          }),
          mockContext(testEnv),
        );

        expect(freezeSpy).toHaveBeenCalledTimes(1);
        expect(freezeSpy).toHaveBeenCalledWith(
          { lease, reason },
          expect.objectContaining({
            organizationsTaggingService: expect.any(
              OrganizationsTaggingService,
            ),
          }),
        );
      },
    );

    it("routes to InnovationSandbox.freezeLease", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        budgetThresholds: [{ dollarsSpent: 90, action: "FREEZE_ACCOUNT" }],
        status: "Active",
      });
      const getSpy = vi
        .spyOn(DynamoLeaseStore.prototype, "get")
        .mockResolvedValue({ result: lease });
      const freezeSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 90,
            totalSpend: 100,
          },
        }),
        mockContext(testEnv),
      );

      expect(getSpy).toHaveBeenCalledWith(
        { uuid: lease.uuid, userEmail: lease.userEmail },
        { consistentRead: true },
      );
      expect(freezeSpy).toHaveBeenCalledWith(
        expect.objectContaining({ lease }),
        expect.anything(),
      );
    });

    const durationReason = {
      type: "Expired",
      triggeredDurationThreshold: 2,
      leaseDurationInHours: 24,
    };
    // An hourly rate limit at 3.00 crossed by a measured 3.50 an hour.
    const rateReason = {
      type: "SpendRateExceeded",
      rateBasis: "HOURLY",
      thresholdRate: 3,
      measuredRate: 3.5,
      budget: 200,
      totalSpend: 60,
    };
    const hourlyRateFreeze = (rate: number) => ({
      basis: "HOURLY",
      rate,
      action: "FREEZE_ACCOUNT",
    });
    // Crossed on the projection while the bill was still below the line.
    const projectedReason = {
      type: "BudgetExceeded",
      triggeredBudgetThreshold: 90,
      totalSpend: 60,
      triggeredBy: "PREDICTED",
      rateSource: "HOURLY",
    };
    it.each([
      {
        name: "drops a budget freeze whose line was raised above the reported spend",
        lease: {
          budgetThresholds: [{ dollarsSpent: 150, action: "FREEZE_ACCOUNT" }],
        },
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 90,
          totalSpend: 100,
        },
        freezes: false,
      },
      {
        name: "freezes for a budget line an admin lowered below the crossing",
        lease: {
          budgetThresholds: [{ dollarsSpent: 80, action: "FREEZE_ACCOUNT" }],
        },
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 90,
          totalSpend: 100,
        },
        freezes: true,
      },
      {
        name: "freezes for a budget line raised to a figure the reported spend still passes",
        lease: {
          budgetThresholds: [{ dollarsSpent: 95, action: "FREEZE_ACCOUNT" }],
        },
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 90,
          totalSpend: 100,
        },
        freezes: true,
      },
      {
        name: "drops a budget freeze whose threshold is now alert-only",
        lease: {
          budgetThresholds: [{ dollarsSpent: 90, action: "ALERT" }],
        },
        reason: {
          type: "BudgetExceeded",
          triggeredBudgetThreshold: 90,
          totalSpend: 100,
        },
        freezes: false,
      },
      {
        name: "freezes for a projected crossing whose threshold still freezes on the projection",
        lease: {
          budgetThresholds: [
            {
              dollarsSpent: 90,
              action: "FREEZE_ACCOUNT",
              triggerOn: "PREDICTED",
            },
          ],
        },
        reason: projectedReason,
        freezes: true,
      },
      {
        name: "drops a projected freeze whose threshold now freezes only on the bill",
        lease: {
          budgetThresholds: [
            {
              dollarsSpent: 90,
              action: "FREEZE_ACCOUNT",
              triggerOn: "REPORTED",
            },
          ],
        },
        reason: projectedReason,
        freezes: false,
      },
      {
        name: "freezes for a rate limit of the same basis the measured rate still exceeds",
        lease: {
          predictiveBudgetEnabled: true,
          rateLimits: [hourlyRateFreeze(3)],
        },
        reason: rateReason,
        freezes: true,
      },
      {
        name: "freezes for a rate limit an admin lowered below the crossing",
        lease: {
          predictiveBudgetEnabled: true,
          rateLimits: [hourlyRateFreeze(2.5)],
        },
        reason: rateReason,
        freezes: true,
      },
      {
        name: "drops a rate freeze whose limit is no longer on the lease",
        lease: { predictiveBudgetEnabled: true, rateLimits: [] },
        reason: rateReason,
        freezes: false,
      },
      {
        name: "drops a rate freeze whose limit is now alert-only",
        lease: {
          predictiveBudgetEnabled: true,
          rateLimits: [{ basis: "HOURLY", rate: 3, action: "ALERT" }],
        },
        reason: rateReason,
        freezes: false,
      },
      {
        name: "drops a rate freeze whose limit was raised above the measured rate",
        lease: {
          predictiveBudgetEnabled: true,
          rateLimits: [hourlyRateFreeze(4)],
        },
        reason: rateReason,
        freezes: false,
      },
      {
        name: "drops a rate freeze whose limit now applies to the other basis",
        lease: {
          predictiveBudgetEnabled: true,
          rateLimits: [{ ...hourlyRateFreeze(3), basis: "DAILY" }],
        },
        reason: rateReason,
        freezes: false,
      },
      {
        name: "drops a rate freeze once predictive controls are disabled",
        lease: {
          predictiveBudgetEnabled: false,
          rateLimits: [hourlyRateFreeze(3)],
        },
        reason: rateReason,
        freezes: false,
      },
      {
        name: "drops a duration freeze whose threshold is now alert-only",
        lease: {
          expirationDate: now().plus({ hours: 1 }).toISO(),
          durationThresholds: [{ hoursRemaining: 2, action: "ALERT" }],
        },
        reason: durationReason,
        freezes: false,
      },
      {
        name: "freezes for a duration threshold the current expiration still reaches",
        lease: {
          expirationDate: now().plus({ hours: 1 }).toISO(),
          durationThresholds: [{ hoursRemaining: 2, action: "FREEZE_ACCOUNT" }],
        },
        reason: durationReason,
        freezes: true,
      },
      {
        name: "freezes for a duration line an admin made stricter",
        lease: {
          expirationDate: now().plus({ hours: 30 }).toISO(),
          durationThresholds: [
            { hoursRemaining: 48, action: "FREEZE_ACCOUNT" },
          ],
        },
        reason: { ...durationReason, triggeredDurationThreshold: 24 },
        freezes: true,
      },
      {
        name: "drops a duration freeze the extended expiration no longer reaches",
        lease: {
          expirationDate: now().plus({ days: 5 }).toISO(),
          durationThresholds: [{ hoursRemaining: 2, action: "FREEZE_ACCOUNT" }],
        },
        reason: durationReason,
        freezes: false,
      },
      {
        name: "drops a duration freeze whose threshold is no longer on the lease",
        lease: {
          expirationDate: now().plus({ hours: 1 }).toISO(),
          durationThresholds: [],
        },
        reason: durationReason,
        freezes: false,
      },
    ])("$name", async ({ lease: fields, reason, freezes }) => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        ...(fields as object),
        status: "Active",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const freezeSpy = vi
        .spyOn(InnovationSandbox, "freezeLease")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          reason,
        }),
        mockContext(testEnv),
      );

      expect(freezeSpy).toHaveBeenCalledTimes(freezes ? 1 : 0);
    });

    async function freezeAlertFor(lease: {
      uuid: string;
      userEmail: string;
      awsAccountId: string;
    }) {
      return handler(
        sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
          leaseId: { uuid: lease.uuid, userEmail: lease.userEmail },
          accountId: lease.awsAccountId,
          reason: {
            type: "BudgetExceeded",
            triggeredBudgetThreshold: 90,
            totalSpend: 100,
          },
        }),
        mockContext(testEnv),
      );
    }

    it("ignores a duplicate freeze alert for a lease that is already frozen", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: {
          intent: "FREEZE",
          dispatchedAt: "2026-10-01T00:00:00.000Z",
        },
        status: "Frozen",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const freezeSpy = vi.spyOn(InnovationSandbox, "freezeLease");

      await freezeAlertFor(lease);

      expect(freezeSpy).not.toHaveBeenCalled();
    });

    it("throws on a freeze alert for a frozen lease with no dispatch marker, since freezeLease may not have finished", async () => {
      const lease = generateSchemaData(PersistedMonitoredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: undefined,
        status: "Frozen",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const freezeSpy = vi.spyOn(InnovationSandbox, "freezeLease");

      await expect(freezeAlertFor(lease)).rejects.toThrow(
        /may not have finished/,
      );
      expect(freezeSpy).not.toHaveBeenCalled();
    });

    it("ignores a freeze alert that a termination overtook", async () => {
      const lease = generateSchemaData(PersistedExpiredLeaseSchema, {
        rateLimits: [],
        lifecycleDispatch: {
          intent: "TERMINATE",
          dispatchedAt: "2026-10-01T00:00:00.000Z",
        },
        status: "BudgetExceeded",
      });
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      const freezeSpy = vi.spyOn(InnovationSandbox, "freezeLease");

      await freezeAlertFor(lease);

      expect(freezeSpy).not.toHaveBeenCalled();
    });

    it("still throws for a lease that is neither active nor already handled", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: generateSchemaData(PersistedPendingLeaseSchema, {
          rateLimits: [],
          status: "PendingApproval",
        }),
      });

      await expect(
        handler(
          sqsEvent(EventDetailTypes.LeaseFreezingThresholdBreachedAlert, {
            leaseId: {
              uuid: "11111111-1111-4111-8111-111111111111",
              userEmail: "u@example.com",
            },
            accountId: "111111111111",
            reason: {
              type: "BudgetExceeded",
              triggeredBudgetThreshold: 90,
              totalSpend: 100,
            },
          }),
          mockContext(testEnv),
        ),
      ).rejects.toThrow(/incorrectly raised for an inactive lease/);
    });
  });

  describe("AccountCleanupFailure", () => {
    it("routes to InnovationSandbox.quarantineAccount with reasonForQuarantine=CLEANUP_FAILED", async () => {
      const quarantineSpy = vi
        .spyOn(InnovationSandbox, "quarantineAccount")
        .mockResolvedValue();

      await handler(
        sqsEvent(EventDetailTypes.AccountCleanupFailure, {
          accountId: "111111111111",
          cleanupExecutionContext: {
            executionArn: "arn:execution",
            executionStartTime: new Date().toISOString(),
          },
          reason: "LEASE_TERMINATION",
        }),
        mockContext(testEnv),
      );

      expect(quarantineSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          accountId: "111111111111",
          currentOu: "CleanUp",
          reasonForQuarantine: "CLEANUP_FAILED",
        }),
        expect.anything(),
      );
    });
  });

  describe("AccountCleanupSuccessful", () => {
    function buildEvent(accountId = "111111111111") {
      return sqsEvent(EventDetailTypes.AccountCleanupSuccessful, {
        accountId,
        cleanupExecutionContext: {
          executionArn: "arn:execution",
          executionStartTime: new Date().toISOString(),
        },
        reason: "LEASE_TERMINATION",
      });
    }

    it("moves the account from CleanUp to Available and writes the Status tag as Available", async () => {
      const account = {
        awsAccountId: "111111111111",
        status: "CleanUp" as const,
      };
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: account,
      });
      const moveSpy = vi
        .spyOn(SandboxOuService.prototype, "transactionalMoveAccount")
        .mockReturnValue({
          complete: vi.fn().mockResolvedValue(undefined),
        } as never);
      const updateStatusTagSpy = vi
        .spyOn(OrganizationsTaggingService.prototype, "updateStatusTag")
        .mockResolvedValue();

      await handler(buildEvent(), mockContext(testEnv));

      expect(moveSpy).toHaveBeenCalledWith(account, "CleanUp", "Available");
      expect(updateStatusTagSpy).toHaveBeenCalledWith(
        account.awsAccountId,
        "Available",
      );
    });

    it("does not block the lifecycle when updateStatusTag rejects", async () => {
      const account = {
        awsAccountId: "111111111111",
        status: "CleanUp" as const,
      };
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: account,
      });
      vi.spyOn(
        SandboxOuService.prototype,
        "transactionalMoveAccount",
      ).mockReturnValue({
        complete: vi.fn().mockResolvedValue(undefined),
      } as never);
      vi.spyOn(
        OrganizationsTaggingService.prototype,
        "updateStatusTag",
      ).mockRejectedValue(new Error("AccessDenied"));

      // Should resolve without throwing — `.catch` swallows the failure.
      await expect(
        handler(buildEvent(), mockContext(testEnv)),
      ).resolves.toBeUndefined();
    });

    it("throws if the account is not in CleanUp status", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: { awsAccountId: "111111111111", status: "Available" },
      });
      await expect(handler(buildEvent(), mockContext(testEnv))).rejects.toThrow(
        /incorrectly raised for an account whose status is not CleanUp/,
      );
    });

    it("throws if the account record is not found", async () => {
      vi.spyOn(DynamoSandboxAccountStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });
      await expect(handler(buildEvent(), mockContext(testEnv))).rejects.toThrow(
        /Sandbox account not found/,
      );
    });
  });
});

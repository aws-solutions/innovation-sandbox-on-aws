// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

import { GlobalConfigSchema } from "@amzn/innovation-sandbox-commons/data/global-config/global-config.js";
import { PendingLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { LeaseDeniedEvent } from "@amzn/innovation-sandbox-commons/events/lease-denied-event.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedIsbEventBridge,
  mockedLeaseStore,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { DateTime } from "luxon";

function createMockContext() {
  return {
    leaseStore: mockedLeaseStore(),
    isbEventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
    globalConfig: generateSchemaData(GlobalConfigSchema, {
      leases: generateSchemaData(GlobalConfigSchema.shape.leases, {
        ttl: 30,
      }),
    }),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.denyLease()", () => {
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mockContext = createMockContext();

    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("Writes denied lease to DB", async () => {
    const leaseToDeny = generateSchemaData(PendingLeaseSchema, {
      status: "PendingApproval",
    });
    const denier = {
      email: "UnhappyManager@managers.com",
    };

    await InnovationSandbox.denyLease(
      {
        lease: leaseToDeny,
        denier: denier,
      },
      mockContext,
    );

    expect(mockContext.leaseStore.update).toHaveBeenCalledWith({
      ...leaseToDeny,
      ttl: Math.floor(currentDateTime.plus({ days: 30 }).valueOf() / 1000),
      status: "ApprovalDenied",
      approvedBy: denier.email,
    });
  });

  test("Send LeaseDenied event to EventBus", async () => {
    const leaseToDeny = generateSchemaData(PendingLeaseSchema, {
      status: "PendingApproval",
    });
    const denier = {
      email: "UnhappyManager@managers.com",
    };

    await InnovationSandbox.denyLease(
      {
        lease: leaseToDeny,
        denier: denier,
      },
      mockContext,
    );

    expect(mockContext.isbEventBridgeClient.sendIsbEvent).toHaveBeenCalledWith(
      expect.any(Tracer),
      new LeaseDeniedEvent({
        leaseId: leaseToDeny.uuid,
        userEmail: leaseToDeny.userEmail,
        deniedBy: denier.email,
      }),
    );
  });

  test("throws error on failure", async () => {
    mockContext.leaseStore.update.mockRejectedValueOnce(
      new Error("unexplained put error"),
    );

    await expect(
      async () =>
        await InnovationSandbox.denyLease(
          {
            lease: generateSchemaData(PendingLeaseSchema, {
              status: "PendingApproval",
            }),
            denier: {
              email: "UnhappyManager@managers.com",
            },
          },
          mockContext,
        ),
    ).rejects.toThrow("unexplained put error");
  });

  test("logs errors to logger", async () => {
    mockContext.leaseStore.update.mockRejectedValueOnce(
      new Error("unexplained put error"),
    );

    try {
      await InnovationSandbox.denyLease(
        {
          lease: generateSchemaData(PendingLeaseSchema, {
            status: "PendingApproval",
          }),
          denier: {
            email: "UnhappyManager@managers.com",
          },
        },
        mockContext,
      );
    } catch (e) {
      //do nothing
    }
    expect(mockContext.logger.info).not.toHaveBeenCalled();
    expect(mockContext.logger.error).toHaveBeenCalledWith(
      "An error occurred performing action (denyLease): Error: unexplained put error",
    );
  });
});

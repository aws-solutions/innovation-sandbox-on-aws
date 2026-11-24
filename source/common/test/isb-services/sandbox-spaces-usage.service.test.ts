// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  LeaseUserSandboxSpacesUsage,
  MalformedSandboxSpacesUsageRecordError,
  SandboxSpacesUsageStore,
} from "@amzn/innovation-sandbox-commons/data/sandbox-spaces-usage/sandbox-spaces-usage-store.js";
import {
  getCallerSandboxSpacesEstimatedTokenCost,
  getLeaseSandboxSpacesEstimatedTokenCost,
  getLeaseSandboxSpacesUsageBreakdown,
  ModelTokenRates,
  priceTurn,
  recordSandboxSpacesTurnUsage,
  sumTokenTypes,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-spaces-usage/index.js";
import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging.js";
import type { IsbUser } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

const NOW = "2026-09-10T12:00:00.000Z";
const LEASE_ID = "11111111-1111-4111-8111-111111111111";
const MODEL_ID = "global.anthropic.claude-sonnet-4-6";

const RATES: ModelTokenRates = {
  inputPricePer1KTokens: 0.003,
  outputPricePer1KTokens: 0.015,
  cacheReadPricePer1KTokens: 0.0003,
  cacheWritePricePer1KTokens: 0.00375,
};

function userUsage(
  userId: string,
  sandboxSpacesEstimatedTokenCostAccrued: number,
): LeaseUserSandboxSpacesUsage {
  return {
    leaseId: LEASE_ID,
    userId,
    sandboxSpacesEstimatedTokenCostAccrued,
    invocationCount: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    firstSeenAt: NOW,
    lastSeenAt: NOW,
  };
}

const TOKENS = {
  inputTokens: 1_000,
  outputTokens: 2_000,
  cacheReadTokens: 10_000,
  cacheWriteTokens: 400,
};

const mockGetLeaseUserUsage = vi.fn();
const mockListLeaseUserUsage = vi.fn();
const mockRecordTurnUsage = vi.fn();
const services = {
  sandboxSpacesUsageStore: {
    getLeaseUserUsage: mockGetLeaseUserUsage,
    listLeaseUserUsage: mockListLeaseUserUsage,
    recordTurnUsage: mockRecordTurnUsage,
  } as unknown as SandboxSpacesUsageStore,
  logger: new Logger({ serviceName: "sandbox-spaces-usage-test" }),
};

beforeEach(() => {
  vi.resetAllMocks();
});

describe("priceTurn", () => {
  it("prices all four token types at their own per-1K rates", () => {
    // 1*0.003 + 2*0.015 + 10*0.0003 + 0.4*0.00375
    expect(priceTurn(TOKENS, RATES)).toBe(0.0375);
  });

  it("charges unpublished cache rates at the input rate", () => {
    const rates: ModelTokenRates = {
      inputPricePer1KTokens: 0.003,
      outputPricePer1KTokens: 0.015,
    };
    // 1*0.003 + 2*0.015 + 10*0.003 + 0.4*0.003
    expect(priceTurn(TOKENS, rates)).toBe(0.0642);
  });

  it("sums the four token types", () => {
    expect(sumTokenTypes(TOKENS)).toBe(13_400);
  });
});

describe("getCallerSandboxSpacesEstimatedTokenCost", () => {
  const USER_ID = "22222222-2222-4222-8222-222222222222";
  const props = { leaseId: LEASE_ID, userId: USER_ID };

  it("returns the caller's recorded cost on the lease", async () => {
    mockGetLeaseUserUsage.mockResolvedValue(userUsage(USER_ID, 1.25));

    await expect(
      getCallerSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBe(1.25);
    expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(LEASE_ID, USER_ID);
  });

  it("returns zero for a caller with no recorded turns", async () => {
    mockGetLeaseUserUsage.mockResolvedValue(null);

    await expect(
      getCallerSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBe(0);
  });

  it("returns undefined, without throwing, when the record is unreadable", async () => {
    mockGetLeaseUserUsage.mockRejectedValue(
      new MalformedSandboxSpacesUsageRecordError("bad"),
    );

    await expect(
      getCallerSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBeUndefined();
  });

  it("rethrows infrastructure errors", async () => {
    mockGetLeaseUserUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(
      getCallerSandboxSpacesEstimatedTokenCost(props, services),
    ).rejects.toThrow("DynamoDB unavailable");
  });
});

describe("getLeaseSandboxSpacesEstimatedTokenCost", () => {
  const props = { leaseId: LEASE_ID };

  it("sums the estimated cost across every user on the lease", async () => {
    mockListLeaseUserUsage.mockResolvedValue({
      usage: [userUsage("user-a", 1.25), userUsage("user-b", 2.5)],
    });

    await expect(
      getLeaseSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBe(3.75);
    expect(mockListLeaseUserUsage).toHaveBeenCalledWith(LEASE_ID);
  });

  it("returns zero for a lease with no recorded turns", async () => {
    mockListLeaseUserUsage.mockResolvedValue({ usage: [] });

    await expect(
      getLeaseSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBe(0);
  });

  it("returns undefined rather than a partial sum when a record is unreadable", async () => {
    mockListLeaseUserUsage.mockResolvedValue({
      usage: [userUsage("user-a", 1.25)],
      error: "1 malformed record",
    });

    await expect(
      getLeaseSandboxSpacesEstimatedTokenCost(props, services),
    ).resolves.toBeUndefined();
  });

  it("rethrows infrastructure errors", async () => {
    mockListLeaseUserUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(
      getLeaseSandboxSpacesEstimatedTokenCost(props, services),
    ).rejects.toThrow("DynamoDB unavailable");
  });
});

describe("getLeaseSandboxSpacesUsageBreakdown", () => {
  const ALICE_ID = "11111111-1111-4111-8111-111111111111";
  const BOB_ID = "44444444-4444-4444-8444-444444444444";
  const user = (roles: IsbUser["roles"], userId = ALICE_ID) =>
    ({ type: "user", email: "alice@example.com", userId, roles }) as IsbUser;

  beforeEach(() => {
    mockListLeaseUserUsage.mockResolvedValue({
      usage: [userUsage(BOB_ID, 1.25), userUsage(ALICE_ID, 2.25)],
    });
    mockGetLeaseUserUsage.mockResolvedValue(null);
  });

  describe("Admin and Manager", () => {
    it.each([["Admin"], ["Manager"]] as const)(
      "%s sees every user, highest spend first",
      async (role) => {
        await expect(
          getLeaseSandboxSpacesUsageBreakdown(
            { leaseId: LEASE_ID, user: user([role]) },
            services,
          ),
        ).resolves.toEqual({
          spendByUsers: [
            { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 2.25 },
            { userId: BOB_ID, sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
          ],
        });
        expect(mockListLeaseUserUsage).toHaveBeenCalledWith(LEASE_ID);
        expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
      },
    );

    it("breaks spend ties by user id", async () => {
      mockListLeaseUserUsage.mockResolvedValue({
        usage: [userUsage(BOB_ID, 1), userUsage(ALICE_ID, 1)],
      });

      const { spendByUsers } = await getLeaseSandboxSpacesUsageBreakdown(
        { leaseId: LEASE_ID, user: user(["Admin"]) },
        services,
      );

      expect(spendByUsers.map((row) => row.userId)).toEqual([ALICE_ID, BOB_ID]);
    });

    it("returns an empty list for a lease with no recorded turns", async () => {
      mockListLeaseUserUsage.mockResolvedValue({ usage: [] });

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["Admin"]) },
          services,
        ),
      ).resolves.toEqual({ spendByUsers: [] });
    });

    it("leaves out a row that could not be read, and logs it", async () => {
      const warn = vi.spyOn(services.logger, "warn");
      mockListLeaseUserUsage.mockResolvedValue({
        usage: [userUsage(ALICE_ID, 2.25)],
        error: "1 item failed validation",
      });

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["Admin"]) },
          services,
        ),
      ).resolves.toEqual({
        spendByUsers: [
          { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 2.25 },
        ],
      });
      expect(warn).toHaveBeenCalledWith(
        "Some per-user Sandbox Spaces usage records were skipped",
        { leaseId: LEASE_ID, error: "1 item failed validation" },
      );
    });
  });

  describe("User role", () => {
    it("returns only the caller's own row", async () => {
      mockGetLeaseUserUsage.mockResolvedValue(userUsage(ALICE_ID, 2.25));

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["User"]) },
          services,
        ),
      ).resolves.toEqual({
        spendByUsers: [
          { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 2.25 },
        ],
      });
      expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(LEASE_ID, ALICE_ID);
      expect(mockListLeaseUserUsage).not.toHaveBeenCalled();
    });

    it("returns a zero entry for a caller who has not spent yet", async () => {
      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["User"]) },
          services,
        ),
      ).resolves.toEqual({
        spendByUsers: [
          { userId: ALICE_ID, sandboxSpacesEstimatedTokenCostAccrued: 0 },
        ],
      });
    });

    it("leaves out the caller's row, and logs it, when it cannot be read", async () => {
      const warn = vi.spyOn(services.logger, "warn");
      mockGetLeaseUserUsage.mockRejectedValue(
        new MalformedSandboxSpacesUsageRecordError("bad"),
      );

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["User"]) },
          services,
        ),
      ).resolves.toEqual({ spendByUsers: [] });
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining(LogPatterns.DataValidationWarning.pattern),
        expect.objectContaining({ leaseId: LEASE_ID }),
      );
    });

    it("rethrows infrastructure errors reading the caller's row", async () => {
      mockGetLeaseUserUsage.mockRejectedValue(
        new Error("DynamoDB unavailable"),
      );

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: user(["User"]) },
          services,
        ),
      ).rejects.toThrow("DynamoDB unavailable");
    });

    it("never reads or returns another user's row", async () => {
      mockGetLeaseUserUsage.mockResolvedValue(userUsage(BOB_ID, 1.25));

      const { spendByUsers } = await getLeaseSandboxSpacesUsageBreakdown(
        { leaseId: LEASE_ID, user: user(["User"], BOB_ID) },
        services,
      );

      expect(spendByUsers).toEqual([
        { userId: BOB_ID, sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
      ]);
      expect(mockGetLeaseUserUsage).toHaveBeenCalledWith(LEASE_ID, BOB_ID);
    });

    it("returns no user entries for a machine identity without elevated roles", async () => {
      const m2m = {
        type: "m2m",
        clientId: "client-1",
        roles: ["User"],
      } as IsbUser;

      await expect(
        getLeaseSandboxSpacesUsageBreakdown(
          { leaseId: LEASE_ID, user: m2m },
          services,
        ),
      ).resolves.toEqual({ spendByUsers: [] });
      expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
      expect(mockListLeaseUserUsage).not.toHaveBeenCalled();
    });
  });
});

describe("recordSandboxSpacesTurnUsage", () => {
  function recordProps() {
    return {
      leaseId: LEASE_ID,
      userId: "alice-at-example-d-com",
      userEmail: "alice@example.com",
      messageId: "msg-1",
      month: "MONTH#2026-09",
      modelId: MODEL_ID,
      tokens: TOKENS,
      sandboxSpacesEstimatedTokenCostAccrued: 0.0375,
      sessionId: "session-1",
    };
  }

  beforeEach(() => {
    mockRecordTurnUsage.mockResolvedValue(undefined);
  });

  it("banks the provided turn spend without reading it back", async () => {
    await expect(
      recordSandboxSpacesTurnUsage(recordProps(), services),
    ).resolves.toBeUndefined();

    expect(mockRecordTurnUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: LEASE_ID,
        tokens: TOKENS,
        sandboxSpacesEstimatedTokenCostAccrued: 0.0375,
      }),
    );
    expect(mockRecordTurnUsage.mock.calls[0]![0]).not.toHaveProperty("modelId");
    expect(mockGetLeaseUserUsage).not.toHaveBeenCalled();
    expect(mockListLeaseUserUsage).not.toHaveBeenCalled();
  });

  it("still throws when the usage write itself fails", async () => {
    mockRecordTurnUsage.mockRejectedValue(new Error("DynamoDB unavailable"));

    await expect(
      recordSandboxSpacesTurnUsage(recordProps(), services),
    ).rejects.toThrow("DynamoDB unavailable");
  });
});

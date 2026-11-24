// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { PersistedAgentModelCatalogRow } from "@amzn/innovation-sandbox-commons/data/config/agent-model-catalog.js";
import {
  ConnectionContext,
  FeatureDisabledError,
  LeaseNotActiveError,
  ModelNotAllowedError,
  resolveCallerLease,
  sendError,
  sendKeepAlive,
  sendToConnection,
  validateAndRoute,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  AgentConfig,
  AgentConfigSchema,
} from "@amzn/innovation-sandbox-shared/types/configuration.js";
import { type LeaseKey } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Mocks ────────────────────────────────────────────────────────────────────

const mockLeaseGet = vi.fn();
const mockLeaseStore = { get: mockLeaseGet } as any;
const mockLogger = {
  debug: vi.fn(),
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as any;

const defaultAgentConfig: AgentConfig = AgentConfigSchema.parse({});
const enabledConfig: AgentConfig = AgentConfigSchema.parse({
  sandboxSpacesEnabled: true,
});

const services = {
  leaseStore: mockLeaseStore,
  logger: mockLogger,
};

const USER_IDS = {
  alice: "11111111-1111-4111-8111-111111111111",
  admin: "22222222-2222-4222-8222-222222222222",
  manager: "33333333-3333-4333-8333-333333333333",
  owner: "44444444-4444-4444-8444-444444444444",
} as const;

/** Minimal catalog row for the model gate; only `modelId` and `enabled` are read. */
function modelRow(modelId: string, enabled = true) {
  return { modelId, enabled } as PersistedAgentModelCatalogRow;
}

// The per-turn model the client selected, with an enabled catalog row so
// happy-path cases pass the model gate; their leases carry no subset.
const requestedModelId = "anthropic.claude-3-5-sonnet-20241022-v2:0";
const requestedModel = modelRow(requestedModelId);

function makeAdminConnection(): ConnectionContext {
  return {
    connectionId: "conn-admin",
    actorId: "admin-at-example-d-com",
    role: "Admin",
    email: "admin@example.com",
    userId: USER_IDS.admin,
    protocolVersion: 1,
  };
}

function makeUserConnection(): ConnectionContext {
  return {
    connectionId: "conn-user",
    actorId: "alice-at-example-d-com",
    role: "User",
    email: "alice@example.com",
    userId: USER_IDS.alice,
    protocolVersion: 1,
  };
}

function makeManagerConnection(): ConnectionContext {
  return {
    connectionId: "conn-manager",
    actorId: "manager-at-example-d-com",
    role: "Manager",
    email: "manager@example.com",
    userId: USER_IDS.manager,
    protocolVersion: 1,
  };
}

function leaseKeyOf(uuid: string, userEmail = "alice@example.com"): LeaseKey {
  return { userEmail, uuid };
}

/** `desiredUserIds` are the USER principals in the lease's desiredAssignments. */
function makeActiveLease(
  leaseId: string,
  email: string,
  allowedModelIds?: string[],
  desiredUserIds: string[] = [USER_IDS.alice],
) {
  return {
    result: {
      uuid: leaseId,
      userEmail: email,
      status: "Active",
      awsAccountId: "111111111111",
      sandboxSpacesEnabled: true,
      desiredAssignments: desiredUserIds.map((principalId) => ({
        principalId,
        principalType: "USER",
      })),
      ...(allowedModelIds === undefined ? {} : { allowedModelIds }),
    },
    meta: {},
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockLeaseGet.mockResolvedValue({ result: undefined });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("validateAndRoute — lease-bound routing for every role", () => {
  // Admin, Manager, and User all launch a lease-bound Sandbox Space; none of
  // them bypasses the desiredAssignments check.
  const roleCases: [string, () => ConnectionContext][] = [
    ["User", makeUserConnection],
    ["Manager", makeManagerConnection],
    ["Admin", makeAdminConnection],
  ];

  it.each(roleCases)(
    "%s owner of an active, account-backed, enabled lease routes to a lease-bound execution context",
    async (_role, makeConnection) => {
      const connection = makeConnection();
      const leaseKey = leaseKeyOf("lease-abc", connection.email);
      mockLeaseGet.mockResolvedValue(
        makeActiveLease("lease-abc", connection.email, undefined, [
          connection.userId,
        ]),
      );

      const result = await validateAndRoute(
        {
          connection,
          leaseKey,
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel,
        },
        services,
      );

      expect(result.accountId).toBe("111111111111");
      expect(result.runtimeSessionId).toBe(`lease-abc_${connection.userId}`);
      // The lease is read once, by the key the client supplied.
      expect(mockLeaseGet).toHaveBeenCalledTimes(1);
      expect(mockLeaseGet).toHaveBeenCalledWith(leaseKey, {
        consistentRead: true,
      });
    },
  );

  it.each(roleCases)(
    "%s who is not in the lease's desiredAssignments is rejected",
    async (_role, makeConnection) => {
      const connection = makeConnection();
      // The lease exists but only lists another user — no role bypasses this.
      mockLeaseGet.mockResolvedValue(
        makeActiveLease("lease-other", "owner@example.com", undefined, [
          USER_IDS.owner,
        ]),
      );

      await expect(
        validateAndRoute(
          {
            connection,
            leaseKey: leaseKeyOf("lease-other", "owner@example.com"),
            agentConfig: enabledConfig,
            requestedModelId,
            requestedModel,
          },
          services,
        ),
      ).rejects.toBeInstanceOf(LeaseNotActiveError);
    },
  );
});

describe("resolveCallerLease", () => {
  const leaseKey = leaseKeyOf("lease-shared", "owner@example.com");

  function leaseWith(
    desired: { principalId: string; principalType: string }[],
  ) {
    const lease = makeActiveLease("lease-shared", "owner@example.com");
    return {
      ...lease,
      result: { ...lease.result, desiredAssignments: desired },
    };
  }

  it("returns the lease for the owner, who is a desired USER", async () => {
    mockLeaseGet.mockResolvedValue(
      makeActiveLease("lease-shared", "owner@example.com", undefined, [
        USER_IDS.owner,
      ]),
    );

    const lease = await resolveCallerLease(
      { leaseKey, userId: USER_IDS.owner },
      services,
    );

    expect(lease?.userEmail).toBe("owner@example.com");
    expect(mockLeaseGet).toHaveBeenCalledWith(leaseKey, {
      consistentRead: true,
    });
  });

  it("returns the lease for a direct assignee keyed by the owner's email", async () => {
    mockLeaseGet.mockResolvedValue(
      makeActiveLease("lease-shared", "owner@example.com", undefined, [
        USER_IDS.owner,
        USER_IDS.alice,
      ]),
    );

    const lease = await resolveCallerLease(
      { leaseKey, userId: USER_IDS.alice },
      services,
    );

    expect(lease?.uuid).toBe("lease-shared");
  });

  it("returns undefined when the caller was removed from desiredAssignments", async () => {
    mockLeaseGet.mockResolvedValue(
      makeActiveLease("lease-shared", "owner@example.com", undefined, [
        USER_IDS.owner,
      ]),
    );

    await expect(
      resolveCallerLease({ leaseKey, userId: USER_IDS.alice }, services),
    ).resolves.toBeUndefined();
  });

  it("does not match a GROUP entry against the caller's user id", async () => {
    mockLeaseGet.mockResolvedValue(
      leaseWith([{ principalId: USER_IDS.alice, principalType: "GROUP" }]),
    );

    await expect(
      resolveCallerLease({ leaseKey, userId: USER_IDS.alice }, services),
    ).resolves.toBeUndefined();
  });

  it("returns undefined for a caller who is only reachable through a GROUP entry", async () => {
    mockLeaseGet.mockResolvedValue(
      leaseWith([
        { principalId: USER_IDS.owner, principalType: "USER" },
        {
          principalId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
          principalType: "GROUP",
        },
      ]),
    );

    await expect(
      resolveCallerLease({ leaseKey, userId: USER_IDS.alice }, services),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the lease has no desiredAssignments", async () => {
    const lease = makeActiveLease("lease-shared", "owner@example.com");
    mockLeaseGet.mockResolvedValue({
      ...lease,
      result: { ...lease.result, desiredAssignments: undefined },
    });

    await expect(
      resolveCallerLease({ leaseKey, userId: USER_IDS.owner }, services),
    ).resolves.toBeUndefined();
  });

  it("returns undefined when the lease does not exist", async () => {
    mockLeaseGet.mockResolvedValue({ result: undefined });

    await expect(
      resolveCallerLease({ leaseKey, userId: USER_IDS.owner }, services),
    ).resolves.toBeUndefined();
  });

  it("logs a warning when the store reports a read error", async () => {
    mockLeaseGet.mockResolvedValue({
      result: undefined,
      error: "invalid item",
    });

    await resolveCallerLease({ leaseKey, userId: USER_IDS.owner }, services);

    expect(mockLogger.warn).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ error: "invalid item" }),
    );
  });

  it("routes a direct assignee with a per-caller runtime session", async () => {
    mockLeaseGet.mockResolvedValue(
      makeActiveLease("lease-shared", "owner@example.com", undefined, [
        USER_IDS.owner,
        USER_IDS.alice,
      ]),
    );
    const connection = makeUserConnection();

    const result = await validateAndRoute(
      {
        connection,
        leaseKey,
        agentConfig: enabledConfig,
        requestedModelId,
        requestedModel,
      },
      services,
    );

    // Routing stays on the owner's lease account; the runtime session is per caller.
    expect(result.accountId).toBe("111111111111");
    expect(result.runtimeSessionId).toBe(`lease-shared_${connection.userId}`);
  });
});

describe("validateAndRoute — feature toggle", () => {
  const roleCases: [string, () => ConnectionContext][] = [
    ["User", makeUserConnection],
    ["Manager", makeManagerConnection],
    ["Admin", makeAdminConnection],
  ];

  it.each(roleCases)(
    "throws FeatureDisabledError for %s when sandboxSpacesEnabled is false",
    async (_role, makeConnection) => {
      await expect(
        validateAndRoute(
          {
            connection: makeConnection(),
            leaseKey: leaseKeyOf("l"),
            agentConfig: defaultAgentConfig,
            requestedModelId,
            requestedModel,
          },
          services,
        ),
      ).rejects.toBeInstanceOf(FeatureDisabledError);
    },
  );
});

describe("validateAndRoute — requested model catalog row", () => {
  it("throws ModelNotAllowedError when the requested model's row is disabled", async () => {
    mockLeaseGet.mockResolvedValue(makeActiveLease("l", "alice@example.com"));

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel: modelRow(requestedModelId, false),
        },
        services,
      ),
    ).rejects.toBeInstanceOf(ModelNotAllowedError);
  });
});

describe("validateAndRoute — lease validation", () => {
  it("throws LeaseNotActiveError when lease is not found", async () => {
    mockLeaseGet.mockResolvedValue({ result: undefined });

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("missing"),
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel,
        },
        services,
      ),
    ).rejects.toBeInstanceOf(LeaseNotActiveError);
  });

  it("throws LeaseNotActiveError when lease is TERMINATED", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        uuid: "l",
        userEmail: "alice@example.com",
        status: "Expired",
        awsAccountId: "111",
        desiredAssignments: [
          { principalId: USER_IDS.alice, principalType: "USER" },
        ],
      },
    });

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel,
        },
        services,
      ),
    ).rejects.toBeInstanceOf(LeaseNotActiveError);
  });

  it("returns the current lease spend for lease budget tracking", async () => {
    const lease = makeActiveLease("l", "alice@example.com");
    mockLeaseGet.mockResolvedValue({
      ...lease,
      result: {
        ...lease.result,
        maxSpend: 50,
        totalCostAccrued: 12.5,
        lastEvaluatedSpend: 13.5,
        bedrockTokenMonitoringEnabled: true,
      },
    });
    const connection = makeUserConnection();

    const result = await validateAndRoute(
      {
        connection,
        leaseKey: leaseKeyOf("l"),
        agentConfig: enabledConfig,
        requestedModelId,
        requestedModel,
      },
      services,
    );

    expect(result).toEqual({
      accountId: "111111111111",
      leaseCurrentSpend: 13.5,
      runtimeSessionId: `l_${connection.userId}`,
    });
  });

  it("throws FeatureDisabledError when the lease snapshot is disabled", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        ...makeActiveLease("l", "alice@example.com").result,
        sandboxSpacesEnabled: false,
      },
    });

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel,
        },
        services,
      ),
    ).rejects.toBeInstanceOf(FeatureDisabledError);
  });
});

// ─── validateAndRoute — missing awsAccountId branch ──────────────────────────

describe("validateAndRoute — lease without awsAccountId", () => {
  it("throws LeaseNotActiveError when lease has no awsAccountId", async () => {
    mockLeaseGet.mockResolvedValue({
      result: {
        uuid: "l",
        userEmail: "alice@example.com",
        status: "Active",
        awsAccountId: undefined,
        desiredAssignments: [
          { principalId: USER_IDS.alice, principalType: "USER" },
        ],
      },
    });

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId,
          requestedModel,
        },
        services,
      ),
    ).rejects.toBeInstanceOf(LeaseNotActiveError);
  });
});

// ─── validateAndRoute — per-turn model gate (rejection before runtime) ───────
//
// The routing boundary is the last server-side checkpoint before the Worker
// invokes the runtime, so a disabled or lease-disallowed model must be rejected
// here — the function throws instead of returning a route result, and the
// offending id is never echoed back to the caller.

describe("validateAndRoute — per-turn model gate", () => {
  const MODEL_A = "model-a";
  const MODEL_B = "model-b";

  it.each([MODEL_A, MODEL_B])(
    "routes model %s when it is both enabled and in the lease subset",
    async (model) => {
      mockLeaseGet.mockResolvedValue(
        makeActiveLease("l", "alice@example.com", [MODEL_A, MODEL_B]),
      );

      const result = await validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId: model,
          requestedModel: modelRow(model),
        },
        services,
      );

      expect(result.accountId).toBe("111111111111");
    },
  );

  it("throws ModelNotAllowedError when the model is enabled but not in the lease subset", async () => {
    // MODEL_B is enabled globally but the lease template only permits MODEL_A.
    mockLeaseGet.mockResolvedValue(
      makeActiveLease("l", "alice@example.com", [MODEL_A]),
    );

    await expect(
      validateAndRoute(
        {
          connection: makeUserConnection(),
          leaseKey: leaseKeyOf("l"),
          agentConfig: enabledConfig,
          requestedModelId: MODEL_B,
          requestedModel: modelRow(MODEL_B),
        },
        services,
      ),
    ).rejects.toBeInstanceOf(ModelNotAllowedError);
  });

  it("does not leak the rejected model id in the error message", async () => {
    mockLeaseGet.mockResolvedValue(makeActiveLease("l", "alice@example.com"));

    await validateAndRoute(
      {
        connection: makeUserConnection(),
        leaseKey: leaseKeyOf("l"),
        agentConfig: enabledConfig,
        requestedModelId: "sneaky-model-id",
        requestedModel: undefined,
      },
      services,
    ).catch((err: unknown) => {
      expect(err).toBeInstanceOf(ModelNotAllowedError);
      expect((err as Error).message).not.toContain("sneaky-model-id");
    });
    expect.assertions(2);
  });
});

// ─── sendToConnection ─────────────────────────────────────────────────────────

describe("sendToConnection", () => {
  it("calls send with serialised payload", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);
    const payload = {
      version: 1 as const,
      type: "chunk" as const,
      data: "hello",
    };

    await sendToConnection("conn-1", payload, mockSend, mockLogger);

    expect(mockSend).toHaveBeenCalledOnce();
    expect(mockSend).toHaveBeenCalledWith("conn-1", JSON.stringify(payload));
  });

  it("silently swallows GoneException (client disconnected)", async () => {
    const mockSend = vi
      .fn()
      .mockRejectedValue(
        Object.assign(new Error("gone"), { name: "GoneException" }),
      );

    await expect(
      sendToConnection(
        "conn-1",
        { version: 1 as const, type: "chunk" as const, data: "hi" },
        mockSend,
        mockLogger,
      ),
    ).resolves.toBeUndefined();

    expect(mockLogger.warn).toHaveBeenCalled();
  });

  it("re-throws non-GoneException errors", async () => {
    const mockSend = vi.fn().mockRejectedValue(new Error("network failure"));

    await expect(
      sendToConnection(
        "conn-1",
        { version: 1 as const, type: "chunk" as const, data: "hi" },
        mockSend,
        mockLogger,
      ),
    ).rejects.toThrow("network failure");
  });
});

// ─── sendKeepAlive ────────────────────────────────────────────────────────────

describe("sendKeepAlive", () => {
  it("sends a chunk payload with the keep-alive token", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);

    await sendKeepAlive("conn-1", mockSend, mockLogger);

    expect(mockSend).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockSend.mock.calls[0]![1] as string);
    expect(sent.type).toBe("chunk");
  });
});

// ─── sendError ────────────────────────────────────────────────────────────────

describe("sendError", () => {
  it("sends an error payload with the provided message", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);

    await sendError(
      "conn-1",
      {
        code: "RUNTIME_ERROR",
        message: "The agent could not process your message. Try again.",
        retryable: true,
      },
      mockSend,
      mockLogger,
    );

    expect(mockSend).toHaveBeenCalledOnce();
    const sent = JSON.parse(mockSend.mock.calls[0]![1] as string);
    expect(sent).toMatchObject({
      type: "error",
      error: {
        code: "RUNTIME_ERROR",
        message: "The agent could not process your message. Try again.",
        retryable: true,
      },
    });
    expect(sent).not.toHaveProperty(
      "callerSandboxSpacesEstimatedTokenCostAccrued",
    );
  });

  it("includes projected caller spend on a billed terminal error", async () => {
    const mockSend = vi.fn().mockResolvedValue(undefined);

    await sendError(
      "conn-1",
      {
        code: "UNKNOWN_ERROR",
        message: "The response could not be fully delivered.",
        retryable: false,
      },
      mockSend,
      mockLogger,
      {
        callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
        leaseCurrentSpend: 10.42,
      },
    );

    const sent = JSON.parse(mockSend.mock.calls[0]![1] as string);
    expect(sent).toMatchObject({
      type: "error",
      callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
      leaseCurrentSpend: 10.42,
    });
  });
});

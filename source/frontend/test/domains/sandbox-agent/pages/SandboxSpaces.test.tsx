// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { MemoryRouter, Route, Routes, useNavigate } from "react-router-dom";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { useGetLeaseById } from "@amzn/innovation-sandbox-frontend/domains/leases/hooks";
import {
  useAgentHistory,
  useAgentWebSocket,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/hooks";
import { SandboxSpaces } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/pages/SandboxSpaces";
import { useSandboxSpacesUsage } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { useGetConfigurations } from "@amzn/innovation-sandbox-frontend/domains/settings/hooks";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-frontend/helpers/encoding";
import { useBreadcrumb } from "@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb";
import {
  type IdcIdentity,
  useUser,
} from "@amzn/innovation-sandbox-frontend/hooks/useUser";
import { createConfiguration } from "@amzn/innovation-sandbox-frontend/mocks/factories/configurationFactory";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";

vi.mock("@amzn/innovation-sandbox-frontend/domains/leases/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries");
vi.mock("@amzn/innovation-sandbox-frontend/domains/settings/hooks");
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useBreadcrumb");
vi.mock("@amzn/innovation-sandbox-frontend/hooks/useUser");

const rawLeaseId = "a57dbb39-442f-4eea-9d2a-c949c50c275e";
const rawSecondLeaseId = "83ec8782-0f0e-4c80-a08c-17e8a081e655";
const owner: IdcIdentity = {
  type: "user",
  email: "owner@example.com",
  userId: "owner-id",
  roles: ["User"],
};

const mockCurrentUser = (user: IdcIdentity | undefined) => {
  const roles = user?.roles ?? [];
  vi.mocked(useUser).mockReturnValue({
    user,
    authError: undefined,
    error: null,
    isAdmin: roles.includes("Admin"),
    isManager: roles.includes("Manager"),
    isLoading: false,
    isUser: roles.includes("User"),
    roles,
  });
};
const routeLeaseId = base64EncodeCompositeKey({
  userEmail: owner.email,
  uuid: rawLeaseId,
});
const secondRouteLeaseId = base64EncodeCompositeKey({
  userEmail: owner.email,
  uuid: rawSecondLeaseId,
});
const sendMessage = vi.fn();
const reconnect = vi.fn();
const retryLastMessage = vi.fn();
const eligibleLease = {
  awsAccountId: "123456789012",
  originalLeaseTemplateName: "Data Science",
  totalCostAccrued: 10,
  maxSpend: 50,
  sandboxSpacesEnabled: true,
  status: "Active" as const,
  userEmail: owner.email,
  uuid: rawLeaseId,
  selectableModels: [
    { modelId: "m0", displayName: "Model Zero", provider: "Anthropic" },
  ],
};

const mockLease = (lease: Record<string, unknown>) =>
  vi.mocked(useGetLeaseById).mockReturnValue({
    data: lease,
    error: null,
    isError: false,
    isLoading: false,
    refetch: vi.fn(),
  } as unknown as ReturnType<typeof useGetLeaseById>);

// Mirrors the fields SandboxSpaces reads from useAgentHistory (the infinite
// query result plus `messages` and `loadEarlierMessages`).
const mockHistory = (
  overrides: Partial<ReturnType<typeof useAgentHistory>> = {},
) =>
  vi.mocked(useAgentHistory).mockReturnValue({
    isLoading: false,
    isError: false,
    isLoadingError: false,
    isFetchNextPageError: false,
    hasNextPage: false,
    isFetching: false,
    isFetchingNextPage: false,
    error: null,
    refetch: vi.fn(),
    loadEarlierMessages: vi.fn(),
    messages: [
      {
        kind: "history",
        messageId: "event-1:0",
        role: "user",
        content: "Earlier request",
        createdAt: "2026-09-10T00:00:00.000Z",
      },
    ],
    ...overrides,
  } as unknown as ReturnType<typeof useAgentHistory>);

const RouteChangeControl = () => {
  const navigate = useNavigate();

  return (
    <button
      onClick={() => navigate(`/leases/${secondRouteLeaseId}/sandbox-spaces`)}
    >
      Open another space
    </button>
  );
};

const renderSandboxSpaces = ({ includeRouteChangeControl = false } = {}) =>
  renderWithQueryClient(
    <MemoryRouter initialEntries={[`/leases/${routeLeaseId}/sandbox-spaces`]}>
      <Routes>
        <Route
          path="/leases/:leaseId/sandbox-spaces"
          element={
            <>
              <SandboxSpaces />
              {includeRouteChangeControl && <RouteChangeControl />}
            </>
          }
        />
      </Routes>
    </MemoryRouter>,
  );

const renderMalformedSandboxSpaces = () =>
  renderWithQueryClient(
    <MemoryRouter initialEntries={["/leases/not-a-lease-key/sandbox-spaces"]}>
      <Routes>
        <Route
          path="/leases/:leaseId/sandbox-spaces"
          element={<SandboxSpaces />}
        />
      </Routes>
    </MemoryRouter>,
  );

describe("SandboxSpaces", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useBreadcrumb).mockReturnValue(vi.fn());
    mockCurrentUser(owner);
    // Capability enabled so the owner-lease gate is what these tests exercise.
    vi.mocked(useGetConfigurations).mockReturnValue({
      data: createConfiguration({ agent: { sandboxSpacesEnabled: true } }),
    } as unknown as ReturnType<typeof useGetConfigurations>);
    mockLease(eligibleLease);
    mockHistory();
    vi.mocked(useSandboxSpacesUsage).mockReturnValue({
      data: {
        spendByUsers: [],
      },
      isSuccess: true,
    } as unknown as ReturnType<typeof useSandboxSpacesUsage>);
    vi.mocked(useAgentWebSocket).mockReturnValue({
      connectionStatus: "connected",
      messages: [
        {
          kind: "streaming",
          messageId: "turn-1",
          role: "assistant",
          content: "Streaming response",
          isComplete: true,
        },
      ],
      isResponding: false,
      reconnect,
      retryLastMessage,
      sendMessage,
    });
  });

  it("starts history and WebSocket transport with the decoded raw lease UUID", async () => {
    renderSandboxSpaces();

    await waitFor(() => {
      expect(useAgentHistory).toHaveBeenCalledWith({
        leaseId: routeLeaseId,
        userId: owner.userId,
        pageSize: 5,
      });
    });
    expect(useAgentWebSocket).toHaveBeenCalledWith({
      leaseId: routeLeaseId,
      leaseUuid: rawLeaseId,
      userId: owner.userId,
    });
    expect(screen.getByText("Earlier request")).toBeVisible();
    expect(screen.getAllByText("Streaming response")[0]).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Load earlier messages" }),
    ).not.toBeInTheDocument();
  });

  it("replaces the chat with a retryable error when the initial history load fails", async () => {
    const user = userEvent.setup();
    const refetch = vi.fn();
    mockHistory({
      isError: true,
      isLoadingError: true,
      error: new Error("boom"),
      refetch,
      messages: [],
    });

    renderSandboxSpaces();

    expect(
      screen.getByText(
        "There was a problem loading this Sandbox Space history.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByRole("textbox", { name: "Chat message input" }),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Try again" }));

    expect(refetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the chat and shows an inline Retry when an earlier history page fails", async () => {
    const user = userEvent.setup();
    const loadEarlierMessages = vi.fn();
    mockHistory({
      isError: true,
      isFetchNextPageError: true,
      hasNextPage: true,
      loadEarlierMessages,
    });

    renderSandboxSpaces();

    expect(screen.getByText("Earlier request")).toBeVisible();
    expect(
      screen.getByText("Earlier messages couldn't be loaded. Try again."),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "There was a problem loading this Sandbox Space history.",
      ),
    ).not.toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Retry" }));

    expect(loadEarlierMessages).toHaveBeenCalledTimes(1);
    expect(loadEarlierMessages).toHaveBeenCalledWith({ cancelRefetch: false });
  });

  it.each([
    ["requests", false, 1],
    ["does not request", true, 0],
  ])(
    "%s an earlier page for a visible sentinel when isFetching is %s",
    (_description, isFetching, expectedCalls) => {
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(
            private readonly callback: IntersectionObserverCallback,
          ) {}
          observe(target: Element) {
            this.callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
          disconnect() {}
        },
      );
      const loadEarlierMessages = vi.fn();
      mockHistory({ hasNextPage: true, isFetching, loadEarlierMessages });

      try {
        renderSandboxSpaces();
      } finally {
        vi.unstubAllGlobals();
      }

      expect(loadEarlierMessages).toHaveBeenCalledTimes(expectedCalls);
    },
  );

  it("does not request lease data or start transport for a malformed lease route key", () => {
    renderMalformedSandboxSpaces();

    expect(useGetLeaseById).toHaveBeenCalledWith(undefined);
    expect(screen.getByText("Sandbox Space unavailable")).toBeVisible();
    expect(useAgentHistory).not.toHaveBeenCalled();
    expect(useAgentWebSocket).not.toHaveBeenCalled();
  });

  it("restarts transport when navigating to a different lease route", async () => {
    const user = userEvent.setup();
    vi.mocked(useGetLeaseById).mockImplementation(
      (leaseId) =>
        ({
          data:
            leaseId === secondRouteLeaseId
              ? { ...eligibleLease, uuid: rawSecondLeaseId }
              : eligibleLease,
          error: null,
          isError: false,
          isLoading: false,
          refetch: vi.fn(),
        }) as unknown as ReturnType<typeof useGetLeaseById>,
    );

    renderSandboxSpaces({ includeRouteChangeControl: true });

    await waitFor(() => {
      expect(useAgentWebSocket).toHaveBeenLastCalledWith({
        leaseId: routeLeaseId,
        leaseUuid: rawLeaseId,
        userId: owner.userId,
      });
    });

    await user.click(
      screen.getByRole("button", { name: "Open another space" }),
    );

    await waitFor(() => {
      expect(useAgentHistory).toHaveBeenLastCalledWith({
        leaseId: secondRouteLeaseId,
        userId: owner.userId,
        pageSize: 5,
      });
    });
    expect(useAgentWebSocket).toHaveBeenLastCalledWith({
      leaseId: secondRouteLeaseId,
      leaseUuid: rawSecondLeaseId,
      userId: owner.userId,
    });
  });

  it.each([
    ["a non-owner", { ...owner, email: "other@example.com" }, eligibleLease],
    [
      "a disabled snapshot",
      owner,
      { ...eligibleLease, sandboxSpacesEnabled: false },
    ],
    ["a non-active lease", owner, { ...eligibleLease, status: "Frozen" }],
    ["a missing account", owner, { ...eligibleLease, awsAccountId: "" }],
  ])("does not start transport for %s", (_description, user, lease) => {
    mockCurrentUser(user as IdcIdentity | undefined);
    vi.mocked(useGetLeaseById).mockReturnValue({
      data: lease,
      error: null,
      isError: false,
      isLoading: false,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGetLeaseById>);

    renderSandboxSpaces();

    expect(screen.getByText("Sandbox Space unavailable")).toBeVisible();
    expect(useAgentHistory).not.toHaveBeenCalled();
    expect(useAgentWebSocket).not.toHaveBeenCalled();
  });

  it.each([
    ["a Manager owner", { ...owner, roles: ["User", "Manager"] }],
    ["an Admin owner", { ...owner, roles: ["User", "Admin"] }],
  ])("starts transport for %s", async (_description, user) => {
    mockCurrentUser(user as IdcIdentity);

    renderSandboxSpaces();

    await waitFor(() => {
      expect(useAgentHistory).toHaveBeenCalledWith({
        leaseId: routeLeaseId,
        userId: owner.userId,
        pageSize: 5,
      });
    });
    expect(useAgentWebSocket).toHaveBeenCalledWith({
      leaseId: routeLeaseId,
      leaseUuid: rawLeaseId,
      userId: owner.userId,
    });
  });

  describe("group-shared leases", () => {
    const groupSharedLease = {
      ...eligibleLease,
      desiredAssignments: [
        { principalId: owner.userId, principalType: "USER" as const },
        { principalId: "group-id", principalType: "GROUP" as const },
      ],
    };
    const outsider = {
      ...owner,
      email: "member@example.com",
      userId: "member-id",
    };

    it.each(["User", "Admin", "Manager"])(
      "shows unavailable, without transport, for a %s who is only in an assigned group",
      (role) => {
        mockCurrentUser({
          ...outsider,
          roles: role === "User" ? ["User"] : ["User", role],
        } as IdcIdentity);
        mockLease(groupSharedLease);

        renderSandboxSpaces();

        expect(screen.getByText("Sandbox Space unavailable")).toBeVisible();
        expect(useAgentHistory).not.toHaveBeenCalled();
        expect(useAgentWebSocket).not.toHaveBeenCalled();
      },
    );
  });

  it("does not start transport when Sandbox Spaces is globally disabled", () => {
    vi.mocked(useGetConfigurations).mockReturnValue({
      data: createConfiguration({ agent: { sandboxSpacesEnabled: false } }),
    } as unknown as ReturnType<typeof useGetConfigurations>);

    renderSandboxSpaces();

    expect(screen.getByText("Sandbox Space unavailable")).toBeVisible();
    expect(useAgentHistory).not.toHaveBeenCalled();
    expect(useAgentWebSocket).not.toHaveBeenCalled();
  });

  it("shows the loader (not unavailable) while the configuration query is loading", () => {
    // An owner-eligible lease with the config query still in flight: `config` is
    // undefined, so evaluating the global gate now would read as unusable and
    // wrongly show the unavailable state. It must show the loader instead.
    vi.mocked(useGetConfigurations).mockReturnValue({
      data: undefined,
      isLoading: true,
      isError: false,
      error: null,
      refetch: vi.fn(),
    } as unknown as ReturnType<typeof useGetConfigurations>);

    renderSandboxSpaces();

    expect(screen.getByText("Loading...")).toBeVisible();
    expect(
      screen.queryByText("Sandbox Space unavailable"),
    ).not.toBeInTheDocument();
    expect(useAgentHistory).not.toHaveBeenCalled();
    expect(useAgentWebSocket).not.toHaveBeenCalled();
  });

  it("shows a distinct error state (not unavailable) when the configuration query errors", () => {
    const refetch = vi.fn();
    vi.mocked(useGetConfigurations).mockReturnValue({
      data: undefined,
      isLoading: false,
      isError: true,
      error: new Error("boom"),
      refetch,
    } as unknown as ReturnType<typeof useGetConfigurations>);

    renderSandboxSpaces();

    expect(
      screen.getByText(
        "There was a problem loading Sandbox Space configuration.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText("Sandbox Space unavailable"),
    ).not.toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(useAgentHistory).not.toHaveBeenCalled();
    expect(useAgentWebSocket).not.toHaveBeenCalled();
  });

  it("renders the lease title, short ID, and AWS account in the header", async () => {
    renderSandboxSpaces();

    await waitFor(() => {
      expect(
        screen.getByRole("heading", {
          name: `Data Science (${rawLeaseId.slice(0, 8)})`,
        }),
      ).toBeVisible();
    });
    expect(screen.getByText("AWS account 123456789012")).toBeVisible();
  });

  describe("lease budget tracker", () => {
    const mockUsage = (
      spendByUsers: {
        userId: string;
        sandboxSpacesEstimatedTokenCostAccrued: number;
      }[],
    ) =>
      vi.mocked(useSandboxSpacesUsage).mockReturnValue({
        data: { spendByUsers },
        isSuccess: true,
      } as unknown as ReturnType<typeof useSandboxSpacesUsage>);

    const openTracker = async () => {
      const user = userEvent.setup();
      await user.click(screen.getByRole("button", { name: /lease budget/i }));
    };

    it("shows overall lease spend and keeps an omitted caller unavailable", async () => {
      mockLease({ ...eligibleLease, maxSpend: 50 });
      mockUsage([
        {
          userId: "other-id",
          sandboxSpacesEstimatedTokenCostAccrued: 7.5,
        },
      ]);

      renderSandboxSpaces();
      await openTracker();

      expect(useSandboxSpacesUsage).toHaveBeenCalledWith(
        routeLeaseId,
        owner.userId,
      );
      expect(screen.getByText("USD 10.00 of USD 50.00")).toBeVisible();
      expect(
        screen.getByText("Your Sandbox Space spend estimate is not available."),
      ).toBeVisible();
    });

    it("shows USD 0.00 for an explicit zero caller row", async () => {
      mockUsage([
        {
          userId: owner.userId,
          sandboxSpacesEstimatedTokenCostAccrued: 0,
        },
      ]);

      renderSandboxSpaces();
      await openTracker();

      expect(
        screen.getByText(
          "Your Sandbox Space has used an estimated USD 0.00 of the lease budget.",
        ),
      ).toBeVisible();
    });

    it("uses the lease's evaluated spend for progress when it is above the billed total", async () => {
      mockLease({
        ...eligibleLease,
        lastEvaluatedSpend: 12,
        maxSpend: 50,
        bedrockTokenMonitoringEnabled: true,
      });
      mockUsage([
        {
          userId: "other-id",
          sandboxSpacesEstimatedTokenCostAccrued: 7.5,
        },
        {
          userId: owner.userId,
          sandboxSpacesEstimatedTokenCostAccrued: 2.25,
        },
      ]);

      renderSandboxSpaces();
      await openTracker();

      expect(screen.getByText("USD 12.00 of USD 50.00")).toBeVisible();
      expect(
        screen.getByText(
          "Your Sandbox Space has used an estimated USD 2.25 of the lease budget.",
        ),
      ).toBeVisible();
    });

    it("keeps lease spend available while caller usage is pending", async () => {
      vi.mocked(useSandboxSpacesUsage).mockReturnValue({
        data: undefined,
        isPending: true,
        isSuccess: false,
      } as unknown as ReturnType<typeof useSandboxSpacesUsage>);

      renderSandboxSpaces();
      await openTracker();

      expect(screen.getByText("USD 10.00 of USD 50.00")).toBeVisible();
      expect(screen.getByText("Loading Sandbox Spaces spend")).toBeVisible();
    });

    it("keeps lease spend available when caller usage fails", async () => {
      vi.mocked(useSandboxSpacesUsage).mockReturnValue({
        data: undefined,
        isError: true,
        isPending: false,
        isSuccess: false,
      } as unknown as ReturnType<typeof useSandboxSpacesUsage>);

      renderSandboxSpaces();
      await openTracker();

      expect(screen.getByText("USD 10.00 of USD 50.00")).toBeVisible();
      expect(
        screen.getByText("Your Sandbox Space spend estimate is not available."),
      ).toBeVisible();
    });

    it("shows the higher WebSocket spend snapshots", async () => {
      mockUsage([
        {
          userId: owner.userId,
          sandboxSpacesEstimatedTokenCostAccrued: 2.25,
        },
      ]);
      vi.mocked(useAgentWebSocket).mockReturnValue({
        connectionStatus: "connected",
        messages: [],
        isResponding: false,
        callerSandboxSpacesEstimatedTokenCostAccrued: 3.1,
        leaseCurrentSpend: 20,
        reconnect,
        retryLastMessage,
        sendMessage,
      });

      renderSandboxSpaces();
      await openTracker();

      expect(screen.getByText("USD 20.00 of USD 50.00")).toBeVisible();
      expect(
        screen.getByText(
          "Your Sandbox Space has used an estimated USD 3.10 of the lease budget.",
        ),
      ).toBeVisible();
    });

    it("keeps the higher lease-query spend over a lower WebSocket snapshot", async () => {
      mockLease({ ...eligibleLease, maxSpend: 50 });
      mockUsage([
        {
          userId: owner.userId,
          sandboxSpacesEstimatedTokenCostAccrued: 4.5,
        },
      ]);
      vi.mocked(useAgentWebSocket).mockReturnValue({
        connectionStatus: "connected",
        messages: [],
        isResponding: false,
        callerSandboxSpacesEstimatedTokenCostAccrued: 3.1,
        leaseCurrentSpend: 7,
        reconnect,
        retryLastMessage,
        sendMessage,
      });

      renderSandboxSpaces();
      await openTracker();

      expect(screen.getByText("USD 10.00 of USD 50.00")).toBeVisible();
      expect(
        screen.getByText(
          "Your Sandbox Space has used an estimated USD 4.50 of the lease budget.",
        ),
      ).toBeVisible();
    });
  });

  it("sends the selected model id with each message", async () => {
    const user = userEvent.setup();

    renderSandboxSpaces();

    const input = await screen.findByRole("textbox", {
      name: "Chat message input",
    });
    await user.type(input, "Create a bucket");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(sendMessage).toHaveBeenCalledWith("Create a bucket", "m0");
  });

  it("disables the model selector while a turn is in flight", () => {
    vi.mocked(useAgentWebSocket).mockReturnValue({
      connectionStatus: "connected",
      messages: [],
      isResponding: true,
      reconnect,
      retryLastMessage,
      sendMessage,
    });

    renderSandboxSpaces();

    expect(screen.getByRole("button", { name: /Select model/ })).toBeDisabled();
  });

  it("offers exactly the selectable models the lease read returns", async () => {
    // `allowedModelIds` on the record must not narrow the list; the server does.
    const user = userEvent.setup();
    mockLease({
      ...eligibleLease,
      allowedModelIds: ["m0", "m1"],
      selectableModels: [
        { modelId: "m1", displayName: "Model One", provider: "Anthropic" },
      ],
    });

    renderSandboxSpaces();

    await user.click(screen.getByRole("button", { name: /Select model/ }));

    const options = screen.getAllByRole("option");
    expect(options).toHaveLength(1);
    expect(options[0]).toHaveTextContent("Model One");
  });

  it("shows the distinct no-model state (not the owner/active message) when the lease read returns no selectable models", () => {
    // The active lease user is correctly authenticated and the capability is
    // on, but the server resolved no selectable model for this lease, so no
    // message could carry a required modelId. The failure is model
    // availability, not owner/active-lease eligibility, so it must show the
    // distinct message and never mount the chat composer.
    mockLease({ ...eligibleLease, selectableModels: [] });

    renderSandboxSpaces();

    expect(
      screen.getByText(
        "No enabled model is available for this Sandbox Space. Contact an administrator.",
      ),
    ).toBeVisible();
    // Distinct from the owner/active-lease failure message.
    expect(
      screen.queryByText(
        "This Sandbox Space is available only to the active lease user.",
      ),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("textbox", { name: "Chat message input" }),
    ).not.toBeInTheDocument();
  });

  it("shows the owner/active-lease message (not the no-model message) for an owner/active failure", () => {
    // The complementary side of the distinctness proof: a genuine owner/active
    // eligibility failure must show the active-lease-user message and NOT the
    // no-enabled-model message.
    mockCurrentUser({ ...owner, email: "other@example.com" });

    renderSandboxSpaces();

    expect(
      screen.getByText(
        "This Sandbox Space is available only to the active lease user.",
      ),
    ).toBeVisible();
    expect(
      screen.queryByText(
        "No enabled model is available for this Sandbox Space. Contact an administrator.",
      ),
    ).not.toBeInTheDocument();
  });

  it("preselects the lease's template default model when it is allowed", async () => {
    const user = userEvent.setup();
    mockLease({
      ...eligibleLease,
      defaultModelId: "m1",
      selectableModels: [
        { modelId: "m0", displayName: "Model Zero", provider: "Anthropic" },
        { modelId: "m1", displayName: "Model One", provider: "Anthropic" },
      ],
    });

    renderSandboxSpaces();

    const input = await screen.findByRole("textbox", {
      name: "Chat message input",
    });
    await user.type(input, "Create a bucket");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    // The template default (m1) is sent, not the first catalog model (m0).
    expect(sendMessage).toHaveBeenCalledWith("Create a bucket", "m1");
    expect(
      screen.queryByText(/default model for this Sandbox Space is no longer/),
    ).not.toBeInTheDocument();
  });

  it.each([
    ["the default is unset", undefined, false],
    ["the default is not a selectable model", "m-not-selectable", true],
  ])(
    "falls back to the first selectable model when %s",
    async (_description, defaultModelId, expectNotice) => {
      const user = userEvent.setup();
      mockLease({
        ...eligibleLease,
        allowedModelIds: ["m1"],
        defaultModelId,
        selectableModels: [
          { modelId: "m1", displayName: "Model One", provider: "Anthropic" },
        ],
      });

      renderSandboxSpaces();

      const input = await screen.findByRole("textbox", {
        name: "Chat message input",
      });
      await user.type(input, "Create a bucket");
      await user.click(screen.getByRole("button", { name: "Send message" }));

      // The only selectable model (m1) is used regardless of the bad default.
      expect(sendMessage).toHaveBeenCalledWith("Create a bucket", "m1");
      // A carried default that cannot be offered is called out; an unset one
      // is not a fallback the user needs to know about.
      const notice = screen.queryByText(
        /default model for this Sandbox Space is no longer/,
      );
      if (expectNotice) {
        expect(notice).toBeInTheDocument();
      } else {
        expect(notice).not.toBeInTheDocument();
      }
    },
  );
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  onlineManager,
  QueryClient,
  QueryClientProvider,
} from "@tanstack/react-query";
import { act, render, renderHook, waitFor } from "@testing-library/react";
import { type ReactNode, StrictMode, useState } from "react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  expectTypeOf,
  it,
  vi,
} from "vitest";

import {
  type AgentSocket,
  type AgentSocketFactory,
  createPresignedWebSocketUrl,
  createSignedAgentSocket,
  useAgentHistory,
  useAgentWebSocket,
  type UseAgentWebSocketResult,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/hooks";
import {
  AGENT_MODEL_CATALOG_KEY,
  useAgentModelCatalog,
  useAgentModelDiscovery,
  useEnabledCatalogModels,
  usePutAgentModelCatalogEntry,
  useSandboxSpacesUsage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/queries";
import { AgentHistoryService } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/service";
import type {
  HistoryDisplayMessage,
  StreamingDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

// The catalog/discovery/mutation hooks in queries.ts resolve the service via
// the getSandboxAgentService() singleton, so the tests mock that module and
// control the returned service per test.
const mockService = {
  listHistory: vi.fn(),
  getUsage: vi.fn(),
  listModels: vi.fn(),
  discoverModels: vi.fn(),
  listCatalog: vi.fn(),
  putCatalogEntry: vi.fn(),
};
vi.mock(
  "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/service",
  async (importOriginal) => {
    const actual =
      await importOriginal<
        typeof import("@amzn/innovation-sandbox-frontend/domains/sandbox-agent/service")
      >();
    return {
      ...actual,
      getSandboxAgentService: () => mockService,
    };
  },
);

class MockAgentSocket implements AgentSocket {
  readyState: number = WebSocket.CONNECTING;
  onclose: ((event: CloseEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent<string>) => void) | null = null;
  onopen: ((event: Event) => void) | null = null;
  readonly sent: string[] = [];
  sendFailure?: Error;

  close(): void {
    this.readyState = WebSocket.CLOSED;
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(payload: unknown): void {
    this.onmessage?.(
      new MessageEvent("message", { data: JSON.stringify(payload) }),
    );
  }

  disconnect(): void {
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close"));
  }

  send(data: string): void {
    if (this.sendFailure) {
      throw this.sendFailure;
    }
    this.sent.push(data);
  }
}

let latestWebSocket: UseAgentWebSocketResult | undefined;

const TEST_USER_ID = "11111111-1111-4111-8111-111111111111";

const WebSocketHarness = ({
  leaseId,
  socketFactory,
}: {
  leaseId: string;
  socketFactory: AgentSocketFactory;
}) => {
  latestWebSocket = useAgentWebSocket({
    leaseId,
    leaseUuid: `uuid-of-${leaseId}`,
    userId: TEST_USER_ID,
    reconnectDelayMs: 0,
    socketFactory,
  });
  return null;
};

const createWrapper = () => {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  const QueryClientWrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
  QueryClientWrapper.displayName = "QueryClientWrapper";
  return QueryClientWrapper;
};

afterEach(() => {
  vi.useRealTimers();
});

describe("useAgentWebSocket", () => {
  it("keeps the initial route lease ID through reconnects and every sent message", async () => {
    const firstSocket = new MockAgentSocket();
    const secondSocket = new MockAgentSocket();
    const sockets = [firstSocket, secondSocket];
    const socketFactory = vi.fn(async () => sockets.shift()!);

    const { rerender } = render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );

    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => firstSocket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );

    expect(JSON.parse(firstSocket.sent[0]!)).toEqual({
      action: "sendMessage",
      leaseId: "lease-a",
      leaseUuid: "uuid-of-lease-a",
      userId: TEST_USER_ID,
      message: "Create a bucket",
      modelId: "test-model",
    });

    rerender(
      <WebSocketHarness leaseId="lease-b" socketFactory={socketFactory} />,
    );
    act(() => firstSocket.disconnect());

    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    act(() => secondSocket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("List buckets", "test-model"),
    );

    expect(JSON.parse(secondSocket.sent[0]!)).toEqual({
      action: "sendMessage",
      leaseId: "lease-a",
      leaseUuid: "uuid-of-lease-a",
      userId: TEST_USER_ID,
      message: "List buckets",
      modelId: "test-model",
    });
  });

  it("starts a new connection after Strict Mode cleanup and discards a stale resolution", async () => {
    const firstSocket = new MockAgentSocket();
    const secondSocket = new MockAgentSocket();
    const thirdSocket = new MockAgentSocket();
    let resolveFirst: (socket: AgentSocket) => void = () => {
      throw new Error("First socket factory was not initialized");
    };
    let resolveSecond: (socket: AgentSocket) => void = () => {
      throw new Error("Second socket factory was not initialized");
    };
    const firstConnection = new Promise<AgentSocket>((resolve) => {
      resolveFirst = resolve;
    });
    const secondConnection = new Promise<AgentSocket>((resolve) => {
      resolveSecond = resolve;
    });
    const socketFactory = vi
      .fn<AgentSocketFactory>()
      .mockReturnValueOnce(firstConnection)
      .mockReturnValueOnce(secondConnection)
      .mockResolvedValueOnce(thirdSocket);

    render(
      <StrictMode>
        <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />
      </StrictMode>,
    );

    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));

    await act(async () => resolveFirst(firstSocket));
    await waitFor(() => expect(firstSocket.readyState).toBe(WebSocket.CLOSED));

    await act(async () => resolveSecond(secondSocket));
    act(() => secondSocket.open());
    expect(latestWebSocket!.connectionStatus).toBe("connected");

    act(() => secondSocket.disconnect());
    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(3));
  });

  it("accumulates chunks, filters keep-alives, and finalizes on complete", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );

    act(() =>
      socket.receive({ version: 1, type: "chunk", data: "##PROCESSING##" }),
    );
    expect(latestWebSocket!.messages).toHaveLength(1);

    act(() => socket.receive({ version: 1, type: "chunk", data: "Created " }));
    act(() =>
      socket.receive({ version: 1, type: "chunk", data: "the bucket." }),
    );
    act(() => socket.receive({ version: 1, type: "complete" }));

    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "streaming",
      content: "Created the bucket.",
      isComplete: true,
    });
  });

  it("stamps a completed response with the browser time it completed", async () => {
    // Fake only Date so the socket factory promise and waitFor keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );
    act(() => socket.receive({ version: 1, type: "chunk", data: "Created." }));

    vi.setSystemTime(new Date("2026-09-09T00:00:42.000Z"));
    act(() => socket.receive({ version: 1, type: "complete" }));

    expect(latestWebSocket!.messages).toEqual([
      expect.objectContaining({
        kind: "history",
        role: "user",
        createdAt: "2026-09-09T00:00:00.000Z",
      }),
      expect.objectContaining({
        kind: "streaming",
        content: "Created.",
        isComplete: true,
        createdAt: "2026-09-09T00:00:42.000Z",
      }),
    ]);
    expectTypeOf<
      NonNullable<StreamingDisplayMessage["createdAt"]>
    >().toEqualTypeOf<HistoryDisplayMessage["createdAt"]>();
  });

  it("takes the caller's estimated spend from terminal frames but not chunks", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );

    act(() =>
      socket.receive({
        version: 1,
        type: "chunk",
        data: "Created",
        callerSandboxSpacesEstimatedTokenCostAccrued: 9.99,
        leaseCurrentSpend: 99.99,
      }),
    );
    expect(
      latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued,
    ).toBeUndefined();
    expect(latestWebSocket!.leaseCurrentSpend).toBeUndefined();

    act(() =>
      socket.receive({
        version: 1,
        type: "complete",
        callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
        leaseCurrentSpend: 10.42,
      }),
    );
    expect(latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued).toBe(
      0.42,
    );
    expect(latestWebSocket!.leaseCurrentSpend).toBe(10.42);
  });

  it("keeps the last known caller spend when a complete frame omits it", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());

    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );
    act(() =>
      socket.receive({
        version: 1,
        type: "complete",
        callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
        leaseCurrentSpend: 10.42,
      }),
    );
    await act(async () =>
      latestWebSocket!.sendMessage("List buckets", "test-model"),
    );
    act(() => socket.receive({ version: 1, type: "complete" }));

    expect(latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued).toBe(
      0.42,
    );
    expect(latestWebSocket!.leaseCurrentSpend).toBe(10.42);
  });

  it("keeps the error code a model failure arrives with", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );

    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        error: {
          code: "CONTENT_FILTERED",
          message:
            "The model's content filter stopped this reply. Choose a different model and try again.",
          retryable: false,
        },
      }),
    );

    expect(latestWebSocket!.isResponding).toBe(false);
    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "CONTENT_FILTERED",
      retryable: false,
    });
  });

  it("updates caller spend when a billed turn ends with an error", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );

    act(() => socket.receive({ version: 1, type: "chunk", data: "Partial" }));
    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
        leaseCurrentSpend: 10.42,
        error: {
          code: "UNKNOWN_ERROR",
          message: "The response could not be fully delivered.",
          retryable: false,
        },
      }),
    );

    expect(latestWebSocket!.isResponding).toBe(false);
    expect(latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued).toBe(
      0.42,
    );
    expect(latestWebSocket!.leaseCurrentSpend).toBe(10.42);
    expect(latestWebSocket!.messages.at(-2)).toMatchObject({
      kind: "streaming",
      content: "Partial",
      isComplete: true,
    });
    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "UNKNOWN_ERROR",
    });
  });

  it("keeps the last known caller spend when an error frame omits it", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());

    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );
    act(() =>
      socket.receive({
        version: 1,
        type: "complete",
        callerSandboxSpacesEstimatedTokenCostAccrued: 0.42,
        leaseCurrentSpend: 10.42,
      }),
    );
    await act(async () =>
      latestWebSocket!.sendMessage("List buckets", "test-model"),
    );
    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        error: {
          code: "RUNTIME_ERROR",
          message: "The agent could not process your message. Try again.",
          retryable: true,
        },
      }),
    );

    expect(latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued).toBe(
      0.42,
    );
    expect(latestWebSocket!.leaseCurrentSpend).toBe(10.42);
  });

  it("keeps caller spend monotonic and accepts the latest lease spend", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());

    act(() =>
      socket.receive({
        version: 1,
        type: "complete",
        callerSandboxSpacesEstimatedTokenCostAccrued: 2,
        leaseCurrentSpend: 20,
      }),
    );
    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        callerSandboxSpacesEstimatedTokenCostAccrued: 1,
        leaseCurrentSpend: 15,
        error: {
          code: "RUNTIME_ERROR",
          message: "The agent could not process your message. Try again.",
          retryable: true,
        },
      }),
    );

    expect(latestWebSocket!.callerSandboxSpacesEstimatedTokenCostAccrued).toBe(
      2,
    );
    expect(latestWebSocket!.leaseCurrentSpend).toBe(15);
  });

  it("maps only structured safe errors and exposes retryability", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());

    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        error: {
          code: "RUNTIME_ERROR",
          message: "The agent could not process your message. Try again.",
          retryable: true,
        },
      }),
    );

    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "RUNTIME_ERROR",
      message: "The agent could not process your message. Try again.",
      retryable: true,
      messageId: expect.any(String),
    });
  });

  it("assigns distinct identities to repeated errors", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);
    const response = {
      version: 1 as const,
      type: "error" as const,
      error: {
        code: "RUNTIME_ERROR" as const,
        message: "The agent could not process your message. Try again.",
        retryable: true,
      },
    };

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    act(() => socket.receive(response));
    act(() => socket.receive(response));

    const errors = latestWebSocket!.messages.filter(
      (message) => message.kind === "error",
    );
    const [firstError, secondError] = errors;
    expect(errors).toHaveLength(2);
    expect(firstError?.messageId).toEqual(expect.any(String));
    expect(secondError?.messageId).toEqual(expect.any(String));
    expect(secondError?.messageId).not.toBe(firstError?.messageId);
  });
});

describe("useAgentHistory", () => {
  it("maps history, deduplicates page overlap, and prepends earlier messages", async () => {
    const service: AgentHistoryService = {
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
      listHistory: vi
        .fn()
        .mockResolvedValueOnce({
          messages: [
            {
              messageId: "event-2:0",
              role: "user",
              content: "Current request",
              createdAt: "2026-09-10T00:00:00.000Z",
            },
            {
              messageId: "event-2:1",
              role: "assistant",
              content: "Latest response",
              createdAt: "2026-09-10T00:00:00.000Z",
            },
          ],
          nextToken: "earlier-page",
        })
        .mockResolvedValueOnce({
          messages: [
            {
              messageId: "event-2:0",
              role: "user",
              content: "Current request",
              createdAt: "2026-09-10T00:00:00.000Z",
            },
            {
              messageId: "event-2:1",
              role: "assistant",
              content: "Latest response",
              createdAt: "2026-09-10T00:00:00.000Z",
            },
            {
              messageId: "event-1:0",
              role: "user",
              content: "Earlier request",
              createdAt: "2026-09-09T00:00:00.000Z",
            },
            {
              messageId: "event-1:1",
              role: "assistant",
              content: "Earlier response",
              createdAt: "2026-09-09T00:00:00.000Z",
            },
          ],
        }),
    };
    let history: ReturnType<typeof useAgentHistory> | undefined;

    const HistoryHarness = () => {
      history = useAgentHistory({
        leaseId: "lease-a",
        userId: "user-a",
        service,
      });
      return null;
    };

    render(<HistoryHarness />, { wrapper: createWrapper() });

    await waitFor(() => expect(history!.messages).toHaveLength(2));
    await act(async () => history!.loadEarlierMessages());

    await waitFor(() =>
      expect(
        history!.messages.map(
          (message: { content: string }) => message.content,
        ),
      ).toEqual([
        "Earlier request",
        "Earlier response",
        "Current request",
        "Latest response",
      ]),
    );
    expect(service.listHistory).toHaveBeenNthCalledWith(
      2,
      "lease-a",
      "earlier-page",
      undefined,
    );
  });

  it("does not refetch mounted history when the network reconnects", async () => {
    const listHistory = vi.fn().mockResolvedValue({ messages: [] });
    const service: AgentHistoryService = {
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
      listHistory,
    };

    try {
      renderHook(
        () =>
          useAgentHistory({
            leaseId: "lease-a",
            userId: "user-a",
            service,
          }),
        { wrapper: createWrapper() },
      );
      await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));

      act(() => onlineManager.setOnline(false));
      await act(async () => {
        onlineManager.setOnline(true);
        await new Promise((resolve) => setTimeout(resolve, 0));
      });

      expect(listHistory).toHaveBeenCalledTimes(1);
    } finally {
      onlineManager.setOnline(true);
    }
  });

  it("loads a fresh history baseline after the chat unmounts", async () => {
    const listHistory = vi.fn().mockResolvedValue({ messages: [] });
    const service: AgentHistoryService = {
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
      listHistory,
    };
    const client = new QueryClient({
      defaultOptions: {
        queries: { retry: false, refetchOnMount: false },
      },
    });
    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );

    const firstMount = renderHook(
      () =>
        useAgentHistory({
          leaseId: "lease-a",
          userId: "user-a",
          service,
        }),
      { wrapper: Wrapper },
    );
    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(1));
    firstMount.unmount();
    await new Promise((resolve) => setTimeout(resolve, 0));

    renderHook(
      () =>
        useAgentHistory({
          leaseId: "lease-a",
          userId: "user-a",
          service,
        }),
      { wrapper: Wrapper },
    );

    await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(2));
  });

  it("uses pageSize as part of the history cache identity", async () => {
    const service: AgentHistoryService = {
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
      listHistory: vi.fn().mockResolvedValue({ messages: [] }),
    };

    const { rerender } = renderHook(
      ({ pageSize }) =>
        useAgentHistory({
          leaseId: "lease-a",
          userId: "user-a",
          pageSize,
          service,
        }),
      {
        initialProps: { pageSize: 5 },
        wrapper: createWrapper(),
      },
    );

    await waitFor(() =>
      expect(service.listHistory).toHaveBeenCalledWith("lease-a", undefined, 5),
    );

    rerender({ pageSize: 10 });

    await waitFor(() => expect(service.listHistory).toHaveBeenCalledTimes(2));
    expect(service.listHistory).toHaveBeenLastCalledWith(
      "lease-a",
      undefined,
      10,
    );
  });

  it("orders each turn user-before-assistant when a turn shares one event timestamp", async () => {
    // AgentCore stamps every message in one event (a turn) with the same
    // eventTimestamp and returns turns newest-first; within an event the user
    // message precedes the assistant response. The hook must reverse turn order
    // for display without flipping the user/assistant order inside a turn.
    const service: AgentHistoryService = {
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
      listHistory: vi.fn().mockResolvedValueOnce({
        messages: [
          {
            messageId: "event-2:0",
            role: "user",
            content: "Delete the bucket",
            createdAt: "2026-09-10T00:05:00.000Z",
          },
          {
            messageId: "event-2:1",
            role: "assistant",
            content: "Deleted the bucket.",
            createdAt: "2026-09-10T00:05:00.000Z",
          },
          {
            messageId: "event-1:0",
            role: "user",
            content: "Create a bucket",
            createdAt: "2026-09-10T00:00:00.000Z",
          },
          {
            messageId: "event-1:1",
            role: "assistant",
            content: "Created the bucket.",
            createdAt: "2026-09-10T00:00:00.000Z",
          },
        ],
      }),
    };
    let history: ReturnType<typeof useAgentHistory> | undefined;

    const HistoryHarness = () => {
      history = useAgentHistory({
        leaseId: "lease-a",
        userId: "user-a",
        service,
      });
      return null;
    };

    render(<HistoryHarness />, { wrapper: createWrapper() });

    await waitFor(() =>
      expect(
        history!.messages.map(
          (message: { content: string }) => message.content,
        ),
      ).toEqual([
        "Create a bucket",
        "Created the bucket.",
        "Delete the bucket",
        "Deleted the bucket.",
      ]),
    );
  });
});

describe("WebSocket recovery", () => {
  it("retries after socket creation fails", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi
      .fn<AgentSocketFactory>()
      .mockRejectedValueOnce(new Error("connection failed"))
      .mockResolvedValueOnce(socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );

    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    act(() => socket.open());

    expect(latestWebSocket!.connectionStatus).toBe("connected");
  });

  it("preserves a partial response and retries into a new assistant message", async () => {
    // Fake only Date so the socket factory promise and waitFor keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const firstSocket = new MockAgentSocket();
    const secondSocket = new MockAgentSocket();
    const sockets = [firstSocket, secondSocket];
    const socketFactory = vi.fn(async () => sockets.shift()!);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => firstSocket.open());
    await act(async () =>
      latestWebSocket!.sendMessage(
        "Create a bucket",
        "global.anthropic.claude-sonnet-4-6",
      ),
    );
    act(() =>
      firstSocket.receive({ version: 1, type: "chunk", data: "Partial" }),
    );
    vi.setSystemTime(new Date("2026-09-09T00:00:42.000Z"));
    act(() => firstSocket.disconnect());

    expect(latestWebSocket!.isResponding).toBe(false);
    expect(latestWebSocket!.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          kind: "streaming",
          content: "Partial",
          isComplete: true,
          createdAt: "2026-09-09T00:00:42.000Z",
        }),
        expect.objectContaining({
          kind: "error",
          code: "CONNECTION_INTERRUPTED",
          message: "Reconnect and send your message again.",
          retryable: true,
        }),
      ]),
    );
    const [partialResponse, interruption] = latestWebSocket!.messages.slice(-2);
    expect(interruption?.messageId).toBe(partialResponse?.messageId);

    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    act(() => secondSocket.open());
    await act(async () => latestWebSocket!.retryLastMessage());

    expect(JSON.parse(secondSocket.sent[0]!)).toEqual({
      action: "sendMessage",
      leaseId: "lease-a",
      leaseUuid: "uuid-of-lease-a",
      userId: TEST_USER_ID,
      message: "Create a bucket",
      modelId: "global.anthropic.claude-sonnet-4-6",
    });

    act(() =>
      secondSocket.receive({ version: 1, type: "chunk", data: "Complete" }),
    );
    act(() => secondSocket.receive({ version: 1, type: "complete" }));

    expect(
      latestWebSocket!.messages
        .filter((message) => message.kind === "streaming")
        .map((message) => message.content),
    ).toEqual(["Partial", "Complete"]);
  });

  it("presigns the configured stage URL with identity and protocol query parameters", async () => {
    const url = new URL(
      await createPresignedWebSocketUrl(
        {
          endpoint: "wss://test.execute-api.us-east-1.amazonaws.com/prod",
          region: "us-east-1",
        },
        { accessKeyId: "access-key", secretAccessKey: "secret-key" },
        "id-token",
      ),
    );

    expect(url.protocol).toBe("wss:");
    expect(url.pathname).toBe("/prod");
    expect(url.searchParams.get("x-isb-identity")).toBe("id-token");
    expect(url.searchParams.get("x-isb-protocol-version")).toBe("1");
    expect(url.searchParams.get("X-Amz-Algorithm")).toBe("AWS4-HMAC-SHA256");
    expect(url.searchParams.get("X-Amz-Signature")).toBeTruthy();
    expect(url.searchParams.get("X-Amz-Credential")).toContain(
      "/us-east-1/execute-api/aws4_request",
    );
  });
});

describe("WebSocket error handling", () => {
  it("finalizes partial output before appending a structured runtime error", async () => {
    // Fake only Date so the socket factory promise and waitFor keep running.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-09T00:00:00.000Z"));
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );
    act(() => socket.receive({ version: 1, type: "chunk", data: "Partial" }));
    vi.setSystemTime(new Date("2026-09-09T00:00:42.000Z"));
    act(() =>
      socket.receive({
        version: 1,
        type: "error",
        error: {
          code: "RUNTIME_ERROR",
          message: "The agent could not process your message. Try again.",
          retryable: true,
        },
      }),
    );

    expect(latestWebSocket!.messages.at(-2)).toMatchObject({
      kind: "streaming",
      content: "Partial",
      isComplete: true,
      createdAt: "2026-09-09T00:00:42.000Z",
    });
    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "RUNTIME_ERROR",
      retryable: true,
    });
  });

  it("constructs a browser socket from the SigV4-signed URL", async () => {
    const socket: AgentSocket = {
      readyState: 0,
      close: vi.fn(),
      send: vi.fn(),
      onclose: null,
      onerror: null,
      onmessage: null,
      onopen: null,
    };
    let constructedUrl: string | undefined;
    const SocketConstructor = vi.fn(function (url: string) {
      constructedUrl = url;
      return socket;
    });
    vi.stubGlobal("WebSocket", SocketConstructor);

    await createSignedAgentSocket({
      endpoint: "wss://test.execute-api.us-east-1.amazonaws.com/prod",
      region: "us-east-1",
    });

    expect(constructedUrl).toBeDefined();
    const signedUrl = new URL(constructedUrl!);
    expect(signedUrl.protocol).toBe("wss:");
    expect(signedUrl.pathname).toBe("/prod");
    expect(signedUrl.searchParams.get("X-Amz-Signature")).toBeTruthy();

    vi.unstubAllGlobals();
  });
});

describe("hook convention safeguards", () => {
  it("ignores a stale socket close after a newer connection opens", async () => {
    const firstSocket = new MockAgentSocket();
    const secondSocket = new MockAgentSocket();
    const sockets = [firstSocket, secondSocket];
    const socketFactory = vi.fn(async () => sockets.shift()!);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => firstSocket.open());
    act(() => firstSocket.disconnect());

    await waitFor(() => expect(socketFactory).toHaveBeenCalledTimes(2));
    act(() => secondSocket.open());
    act(() => firstSocket.disconnect());
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(socketFactory).toHaveBeenCalledTimes(2);
  });

  it("converts socket send failures into safe chat errors", async () => {
    const socket = new MockAgentSocket();
    const socketFactory = vi.fn(async () => socket);

    render(
      <WebSocketHarness leaseId="lease-a" socketFactory={socketFactory} />,
    );
    await waitFor(() => expect(socketFactory).toHaveBeenCalledOnce());
    act(() => socket.open());

    socket.sendFailure = new Error("socket write failed");
    await act(async () =>
      latestWebSocket!.sendMessage("Create a bucket", "test-model"),
    );
    expect(latestWebSocket!.messages.at(-1)).toMatchObject({
      kind: "error",
      code: "CONNECTION_INTERRUPTED",
      message: "Try again after the chat reconnects.",
      retryable: true,
    });
    expect(latestWebSocket!.isResponding).toBe(false);
  });

  it("does not request history when the route lease ID is empty", async () => {
    const service: AgentHistoryService = {
      listHistory: vi.fn(),
      getUsage: vi.fn(),
      listModels: vi.fn().mockResolvedValue([]),
      discoverModels: vi.fn().mockResolvedValue([]),
      listCatalog: vi.fn().mockResolvedValue([]),
      putCatalogEntry: vi.fn(),
    };

    const EmptyHistoryHarness = () => {
      useAgentHistory({ leaseId: "", userId: "user-a", service });
      return null;
    };

    render(<EmptyHistoryHarness />, { wrapper: createWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(service.listHistory).not.toHaveBeenCalled();
  });
});

// ─── Catalog and mutation hooks ───────────────────────────────────────────────

describe("useAgentModelCatalog", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches catalog entries from the service", async () => {
    const catalogEntries = [
      {
        modelId: "amazon.nova-lite-v1:0",
        displayName: "Nova Lite",
        provider: "Amazon",
        availability: "global",
        enabled: true,
      },
    ];
    mockService.listCatalog.mockResolvedValue(catalogEntries);

    let hookResult: ReturnType<typeof useAgentModelCatalog> | undefined;
    const Harness = () => {
      hookResult = useAgentModelCatalog();
      return null;
    };

    render(<Harness />, { wrapper: createWrapper() });
    await waitFor(() => expect(hookResult?.data).toEqual(catalogEntries));
    expect(mockService.listCatalog).toHaveBeenCalledOnce();
  });
});

describe("useEnabledCatalogModels", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("keeps only enabled rows and returns the same array across re-renders", async () => {
    mockService.listCatalog.mockResolvedValue([
      { modelId: "amazon.nova-lite-v1:0", enabled: true },
      { modelId: "amazon.nova-pro-v1:0", enabled: false },
    ]);

    const results: ReturnType<typeof useEnabledCatalogModels>["data"][] = [];
    let rerender = () => {};
    const Harness = () => {
      const [, setTick] = useState(0);
      rerender = () => setTick((tick) => tick + 1);
      results.push(useEnabledCatalogModels().data);
      return null;
    };

    render(<Harness />, { wrapper: createWrapper() });
    await waitFor(() => expect(results.at(-1)).toHaveLength(1));
    const loaded = results.at(-1);
    expect(loaded?.[0]?.modelId).toBe("amazon.nova-lite-v1:0");

    // An unrelated re-render must not hand consumers a new array, or their
    // memos and effects keyed on it recompute every render.
    act(() => rerender());
    expect(results.at(-1)).toBe(loaded);
  });

  it("exposes the unfiltered catalog alongside the enabled rows", async () => {
    mockService.listCatalog.mockResolvedValue([
      { modelId: "amazon.nova-lite-v1:0", enabled: true },
      { modelId: "amazon.nova-pro-v1:0", enabled: false },
    ]);

    let result: ReturnType<typeof useEnabledCatalogModels> | undefined;
    const Harness = () => {
      result = useEnabledCatalogModels();
      return null;
    };

    render(<Harness />, { wrapper: createWrapper() });
    await waitFor(() => expect(result?.catalog).toHaveLength(2));
    expect(result?.data).toHaveLength(1);
  });
});

describe("useSandboxSpacesUsage", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("fetches usage for the route lease ID", async () => {
    const usage = {
      spendByUsers: [
        { userId: "user-a", sandboxSpacesEstimatedTokenCostAccrued: 1.25 },
      ],
    };
    mockService.getUsage.mockResolvedValue(usage);

    const { result } = renderHook(
      () => useSandboxSpacesUsage("lease-a", "user-a"),
      {
        wrapper: createWrapper(),
      },
    );

    await waitFor(() => expect(result.current.data).toEqual(usage));
    expect(mockService.getUsage).toHaveBeenCalledOnce();
    expect(mockService.getUsage).toHaveBeenCalledWith("lease-a");
  });

  it("separates cached usage by caller", async () => {
    mockService.getUsage.mockResolvedValue({ spendByUsers: [] });

    const { rerender } = renderHook(
      ({ userId }) => useSandboxSpacesUsage("lease-a", userId),
      {
        initialProps: { userId: "user-a" },
        wrapper: createWrapper(),
      },
    );
    await waitFor(() => expect(mockService.getUsage).toHaveBeenCalledOnce());

    rerender({ userId: "user-b" });

    await waitFor(() => expect(mockService.getUsage).toHaveBeenCalledTimes(2));
  });

  it("does not fetch when the route lease ID is empty", async () => {
    const { result } = renderHook(() => useSandboxSpacesUsage("", "user-a"), {
      wrapper: createWrapper(),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(result.current.fetchStatus).toBe("idle");
    expect(mockService.getUsage).not.toHaveBeenCalled();
  });
});

describe("useAgentModelDiscovery", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("does not fetch when enabled is false", async () => {
    mockService.discoverModels.mockResolvedValue([]);

    const Harness = () => {
      useAgentModelDiscovery({ enabled: false });
      return null;
    };

    render(<Harness />, { wrapper: createWrapper() });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(mockService.discoverModels).not.toHaveBeenCalled();
  });

  it("fetches when enabled is true", async () => {
    const models = [
      { modelId: "amazon.nova-lite-v1:0", displayName: "Nova Lite" },
    ];
    mockService.discoverModels.mockResolvedValue(models);

    let hookResult: ReturnType<typeof useAgentModelDiscovery> | undefined;
    const Harness = () => {
      hookResult = useAgentModelDiscovery({ enabled: true });
      return null;
    };

    render(<Harness />, { wrapper: createWrapper() });
    await waitFor(() => expect(hookResult?.data).toEqual(models));
    expect(mockService.discoverModels).toHaveBeenCalledOnce();
  });
});

describe("usePutAgentModelCatalogEntry", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("calls putCatalogEntry and invalidates the catalog key by default", async () => {
    const entry = {
      modelId: "amazon.nova-lite-v1:0",
      displayName: "Nova Lite",
      provider: "Amazon",
      availability: "global",
      enabled: true,
    };
    mockService.putCatalogEntry.mockResolvedValue(entry);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    let mutation: ReturnType<typeof usePutAgentModelCatalogEntry> | undefined;
    const Harness = () => {
      mutation = usePutAgentModelCatalogEntry();
      return null;
    };

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    Wrapper.displayName = "Wrapper";

    render(<Harness />, { wrapper: Wrapper });
    await act(async () => {
      await mutation!.mutateAsync({
        modelId: "amazon.nova-lite-v1:0",
        enabled: true,
      });
    });

    expect(mockService.putCatalogEntry).toHaveBeenCalledOnce();
    expect(invalidateSpy).toHaveBeenCalledWith(
      expect.objectContaining({ queryKey: AGENT_MODEL_CATALOG_KEY }),
    );
  });

  it("skips invalidation when skipInvalidation is true", async () => {
    const entry = {
      modelId: "amazon.nova-lite-v1:0",
      displayName: "Nova Lite",
      provider: "Amazon",
      availability: "global",
      enabled: true,
    };
    mockService.putCatalogEntry.mockResolvedValue(entry);

    const client = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
    const invalidateSpy = vi.spyOn(client, "invalidateQueries");

    let mutation: ReturnType<typeof usePutAgentModelCatalogEntry> | undefined;
    const Harness = () => {
      mutation = usePutAgentModelCatalogEntry({ skipInvalidation: true });
      return null;
    };

    const Wrapper = ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    );
    Wrapper.displayName = "Wrapper";

    render(<Harness />, { wrapper: Wrapper });
    await act(async () => {
      await mutation!.mutateAsync({
        modelId: "amazon.nova-lite-v1:0",
        enabled: true,
      });
    });

    expect(mockService.putCatalogEntry).toHaveBeenCalledOnce();
    expect(invalidateSpy).not.toHaveBeenCalled();
  });
});

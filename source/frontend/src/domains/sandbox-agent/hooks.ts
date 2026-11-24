// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Sha256 } from "@aws-crypto/sha256-js";
import { HttpRequest } from "@aws-sdk/protocol-http";
import { SignatureV4 } from "@aws-sdk/signature-v4";
import type { AwsCredentialIdentity } from "@aws-sdk/types";
import { useInfiniteQuery } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";

import { CognitoAuthService } from "@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService";
import { getConfig } from "@amzn/innovation-sandbox-frontend/helpers/config";
import {
  AGENT_KEEP_ALIVE_TOKEN,
  AGENT_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION_QUERY_PARAM,
  type AgentResponse,
  AgentResponseSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

import { AgentHistoryService, getSandboxAgentService } from "./service";
import type {
  AgentConnectionStatus,
  AgentHistoryResponse,
  ChatRenderableMessage,
  ErrorDisplayMessage,
  HistoryDisplayMessage,
} from "./types";

type ErrorDisplayInput = Omit<ErrorDisplayMessage, "messageId">;

const DEFAULT_RECONNECT_DELAY_MS = 500;
const DEFAULT_ERROR: ErrorDisplayInput = {
  kind: "error",
  code: "UNKNOWN_ERROR",
  message: "The agent could not process your message. Try again.",
  retryable: false,
};
const CONNECTION_INTERRUPTED_ERROR: ErrorDisplayInput = {
  kind: "error",
  code: "CONNECTION_INTERRUPTED",
  message: "Try again after the chat reconnects.",
  retryable: true,
};

export type AgentSocket = {
  readyState: number;
  close(): void;
  send(data: string): void;
  onclose: ((event: CloseEvent) => void) | null;
  onerror: ((event: Event) => void) | null;
  onmessage: ((event: MessageEvent<string>) => void) | null;
  onopen: ((event: Event) => void) | null;
};

export type AgentSocketFactory = (
  connection: AgentSocketConnection,
) => Promise<AgentSocket>;

export type AgentSocketConnection = {
  endpoint: string;
  region: string;
};

export type UseAgentWebSocketOptions = {
  /** Base64url lease key (owner email + uuid) */
  leaseId: string;
  leaseUuid: string;
  /** IDC user id of the signed-in user. */
  userId: string;
  endpoint?: string;
  reconnectDelayMs?: number;
  socketFactory?: AgentSocketFactory;
};

export type UseAgentWebSocketResult = {
  connectionStatus: AgentConnectionStatus;
  messages: ChatRenderableMessage[];
  isResponding: boolean;
  callerSandboxSpacesEstimatedTokenCostAccrued?: number;
  leaseCurrentSpend?: number;
  reconnect(): void;
  retryLastMessage(): Promise<void>;
  sendMessage(message: string, modelId: string): Promise<void>;
};

export function useAgentWebSocket(
  options: UseAgentWebSocketOptions,
): UseAgentWebSocketResult {
  const initialOptions = useRef(options).current;
  const leaseIdRef = useRef(initialOptions.leaseId);
  const leaseUuidRef = useRef(initialOptions.leaseUuid);
  const userIdRef = useRef(initialOptions.userId);
  const socketRef = useRef<AgentSocket | null>(null);
  const isDisposedRef = useRef(false);
  const reconnectTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const connectionGenerationRef = useRef(0);
  const connectionAttemptRef = useRef<symbol>();
  const connectRef = useRef<() => void>(() => {});
  const activeTurnIdRef = useRef<string>();
  const lastMessageRef = useRef<string>();
  const lastModelIdRef = useRef<string>();
  const [messages, setMessages] = useState<ChatRenderableMessage[]>([]);
  const [isResponding, setIsResponding] = useState(false);
  const [
    callerSandboxSpacesEstimatedTokenCostAccrued,
    setCallerSandboxSpacesEstimatedTokenCostAccrued,
  ] = useState<number>();
  const [leaseCurrentSpend, setLeaseCurrentSpend] = useState<number>();
  const [connectionStatus, setConnectionStatus] =
    useState<AgentConnectionStatus>("connecting");

  const releaseConnectionAttempt = useCallback((attempt: symbol): void => {
    if (connectionAttemptRef.current === attempt) {
      connectionAttemptRef.current = undefined;
    }
  }, []);

  // Finalizes any in-flight streaming turn before surfacing an error so a later
  // chunk or retry cannot append to the failed response.
  const appendError = useCallback((error: ErrorDisplayInput) => {
    const turnId = activeTurnIdRef.current;
    activeTurnIdRef.current = undefined;
    setMessages((current) => [
      ...(turnId ? finalizeStreamingMessage(current, turnId) : current),
      {
        ...error,
        messageId: turnId ?? globalThis.crypto.randomUUID(),
      },
    ]);
    setIsResponding(false);
  }, []);

  const scheduleReconnect = useCallback(() => {
    if (isDisposedRef.current || reconnectTimerRef.current) {
      return;
    }
    reconnectTimerRef.current = setTimeout(() => {
      reconnectTimerRef.current = null;
      connectRef.current();
    }, initialOptions.reconnectDelayMs ?? DEFAULT_RECONNECT_DELAY_MS);
  }, [initialOptions.reconnectDelayMs]);

  const reconnect = useCallback(() => {
    if (socketRef.current || connectionAttemptRef.current) {
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }
    setConnectionStatus("connecting");
    connectRef.current();
  }, []);

  const sendMessage = useCallback(
    async (message: string, modelId: string): Promise<void> => {
      const socket = socketRef.current;
      if (socket?.readyState !== WebSocket.OPEN) {
        lastMessageRef.current = message;
        lastModelIdRef.current = modelId;
        appendError(CONNECTION_INTERRUPTED_ERROR);
        setConnectionStatus("reconnecting");
        scheduleReconnect();
        return;
      }

      try {
        socket.send(
          JSON.stringify({
            action: "sendMessage",
            message,
            leaseId: leaseIdRef.current,
            leaseUuid: leaseUuidRef.current,
            userId: userIdRef.current,
            modelId,
          }),
        );
      } catch {
        lastMessageRef.current = message;
        lastModelIdRef.current = modelId;
        if (socketRef.current === socket) {
          socketRef.current = null;
          connectionGenerationRef.current += 1;
          socket.close();
        }
        appendError(CONNECTION_INTERRUPTED_ERROR);
        setConnectionStatus("reconnecting");
        scheduleReconnect();
        return;
      }

      const turnId = globalThis.crypto.randomUUID();
      activeTurnIdRef.current = turnId;
      lastMessageRef.current = message;
      lastModelIdRef.current = modelId;
      setMessages((current) => [
        ...current,
        {
          kind: "history",
          messageId: `${turnId}:user`,
          role: "user",
          content: message,
          createdAt: new Date().toISOString(),
        },
      ]);
      setIsResponding(true);
    },
    [appendError, scheduleReconnect],
  );

  const retryLastMessage = useCallback(async (): Promise<void> => {
    if (lastMessageRef.current && lastModelIdRef.current) {
      await sendMessage(lastMessageRef.current, lastModelIdRef.current);
    }
  }, [sendMessage]);

  const interruptActiveTurn = useCallback(() => {
    const turnId = activeTurnIdRef.current;
    if (!turnId) {
      return;
    }

    activeTurnIdRef.current = undefined;
    setIsResponding(false);
    setMessages((current) => [
      ...finalizeStreamingMessage(current, turnId),
      {
        kind: "error",
        messageId: turnId,
        code: "CONNECTION_INTERRUPTED",
        message: "Reconnect and send your message again.",
        retryable: true,
      },
    ]);
  }, []);

  const isCurrentConnection = useCallback(
    (generation: number): boolean =>
      !isDisposedRef.current && generation === connectionGenerationRef.current,
    [],
  );

  const isCurrentSocket = useCallback(
    (socket: AgentSocket, generation: number): boolean =>
      isCurrentConnection(generation) && socketRef.current === socket,
    [isCurrentConnection],
  );

  const updateTerminalSpend = useCallback((response: AgentResponse): void => {
    // The Worker omits the figure when it cannot read the caller's record;
    // keep the last known value rather than clearing it.
    const callerSpend = response.callerSandboxSpacesEstimatedTokenCostAccrued;
    if (callerSpend !== undefined) {
      setCallerSandboxSpacesEstimatedTokenCostAccrued((current) =>
        current === undefined ? callerSpend : Math.max(current, callerSpend),
      );
    }
    const nextLeaseCurrentSpend = response.leaseCurrentSpend;
    if (nextLeaseCurrentSpend !== undefined) {
      setLeaseCurrentSpend(nextLeaseCurrentSpend);
    }
  }, []);

  const handleSocketMessage = useCallback(
    (event: MessageEvent<string>): void => {
      const response = parseAgentResponse(event.data);
      if (!response) {
        return;
      }

      if (response.type === "chunk") {
        const chunk = response.data;
        if (!chunk || chunk === AGENT_KEEP_ALIVE_TOKEN) {
          return;
        }

        const activeTurnId = activeTurnIdRef.current;
        if (activeTurnId) {
          setMessages((current) => appendChunk(current, activeTurnId, chunk));
        }
        return;
      }

      if (response.type === "complete" || response.type === "error") {
        updateTerminalSpend(response);
      }

      if (response.type === "complete") {
        const activeTurnId = activeTurnIdRef.current;
        if (activeTurnId) {
          setMessages((current) =>
            finalizeStreamingMessage(current, activeTurnId),
          );
        }
        activeTurnIdRef.current = undefined;
        setIsResponding(false);
        return;
      }

      if (response.type === "error") {
        appendError(
          response.error ? { kind: "error", ...response.error } : DEFAULT_ERROR,
        );
      }
    },
    [appendError, updateTerminalSpend],
  );

  const handleSocketDisruption = useCallback(
    (socket: AgentSocket, generation: number, closeSocket: boolean): void => {
      if (!isCurrentSocket(socket, generation)) {
        return;
      }

      socketRef.current = null;
      connectionGenerationRef.current += 1;
      interruptActiveTurn();
      setConnectionStatus("reconnecting");
      scheduleReconnect();
      if (closeSocket) {
        socket.close();
      }
    },
    [interruptActiveTurn, isCurrentSocket, scheduleReconnect],
  );

  const attachSocketHandlers = useCallback(
    (socket: AgentSocket, generation: number): void => {
      socket.onopen = () => {
        if (isCurrentSocket(socket, generation)) {
          setConnectionStatus("connected");
        }
      };
      socket.onmessage = (event) => {
        if (isCurrentSocket(socket, generation)) {
          handleSocketMessage(event);
        }
      };
      socket.onerror = () => {
        handleSocketDisruption(socket, generation, true);
      };
      socket.onclose = () => {
        handleSocketDisruption(socket, generation, false);
      };
    },
    [handleSocketDisruption, handleSocketMessage, isCurrentSocket],
  );

  const connect = useCallback(() => {
    if (isDisposedRef.current || connectionAttemptRef.current) {
      return;
    }
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
      reconnectTimerRef.current = null;
    }

    const generation = connectionGenerationRef.current + 1;
    const attempt = Symbol("connection-attempt");
    connectionGenerationRef.current = generation;
    connectionAttemptRef.current = attempt;
    const endpoint =
      initialOptions.endpoint ?? getConfig().SandboxAgentWebSocketUrl;
    const socketFactory =
      initialOptions.socketFactory ?? createSignedAgentSocket;

    socketFactory({ endpoint, region: getConfig().Region })
      .then((socket) => {
        releaseConnectionAttempt(attempt);
        if (!isCurrentConnection(generation)) {
          socket.close();
          return;
        }

        socketRef.current = socket;
        attachSocketHandlers(socket, generation);
      })
      .catch(() => {
        releaseConnectionAttempt(attempt);
        if (!isCurrentConnection(generation)) {
          return;
        }

        setConnectionStatus("reconnecting");
        scheduleReconnect();
      });
  }, [
    attachSocketHandlers,
    initialOptions,
    isCurrentConnection,
    releaseConnectionAttempt,
    scheduleReconnect,
  ]);

  connectRef.current = connect;

  useEffect(() => {
    isDisposedRef.current = false;
    connectRef.current();
    return () => {
      isDisposedRef.current = true;
      connectionGenerationRef.current += 1;
      const connectionAttempt = connectionAttemptRef.current;
      if (connectionAttempt) {
        releaseConnectionAttempt(connectionAttempt);
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      if (socketRef.current) {
        socketRef.current.onclose = null;
        socketRef.current.onerror = null;
        socketRef.current.close();
      }
    };
  }, [releaseConnectionAttempt]);

  return {
    connectionStatus,
    messages,
    isResponding,
    callerSandboxSpacesEstimatedTokenCostAccrued,
    leaseCurrentSpend,
    reconnect,
    retryLastMessage,
    sendMessage,
  };
}

export type UseAgentHistoryOptions = {
  leaseId: string;
  userId: string;
  pageSize?: number;
  service?: AgentHistoryService;
};

export function useAgentHistory({
  leaseId,
  userId,
  pageSize,
  service = getSandboxAgentService(),
}: UseAgentHistoryOptions) {
  const query = useInfiniteQuery({
    queryKey: ["sandbox-agent", "history", leaseId, userId, pageSize],
    initialPageParam: undefined as string | undefined,
    queryFn: ({ pageParam }) =>
      service.listHistory(leaseId, pageParam, pageSize),
    enabled: !!leaseId,
    // History is the mounted chat's baseline; the socket owns later turns.
    // A reconnect refetch could duplicate a persisted live turn because
    // AgentCore history IDs and browser turn IDs are intentionally unrelated.
    gcTime: 0,
    refetchOnReconnect: false,
    getNextPageParam: (page: AgentHistoryResponse) =>
      page.nextToken ?? undefined,
  });

  // AgentCore returns pages newest-first; messages within an event share a
  // timestamp and must stay in order. Reverse events, not individual messages.
  const messages = deduplicateHistoryMessages(
    [...(query.data?.pages ?? [])]
      .reverse()
      .flatMap((page) =>
        reverseTurns(page.messages).map(toHistoryDisplayMessage),
      ),
  );

  return {
    ...query,
    messages,
    loadEarlierMessages: query.fetchNextPage,
  };
}

/** Removes overlap between paginated or refreshed AgentCore event pages. */
function deduplicateHistoryMessages(
  messages: HistoryDisplayMessage[],
): HistoryDisplayMessage[] {
  const seen = new Set<string>();
  return messages.filter((message) => {
    if (seen.has(message.messageId)) {
      return false;
    }
    seen.add(message.messageId);
    return true;
  });
}

/**
 * Reverses newest-first turns into oldest-first while keeping each turn's own
 * message order intact. Messages sharing a `createdAt` belong to one AgentCore
 * event (one turn); their relative order (user before the assistant response)
 * must survive the reversal, so only whole turns are reordered, never the
 * messages inside a turn.
 */
function reverseTurns<T extends { createdAt: string }>(messages: T[]): T[] {
  const turns: T[][] = [];
  for (const message of messages) {
    const currentTurn = turns.at(-1);
    if (currentTurn && currentTurn[0]?.createdAt === message.createdAt) {
      currentTurn.push(message);
    } else {
      turns.push([message]);
    }
  }
  turns.reverse();
  return turns.flat();
}

function findStreamingMessageIndex(
  messages: ChatRenderableMessage[],
  turnId: string,
): number {
  return messages.findIndex(
    (message) =>
      message.kind === "streaming" &&
      message.messageId === turnId &&
      !message.isComplete,
  );
}

function appendChunk(
  messages: ChatRenderableMessage[],
  turnId: string,
  content: string,
): ChatRenderableMessage[] {
  const index = findStreamingMessageIndex(messages, turnId);
  if (index === -1) {
    return [
      ...messages,
      {
        kind: "streaming",
        role: "assistant",
        content,
        messageId: turnId,
        isComplete: false,
      },
    ];
  }

  const streaming = messages[index];
  if (streaming?.kind !== "streaming") {
    return messages;
  }
  const updated = [...messages];
  updated[index] = { ...streaming, content: streaming.content + content };
  return updated;
}

function finalizeStreamingMessage(
  messages: ChatRenderableMessage[],
  turnId: string,
): ChatRenderableMessage[] {
  const index = findStreamingMessageIndex(messages, turnId);
  if (index === -1) {
    return messages;
  }

  const streaming = messages[index];
  if (streaming?.kind !== "streaming") {
    return messages;
  }
  const updated = [...messages];
  updated[index] = {
    ...streaming,
    isComplete: true,
    createdAt: new Date().toISOString(),
  };
  return updated;
}

function parseAgentResponse(data: string) {
  try {
    const response = AgentResponseSchema.safeParse(JSON.parse(data));
    if (!response.success || response.data.version !== AGENT_PROTOCOL_VERSION) {
      return undefined;
    }
    return response.data;
  } catch {
    return undefined;
  }
}

function toHistoryDisplayMessage(
  message: AgentHistoryResponse["messages"][number],
): HistoryDisplayMessage {
  return { kind: "history", ...message };
}

export async function createSignedAgentSocket(
  connection: AgentSocketConnection,
): Promise<AgentSocket> {
  const [credentials, idToken] = await Promise.all([
    CognitoAuthService.getCredentials(),
    CognitoAuthService.getIdToken(),
  ]);
  if (!credentials || !idToken) {
    throw new Error("No active session");
  }

  return new WebSocket(
    await createPresignedWebSocketUrl(connection, credentials, idToken),
  );
}

export async function createPresignedWebSocketUrl(
  { endpoint, region }: AgentSocketConnection,
  credentials: AwsCredentialIdentity,
  idToken: string,
): Promise<string> {
  const url = new URL(endpoint);
  const request = new HttpRequest({
    protocol: "https:",
    hostname: url.hostname,
    port: url.port ? Number(url.port) : undefined,
    method: "GET",
    path: url.pathname,
    query: {
      "x-isb-identity": idToken,
      [AGENT_PROTOCOL_VERSION_QUERY_PARAM]: String(AGENT_PROTOCOL_VERSION),
    },
    headers: { host: url.host },
  });
  const signer = new SignatureV4({
    credentials,
    region,
    service: "execute-api",
    sha256: Sha256,
  });
  const signed = await signer.presign(request, { expiresIn: 60 });
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(signed.query ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        query.append(key, item);
      }
    } else if (value !== null) {
      query.set(key, value);
    }
  }

  return `wss://${signed.hostname}${signed.path}?${query}`;
}

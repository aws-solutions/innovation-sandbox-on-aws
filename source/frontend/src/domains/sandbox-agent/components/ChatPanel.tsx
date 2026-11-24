// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alert,
  Box,
  Button,
  LiveRegion,
  PromptInput,
  SpaceBetween,
  StatusIndicator,
} from "@cloudscape-design/components";
import type { ReactNode } from "react";
import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";

import { ChatMessages } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/ChatMessages";
import { WelcomeState } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/WelcomeState";
import {
  findScrollContainer,
  getChatMessageAnchorIdentity,
  getChatMessageRenderIdentity,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import type {
  AgentConnectionStatus,
  ChatRenderableMessage,
  ErrorDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import { useEarlierMessagesLoader } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/useEarlierMessagesLoader";

import styles from "./ChatPanel.module.scss";

export type ChatPanelProps = {
  messages: ChatRenderableMessage[];
  onSendMessage: (message: string) => void;
  assistantName: string;
  isResponding?: boolean;
  connectionStatus?: AgentConnectionStatus;
  onReconnect?: () => void;
  onRetry?: (message: ErrorDisplayMessage) => void;
  /** Rendered as the prompt input's secondary actions. */
  composerControls?: ReactNode;
  /**
   * Pinned above the message region (e.g. the page title and account). Kept
   * out of the scrolling message region so it stays visible.
   */
  header?: ReactNode;
  welcome?: {
    heading: string;
    description: string;
    examplePrompts: string[];
  };
  hasEarlierMessages?: boolean;
  isLoadingEarlierMessages?: boolean;
  isLoadEarlierMessagesError?: boolean;
  isHistoryFetching?: boolean;
  onLoadEarlierMessages?: () => void;
};

export const ChatPanel = ({
  messages,
  onSendMessage,
  assistantName,
  isResponding = false,
  connectionStatus = "connected",
  onReconnect,
  onRetry,
  composerControls,
  header,
  welcome,
  hasEarlierMessages = false,
  isLoadingEarlierMessages = false,
  isLoadEarlierMessagesError = false,
  isHistoryFetching = false,
  onLoadEarlierMessages,
}: ChatPanelProps) => {
  const latestMessage = messages.at(-1);
  // Render identity changes with streamed content; anchor identity does not.
  const latestMessageIdentity = latestMessage
    ? getChatMessageRenderIdentity(latestMessage)
    : undefined;
  const latestMessageAnchorIdentity = latestMessage
    ? getChatMessageAnchorIdentity(latestMessage)
    : undefined;
  const firstMessage = messages.at(0);
  const firstMessageIdentity = firstMessage
    ? getChatMessageAnchorIdentity(firstMessage)
    : undefined;
  const scrollTargetId = useId();
  const latestMessageElementId = useId();
  const earlierMessagesSentinelId = useId();
  const [message, setMessage] = useState("");
  const previousLatestMessageIdentity = useRef(latestMessageIdentity);
  const previousFirstMessageIdentity = useRef(firstMessageIdentity);
  const previousMessageCount = useRef(messages.length);
  const hasPositionedInitialMessages = useRef(false);
  const shouldFollowLatest = useRef(true);
  const lastObservedScrollTop = useRef(0);
  const lastObservedMaxScrollTop = useRef(0);

  const getScrollContext = useCallback(() => {
    const target = document.getElementById(scrollTargetId);
    return target ? { target, ...findScrollContainer(target) } : null;
  }, [scrollTargetId]);

  // Open the first non-empty transcript at the newest messages before paint.
  useLayoutEffect(() => {
    if (hasPositionedInitialMessages.current || messages.length === 0) {
      return;
    }
    const scrollContext = getScrollContext();
    if (!scrollContext) {
      return;
    }

    hasPositionedInitialMessages.current = true;
    const { element: container } = scrollContext;
    container.scrollTop = Math.max(
      0,
      container.scrollHeight - container.clientHeight,
    );
    lastObservedScrollTop.current = container.scrollTop;
    lastObservedMaxScrollTop.current = getMaxScrollTop(container);
    shouldFollowLatest.current = true;
  }, [getScrollContext, messages.length]);

  const updateFollowState = useCallback((container: Element) => {
    const currentScrollTop = container.scrollTop;
    const currentMaxScrollTop = getMaxScrollTop(container);
    const scrollRangeShrank =
      currentMaxScrollTop < lastObservedMaxScrollTop.current;
    const remainsAtBottom = isNearBottom(container);
    const movedUp = currentScrollTop < lastObservedScrollTop.current;

    if (movedUp && !(scrollRangeShrank && remainsAtBottom)) {
      shouldFollowLatest.current = false;
    } else if (remainsAtBottom) {
      shouldFollowLatest.current = true;
    }
    lastObservedScrollTop.current = currentScrollTop;
    lastObservedMaxScrollTop.current = currentMaxScrollTop;
  }, []);

  const scrollToLatestImmediately = useCallback(
    (container: Element) => {
      container.scrollTop = getMaxScrollTop(container);
      updateFollowState(container);
    },
    [updateFollowState],
  );

  useEffect(() => {
    const scrollContext = getScrollContext();
    if (!scrollContext) {
      return;
    }

    const { element: container, eventTarget } = scrollContext;
    lastObservedScrollTop.current = container.scrollTop;
    lastObservedMaxScrollTop.current = getMaxScrollTop(container);
    shouldFollowLatest.current = isNearBottom(container);

    const handleScroll = () => updateFollowState(container);
    eventTarget.addEventListener("scroll", handleScroll, { passive: true });
    return () => eventTarget.removeEventListener("scroll", handleScroll);
  }, [getScrollContext, updateFollowState]);

  useEffect(() => {
    const scrollContext = getScrollContext();
    const latestMessageElement = document.getElementById(
      latestMessageElementId,
    );
    if (
      !scrollContext ||
      !latestMessageElement ||
      typeof ResizeObserver === "undefined"
    ) {
      return;
    }

    const { element: container } = scrollContext;
    const observer = new ResizeObserver(() => {
      if (shouldFollowLatest.current) {
        scrollToLatestImmediately(container);
      }
    });
    observer.observe(latestMessageElement);
    return () => observer.disconnect();
  }, [
    getScrollContext,
    latestMessageAnchorIdentity,
    latestMessageElementId,
    scrollToLatestImmediately,
  ]);

  useEffect(() => {
    const previousCount = previousMessageCount.current;
    const isSameLatestMessage =
      latestMessageIdentity === previousLatestMessageIdentity.current;
    const isSameFirstMessage =
      firstMessageIdentity === previousFirstMessageIdentity.current;

    previousLatestMessageIdentity.current = latestMessageIdentity;
    previousFirstMessageIdentity.current = firstMessageIdentity;
    previousMessageCount.current = messages.length;

    if (!latestMessageIdentity) {
      return;
    }

    const isUnchanged =
      isSameLatestMessage && messages.length === previousCount;
    const isPrependedHistory =
      previousCount > 0 &&
      messages.length > previousCount &&
      !isSameFirstMessage;
    if (isUnchanged || isPrependedHistory) {
      return;
    }

    const isNewOutgoingMessage =
      messages.length > previousCount &&
      latestMessage?.kind === "history" &&
      latestMessage.role === "user";

    const scrollContext = getScrollContext();
    if (!scrollContext) {
      return;
    }
    const { element: container, target: scrollTarget } = scrollContext;
    updateFollowState(container);

    // Sending a message starts a new follow session. Incoming growth continues
    // that session until an upward reader scroll disables it.
    if (isNewOutgoingMessage) {
      shouldFollowLatest.current = true;
    }
    if (!shouldFollowLatest.current) {
      return;
    }
    if (latestMessage?.kind === "streaming") {
      scrollToLatestImmediately(container);
    } else if (typeof scrollTarget.scrollIntoView === "function") {
      // Discrete messages can animate once. Streaming and resize-driven
      // updates move immediately so rapid chunks do not restart animations.
      scrollTarget.scrollIntoView({ behavior: "smooth", block: "end" });
    }
  }, [
    firstMessageIdentity,
    getScrollContext,
    latestMessage,
    latestMessageIdentity,
    messages.length,
    scrollToLatestImmediately,
    updateFollowState,
  ]);

  const { requestEarlierMessages } = useEarlierMessagesLoader({
    sentinelId: earlierMessagesSentinelId,
    oldestMessageIdentity: firstMessageIdentity,
    hasEarlierMessages,
    isLoadingEarlierMessages,
    isLoadEarlierMessagesError,
    isHistoryFetching,
    onLoadEarlierMessages,
  });

  const handleSendMessage = () => {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      return;
    }

    onSendMessage(trimmedMessage);
    setMessage("");
  };

  let earlierMessagesControl: ReactNode = null;
  if (onLoadEarlierMessages && isLoadEarlierMessagesError) {
    earlierMessagesControl = (
      <Alert
        type="error"
        action={
          <Button
            onClick={requestEarlierMessages}
            loading={isLoadingEarlierMessages}
            disabled={isHistoryFetching && !isLoadingEarlierMessages}
            disabledReason={
              isHistoryFetching && !isLoadingEarlierMessages
                ? "Retry is available when the current history refresh finishes."
                : undefined
            }
          >
            Retry
          </Button>
        }
      >
        Earlier messages couldn&apos;t be loaded. Try again.
      </Alert>
    );
  } else if (onLoadEarlierMessages && isLoadingEarlierMessages) {
    earlierMessagesControl = (
      <LiveRegion>
        <Box textAlign="center">
          <StatusIndicator type="loading">
            Loading earlier messages
          </StatusIndicator>
        </Box>
      </LiveRegion>
    );
  }

  const showWelcome =
    messages.length === 0 &&
    !isResponding &&
    connectionStatus === "connected" &&
    welcome;

  // Header and composer are fixed siblings; only the fitted middle scrolls.
  return (
    <Box nativeAttributes={{ className: styles.root }}>
      {header && (
        <Box padding={{ horizontal: "l", top: "m", bottom: "s" }}>{header}</Box>
      )}
      <Box nativeAttributes={{ className: styles.fitted }}>
        <Box
          padding={{ horizontal: "l", vertical: "s" }}
          nativeAttributes={{ className: styles.scroller }}
        >
          <Box nativeAttributes={{ id: earlierMessagesSentinelId }} />
          {showWelcome ? (
            <WelcomeState
              heading={welcome.heading}
              description={welcome.description}
              examplePrompts={welcome.examplePrompts}
              onPromptSelect={onSendMessage}
            />
          ) : (
            <SpaceBetween size="s">
              {earlierMessagesControl}
              <ChatMessages
                messages={messages}
                assistantName={assistantName}
                isResponding={isResponding}
                connectionStatus={connectionStatus}
                onReconnect={onReconnect}
                onRetry={onRetry}
                latestMessageElementId={latestMessageElementId}
              />
            </SpaceBetween>
          )}
          <Box nativeAttributes={{ id: scrollTargetId }} />
        </Box>
      </Box>
      <Box padding={{ horizontal: "l", top: "s", bottom: "m" }}>
        <PromptInput
          value={message}
          onChange={({ detail }) => setMessage(detail.value)}
          onAction={handleSendMessage}
          disabled={isResponding || connectionStatus === "reconnecting"}
          placeholder="Ask a question"
          actionButtonIconName="send"
          i18nStrings={{ actionButtonAriaLabel: "Send message" }}
          ariaLabel="Chat message input"
          minRows={2}
          maxRows={8}
          secondaryActions={composerControls}
        />
      </Box>
    </Box>
  );
};

/** Distance from the bottom, in pixels, still considered "following along". */
const SCROLL_FOLLOW_THRESHOLD_PX = 80;

const getMaxScrollTop = (container: Element): number =>
  Math.max(0, container.scrollHeight - container.clientHeight);

/**
 * True when the scroll container is scrolled to (or near) the bottom. Returns
 * true when the container does not overflow, so short conversations follow.
 */
const isNearBottom = (container: Element): boolean => {
  const distanceFromBottom = getMaxScrollTop(container) - container.scrollTop;
  return distanceFromBottom <= SCROLL_FOLLOW_THRESHOLD_PX;
};

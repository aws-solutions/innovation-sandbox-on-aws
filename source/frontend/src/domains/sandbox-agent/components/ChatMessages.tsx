// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import Avatar from "@cloudscape-design/chat-components/avatar";
import ChatBubble from "@cloudscape-design/chat-components/chat-bubble";
import {
  Alert,
  Box,
  Button,
  ButtonGroup,
  LiveRegion,
  SpaceBetween,
} from "@cloudscape-design/components";
import { DateTime } from "luxon";
import { useEffect, useReducer, useState } from "react";

import { TimePopover } from "@amzn/innovation-sandbox-frontend/components/TimePopover";
import {
  getMarkdownSegments,
  MarkdownContent,
  type MarkdownSegment,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/MarkdownContent";
import { AGENT_ERROR_HEADERS } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/error-headers";
import { getChatMessageAnchorIdentity } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import type {
  ChatRenderableMessage,
  ErrorDisplayMessage,
  HistoryDisplayMessage,
  StreamingDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

export const COPY_RESPONSE_TEXT = "Copy";
export const COPY_RESPONSE_SUCCESS_TEXT = "Response copied";
export const COPY_RESPONSE_ERROR_TEXT = "Response failed to copy";

const ARTIFACT_LOADING_DELAY_MS = 1000;
const RELATIVE_TIME_REFRESH_MS = 60_000;
const ERROR_FALLBACK = "The agent could not process your message. Try again.";

export type ChatMessagesProps = {
  messages: ChatRenderableMessage[];
  assistantName: string;
  isResponding: boolean;
  connectionStatus?: "connecting" | "connected" | "reconnecting";
  onReconnect?: () => void;
  onRetry?: (message: ErrorDisplayMessage) => void;
  latestMessageElementId?: string;
};

const isUser = (
  message: ChatRenderableMessage,
): message is HistoryDisplayMessage =>
  message.kind === "history" && message.role === "user";

export const ChatMessages = ({
  messages,
  assistantName,
  isResponding,
  connectionStatus = "connected",
  onReconnect,
  onRetry,
  latestMessageElementId,
}: ChatMessagesProps) => {
  const latestMessage = messages.at(-1);
  const announcement = getAnnouncement(latestMessage);
  const hasStreamingResponse =
    latestMessage?.kind === "streaming" && !latestMessage.isComplete;
  // One list-wide tick keeps relative times current, not a timer per message.
  const [, refreshRelativeTimes] = useReducer((tick: number) => tick + 1, 0);

  useEffect(() => {
    const interval = setInterval(
      refreshRelativeTimes,
      RELATIVE_TIME_REFRESH_MS,
    );
    return () => clearInterval(interval);
  }, []);

  return (
    <>
      <section aria-label="Chat">
        <SpaceBetween size="xs">
          {connectionStatus === "reconnecting" && (
            <Alert
              action={
                onReconnect ? (
                  <Button onClick={onReconnect}>Reconnect</Button>
                ) : undefined
              }
              header="Connection interrupted"
              type="warning"
            >
              Reconnecting your Sandbox Space.
            </Alert>
          )}

          {messages.map((message, index) => {
            const messageIdentity = getChatMessageAnchorIdentity(message);
            return (
              <Box
                key={messageIdentity}
                nativeAttributes={{
                  id:
                    index === messages.length - 1
                      ? latestMessageElementId
                      : undefined,
                  "data-chat-message-identity": messageIdentity,
                }}
              >
                <MessageRow
                  assistantName={assistantName}
                  index={index}
                  message={message}
                  onRetry={onRetry}
                />
              </Box>
            );
          })}

          {isResponding && !hasStreamingResponse && (
            <ChatBubble
              type="incoming"
              ariaLabel={`${assistantName} is generating a response`}
              avatar={
                <Avatar
                  loading
                  color="gen-ai"
                  iconName="gen-ai"
                  ariaLabel={assistantName}
                  tooltipText={assistantName}
                />
              }
            >
              <Box color="text-status-inactive">Generating a response</Box>
            </ChatBubble>
          )}
        </SpaceBetween>
      </section>

      {announcement && <LiveRegion hidden>{announcement}</LiveRegion>}
    </>
  );
};

const MessageRow = ({
  message,
  assistantName,
  index,
  onRetry,
}: {
  message: ChatRenderableMessage;
  assistantName: string;
  index: number;
  onRetry?: (message: ErrorDisplayMessage) => void;
}) => {
  const position = index + 1;

  if (isUser(message)) {
    // History stores one time per turn (when the reply ends), so user messages show none.
    return (
      <ChatBubble
        type="outgoing"
        ariaLabel={`You, message ${position}`}
        avatar={<Avatar ariaLabel="You" tooltipText="You" />}
      >
        <Box>{message.content}</Box>
      </ChatBubble>
    );
  }

  if (message.kind === "error") {
    return (
      <Box
        nativeAttributes={{
          role: "group",
          "aria-label": `${assistantName} error, message ${position}`,
        }}
      >
        <Box display="inline-block">
          <Alert
            action={
              message.retryable && onRetry ? (
                <Button onClick={() => onRetry(message)}>Try again</Button>
              ) : undefined
            }
            header={AGENT_ERROR_HEADERS[message.code ?? "UNKNOWN_ERROR"]}
            type="error"
          >
            {message.message ?? ERROR_FALLBACK}
          </Alert>
        </Box>
      </Box>
    );
  }

  return (
    <SegmentedAssistantMessage
      assistantName={assistantName}
      message={message}
      position={position}
    />
  );
};

const SegmentedAssistantMessage = ({
  assistantName,
  message,
  position,
}: {
  assistantName: string;
  message: HistoryDisplayMessage | StreamingDisplayMessage;
  position: number;
}) => {
  const segments = getMarkdownSegments(message.content);
  const isStreaming = message.kind === "streaming" && !message.isComplete;
  const responseLabel = getResponseLabel(assistantName, message, position);
  const copyAction = isCopyableResponse(message) ? (
    <ButtonGroup
      variant="icon"
      ariaLabel={`${responseLabel} actions`}
      items={[
        {
          type: "icon-copy-to-clipboard",
          id: "copy",
          text: COPY_RESPONSE_TEXT,
          textToCopy: message.content,
          copySuccessText: COPY_RESPONSE_SUCCESS_TEXT,
          copyErrorText: COPY_RESPONSE_ERROR_TEXT,
        },
      ]}
    />
  ) : undefined;
  const hasIncompleteArtifact =
    isStreaming && segments.some((segment) => segment.kind !== "text");
  const [showArtifactLoading, setShowArtifactLoading] = useState(false);

  useEffect(() => {
    if (!hasIncompleteArtifact) {
      setShowArtifactLoading(false);
      return;
    }

    const timeout = setTimeout(
      () => setShowArtifactLoading(true),
      ARTIFACT_LOADING_DELAY_MS,
    );
    return () => clearTimeout(timeout);
  }, [hasIncompleteArtifact]);

  return (
    <SpaceBetween size="xs">
      {segments.map((segment, index) => {
        const isArtifact = segment.kind !== "text";
        const isPendingArtifact = hasIncompleteArtifact && isArtifact;
        const isFirstBubble = index === 0;
        if (isPendingArtifact && !showArtifactLoading) {
          return null;
        }

        return (
          <ChatBubble
            key={`${segment.kind}-${index}`}
            ariaLabel={`${responseLabel}, part ${index + 1}`}
            // Every part gets the avatar so ChatBubble reserves its column; later
            // parts hide it (keeping the space) so they line up with the first.
            avatar={
              <AssistantAvatar
                assistantName={assistantName}
                loading={isFirstBubble && isStreaming}
              />
            }
            hideAvatar={!isFirstBubble}
            // Actions render below the content, so the copy action ends the response.
            actions={index === segments.length - 1 ? copyAction : undefined}
            showLoadingBar={isPendingArtifact}
            type="incoming"
          >
            <SpaceBetween size="xxs">
              {isFirstBubble && message.createdAt && (
                <MessageTime createdAt={message.createdAt} />
              )}
              <ResponsePartContent
                isPendingArtifact={isPendingArtifact}
                segment={segment}
              />
            </SpaceBetween>
          </ChatBubble>
        );
      })}
    </SpaceBetween>
  );
};

const ResponsePartContent = ({
  isPendingArtifact,
  segment,
}: {
  isPendingArtifact: boolean;
  segment: MarkdownSegment;
}) =>
  isPendingArtifact ? (
    <Box color="text-status-inactive">
      Generating {segment.kind === "code" ? "code" : "table"}
    </Box>
  ) : (
    <MarkdownContent content={segment.content} />
  );

const MessageTime = ({
  createdAt,
}: {
  createdAt: HistoryDisplayMessage["createdAt"];
}) => (
  <Box color="text-body-secondary" fontSize="body-s">
    <TimePopover time={createdAt} />
  </Box>
);

// An unparseable time shows as stored, not as luxon's "Invalid DateTime".
const formatTime = (createdAt: HistoryDisplayMessage["createdAt"]) => {
  const parsed = DateTime.fromISO(createdAt);
  return parsed.isValid
    ? parsed.toLocaleString(DateTime.TIME_SIMPLE)
    : createdAt;
};

const isCopyableResponse = (
  message: HistoryDisplayMessage | StreamingDisplayMessage,
): boolean => message.kind === "history" || message.isComplete;

// A response still streaming has no time yet and keeps the label without one.
const getResponseLabel = (
  assistantName: string,
  message: HistoryDisplayMessage | StreamingDisplayMessage,
  position: number,
): string =>
  message.createdAt
    ? `${assistantName} at ${formatTime(message.createdAt)}, response ${position}`
    : `${assistantName} response ${position}`;

const AssistantAvatar = ({
  assistantName,
  loading = false,
}: {
  assistantName: string;
  loading?: boolean;
}) => (
  <Avatar
    color="gen-ai"
    iconName="gen-ai"
    loading={loading}
    ariaLabel={assistantName}
    tooltipText={assistantName}
  />
);

const getAnnouncement = (
  message: ChatRenderableMessage | undefined,
): string | undefined => {
  if (!message) {
    return undefined;
  }
  if (message.kind === "error") {
    return message.message ?? "The agent reported an error.";
  }
  if (message.kind === "streaming" && message.isComplete) {
    return message.content;
  }
  return undefined;
};

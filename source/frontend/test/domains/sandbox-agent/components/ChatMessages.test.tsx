// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createChatWrapper from "@cloudscape-design/chat-components/test-utils/dom";
import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ChatMessages,
  COPY_RESPONSE_ERROR_TEXT,
  COPY_RESPONSE_SUCCESS_TEXT,
  COPY_RESPONSE_TEXT,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/ChatMessages";
import type {
  ErrorDisplayMessage,
  HistoryDisplayMessage,
  StreamingDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import { formatRelativeTime } from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

const userMessage: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-1:0",
  role: "user",
  content: "Create a bucket",
  createdAt: "2026-09-09T00:00:00.000Z",
};

const assistantMessage: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-1:1",
  role: "assistant",
  content: "I can help with that.",
  createdAt: "2026-09-09T00:01:00.000Z",
};

const completedStreamingMessage: StreamingDisplayMessage = {
  kind: "streaming",
  messageId: "turn-1",
  role: "assistant",
  content: "The bucket was created.",
  isComplete: true,
};

const incompleteStreamingMessage: StreamingDisplayMessage = {
  ...completedStreamingMessage,
  isComplete: false,
};

// A live response as the hook leaves it once the complete frame arrives.
const finishedLiveResponse: StreamingDisplayMessage = {
  ...completedStreamingMessage,
  createdAt: "2026-09-09T00:03:00.000Z",
};

const multiPartResponse: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-2:1",
  role: "assistant",
  content:
    "Use `npm run build`.\n\n```typescript\nconst answer = 42;\n```\n\n| Service | Status |\n| --- | --- |\n| S3 | Ready |",
  createdAt: "2026-09-09T00:02:00.000Z",
};

const followUpMessage: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-3:0",
  role: "user",
  content: "List my buckets",
  createdAt: "2026-09-09T00:02:30.000Z",
};

const interruptedError: ErrorDisplayMessage = {
  kind: "error",
  messageId: "turn-1",
  code: "CONNECTION_INTERRUPTED",
  message: "Connection interrupted. Reconnect and try your message.",
  retryable: true,
};

const timeLabel = (createdAt: string) =>
  DateTime.fromISO(createdAt).toLocaleString(DateTime.TIME_SIMPLE);

const chat = () => within(screen.getByRole("region", { name: "Chat" }));

const bubbleWith = (text: string) =>
  chat().getByText(text).closest<HTMLElement>('[role="group"]')!;

const copyButtons = () =>
  chat().queryAllByRole("button", { name: COPY_RESPONSE_TEXT });

describe("ChatMessages", () => {
  it("renders user and assistant message content", () => {
    render(
      <ChatMessages
        messages={[userMessage, assistantMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    const chat = screen.getByRole("region", { name: "Chat" });
    expect(chat.tagName).toBe("SECTION");
    expect(within(chat).getByText("Create a bucket")).toBeVisible();
    expect(within(chat).getByText("I can help with that.")).toBeVisible();
  });

  it("renders an error message as an alert with the provided text", () => {
    const error: ErrorDisplayMessage = {
      kind: "error",
      messageId: "error-1",
      message: "Monthly agent budget exceeded. Contact your administrator.",
    };

    render(
      <ChatMessages
        messages={[userMessage, error]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    expect(chat.getByText("Something went wrong")).toBeVisible();
    expect(
      chat.getByText(
        "Monthly agent budget exceeded. Contact your administrator.",
      ),
    ).toBeVisible();
  });

  it("falls back to safe text when an error carries no message", () => {
    const error: ErrorDisplayMessage = {
      kind: "error",
      messageId: "error-2",
    };

    render(
      <ChatMessages
        messages={[error]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    expect(
      chat.getByText("The agent could not process your message. Try again."),
    ).toBeVisible();
  });

  it("shows reconnect recovery only while the connection is reconnecting", async () => {
    const onReconnect = vi.fn();
    const { rerender } = render(
      <ChatMessages
        messages={[]}
        assistantName="Sandbox agent"
        connectionStatus="reconnecting"
        isResponding={false}
      />,
    );

    expect(screen.getByText("Connection interrupted")).toBeVisible();
    expect(
      screen.queryByRole("button", { name: "Reconnect" }),
    ).not.toBeInTheDocument();

    rerender(
      <ChatMessages
        messages={[]}
        assistantName="Sandbox agent"
        connectionStatus="reconnecting"
        isResponding={false}
        onReconnect={onReconnect}
      />,
    );

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: "Reconnect" }));
    expect(onReconnect).toHaveBeenCalledOnce();
  });

  it("shows the loading bubble only while responding", () => {
    const { rerender } = render(
      <ChatMessages
        messages={[userMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(screen.queryByText("Generating a response")).not.toBeInTheDocument();

    rerender(
      <ChatMessages
        messages={[userMessage]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(screen.getByText("Generating a response")).toBeVisible();
  });
});

describe("LiveRegion announcements", () => {
  it("announces a completed streaming response but not an incomplete chunk", () => {
    const { rerender } = render(
      <ChatMessages
        messages={[incompleteStreamingMessage]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(screen.getAllByText("The bucket was created.")).toHaveLength(1);

    rerender(
      <ChatMessages
        messages={[completedStreamingMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(screen.getAllByText("The bucket was created.")).toHaveLength(2);
  });
});

describe("structured assistant responses", () => {
  it("stacks text, code, and table segments with only the first assistant avatar shown", () => {
    render(
      <ChatMessages
        messages={[multiPartResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(screen.getByText("npm run build").tagName).toBe("CODE");
    expect(screen.getByLabelText("typescript code snippet")).toBeVisible();
    expect(screen.getByRole("table")).toBeVisible();
    // Later parts keep a hidden avatar slot so every part lines up with the
    // first one instead of shifting into the avatar column.
    const bubbles = [1, 2, 3].map((partNumber) =>
      screen.getByRole("group", {
        name: `Sandbox agent at ${timeLabel(multiPartResponse.createdAt)}, response 1, part ${partNumber}`,
      }),
    );
    const avatarSlot = (part: HTMLElement) => {
      let element = within(part).getByLabelText("Sandbox agent");
      while (element.parentElement !== part) {
        element = element.parentElement!;
      }
      return element;
    };
    expect(bubbles.map((bubble) => avatarSlot(bubble).inert)).toEqual([
      false,
      true,
      true,
    ]);
  });

  it("renders a retry action only for retryable structured errors", async () => {
    const user = userEvent.setup();
    const onRetry = vi.fn();
    const retryableError: ErrorDisplayMessage = {
      kind: "error",
      messageId: "error-3",
      code: "RUNTIME_ERROR",
      message: "The agent could not process your message. Try again.",
      retryable: true,
    };

    const { rerender } = render(
      <ChatMessages
        messages={[retryableError]}
        assistantName="Sandbox agent"
        isResponding={false}
        onRetry={onRetry}
      />,
    );

    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(onRetry).toHaveBeenCalledWith(retryableError);

    rerender(
      <ChatMessages
        messages={[{ ...retryableError, retryable: false }]}
        assistantName="Sandbox agent"
        isResponding={false}
        onRetry={onRetry}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("does not offer retry when a retryable error has no recovery callback", () => {
    render(
      <ChatMessages
        messages={[
          {
            kind: "error",
            messageId: "error-4",
            message: "The service is temporarily unavailable.",
            retryable: true,
          },
        ]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });

  it("delays incomplete code artifacts until the loading threshold", () => {
    vi.useFakeTimers();
    const content =
      "Preparing the command.\n\n```typescript\nconst answer = 42;\n```";

    const { rerender } = render(
      <ChatMessages
        messages={[
          {
            kind: "streaming",
            messageId: "turn-3",
            role: "assistant",
            content,
            isComplete: false,
          },
        ]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(screen.getByText("Preparing the command.")).toBeVisible();
    expect(screen.queryByText("Generating code")).not.toBeInTheDocument();
    expect(
      screen.queryByLabelText("typescript code snippet"),
    ).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(999));
    expect(screen.queryByText("Generating code")).not.toBeInTheDocument();

    act(() => vi.advanceTimersByTime(1));
    expect(screen.getByText("Generating code")).toBeVisible();

    rerender(
      <ChatMessages
        messages={[
          {
            kind: "streaming",
            messageId: "turn-3",
            role: "assistant",
            content,
            isComplete: true,
          },
        ]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(screen.queryByText("Generating code")).not.toBeInTheDocument();
    expect(screen.getByLabelText("typescript code snippet")).toBeVisible();

    vi.useRealTimers();
  });
});

describe("message time", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-09T00:05:00.000Z"));
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("shows the time on history responses and finished live responses", () => {
    render(
      <ChatMessages
        messages={[userMessage, assistantMessage, finishedLiveResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      within(bubbleWith("I can help with that.")).getByText(
        formatRelativeTime(assistantMessage.createdAt),
      ),
    ).toBeVisible();
    expect(
      within(bubbleWith("The bucket was created.")).getByText(
        formatRelativeTime(finishedLiveResponse.createdAt!),
      ),
    ).toBeVisible();
  });

  it("shows no time on user messages, whether sent live or loaded from history", () => {
    const liveUserMessage: HistoryDisplayMessage = {
      kind: "history",
      messageId: "event-4:0",
      role: "user",
      content: "Add a lifecycle rule",
      createdAt: "2026-09-09T00:05:00.000Z",
    };
    render(
      <ChatMessages
        messages={[userMessage, assistantMessage, liveUserMessage]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    for (const content of ["Create a bucket", "Add a lifecycle rule"]) {
      expect(createWrapper(bubbleWith(content)).findPopover()).toBeNull();
    }
    expect(
      within(bubbleWith("Create a bucket")).queryByText(
        formatRelativeTime(userMessage.createdAt),
      ),
    ).not.toBeInTheDocument();
  });

  it("shows a response's time once when the response spans several bubbles", () => {
    render(
      <ChatMessages
        messages={[multiPartResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      chat().getAllByText(formatRelativeTime(multiPartResponse.createdAt)),
    ).toHaveLength(1);
  });

  it("shows no time while a response streams and shows it once the response finishes", () => {
    const { rerender } = render(
      <ChatMessages
        messages={[incompleteStreamingMessage]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(
      createWrapper(screen.getByRole("region", { name: "Chat" })).findPopover(),
    ).toBeNull();

    rerender(
      <ChatMessages
        messages={[finishedLiveResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      within(bubbleWith("The bucket was created.")).getByText(
        formatRelativeTime(finishedLiveResponse.createdAt!),
      ),
    ).toBeVisible();
  });

  it("still shows the time on a response ended early by an error", () => {
    render(
      <ChatMessages
        messages={[userMessage, finishedLiveResponse, interruptedError]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      within(bubbleWith("The bucket was created.")).getByText(
        formatRelativeTime(finishedLiveResponse.createdAt!),
      ),
    ).toBeVisible();
  });

  it("shows no time on the generating placeholder or on error bubbles", () => {
    render(
      <ChatMessages
        messages={[userMessage, interruptedError]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(
      createWrapper(
        screen.getByRole("group", {
          name: "Sandbox agent is generating a response",
        }),
      ).findPopover(),
    ).toBeNull();
    expect(
      createWrapper(
        screen.getByRole("group", { name: "Sandbox agent error, message 2" }),
      ).findPopover(),
    ).toBeNull();
  });

  it("refreshes relative times every 60 seconds and leaves no timer after unmount", () => {
    const { unmount } = render(
      <ChatMessages
        messages={[assistantMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      within(bubbleWith("I can help with that.")).getByText("4 minutes ago"),
    ).toBeVisible();

    act(() => vi.advanceTimersByTime(60_000));

    expect(
      within(bubbleWith("I can help with that.")).getByText("5 minutes ago"),
    ).toBeVisible();

    unmount();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("uses one refresh timer for the whole list, not one per message", () => {
    const { rerender } = render(
      <ChatMessages
        messages={[userMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );
    const timerCountForOneMessage = vi.getTimerCount();
    expect(timerCountForOneMessage).toBe(1);

    rerender(
      <ChatMessages
        messages={[
          userMessage,
          assistantMessage,
          multiPartResponse,
          finishedLiveResponse,
          followUpMessage,
        ]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(vi.getTimerCount()).toBe(1);
  });

  it("labels each bubble with its author, position, and the time on replies only", () => {
    render(
      <ChatMessages
        messages={[
          userMessage,
          multiPartResponse,
          followUpMessage,
          finishedLiveResponse,
          interruptedError,
        ]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    const ariaLabels = [
      "You, message 1",
      `Sandbox agent at ${timeLabel(multiPartResponse.createdAt)}, response 2, part 1`,
      `Sandbox agent at ${timeLabel(multiPartResponse.createdAt)}, response 2, part 2`,
      `Sandbox agent at ${timeLabel(multiPartResponse.createdAt)}, response 2, part 3`,
      "You, message 3",
      `Sandbox agent at ${timeLabel(finishedLiveResponse.createdAt!)}, response 4, part 1`,
      "Sandbox agent error, message 5",
      "Sandbox agent is generating a response",
    ];
    for (const ariaLabel of ariaLabels) {
      expect(
        screen.getByRole("group", { name: ariaLabel }),
      ).toBeInTheDocument();
    }
  });

  it("labels a reply with its stored time when the time cannot be parsed", () => {
    const unreadableTimeResponse: HistoryDisplayMessage = {
      kind: "history",
      messageId: "event-5:1",
      role: "assistant",
      content: "The table was created.",
      createdAt: "not-a-time",
    };
    render(
      <ChatMessages
        messages={[unreadableTimeResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(
      screen.getByRole("group", {
        name: "Sandbox agent at not-a-time, response 1, part 1",
      }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("group", { name: /Invalid DateTime/ }),
    ).not.toBeInTheDocument();
  });
});

describe("copy action", () => {
  it("offers one copy action on each finished response and none on user messages", () => {
    render(
      <ChatMessages
        messages={[userMessage, assistantMessage, finishedLiveResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(copyButtons()).toHaveLength(2);
    expect(
      chat()
        .getAllByRole("toolbar")
        .map((toolbar) => toolbar.getAttribute("aria-label")),
    ).toEqual([
      `Sandbox agent at ${timeLabel(assistantMessage.createdAt)}, response 2 actions`,
      `Sandbox agent at ${timeLabel(finishedLiveResponse.createdAt!)}, response 3 actions`,
    ]);
    expect(
      within(bubbleWith("I can help with that.")).getByRole("button", {
        name: COPY_RESPONSE_TEXT,
      }),
    ).toBeVisible();
    expect(
      within(bubbleWith("The bucket was created.")).getByRole("button", {
        name: COPY_RESPONSE_TEXT,
      }),
    ).toBeVisible();
    expect(
      within(bubbleWith("Create a bucket")).queryByRole("button", {
        name: COPY_RESPONSE_TEXT,
      }),
    ).not.toBeInTheDocument();
  });

  it("offers no copy action while a response streams and one once it finishes", () => {
    const { rerender } = render(
      <ChatMessages
        messages={[userMessage, incompleteStreamingMessage]}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(copyButtons()).toHaveLength(0);

    rerender(
      <ChatMessages
        messages={[userMessage, finishedLiveResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(copyButtons()).toHaveLength(1);
  });

  it("offers the copy action on a response ended early by an error", () => {
    render(
      <ChatMessages
        messages={[
          userMessage,
          assistantMessage,
          followUpMessage,
          finishedLiveResponse,
          interruptedError,
        ]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(copyButtons()).toHaveLength(2);
    expect(
      within(bubbleWith("The bucket was created.")).getByRole("button", {
        name: COPY_RESPONSE_TEXT,
      }),
    ).toBeVisible();
  });

  it("offers one copy action for a response that spans several bubbles", () => {
    render(
      <ChatMessages
        messages={[multiPartResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    expect(copyButtons()).toHaveLength(1);
  });

  it("copies the whole response and confirms the copy", async () => {
    const user = userEvent.setup();
    render(
      <ChatMessages
        messages={[multiPartResponse]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    await user.click(chat().getByRole("button", { name: COPY_RESPONSE_TEXT }));

    expect(await navigator.clipboard.readText()).toBe(
      multiPartResponse.content,
    );
    await waitFor(() =>
      expect(
        createWrapper(document.body)
          .findButtonGroup()
          ?.findTooltip()
          ?.getElement(),
      ).toHaveTextContent(COPY_RESPONSE_SUCCESS_TEXT),
    );
  });

  it("tells the user when the copy fails", async () => {
    const user = userEvent.setup();
    const writeText = vi
      .spyOn(navigator.clipboard, "writeText")
      .mockRejectedValue(new Error("Clipboard write denied"));
    render(
      <ChatMessages
        messages={[assistantMessage]}
        assistantName="Sandbox agent"
        isResponding={false}
      />,
    );

    await user.click(chat().getByRole("button", { name: COPY_RESPONSE_TEXT }));

    expect(writeText).toHaveBeenCalledWith(assistantMessage.content);
    await waitFor(() =>
      expect(
        createWrapper(document.body)
          .findButtonGroup()
          ?.findTooltip()
          ?.getElement(),
      ).toHaveTextContent(COPY_RESPONSE_ERROR_TEXT),
    );
    writeText.mockRestore();
  });
});

describe("error alerts", () => {
  const renderError = (error: Partial<ErrorDisplayMessage>) =>
    render(
      <ChatMessages
        messages={[
          userMessage,
          {
            kind: "error",
            messageId: "error-5",
            message: "The model took too long to respond. Try again.",
            ...error,
          },
        ]}
        assistantName="Sandbox agent"
        isResponding={false}
        onRetry={vi.fn()}
      />,
    );

  const alertHeader = () =>
    createWrapper(document.body).findAlert()?.findHeader()?.getElement();

  it.each([
    ["CONTENT_FILTERED", "Content filter stopped the reply"],
    ["INPUT_BLOCKED", "Safety filter blocked the message"],
    ["MODEL_THROTTLED", "Model is busy"],
    ["MODEL_TIMED_OUT", "Model timed out"],
    ["MODEL_SERVICE_UNAVAILABLE", "Model service unavailable"],
    ["MODEL_STREAM_ENDED", "Reply cut off"],
    ["TIME_LIMIT", "Time limit reached"],
    ["TURN_IN_PROGRESS", "Request already in progress"],
    ["CONNECTION_INTERRUPTED", "Connection interrupted"],
    ["LEASE_NOT_ACTIVE", "Sandbox Space not active"],
    ["FEATURE_DISABLED", "Sandbox Spaces not available"],
    ["INVALID_REQUEST", "Request can't be processed"],
    ["MESSAGE_TOO_LARGE", "Message too long"],
    ["SESSION_EXPIRED", "Session expired"],
    ["RUNTIME_ERROR", "Something went wrong"],
    ["UNKNOWN_ERROR", "Something went wrong"],
  ] as const)("names the problem in the heading for %s", (code, heading) => {
    renderError({ code });

    expect(alertHeader()).toHaveTextContent(heading);
  });

  it("uses the generic heading when the error has no code", () => {
    renderError({});

    expect(alertHeader()).toHaveTextContent("Something went wrong");
  });

  it("shows the error alert outside a chat bubble", () => {
    renderError({ code: "CONTENT_FILTERED" });

    const alert = createWrapper(document.body).findAlert()!.getElement();
    const bubbles = createChatWrapper(document.body).findAllChatBubbles();
    expect(bubbles).toHaveLength(1);
    expect(bubbles.some((bubble) => bubble.getElement().contains(alert))).toBe(
      false,
    );
  });

  it("wraps the error alert in its own box inside the labelled group", () => {
    renderError({ code: "CONTENT_FILTERED" });

    const group = screen.getByRole("group", {
      name: "Sandbox agent error, message 2",
    });
    const alert = createWrapper(group).findAlert()!.getElement();
    const alertBoxes = createWrapper(group)
      .findAllBoxes()
      .filter((box) => box.getElement().contains(alert));
    expect(alertBoxes).toHaveLength(1);
  });

  it("offers Try again only when the error is retryable", () => {
    const { unmount } = renderError({
      code: "MODEL_TIMED_OUT",
      retryable: true,
    });
    expect(screen.getByRole("button", { name: "Try again" })).toBeVisible();
    unmount();

    renderError({ code: "CONTENT_FILTERED", retryable: false });
    expect(
      screen.queryByRole("button", { name: "Try again" }),
    ).not.toBeInTheDocument();
  });
});

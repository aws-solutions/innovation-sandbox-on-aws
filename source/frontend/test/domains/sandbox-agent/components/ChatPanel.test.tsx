// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { ReactElement } from "react";
import { useLayoutEffect } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { ChatPanel } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/ChatPanel";
import { getChatMessageAnchorIdentity } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import type {
  HistoryDisplayMessage,
  StreamingDisplayMessage,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

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

const appendedUserMessage: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-2:0",
  role: "user",
  content: "Continue with the bucket policy.",
  createdAt: "2026-09-09T00:02:00.000Z",
};

const streamingMessage: StreamingDisplayMessage = {
  kind: "streaming",
  role: "assistant",
  content: "I can",
  messageId: "message-1",
  isComplete: false,
};

const welcome = {
  heading: "Welcome to your Sandbox Space",
  description: "Describe what you want to build.",
  examplePrompts: ["Create an S3 bucket"],
};

let originalScrollIntoView: PropertyDescriptor | undefined;
let scrollIntoView: ReturnType<typeof vi.fn>;

const olderMessage: HistoryDisplayMessage = {
  kind: "history",
  messageId: "event-0:1",
  role: "assistant",
  content: "An earlier answer.",
  createdAt: "2026-09-08T23:59:00.000Z",
};

const EARLIER_HISTORY_ERROR = "Earlier messages couldn't be loaded. Try again.";

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const scrolledAway: ScrollMetrics = {
  scrollTop: 0,
  scrollHeight: 1000,
  clientHeight: 300,
};

const notOverflowing: ScrollMetrics = {
  scrollTop: 0,
  scrollHeight: 300,
  clientHeight: 300,
};

const fixtureHosts: HTMLElement[] = [];

/**
 * jsdom has no layout, so scroll metrics are stubbed. `scrollTop` stays
 * writable so the panel can position the transcript and tests can scroll it.
 */
const stubScrollMetrics = (element: HTMLElement, metrics: ScrollMetrics) => {
  for (const [property, value] of Object.entries(metrics)) {
    Object.defineProperty(element, property, {
      configurable: true,
      writable: property === "scrollTop",
      value,
    });
  }
};

/**
 * Renders into an `overflow-y: auto` host so it is the transcript's scroll
 * container.
 */
const renderInScroller = (
  ui: ReactElement,
  metrics: ScrollMetrics,
  parent: HTMLElement = document.body,
) => {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  parent.appendChild(scroller);
  fixtureHosts.push(scroller);
  stubScrollMetrics(scroller, metrics);

  return { ...render(ui, { container: scroller }), scroller };
};

/** The newest messages are in view: `scrollHeight - clientHeight`. */
const NEWEST_SCROLL_TOP = scrolledAway.scrollHeight - scrolledAway.clientHeight;

describe("ChatPanel", () => {
  beforeEach(() => {
    originalScrollIntoView = Object.getOwnPropertyDescriptor(
      HTMLElement.prototype,
      "scrollIntoView",
    );
    scrollIntoView = vi.fn();
    Object.defineProperty(HTMLElement.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
    fixtureHosts.splice(0).forEach((host) => host.remove());

    if (originalScrollIntoView) {
      Object.defineProperty(
        HTMLElement.prototype,
        "scrollIntoView",
        originalScrollIntoView,
      );
      return;
    }

    Reflect.deleteProperty(HTMLElement.prototype, "scrollIntoView");
  });

  it("renders messages and the message input", () => {
    render(
      <ChatPanel
        messages={[userMessage, assistantMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    const userContent = chat.getByText("Create a bucket");
    expect(userContent).toBeInTheDocument();
    expect(chat.getByText("I can help with that.")).toBeInTheDocument();
    expect(
      userContent.closest<HTMLElement>("[data-chat-message-identity]")?.dataset
        .chatMessageIdentity,
    ).toBe(getChatMessageAnchorIdentity(userMessage));
    expect(
      screen.getByRole("textbox", { name: "Chat message input" }),
    ).toBeInTheDocument();
  });

  it("shows the welcome state when there are no messages", () => {
    render(
      <ChatPanel
        messages={[]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        welcome={welcome}
      />,
    );

    expect(screen.getByText("Welcome to your Sandbox Space")).toBeVisible();
  });

  it("hides the welcome state once a message exists", () => {
    render(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        welcome={welcome}
      />,
    );

    expect(
      screen.queryByText("Welcome to your Sandbox Space"),
    ).not.toBeInTheDocument();
  });

  it("sends a trimmed message and clears the input", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();

    render(
      <ChatPanel
        messages={[]}
        onSendMessage={onSendMessage}
        assistantName="Sandbox agent"
      />,
    );

    const input = screen.getByRole("textbox", { name: "Chat message input" });
    await user.type(input, "  Create a bucket  ");
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).toHaveBeenCalledWith("Create a bucket");
    expect(input).toHaveValue("");
  });

  it("does not send blank or whitespace-only messages", async () => {
    const user = userEvent.setup();
    const onSendMessage = vi.fn();

    render(
      <ChatPanel
        messages={[]}
        onSendMessage={onSendMessage}
        assistantName="Sandbox agent"
      />,
    );

    await user.type(
      screen.getByRole("textbox", { name: "Chat message input" }),
      "   ",
    );
    await user.click(screen.getByRole("button", { name: "Send message" }));

    expect(onSendMessage).not.toHaveBeenCalled();
  });

  it("disables the input while responding", () => {
    render(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        isResponding
      />,
    );

    expect(
      screen.getByRole("textbox", { name: "Chat message input" }),
    ).toBeDisabled();
    expect(screen.getByText("Generating a response")).toBeVisible();
  });

  it("renders composer controls alongside the message input", () => {
    render(
      <ChatPanel
        messages={[]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        composerControls={<div>Model picker slot</div>}
      />,
    );

    expect(screen.getByText("Model picker slot")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Chat message input" }),
    ).toBeInTheDocument();
  });

  it("places composer controls in the same composer as the send action", () => {
    render(
      <ChatPanel
        messages={[]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        composerControls={<button type="button">Model picker slot</button>}
      />,
    );

    const input = screen.getByRole("textbox", { name: "Chat message input" });
    const sendButton = screen.getByRole("button", { name: "Send message" });
    const controls = screen.getByRole("button", { name: "Model picker slot" });

    // The composer is a single bounded card: the prompt, the model trigger, and
    // the send action share the innermost element that already wraps the prompt
    // and its send action, rather than the controls sitting in a separate row
    // above the input.
    let composer: HTMLElement | null = input.parentElement;
    while (composer && !composer.contains(sendButton)) {
      composer = composer.parentElement;
    }

    expect(composer).not.toBeNull();
    expect(composer?.contains(controls)).toBe(true);
  });

  it("pins a header above the message region and the composer", () => {
    render(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
        header={<h1>Data Science (a57dbb39)</h1>}
      />,
    );

    // The header shares the full-height container with the composer, so both
    // stay in view regardless of transcript length (no scrolling page wrapper).
    expect(
      screen.getByRole("heading", { name: "Data Science (a57dbb39)" }),
    ).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Chat message input" }),
    ).toBeInTheDocument();
  });

  it("scrolls to the target when an incoming message is added near the bottom", async () => {
    const { rerender } = render(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    rerender(
      <ChatPanel
        messages={[userMessage, assistantMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "end",
      });
    });
  });

  it("scrolls for a newly appended outgoing message when the reader is scrolled up", async () => {
    const { rerender, scroller } = renderInScroller(
      <ChatPanel
        messages={[userMessage, assistantMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      scrolledAway,
    );
    scroller.scrollTop = 0;

    rerender(
      <ChatPanel
        messages={[userMessage, assistantMessage, appendedUserMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "end",
      });
    });
  });

  it("does not auto-scroll for an incoming message when the reader is scrolled up", async () => {
    const { rerender, scroller } = renderInScroller(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      scrolledAway,
    );
    scroller.scrollTop = 0;

    rerender(
      <ChatPanel
        messages={[userMessage, assistantMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    await Promise.resolve();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("does not auto-scroll when the latest streaming message updates while scrolled up", async () => {
    const { rerender, scroller } = renderInScroller(
      <ChatPanel
        messages={[streamingMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      scrolledAway,
    );
    scroller.scrollTop = 0;

    rerender(
      <ChatPanel
        messages={[{ ...streamingMessage, content: "I can help with that." }]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    await Promise.resolve();
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("scrolls streaming growth immediately without starting an animation", () => {
    const { rerender, scroller } = renderInScroller(
      <ChatPanel
        messages={[streamingMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 },
    );
    scrollIntoView.mockClear();
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1050,
    });

    rerender(
      <ChatPanel
        messages={[{ ...streamingMessage, content: "I can help with that." }]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    expect(scroller.scrollTop).toBe(750);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("keeps following when response growth moves the bottom beyond the threshold", () => {
    const { rerender, scroller } = renderInScroller(
      <ChatPanel
        messages={[streamingMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 },
    );
    scrollIntoView.mockClear();
    Object.defineProperty(scroller, "scrollHeight", {
      configurable: true,
      value: 1200,
    });

    rerender(
      <ChatPanel
        messages={[{ ...streamingMessage, content: "I can help with that." }]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    expect(scroller.scrollTop).toBe(900);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it("continues following delayed parts without repeated smooth animations", () => {
    vi.useFakeTimers();
    let reportResize: (() => void) | undefined;
    let observedElement: Element | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          reportResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe(element: Element) {
          observedElement = element;
        }
        disconnect() {}
      },
    );

    try {
      const { scroller } = renderInScroller(
        <ChatPanel
          messages={[
            {
              ...streamingMessage,
              content:
                "Preparing the command.\n\n```typescript\nconst answer = 42;\n```",
            },
          ]}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
          isResponding
        />,
        { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 },
      );
      expect(
        observedElement?.contains(screen.getByText("Preparing the command.")),
      ).toBe(true);
      scrollIntoView.mockClear();

      act(() => vi.advanceTimersByTime(1000));
      expect(screen.getByText("Generating code")).toBeVisible();
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 1200,
      });
      act(() => reportResize?.());

      expect(scroller.scrollTop).toBe(900);
      expect(scrollIntoView).not.toHaveBeenCalled();

      scroller.scrollTop = 0;
      fireEvent.scroll(scroller);
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 1300,
      });
      act(() => reportResize?.());
      expect(scroller.scrollTop).toBe(0);

      scroller.scrollTop = 1000;
      fireEvent.scroll(scroller);
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 1400,
      });
      act(() => reportResize?.());
      expect(scroller.scrollTop).toBe(1100);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.useRealTimers();
      vi.unstubAllGlobals();
    }
  });

  it("keeps following when a content shrink clamps the scroll position", () => {
    let reportResize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          reportResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );

    try {
      const { scroller } = renderInScroller(
        <ChatPanel
          messages={[streamingMessage]}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
        />,
        { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 },
      );
      scrollIntoView.mockClear();

      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 800,
      });
      scroller.scrollTop = 500;
      fireEvent.scroll(scroller);
      act(() => reportResize?.());
      expect(scroller.scrollTop).toBe(500);

      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 900,
      });
      act(() => reportResize?.());

      expect(scroller.scrollTop).toBe(600);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("keeps following when a viewport growth clamps the scroll position", () => {
    let reportResize: (() => void) | undefined;
    vi.stubGlobal(
      "ResizeObserver",
      class {
        constructor(callback: ResizeObserverCallback) {
          reportResize = () => callback([], this as unknown as ResizeObserver);
        }
        observe() {}
        disconnect() {}
      },
    );

    try {
      const { scroller } = renderInScroller(
        <ChatPanel
          messages={[streamingMessage]}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
        />,
        { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 },
      );
      scrollIntoView.mockClear();

      Object.defineProperty(scroller, "clientHeight", {
        configurable: true,
        value: 400,
      });
      scroller.scrollTop = 600;
      fireEvent.scroll(scroller);
      Object.defineProperty(scroller, "scrollHeight", {
        configurable: true,
        value: 1100,
      });
      act(() => reportResize?.());

      expect(scroller.scrollTop).toBe(700);
      expect(scrollIntoView).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("follows an incoming message while its scroll container does not overflow, even inside a scrolled outer element", async () => {
    const outer = document.createElement("div");
    document.body.appendChild(outer);
    fixtureHosts.push(outer);
    stubScrollMetrics(outer, scrolledAway);

    const { rerender } = renderInScroller(
      <ChatPanel
        messages={[userMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
      notOverflowing,
      outer,
    );

    rerender(
      <ChatPanel
        messages={[userMessage, assistantMessage]}
        onSendMessage={vi.fn()}
        assistantName="Sandbox agent"
      />,
    );

    await waitFor(() => {
      expect(scrollIntoView).toHaveBeenCalledWith({
        behavior: "smooth",
        block: "end",
      });
    });
  });

  describe("initial position", () => {
    const transcript = [userMessage, assistantMessage];
    const panelProps = {
      onSendMessage: vi.fn(),
      assistantName: "Sandbox agent",
    };

    it("opens an overflowing transcript at the newest messages before paint", () => {
      let scrollTopBeforePaint: number | undefined;
      // A parent's layout effect runs after its children's layout effects and
      // before the browser paints, so it observes the pre-paint position.
      const PaintProbe = ({ children }: { children: ReactElement }) => {
        useLayoutEffect(() => {
          scrollTopBeforePaint = fixtureHosts.at(-1)?.scrollTop;
        });
        return children;
      };

      const { scroller } = renderInScroller(
        <PaintProbe>
          <ChatPanel {...panelProps} messages={transcript} />
        </PaintProbe>,
        scrolledAway,
      );

      expect(scrollTopBeforePaint).toBe(NEWEST_SCROLL_TOP);
      expect(scroller.scrollTop).toBe(NEWEST_SCROLL_TOP);
      expect(scrollIntoView).not.toHaveBeenCalled();
    });

    it("leaves a transcript that does not overflow at the top", () => {
      const { scroller } = renderInScroller(
        <ChatPanel {...panelProps} messages={transcript} />,
        notOverflowing,
      );

      expect(scroller.scrollTop).toBe(0);
    });

    it("waits for the first messages when the panel opens with none", () => {
      const { rerender, scroller } = renderInScroller(
        <ChatPanel {...panelProps} messages={[]} />,
        scrolledAway,
      );
      expect(scroller.scrollTop).toBe(0);

      rerender(<ChatPanel {...panelProps} messages={transcript} />);

      expect(scroller.scrollTop).toBe(NEWEST_SCROLL_TOP);
    });

    it("does not return to the newest messages once the reader scrolls away", async () => {
      const props = {
        ...panelProps,
        hasEarlierMessages: true,
        onLoadEarlierMessages: vi.fn(),
      };
      const { rerender, scroller } = renderInScroller(
        <ChatPanel {...props} messages={transcript} />,
        scrolledAway,
      );
      scroller.scrollTop = 50;

      rerender(
        <ChatPanel {...props} messages={[olderMessage, ...transcript]} />,
      );
      rerender(
        <ChatPanel
          {...props}
          messages={[
            olderMessage,
            ...transcript,
            {
              ...assistantMessage,
              messageId: "event-3:1",
              content: "The bucket is ready.",
              createdAt: "2026-09-09T00:03:00.000Z",
            },
          ]}
        />,
      );

      expect(scroller.scrollTop).toBe(50);
      await Promise.resolve();
      expect(scrollIntoView).not.toHaveBeenCalled();
    });
  });

  describe("earlier history", () => {
    const transcript = [userMessage, assistantMessage];

    it("does not offer a Load earlier messages button or idle status", () => {
      render(
        <ChatPanel
          messages={transcript}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
          hasEarlierMessages
          onLoadEarlierMessages={vi.fn()}
        />,
      );

      expect(
        screen.queryByRole("button", { name: "Load earlier messages" }),
      ).not.toBeInTheDocument();
      expect(
        screen.queryByText("Loading earlier messages"),
      ).not.toBeInTheDocument();
    });

    it("requests a page when the sentinel above the transcript is in view", () => {
      const observed: Element[] = [];
      vi.stubGlobal(
        "IntersectionObserver",
        class {
          constructor(
            private readonly callback: IntersectionObserverCallback,
          ) {}
          observe(target: Element) {
            observed.push(target);
            this.callback(
              [{ target, isIntersecting: true } as IntersectionObserverEntry],
              this as unknown as IntersectionObserver,
            );
          }
          disconnect() {}
        },
      );
      const onLoadEarlierMessages = vi.fn();

      try {
        render(
          <ChatPanel
            messages={transcript}
            onSendMessage={vi.fn()}
            assistantName="Sandbox agent"
            hasEarlierMessages
            onLoadEarlierMessages={onLoadEarlierMessages}
          />,
        );
      } finally {
        vi.unstubAllGlobals();
      }

      expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
      expect(observed).toHaveLength(1);
      const [sentinel] = observed;
      expect(sentinel).toBeEmptyDOMElement();
      expect(
        sentinel.compareDocumentPosition(screen.getByText("Create a bucket")) &
          Node.DOCUMENT_POSITION_FOLLOWING,
      ).toBeTruthy();
    });

    it("shows a loading status while an earlier page loads", () => {
      const { container } = render(
        <ChatPanel
          messages={transcript}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
          hasEarlierMessages
          isLoadingEarlierMessages
          onLoadEarlierMessages={vi.fn()}
        />,
      );

      const status = createWrapper(container).findStatusIndicator();
      expect(status?.getElement()).toHaveTextContent(
        "Loading earlier messages",
      );
      expect(screen.getByText("Create a bucket")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Load earlier messages" }),
      ).not.toBeInTheDocument();
    });

    it("keeps the transcript and offers Retry when an earlier page fails", async () => {
      const user = userEvent.setup();
      const onLoadEarlierMessages = vi.fn();

      render(
        <ChatPanel
          messages={transcript}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
          hasEarlierMessages
          isLoadEarlierMessagesError
          onLoadEarlierMessages={onLoadEarlierMessages}
        />,
      );

      expect(screen.getByText(EARLIER_HISTORY_ERROR)).toBeVisible();
      const chat = within(screen.getByRole("region", { name: "Chat" }));
      expect(chat.getByText("Create a bucket")).toBeVisible();
      expect(chat.getByText("I can help with that.")).toBeVisible();
      expect(
        screen.queryByRole("button", { name: "Load earlier messages" }),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: "Retry" }));

      expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
    });

    it("disables Retry while a background history refresh is running", () => {
      const onLoadEarlierMessages = vi.fn();

      render(
        <ChatPanel
          messages={transcript}
          onSendMessage={vi.fn()}
          assistantName="Sandbox agent"
          hasEarlierMessages
          isLoadEarlierMessagesError
          isHistoryFetching
          onLoadEarlierMessages={onLoadEarlierMessages}
        />,
      );

      const retryButton = screen.getByRole("button", { name: "Retry" });
      expect(retryButton).toHaveAttribute("aria-disabled", "true");
      expect(
        screen.getByText(
          "Retry is available when the current history refresh finishes.",
        ),
      ).toBeInTheDocument();
      expect(onLoadEarlierMessages).not.toHaveBeenCalled();
    });

    it("keeps the same transcript elements as earlier-history feedback changes", () => {
      const props = {
        messages: transcript,
        onSendMessage: vi.fn(),
        assistantName: "Sandbox agent",
        hasEarlierMessages: true,
        onLoadEarlierMessages: vi.fn(),
      };
      const { rerender } = render(<ChatPanel {...props} />);
      const renderedMessage = screen.getByText("Create a bucket");

      rerender(<ChatPanel {...props} isLoadingEarlierMessages />);
      expect(screen.getByText("Loading earlier messages")).toBeVisible();
      expect(screen.getByText("Create a bucket")).toBe(renderedMessage);

      rerender(<ChatPanel {...props} isLoadEarlierMessagesError />);
      expect(screen.getByText(EARLIER_HISTORY_ERROR)).toBeVisible();
      expect(
        screen.queryByText("Loading earlier messages"),
      ).not.toBeInTheDocument();
      expect(screen.getByText("Create a bucket")).toBe(renderedMessage);

      rerender(<ChatPanel {...props} hasEarlierMessages={false} />);
      expect(screen.queryByText(EARLIER_HISTORY_ERROR)).not.toBeInTheDocument();
      expect(screen.getByText("Create a bucket")).toBe(renderedMessage);
    });

    it("preserves live response state when history is prepended", () => {
      vi.useFakeTimers();
      const liveResponse: StreamingDisplayMessage = {
        ...streamingMessage,
        content:
          "Preparing the command.\n\n```typescript\nconst answer = 42;\n```",
      };
      const props = {
        onSendMessage: vi.fn(),
        assistantName: "Sandbox agent",
        isResponding: true,
      };

      try {
        const { rerender } = render(
          <ChatPanel {...props} messages={[liveResponse]} />,
        );
        act(() => vi.advanceTimersByTime(1000));
        const loadingIndicator = screen.getByText("Generating code");

        rerender(
          <ChatPanel
            {...props}
            messages={[olderMessage, userMessage, liveResponse]}
          />,
        );

        expect(screen.getByText("Generating code")).toBe(loadingIndicator);
      } finally {
        vi.useRealTimers();
      }
    });

    it("does not scroll to the bottom when older messages are prepended", () => {
      let observeCount = 0;
      vi.stubGlobal(
        "ResizeObserver",
        class {
          constructor(private readonly callback: ResizeObserverCallback) {}
          observe() {
            observeCount += 1;
            this.callback([], this as unknown as ResizeObserver);
          }
          disconnect() {}
        },
      );
      const props = {
        onSendMessage: vi.fn(),
        assistantName: "Sandbox agent",
        hasEarlierMessages: true,
        onLoadEarlierMessages: vi.fn(),
      };

      try {
        const { rerender } = render(
          <ChatPanel {...props} messages={transcript} />,
        );
        const existingMessage = screen.getByText("I can help with that.");
        const initialObserveCount = observeCount;
        expect(initialObserveCount).toBeGreaterThan(0);
        scrollIntoView.mockClear();

        rerender(
          <ChatPanel {...props} messages={[olderMessage, ...transcript]} />,
        );

        expect(screen.getByText("An earlier answer.")).toBeVisible();
        expect(screen.getByText("I can help with that.")).toBe(existingMessage);
        expect(observeCount).toBe(initialObserveCount);
        expect(scrollIntoView).not.toHaveBeenCalled();
      } finally {
        vi.unstubAllGlobals();
      }
    });
  });
});

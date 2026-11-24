// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, fireEvent, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode, useCallback } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getChatMessageAnchorIdentity } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import { useAgentHistory } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/hooks";
import type { AgentHistoryService } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/service";
import type { AgentHistoryResponse } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import {
  useEarlierMessagesLoader,
  type UseEarlierMessagesLoaderOptions,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/useEarlierMessagesLoader";

const SENTINEL_ID = "transcript-start";

/**
 * Controlled IntersectionObserver. Like the browser, observe() queues a report
 * of the target's current intersection (set with `sentinelVisible`), delivered
 * after the render commits by `flushObservations`.
 */
class MockIntersectionObserver {
  static instances: MockIntersectionObserver[] = [];
  static pending: Array<() => void> = [];

  readonly targets = new Set<Element>();
  disconnected = false;

  constructor(
    private readonly callback: IntersectionObserverCallback,
    readonly options: IntersectionObserverInit = {},
  ) {
    MockIntersectionObserver.instances.push(this);
  }

  observe(target: Element) {
    this.targets.add(target);
    MockIntersectionObserver.pending.push(() => {
      if (this.targets.has(target)) {
        this.report(target, sentinelVisible);
      }
    });
  }

  unobserve(target: Element) {
    this.targets.delete(target);
  }

  disconnect() {
    this.targets.clear();
    this.disconnected = true;
  }

  takeRecords(): IntersectionObserverEntry[] {
    return [];
  }

  report(target: Element, isIntersecting: boolean) {
    const entry = { target, isIntersecting } as IntersectionObserverEntry;
    this.callback([entry], this as unknown as IntersectionObserver);
  }
}

let sentinelVisible = false;

const flushObservations = () =>
  act(() => {
    MockIntersectionObserver.pending.splice(0).forEach((report) => report());
  });

const activeObservers = () =>
  MockIntersectionObserver.instances.filter(
    (observer) => !observer.disconnected,
  );

/** Moves the sentinel into or out of view for every active observer. */
const setSentinelVisible = (visible: boolean) => {
  sentinelVisible = visible;
  act(() => {
    for (const observer of activeObservers()) {
      observer.targets.forEach((target) => observer.report(target, visible));
    }
  });
};

type ScrollMetrics = {
  scrollTop: number;
  scrollHeight: number;
  clientHeight: number;
};

const scrollers: HTMLElement[] = [];

/**
 * An `overflow-y: auto` scroller containing the sentinel. jsdom has no layout,
 * so the scroll metrics are stubbed.
 */
const createScroller = (metrics: ScrollMetrics) => {
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  const sentinel = document.createElement("div");
  sentinel.id = SENTINEL_ID;
  scroller.appendChild(sentinel);
  document.body.appendChild(scroller);
  scrollers.push(scroller);

  let scrollHeight = metrics.scrollHeight;
  Object.defineProperty(scroller, "scrollTop", {
    configurable: true,
    writable: true,
    value: metrics.scrollTop,
  });
  Object.defineProperty(scroller, "scrollHeight", {
    configurable: true,
    get: () => scrollHeight,
  });
  Object.defineProperty(scroller, "clientHeight", {
    configurable: true,
    value: metrics.clientHeight,
  });

  return {
    scroller,
    sentinel,
    scrollTo: (scrollTop: number) => {
      scroller.scrollTop = scrollTop;
      fireEvent.scroll(scroller);
    },
    setScrollHeight: (value: number) => {
      scrollHeight = value;
    },
  };
};

const renderLoader = (
  overrides: Partial<UseEarlierMessagesLoaderOptions> = {},
  metrics: ScrollMetrics = atTop,
) => {
  const fixture = createScroller(metrics);
  const onLoadEarlierMessages = vi.fn();
  const initialProps: UseEarlierMessagesLoaderOptions = {
    sentinelId: SENTINEL_ID,
    oldestMessageIdentity: "message-1",
    hasEarlierMessages: true,
    isLoadingEarlierMessages: false,
    isLoadEarlierMessagesError: false,
    isHistoryFetching: false,
    onLoadEarlierMessages,
    ...overrides,
  };
  const hook = renderHook(
    (props: UseEarlierMessagesLoaderOptions) => useEarlierMessagesLoader(props),
    { initialProps },
  );
  flushObservations();

  return {
    ...fixture,
    ...hook,
    onLoadEarlierMessages,
    rerenderWith: (changes: Partial<UseEarlierMessagesLoaderOptions>) => {
      hook.rerender({ ...initialProps, ...changes });
      flushObservations();
    },
  };
};

const atTop = { scrollTop: 0, scrollHeight: 1000, clientHeight: 300 };
const notOverflowing = { scrollTop: 0, scrollHeight: 300, clientHeight: 300 };
/** Where the transcript owner positions an overflowing transcript on open. */
const atNewest = { scrollTop: 700, scrollHeight: 1000, clientHeight: 300 };

describe("useEarlierMessagesLoader", () => {
  let originalIntersectionObserver: PropertyDescriptor | undefined;

  beforeEach(() => {
    sentinelVisible = false;
    MockIntersectionObserver.instances = [];
    MockIntersectionObserver.pending = [];
    originalIntersectionObserver = Object.getOwnPropertyDescriptor(
      globalThis,
      "IntersectionObserver",
    );
    Object.defineProperty(globalThis, "IntersectionObserver", {
      configurable: true,
      writable: true,
      value: MockIntersectionObserver,
    });
  });

  afterEach(() => {
    scrollers.splice(0).forEach((scroller) => scroller.remove());
    if (originalIntersectionObserver) {
      Object.defineProperty(
        globalThis,
        "IntersectionObserver",
        originalIntersectionObserver,
      );
    } else {
      Reflect.deleteProperty(globalThis, "IntersectionObserver");
    }
  });

  it("observes the sentinel within the transcript scroller with an 80px top margin", () => {
    const { scroller, sentinel } = renderLoader();

    const [observer] = activeObservers();
    expect(observer.options).toEqual({
      root: scroller,
      rootMargin: "80px 0px 0px 0px",
    });
    expect([...observer.targets]).toEqual([sentinel]);
  });

  it("uses the viewport as the root when the document is the scroller", () => {
    const sentinel = document.createElement("div");
    sentinel.id = SENTINEL_ID;
    document.body.appendChild(sentinel);
    scrollers.push(sentinel);

    renderHook(() =>
      useEarlierMessagesLoader({
        sentinelId: SENTINEL_ID,
        oldestMessageIdentity: "message-1",
        hasEarlierMessages: true,
        isLoadingEarlierMessages: false,
        isLoadEarlierMessagesError: false,
        isHistoryFetching: false,
        onLoadEarlierMessages: vi.fn(),
      }),
    );

    expect(activeObservers()[0].options.root).toBeNull();
  });

  it("restores a document-scroller anchor using viewport coordinates", () => {
    const documentScroller = document.documentElement;
    const originalDescriptors = new Map(
      ["scrollTop", "scrollHeight", "clientHeight"].map((property) => [
        property,
        Object.getOwnPropertyDescriptor(documentScroller, property),
      ]),
    );
    const host = document.createElement("div");
    const sentinel = document.createElement("div");
    sentinel.id = SENTINEL_ID;
    const anchor = document.createElement("div");
    anchor.dataset.chatMessageIdentity = "event-1:0";
    host.append(sentinel, anchor);
    document.body.appendChild(host);
    scrollers.push(host);
    let scrollHeight = 1000;
    let anchorTop = 120;
    Object.defineProperty(documentScroller, "scrollTop", {
      configurable: true,
      writable: true,
      value: 40,
    });
    Object.defineProperty(documentScroller, "scrollHeight", {
      configurable: true,
      get: () => scrollHeight,
    });
    Object.defineProperty(documentScroller, "clientHeight", {
      configurable: true,
      value: 300,
    });
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => ({ top: anchorTop }) as DOMRect,
    );
    const containerRect = vi.spyOn(documentScroller, "getBoundingClientRect");
    const onLoadEarlierMessages = vi.fn();
    const initialProps: UseEarlierMessagesLoaderOptions = {
      sentinelId: SENTINEL_ID,
      oldestMessageIdentity: "event-1:0",
      hasEarlierMessages: true,
      isLoadingEarlierMessages: false,
      isLoadEarlierMessagesError: false,
      isHistoryFetching: false,
      onLoadEarlierMessages,
    };

    try {
      const { result, rerender } = renderHook(
        (props: UseEarlierMessagesLoaderOptions) =>
          useEarlierMessagesLoader(props),
        { initialProps },
      );
      act(() => result.current.requestEarlierMessages());
      scrollHeight = 1900;
      anchorTop = 720;
      rerender({ ...initialProps, oldestMessageIdentity: "event-0:0" });

      expect(documentScroller.scrollTop).toBe(640);
      expect(containerRect).not.toHaveBeenCalled();
    } finally {
      containerRect.mockRestore();
      for (const [property, descriptor] of originalDescriptors) {
        if (descriptor) {
          Object.defineProperty(documentScroller, property, descriptor);
        } else {
          Reflect.deleteProperty(documentScroller, property);
        }
      }
    }
  });

  it("finds the exact anchor among similar message identities", () => {
    const messageIdentity = "event-1:0";
    const {
      scroller,
      sentinel,
      result,
      scrollTo,
      setScrollHeight,
      rerenderWith,
    } = renderLoader({ oldestMessageIdentity: messageIdentity });
    const decoy = document.createElement("div");
    decoy.dataset.chatMessageIdentity = "event-1:00";
    const anchor = document.createElement("div");
    anchor.dataset.chatMessageIdentity = messageIdentity;
    sentinel.after(decoy, anchor);
    let anchorTop = 120;
    vi.spyOn(scroller, "getBoundingClientRect").mockReturnValue({
      top: 100,
    } as DOMRect);
    vi.spyOn(decoy, "getBoundingClientRect").mockReturnValue({
      top: 400,
    } as DOMRect);
    vi.spyOn(anchor, "getBoundingClientRect").mockImplementation(
      () => ({ top: anchorTop }) as DOMRect,
    );

    scrollTo(40);
    act(() => result.current.requestEarlierMessages());
    setScrollHeight(1900);
    anchorTop = 720;
    rerenderWith({ oldestMessageIdentity: "earlier-event:0" });

    // The height fallback would produce 940, and selecting the decoy would
    // leave 40. The exact anchor moved 600px, so the restored position is 640.
    expect(scroller.scrollTop).toBe(640);
  });

  it("requests a page when the sentinel is visible on the first render and the transcript does not overflow", () => {
    sentinelVisible = true;

    const { scroller, onLoadEarlierMessages } = renderLoader(
      {},
      notOverflowing,
    );

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(0);
  });

  it("does not request a page while an overflowing transcript at its newest messages hides the sentinel", () => {
    const { scroller, onLoadEarlierMessages } = renderLoader({}, atNewest);

    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
    expect(scroller.scrollTop).toBe(atNewest.scrollTop);
  });

  it("requests a page once the reader scrolls an overflowing transcript to its top", () => {
    const { scrollTo, onLoadEarlierMessages } = renderLoader({}, atNewest);

    scrollTo(0);
    setSentinelVisible(true);

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("requests a page for any visible sentinel without moving the scroll position", () => {
    sentinelVisible = true;

    const { scroller, onLoadEarlierMessages } = renderLoader();

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
    expect(scroller.scrollTop).toBe(0);
  });

  it("does not request a page while the sentinel is out of view", () => {
    const { onLoadEarlierMessages } = renderLoader();

    setSentinelVisible(false);

    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
  });

  it("requests a page when the reader brings the sentinel into view", () => {
    const { onLoadEarlierMessages } = renderLoader();

    setSentinelVisible(true);

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps requesting pages while the transcript still does not overflow", () => {
    sentinelVisible = true;
    const { rerenderWith, setScrollHeight, onLoadEarlierMessages } =
      renderLoader({}, notOverflowing);

    rerenderWith({ isLoadingEarlierMessages: true });
    setScrollHeight(300);
    rerenderWith({ oldestMessageIdentity: "message-0" });

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(2);
  });

  it("stops requesting once a page pushes the sentinel out of view", () => {
    sentinelVisible = true;
    const { rerenderWith, setScrollHeight, onLoadEarlierMessages } =
      renderLoader({}, notOverflowing);

    rerenderWith({ isLoadingEarlierMessages: true });
    setScrollHeight(1000);
    sentinelVisible = false;
    rerenderWith({ oldestMessageIdentity: "message-0" });

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("does not observe while a page is loading, has failed, or none remain", () => {
    sentinelVisible = true;
    const { rerenderWith, onLoadEarlierMessages } = renderLoader({
      isLoadingEarlierMessages: true,
    });
    setSentinelVisible(true);

    rerenderWith({ isLoadEarlierMessagesError: true });
    setSentinelVisible(true);

    rerenderWith({ hasEarlierMessages: false });
    setSentinelVisible(true);

    expect(activeObservers()).toHaveLength(0);
    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
  });

  it("sends one request until the loading state arrives, however many triggers fire", () => {
    const { result, onLoadEarlierMessages } = renderLoader();

    setSentinelVisible(true);
    setSentinelVisible(false);
    setSentinelVisible(true);
    act(() => result.current.requestEarlierMessages());

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("keeps one request in flight when the observer is recreated before loading starts", () => {
    sentinelVisible = true;
    const { rerenderWith, onLoadEarlierMessages } = renderLoader(
      {},
      notOverflowing,
    );

    rerenderWith({ onLoadEarlierMessages: onLoadEarlierMessages.bind(null) });

    expect(MockIntersectionObserver.instances).toHaveLength(2);
    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("disconnects the observer when loading starts and on unmount", () => {
    const { rerenderWith, unmount } = renderLoader();
    const [first] = activeObservers();

    rerenderWith({ isLoadingEarlierMessages: true });
    expect(first.disconnected).toBe(true);
    expect(activeObservers()).toHaveLength(0);

    rerenderWith({});
    const [second] = activeObservers();
    unmount();
    expect(second.disconnected).toBe(true);
  });

  it("disconnects the observer and ignores requests while any history fetch runs", () => {
    const { rerenderWith, result, onLoadEarlierMessages } = renderLoader();
    const [first] = activeObservers();

    rerenderWith({ isHistoryFetching: true });
    setSentinelVisible(true);
    act(() => result.current.requestEarlierMessages());

    expect(first.disconnected).toBe(true);
    expect(activeObservers()).toHaveLength(0);
    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
  });

  it("records no scroll snapshot while history fetches, so later requests are not blocked", () => {
    const {
      scroller,
      result,
      setScrollHeight,
      rerenderWith,
      onLoadEarlierMessages,
    } = renderLoader({ isHistoryFetching: true }, atNewest);

    act(() => result.current.requestEarlierMessages());
    setScrollHeight(1600);
    rerenderWith({
      isHistoryFetching: true,
      oldestMessageIdentity: "message-0",
    });
    expect(scroller.scrollTop).toBe(atNewest.scrollTop);
    expect(onLoadEarlierMessages).not.toHaveBeenCalled();

    rerenderWith({
      isHistoryFetching: false,
      oldestMessageIdentity: "message-0",
    });
    act(() => result.current.requestEarlierMessages());

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("requests a visible page once a background history fetch ends", () => {
    sentinelVisible = true;
    const { rerenderWith, onLoadEarlierMessages } = renderLoader({
      isHistoryFetching: true,
    });
    expect(MockIntersectionObserver.instances).toHaveLength(0);

    rerenderWith({ isHistoryFetching: false });

    expect(activeObservers()).toHaveLength(1);
    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);
  });

  it("does not retry automatically after a failed page, but Retry requests again", () => {
    sentinelVisible = true;
    const { rerenderWith, result, onLoadEarlierMessages } = renderLoader(
      {},
      notOverflowing,
    );

    rerenderWith({ isLoadingEarlierMessages: true });
    rerenderWith({ isLoadEarlierMessagesError: true });
    setSentinelVisible(true);
    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(1);

    act(() => result.current.requestEarlierMessages());
    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(2);
  });

  it("allows another request once no earlier page remains", () => {
    const { rerenderWith, result, onLoadEarlierMessages } = renderLoader();

    setSentinelVisible(true);
    rerenderWith({ hasEarlierMessages: false });
    rerenderWith({});
    act(() => result.current.requestEarlierMessages());

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(2);
  });

  it("shifts the scroll position by the height of the prepended page", () => {
    const { scroller, scrollTo, setScrollHeight, rerenderWith } =
      renderLoader();

    scrollTo(40);
    setSentinelVisible(true);
    rerenderWith({ isLoadingEarlierMessages: true });
    setScrollHeight(1600);
    rerenderWith({ oldestMessageIdentity: "message-0" });

    expect(scroller.scrollTop).toBe(640);
  });

  it("excludes live response growth while restoring a prepended history page", () => {
    const { scroller, scrollTo, setScrollHeight, rerenderWith, sentinel } =
      renderLoader();
    const visibleMessage = document.createElement("div");
    visibleMessage.dataset.chatMessageIdentity = "message-1";
    sentinel.after(visibleMessage);
    let containerTop = 100;
    let visibleMessageTop = 120;
    vi.spyOn(scroller, "getBoundingClientRect").mockImplementation(
      () => ({ top: containerTop }) as DOMRect,
    );
    vi.spyOn(visibleMessage, "getBoundingClientRect").mockImplementation(
      () => ({ top: visibleMessageTop }) as DOMRect,
    );

    scrollTo(40);
    setSentinelVisible(true);
    rerenderWith({ isLoadingEarlierMessages: true });

    // This growth is below the visible message and must not be attributed to
    // the history page that will be inserted above it.
    setScrollHeight(1300);

    // The history page contributes 600px above the visible message. Moving the
    // outer container must not be mistaken for movement inside the transcript.
    setScrollHeight(1900);
    containerTop = 50;
    visibleMessageTop = 670;
    rerenderWith({ oldestMessageIdentity: "message-0" });

    expect(scroller.scrollTop).toBe(640);
  });

  it("measures each auto-filled page from the position restored after the previous one", () => {
    sentinelVisible = true;
    const { scroller, setScrollHeight, rerenderWith, onLoadEarlierMessages } =
      renderLoader({}, notOverflowing);

    rerenderWith({ isLoadingEarlierMessages: true });
    setScrollHeight(400);
    rerenderWith({ oldestMessageIdentity: "message-0" });
    expect(scroller.scrollTop).toBe(100);

    sentinelVisible = false;
    rerenderWith({
      oldestMessageIdentity: "message-0",
      isLoadingEarlierMessages: true,
    });
    setScrollHeight(600);
    rerenderWith({ oldestMessageIdentity: "message-minus-1" });

    expect(onLoadEarlierMessages).toHaveBeenCalledTimes(2);
    expect(scroller.scrollTop).toBe(300);
  });

  it("restores relative to where the reader scrolled while the page loaded", () => {
    const { scroller, scrollTo, setScrollHeight, rerenderWith } =
      renderLoader();

    scrollTo(40);
    setSentinelVisible(true);
    rerenderWith({ isLoadingEarlierMessages: true });
    scrollTo(100);
    setScrollHeight(1600);
    rerenderWith({ oldestMessageIdentity: "message-0" });

    expect(scroller.scrollTop).toBe(700);
  });

  it("does nothing when IntersectionObserver is unavailable", () => {
    Reflect.deleteProperty(globalThis, "IntersectionObserver");

    const { onLoadEarlierMessages } = renderLoader();

    expect(onLoadEarlierMessages).not.toHaveBeenCalled();
  });

  describe("with useAgentHistory", () => {
    const firstPage: AgentHistoryResponse = {
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
    };
    const earlierPage: AgentHistoryResponse = {
      messages: [
        {
          messageId: "event-1:0",
          role: "user",
          content: "Earlier request",
          createdAt: "2026-09-09T00:00:00.000Z",
        },
      ],
    };

    const useHistoryWithLoader = (service: AgentHistoryService) => {
      const history = useAgentHistory({
        leaseId: "lease-a",
        userId: "user-a",
        service,
      });
      const { loadEarlierMessages } = history;
      const onLoadEarlierMessages = useCallback(() => {
        void loadEarlierMessages({ cancelRefetch: false });
      }, [loadEarlierMessages]);
      const oldestMessage = history.messages[0];
      const loader = useEarlierMessagesLoader({
        sentinelId: SENTINEL_ID,
        oldestMessageIdentity: oldestMessage
          ? getChatMessageAnchorIdentity(oldestMessage)
          : undefined,
        hasEarlierMessages: history.hasNextPage,
        isLoadingEarlierMessages: history.isFetchingNextPage,
        isLoadEarlierMessagesError: history.isFetchNextPageError,
        isHistoryFetching: history.isFetching,
        onLoadEarlierMessages,
      });
      return { history, loader };
    };

    it("requests the next page after a background refresh that blocked loading ends", async () => {
      let resolveRefresh: (page: AgentHistoryResponse) => void = () => {
        throw new Error("Refresh was not started");
      };
      const listHistory = vi
        .fn<AgentHistoryService["listHistory"]>()
        .mockResolvedValueOnce(firstPage)
        .mockReturnValueOnce(
          new Promise((resolve) => {
            resolveRefresh = resolve;
          }),
        )
        .mockResolvedValueOnce(earlierPage);
      const service: AgentHistoryService = {
        listHistory,
        getUsage: vi.fn(),
        listModels: vi.fn(),
        discoverModels: vi.fn(),
        listCatalog: vi.fn(),
        putCatalogEntry: vi.fn(),
      };
      const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
      });
      const wrapper = ({ children }: { children: ReactNode }) =>
        createElement(QueryClientProvider, { client }, children);
      createScroller(atNewest);

      const { result } = renderHook(() => useHistoryWithLoader(service), {
        wrapper,
      });
      await waitFor(() => {
        expect(result.current.history.hasNextPage).toBe(true);
        expect(result.current.history.isFetching).toBe(false);
      });

      act(() => {
        void result.current.history.refetch();
      });
      await waitFor(() => expect(result.current.history.isFetching).toBe(true));
      expect(result.current.history.isFetchingNextPage).toBe(false);

      setSentinelVisible(true);
      act(() => result.current.loader.requestEarlierMessages());
      expect(activeObservers()).toHaveLength(0);
      expect(listHistory).toHaveBeenCalledTimes(2);
      expect(listHistory).toHaveBeenLastCalledWith(
        "lease-a",
        undefined,
        undefined,
      );

      await act(async () => resolveRefresh(firstPage));
      await waitFor(() =>
        expect(result.current.history.isFetching).toBe(false),
      );
      expect(activeObservers()).toHaveLength(1);

      flushObservations();

      await waitFor(() => expect(listHistory).toHaveBeenCalledTimes(3));
      expect(listHistory).toHaveBeenLastCalledWith(
        "lease-a",
        "earlier-page",
        undefined,
      );
      await waitFor(() =>
        expect(
          result.current.history.messages.map((message) => message.content),
        ).toEqual(["Earlier request", "Current request", "Latest response"]),
      );
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { useCallback, useEffect, useLayoutEffect, useRef } from "react";

import {
  findScrollContainer,
  isDocumentScroller,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";

/** Starts loading when the top sentinel is within 80px of the visible area. */
const LOAD_EARLIER_ROOT_MARGIN = "80px 0px 0px 0px";
const MESSAGE_ANCHOR_SELECTOR = "[data-chat-message-identity]";

type ScrollSnapshot = {
  scrollHeight: number;
  scrollTop: number;
  oldestMessageIdentity: string | undefined;
  anchorOffset: number | undefined;
};

const getMessageAnchorOffset = (
  container: Element,
  messageIdentity: string | undefined,
): number | undefined => {
  if (!messageIdentity) {
    return undefined;
  }
  const anchor = Array.from(
    container.querySelectorAll<HTMLElement>(MESSAGE_ANCHOR_SELECTOR),
  ).find((element) => element.dataset.chatMessageIdentity === messageIdentity);
  if (!anchor) {
    return undefined;
  }

  const containerTop = isDocumentScroller(container)
    ? 0
    : container.getBoundingClientRect().top;
  return anchor.getBoundingClientRect().top - containerTop;
};

export type UseEarlierMessagesLoaderOptions = {
  /** Id of a zero-content element rendered above the oldest message. */
  sentinelId: string;
  oldestMessageIdentity: string | undefined;
  hasEarlierMessages: boolean;
  isLoadingEarlierMessages: boolean;
  isLoadEarlierMessagesError: boolean;
  /** Blocks pagination while another history request is active. */
  isHistoryFetching: boolean;
  onLoadEarlierMessages?: () => void;
};

/**
 * Requests earlier transcript pages while the top sentinel is near the visible
 * area, and keeps the reader's place once a page is prepended.
 */
export function useEarlierMessagesLoader({
  sentinelId,
  oldestMessageIdentity,
  hasEarlierMessages,
  isLoadingEarlierMessages,
  isLoadEarlierMessagesError,
  isHistoryFetching,
  onLoadEarlierMessages,
}: UseEarlierMessagesLoaderOptions): { requestEarlierMessages: () => void } {
  const scrollContainer = useRef<Element | null>(null);
  const inFlightSnapshot = useRef<ScrollSnapshot | null>(null);
  const wasLoadingEarlierMessages = useRef(isLoadingEarlierMessages);

  const canAutoLoadEarlierMessages =
    !!onLoadEarlierMessages &&
    hasEarlierMessages &&
    !isLoadingEarlierMessages &&
    !isLoadEarlierMessagesError &&
    !isHistoryFetching;

  const requestEarlierMessages = useCallback(() => {
    if (
      !onLoadEarlierMessages ||
      isHistoryFetching ||
      inFlightSnapshot.current
    ) {
      return;
    }

    const container = scrollContainer.current;
    if (container) {
      inFlightSnapshot.current = {
        scrollHeight: container.scrollHeight,
        scrollTop: container.scrollTop,
        oldestMessageIdentity,
        anchorOffset: getMessageAnchorOffset(container, oldestMessageIdentity),
      };
    }
    onLoadEarlierMessages();
  }, [isHistoryFetching, oldestMessageIdentity, onLoadEarlierMessages]);

  useEffect(() => {
    if (!onLoadEarlierMessages) {
      return;
    }
    const sentinel = document.getElementById(sentinelId);
    if (!sentinel) {
      return;
    }

    const { element, eventTarget } = findScrollContainer(sentinel);
    scrollContainer.current = element;

    // Restoration assigns an absolute position, so it stays correct whether or
    // not the browser's scroll anchoring already shifted the view. That needs
    // the reader's latest position if they scroll while the page loads.
    const trackReaderPosition = () => {
      const snapshot = inFlightSnapshot.current;
      if (snapshot) {
        snapshot.scrollTop = element.scrollTop;
        snapshot.scrollHeight = element.scrollHeight;
        snapshot.anchorOffset = getMessageAnchorOffset(
          element,
          snapshot.oldestMessageIdentity,
        );
      }
    };

    eventTarget.addEventListener("scroll", trackReaderPosition, {
      passive: true,
    });
    return () => {
      eventTarget.removeEventListener("scroll", trackReaderPosition);
    };
  }, [onLoadEarlierMessages, sentinelId]);

  useEffect(() => {
    const Observer = globalThis.IntersectionObserver;
    const container = scrollContainer.current;
    const sentinel = document.getElementById(sentinelId);
    if (
      !canAutoLoadEarlierMessages ||
      typeof Observer !== "function" ||
      !container ||
      !sentinel
    ) {
      return;
    }

    const observer = new Observer(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          requestEarlierMessages();
        }
      },
      {
        root: isDocumentScroller(container) ? null : container,
        rootMargin: LOAD_EARLIER_ROOT_MARGIN,
      },
    );
    // Re-observing after a page allows short transcripts to keep loading.
    observer.observe(sentinel);
    return () => observer.disconnect();
  }, [canAutoLoadEarlierMessages, requestEarlierMessages, sentinelId]);

  useLayoutEffect(() => {
    const wasLoading = wasLoadingEarlierMessages.current;
    wasLoadingEarlierMessages.current = isLoadingEarlierMessages;
    const snapshot = inFlightSnapshot.current;
    const element = scrollContainer.current;
    if (!snapshot) {
      return;
    }

    if (element && oldestMessageIdentity !== snapshot.oldestMessageIdentity) {
      const currentAnchorOffset = getMessageAnchorOffset(
        element,
        snapshot.oldestMessageIdentity,
      );
      if (
        snapshot.anchorOffset !== undefined &&
        currentAnchorOffset !== undefined
      ) {
        // Keep the same message at the same container-relative offset. Growth
        // below the anchor, such as a streaming reply, does not affect it.
        element.scrollTop += currentAnchorOffset - snapshot.anchorOffset;
      } else {
        // Fall back for transcripts rendered without message anchors.
        const addedHeight = element.scrollHeight - snapshot.scrollHeight;
        element.scrollTop = snapshot.scrollTop + addedHeight;
      }
      inFlightSnapshot.current = null;
      return;
    }

    const finishedWithoutPrepending =
      !isLoadingEarlierMessages && (wasLoading || isLoadEarlierMessagesError);
    if (finishedWithoutPrepending || !hasEarlierMessages) {
      inFlightSnapshot.current = null;
    }
  }, [
    hasEarlierMessages,
    isLoadEarlierMessagesError,
    isLoadingEarlierMessages,
    oldestMessageIdentity,
  ]);

  return { requestEarlierMessages };
}

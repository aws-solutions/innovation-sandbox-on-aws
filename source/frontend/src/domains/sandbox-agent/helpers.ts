// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import type { ChatRenderableMessage } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import {
  isActiveLease,
  type Lease,
} from "@amzn/innovation-sandbox-shared/types/lease.js";
import {
  getUserEmail,
  type IsbUser,
  isIdcUser,
} from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

/** The owner or a direct USER assignee; group assignments are not allowed to access. */
export const isSandboxSpaceAssignee = (
  lease: Lease,
  user: IsbUser | undefined,
): boolean =>
  !!user &&
  (lease.userEmail === getUserEmail(user) ||
    (isIdcUser(user) &&
      !!lease.desiredAssignments?.some(
        (a) => a.principalType === "USER" && a.principalId === user.userId,
      )));

export const isSandboxSpaceAvailable = (lease: Lease): boolean =>
  isActiveLease(lease) && !!lease.awsAccountId && lease.sandboxSpacesEnabled;

export const canOpenSandboxSpace = (
  lease: Lease,
  user: IsbUser | undefined,
): boolean =>
  isSandboxSpaceAssignee(lease, user) && isSandboxSpaceAvailable(lease);

/** Route of a lease's Sandbox Space; keep in step with the route in App.tsx. */
export const sandboxSpacePath = (leaseId: string): string =>
  `/leases/${leaseId}/sandbox-spaces`;

export const SANDBOX_SPACE_ASSIGNEE_ONLY_REASON =
  "This action is available for the lease owner and users added to the lease individually, not through a group.";

export const isSandboxSpacesGloballyUsable = (
  sandboxSpacesEnabled: boolean | undefined,
): boolean => sandboxSpacesEnabled === true;

/** Stable identity used for React keys and scroll anchors. */
export const getChatMessageAnchorIdentity = (
  message: ChatRenderableMessage,
): string => {
  return JSON.stringify([message.kind, message.messageId]);
};

/** Changes whenever content affecting the latest rendered message changes. */
export const getChatMessageRenderIdentity = (
  message: ChatRenderableMessage,
): string => {
  if (message.kind === "error") {
    return JSON.stringify([message.kind, message.message ?? "error"]);
  }
  if (message.kind === "streaming") {
    return JSON.stringify([
      message.kind,
      message.role,
      message.content,
      message.isComplete,
    ]);
  }
  return JSON.stringify([
    message.kind,
    message.role,
    message.content,
    message.createdAt,
  ]);
};

const SCROLLABLE_OVERFLOW = new Set(["auto", "scroll", "overlay"]);

export const isDocumentScroller = (element: Element): boolean =>
  element === document.scrollingElement || element === document.documentElement;

export const findScrollContainer = (
  element: HTMLElement,
): { element: Element; eventTarget: EventTarget } => {
  let node: HTMLElement | null = element.parentElement;

  while (node) {
    if (SCROLLABLE_OVERFLOW.has(globalThis.getComputedStyle(node).overflowY)) {
      return { element: node, eventTarget: node };
    }
    node = node.parentElement;
  }

  const documentScroller =
    document.scrollingElement ?? document.documentElement;
  return { element: documentScroller, eventTarget: globalThis };
};

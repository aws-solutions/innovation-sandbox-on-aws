// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  canOpenSandboxSpace,
  getChatMessageAnchorIdentity,
  getChatMessageRenderIdentity,
  isDocumentScroller,
  isSandboxSpaceAssignee,
  isSandboxSpaceAvailable,
  isSandboxSpacesGloballyUsable,
} from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/helpers";
import type { ChatRenderableMessage } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";
import { createActiveLease } from "@amzn/innovation-sandbox-frontend/mocks/factories/leaseFactory";

const owner = {
  type: "user" as const,
  email: "owner@example.com",
  userId: "owner-id",
  roles: ["User" as const],
};

const eligibleLease = createActiveLease({
  awsAccountId: "123456789012",
  sandboxSpacesEnabled: true,
  userEmail: owner.email,
  desiredAssignments: undefined,
});

describe("canOpenSandboxSpace", () => {
  it("allows an active owner lease with an enabled capability snapshot", () => {
    expect(canOpenSandboxSpace(eligibleLease, owner)).toBe(true);
  });

  it.each([
    ["the lease is not active", { status: "Frozen" as const }],
    ["the lease has no account", { awsAccountId: "" }],
    ["the capability snapshot is disabled", { sandboxSpacesEnabled: false }],
  ])("denies access when %s", (_description, overrides) => {
    expect(canOpenSandboxSpace({ ...eligibleLease, ...overrides }, owner)).toBe(
      false,
    );
  });

  it.each([
    ["a Manager owner", ["User", "Manager"] as const],
    ["an Admin owner", ["User", "Admin"] as const],
  ])("allows %s", (_description, roles) => {
    expect(
      canOpenSandboxSpace(eligibleLease, {
        ...owner,
        roles: [...roles],
      }),
    ).toBe(true);
  });

  it("denies a non-owner", () => {
    expect(
      canOpenSandboxSpace(eligibleLease, {
        ...owner,
        email: "other@example.com",
      }),
    ).toBe(false);
  });

  describe("shared leases", () => {
    const assignee = {
      type: "user" as const,
      email: "assignee@example.com",
      userId: "assignee-id",
      roles: ["User" as const],
    };

    const stranger = {
      ...assignee,
      email: "stranger@example.com",
      userId: "stranger-id",
    };

    const sharedLease = {
      ...eligibleLease,
      desiredAssignments: [
        { principalId: owner.userId, principalType: "USER" as const },
        { principalId: assignee.userId, principalType: "USER" as const },
      ],
    };

    const groupSharedLease = {
      ...sharedLease,
      desiredAssignments: [
        ...sharedLease.desiredAssignments,
        { principalId: "group-id", principalType: "GROUP" as const },
      ],
    };

    it("allows a direct USER assignee", () => {
      expect(canOpenSandboxSpace(sharedLease, assignee)).toBe(true);
    });

    it("denies a user who is not in desiredAssignments", () => {
      expect(canOpenSandboxSpace(sharedLease, stranger)).toBe(false);
    });

    it.each(["User", "Admin", "Manager"] as const)(
      "denies a %s who is only in an assigned group",
      (role) => {
        expect(
          canOpenSandboxSpace(groupSharedLease, {
            ...stranger,
            roles: role === "User" ? ["User"] : ["User", role],
          }),
        ).toBe(false);
      },
    );

    it.each(["Admin", "Manager"] as const)(
      "allows a %s who is a direct USER assignee",
      (role) => {
        expect(
          canOpenSandboxSpace(groupSharedLease, {
            ...assignee,
            roles: ["User", role],
          }),
        ).toBe(true);
      },
    );

    it("does not match a GROUP principal against the user id", () => {
      expect(
        canOpenSandboxSpace(sharedLease, { ...assignee, userId: "group-id" }),
      ).toBe(false);
    });

    it.each([
      ["the lease is not active", { status: "Frozen" as const }],
      ["the capability snapshot is disabled", { sandboxSpacesEnabled: false }],
    ])("denies a direct assignee when %s", (_description, overrides) => {
      expect(
        canOpenSandboxSpace({ ...sharedLease, ...overrides }, assignee),
      ).toBe(false);
    });

    it("denies an M2M caller", () => {
      expect(
        canOpenSandboxSpace(groupSharedLease, {
          type: "m2m",
          clientId: "assignee-id",
          roles: ["User"],
        }),
      ).toBe(false);
    });
  });
});

describe("isSandboxSpaceAssignee", () => {
  const stranger = { ...owner, email: "stranger@example.com", userId: "x" };

  it("is true for the owner", () => {
    expect(isSandboxSpaceAssignee(eligibleLease, owner)).toBe(true);
  });

  it("is false for another user and for no user", () => {
    expect(isSandboxSpaceAssignee(eligibleLease, stranger)).toBe(false);
    expect(isSandboxSpaceAssignee(eligibleLease, undefined)).toBe(false);
  });
});

describe("isSandboxSpaceAvailable", () => {
  it("is true for an active lease with an account and an enabled snapshot", () => {
    expect(isSandboxSpaceAvailable(eligibleLease)).toBe(true);
  });

  it.each([
    ["the lease is not active", { status: "Frozen" as const }],
    ["the lease has no account", { awsAccountId: "" }],
    ["the capability snapshot is disabled", { sandboxSpacesEnabled: false }],
  ])("is false when %s", (_description, overrides) => {
    expect(isSandboxSpaceAvailable({ ...eligibleLease, ...overrides })).toBe(
      false,
    );
  });
});

describe("isSandboxSpacesGloballyUsable", () => {
  it("is true when the capability is enabled", () => {
    expect(isSandboxSpacesGloballyUsable(true)).toBe(true);
  });

  it.each([
    ["the capability is disabled", false],
    ["the capability is undefined", undefined],
  ])("is false when %s", (_description, capability) => {
    expect(isSandboxSpacesGloballyUsable(capability)).toBe(false);
  });
});

describe("isDocumentScroller", () => {
  it("identifies both document scrollers but not regular elements", () => {
    const scrollingElement = document.createElement("div");
    const regularElement = document.createElement("div");
    const originalDescriptor = Object.getOwnPropertyDescriptor(
      document,
      "scrollingElement",
    );
    Object.defineProperty(document, "scrollingElement", {
      configurable: true,
      get: () => scrollingElement,
    });

    try {
      expect(isDocumentScroller(document.documentElement)).toBe(true);
      expect(isDocumentScroller(scrollingElement)).toBe(true);
      expect(isDocumentScroller(regularElement)).toBe(false);
    } finally {
      if (originalDescriptor) {
        Object.defineProperty(document, "scrollingElement", originalDescriptor);
      } else {
        Reflect.deleteProperty(document, "scrollingElement");
      }
    }
  });
});

describe("chat message identities", () => {
  const streamingMessage: ChatRenderableMessage = {
    kind: "streaming",
    role: "assistant",
    messageId: "turn-1",
    content: "First part",
    isComplete: false,
  };

  it("keeps the anchor identity stable while streaming content changes", () => {
    expect(
      getChatMessageAnchorIdentity({
        ...streamingMessage,
        content: "First and second parts",
        isComplete: true,
      }),
    ).toBe(getChatMessageAnchorIdentity(streamingMessage));
  });

  it("distinguishes identical history messages by backend message ID", () => {
    const first: ChatRenderableMessage = {
      kind: "history",
      messageId: "event-1:0",
      role: "user",
      content: "Repeated request",
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const second: ChatRenderableMessage = {
      ...first,
      messageId: "event-2:0",
    };

    expect(getChatMessageAnchorIdentity(first)).not.toBe(
      getChatMessageAnchorIdentity(second),
    );
  });

  it("distinguishes a streaming response from its turn error", () => {
    const turnError: ChatRenderableMessage = {
      kind: "error",
      messageId: streamingMessage.messageId,
      code: "CONNECTION_INTERRUPTED",
      message: "Connection interrupted. Reconnect and try your message.",
      retryable: true,
    };

    expect(getChatMessageAnchorIdentity(streamingMessage)).not.toBe(
      getChatMessageAnchorIdentity(turnError),
    );
  });

  it("keeps identities collision-free across message kinds", () => {
    const streaming: ChatRenderableMessage = {
      kind: "streaming",
      messageId: "shared-id",
      role: "assistant",
      content: "Streaming response",
      isComplete: false,
    };
    const history: ChatRenderableMessage = {
      kind: "history",
      messageId: JSON.stringify([streaming.kind, streaming.messageId]),
      role: "assistant",
      content: "History response",
      createdAt: "2026-09-09T00:00:00.000Z",
    };

    expect(getChatMessageAnchorIdentity(history)).not.toBe(
      getChatMessageAnchorIdentity(streaming),
    );
  });

  it("changes the render identity when streaming content changes", () => {
    expect(
      getChatMessageRenderIdentity({
        ...streamingMessage,
        content: "First and second parts",
      }),
    ).not.toBe(getChatMessageRenderIdentity(streamingMessage));
  });

  it("distinguishes history and error message anchors", () => {
    const historyMessage: ChatRenderableMessage = {
      kind: "history",
      messageId: "event-1:0",
      role: "user",
      content: "Create a bucket",
      createdAt: "2026-09-09T00:00:00.000Z",
    };
    const errorMessage: ChatRenderableMessage = {
      kind: "error",
      messageId: "turn-1",
      code: "RUNTIME_ERROR",
      message: "Try again.",
    };

    expect(getChatMessageAnchorIdentity(historyMessage)).not.toBe(
      getChatMessageAnchorIdentity(errorMessage),
    );
    expect(getChatMessageRenderIdentity(historyMessage)).not.toBe(
      getChatMessageRenderIdentity(errorMessage),
    );
  });
});

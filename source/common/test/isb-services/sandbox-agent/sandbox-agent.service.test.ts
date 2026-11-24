// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { describe, expect, it } from "vitest";

import {
  mapMemoryEventsToHistoryMessages,
  mapMemoryEventsToMessages,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import type {
  Event as AgentCoreEvent,
  PayloadType,
} from "@aws-sdk/client-bedrock-agentcore";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeEvent(payloads: AgentCoreEvent["payload"]): AgentCoreEvent {
  return {
    memoryId: "MEM1",
    actorId: "alice-at-example-d-com",
    sessionId: "session-1",
    eventId: "evt-1",
    eventTimestamp: new Date("2026-06-25T10:00:00Z"),
    payload: payloads,
  };
}

function conversationalPayload(role: "USER" | "ASSISTANT", text: string) {
  return {
    conversational: {
      role,
      content: { text },
    },
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────────

describe("mapMemoryEventsToHistoryMessages", () => {
  it("derives stable IDs from the event and original payload index", () => {
    const event = makeEvent([
      { blob: { type: "turn-start" } } as unknown as PayloadType,
      conversationalPayload("USER", "question"),
      conversationalPayload("ASSISTANT", "answer"),
    ]);

    expect(mapMemoryEventsToHistoryMessages([event])).toEqual([
      {
        messageId: "evt-1:1",
        role: "user",
        content: "question",
        createdAt: new Date("2026-06-25T10:00:00Z"),
      },
      {
        messageId: "evt-1:2",
        role: "assistant",
        content: "answer",
        createdAt: new Date("2026-06-25T10:00:00Z"),
      },
    ]);
  });

  it("skips events without an ID or timestamp", () => {
    const valid = makeEvent([conversationalPayload("USER", "kept")]);
    const missingId = { ...valid, eventId: undefined };
    const missingTimestamp = { ...valid, eventTimestamp: undefined };

    expect(
      mapMemoryEventsToHistoryMessages([missingId, missingTimestamp, valid]),
    ).toEqual([
      {
        messageId: "evt-1:0",
        role: "user",
        content: "kept",
        createdAt: new Date("2026-06-25T10:00:00Z"),
      },
    ]);
  });
});

describe("mapMemoryEventsToMessages", () => {
  it("returns empty array for no events", () => {
    expect(mapMemoryEventsToMessages([])).toEqual([]);
  });

  it("maps USER payload to role user", () => {
    const events = [makeEvent([conversationalPayload("USER", "hello")])];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "hello" },
    ]);
  });

  it("maps ASSISTANT payload to role assistant", () => {
    const events = [
      makeEvent([conversationalPayload("ASSISTANT", "hi there")]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "assistant", content: "hi there" },
    ]);
  });

  it("maps multiple payloads in a single event in order", () => {
    const events = [
      makeEvent([
        conversationalPayload("USER", "question"),
        conversationalPayload("ASSISTANT", "answer"),
      ]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "question" },
      { role: "assistant", content: "answer" },
    ]);
  });

  it("maps payloads across multiple events in order", () => {
    const events = [
      makeEvent([conversationalPayload("USER", "first")]),
      makeEvent([conversationalPayload("ASSISTANT", "second")]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "first" },
      { role: "assistant", content: "second" },
    ]);
  });

  it("skips payloads with no conversational field", () => {
    const events = [
      makeEvent([
        { blob: { foo: "bar" } } as unknown as PayloadType,
        conversationalPayload("USER", "kept"),
      ]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "kept" },
    ]);
  });

  it("skips payloads with unknown roles (e.g. TOOL)", () => {
    const events = [
      makeEvent([
        {
          conversational: {
            role: "TOOL" as "USER",
            content: { text: "tool-output" },
          },
        },
        conversationalPayload("ASSISTANT", "response"),
      ]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "assistant", content: "response" },
    ]);
  });

  it("skips payloads with empty or missing content text", () => {
    const events = [
      makeEvent([
        { conversational: { role: "USER" as const, content: { text: "" } } },
        conversationalPayload("ASSISTANT", "non-empty"),
      ]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "assistant", content: "non-empty" },
    ]);
  });

  it("skips payloads with null/undefined content", () => {
    const events = [
      makeEvent([
        { conversational: { role: "USER" as const, content: null as never } },
        conversationalPayload("USER", "valid"),
      ]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "valid" },
    ]);
  });

  it("handles event with empty payload array", () => {
    const events = [
      makeEvent([]),
      makeEvent([conversationalPayload("USER", "hi")]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "user", content: "hi" },
    ]);
  });

  it("handles event with undefined payload", () => {
    const events = [
      makeEvent(undefined),
      makeEvent([conversationalPayload("ASSISTANT", "hello")]),
    ];
    expect(mapMemoryEventsToMessages(events)).toEqual([
      { role: "assistant", content: "hello" },
    ]);
  });
});

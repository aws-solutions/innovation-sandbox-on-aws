// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  dropUnansweredUserMessages,
  messageText,
  startAtFirstUserMessage,
} from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import {
  CitationsBlock,
  Message,
  ReasoningBlock,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@strands-agents/sdk";

describe("messageText", () => {
  it("joins only text blocks, leaving out reasoning, citations and tool blocks", () => {
    const message = new Message({
      role: "assistant",
      content: [
        new ReasoningBlock({ text: "private reasoning" }),
        new TextBlock("first"),
        new CitationsBlock({
          citations: [],
          content: [{ text: "cited text" }],
        }),
        new ToolUseBlock({ name: "cli", toolUseId: "t1", input: {} }),
        new ToolResultBlock({
          toolUseId: "t1",
          status: "success",
          content: [new TextBlock("tool output")],
        }),
        new TextBlock("second"),
      ],
    });

    expect(messageText(message, " ")).toBe("first second");
  });
});

describe("dropUnansweredUserMessages", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (content: string) => ({
    role: "assistant" as const,
    content,
  });

  it("keeps only the user message the assistant answered", () => {
    expect(
      dropUnansweredUserMessages([user("u1"), user("u2"), assistant("a2")]),
    ).toEqual([user("u2"), assistant("a2")]);
  });

  it("removes a trailing run of user messages", () => {
    expect(
      dropUnansweredUserMessages([
        user("u1"),
        assistant("a1"),
        user("u2"),
        user("u3"),
      ]),
    ).toEqual([user("u1"), assistant("a1")]);
  });

  it("keeps a user-role tool result and the user message it follows", () => {
    const messages = [
      new Message({ role: "user", content: [new TextBlock("list buckets")] }),
      new Message({
        role: "assistant",
        content: [
          new ToolUseBlock({ name: "cli", toolUseId: "t1", input: {} }),
        ],
      }),
      new Message({
        role: "user",
        content: [
          new ToolResultBlock({
            toolUseId: "t1",
            status: "success",
            content: [new TextBlock("bucket-a")],
          }),
        ],
      }),
    ];

    expect(dropUnansweredUserMessages(messages)).toEqual(messages);
  });

  it("returns an empty history unchanged", () => {
    expect(dropUnansweredUserMessages([])).toEqual([]);
  });

  it("leaves a history with no unanswered message unchanged", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];

    expect(dropUnansweredUserMessages(messages)).toEqual(messages);
  });
});

describe("startAtFirstUserMessage", () => {
  const user = (content: string) => ({ role: "user" as const, content });
  const assistant = (content: string) => ({
    role: "assistant" as const,
    content,
  });

  it("drops the assistant messages before the first user message", () => {
    expect(
      startAtFirstUserMessage([
        assistant("a0"),
        assistant("a1"),
        user("u2"),
        assistant("a2"),
      ]),
    ).toEqual([user("u2"), assistant("a2")]);
  });

  it("leaves a history that starts with a user message unchanged", () => {
    const messages = [user("u1"), assistant("a1"), user("u2"), assistant("a2")];

    expect(startAtFirstUserMessage(messages)).toEqual(messages);
  });

  it("returns an empty history when no user message remains", () => {
    expect(startAtFirstUserMessage([assistant("a1"), assistant("a2")])).toEqual(
      [],
    );
  });

  it("does not start at a user-role tool result", () => {
    const toolResult = new Message({
      role: "user",
      content: [
        new ToolResultBlock({
          toolUseId: "t1",
          status: "success",
          content: [new TextBlock("bucket-a")],
        }),
      ],
    });
    const question = new Message({
      role: "user",
      content: [new TextBlock("list buckets")],
    });

    expect(startAtFirstUserMessage([toolResult, question])).toEqual([question]);
  });
});

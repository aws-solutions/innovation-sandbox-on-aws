// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Message } from "@strands-agents/sdk";

/** Joins a message's text blocks; reasoning, citations and tool blocks are left out. */
export function messageText(message: Message, separator: string): string {
  return message.content
    .flatMap((block) => (block.type === "textBlock" ? [block.text] : []))
    .join(separator);
}

/** A Strands message, or a memory message whose content is plain text. */
type ConversationMessage = {
  role: Message["role"];
  content: string | Message["content"];
};

export function isToolResultMessage(message: ConversationMessage): boolean {
  return (
    typeof message.content !== "string" &&
    message.content.some((block) => block.type === "toolResultBlock")
  );
}

/**
 * Drops user messages whose next conversational message is another user
 * message or the end of history, so a failed model call is not resent.
 * User-role tool results are kept and skipped when looking for the reply.
 */
export function dropUnansweredUserMessages<T extends ConversationMessage>(
  messages: readonly T[],
): T[] {
  const kept: T[] = [];
  let answered = false;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]!;
    if (message.role === "assistant") {
      answered = true;
      kept.push(message);
    } else if (isToolResultMessage(message)) {
      kept.push(message);
    } else {
      if (answered) kept.push(message);
      answered = false;
    }
  }
  return kept.reverse();
}

/**
 * Drops every message before the first user message that is not a tool
 * result, because Bedrock rejects a conversation that starts any other way.
 */
export function startAtFirstUserMessage<T extends ConversationMessage>(
  messages: readonly T[],
): T[] {
  const start = messages.findIndex(
    (message) => message.role === "user" && !isToolResultMessage(message),
  );
  return start === -1 ? [] : messages.slice(start);
}

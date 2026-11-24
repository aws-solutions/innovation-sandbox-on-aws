// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { messageText } from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import { RuntimeStreamEvent } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  Agent,
  AgentResult,
  ConcurrentInvocationError,
  MaxTokensError,
  type Usage,
} from "@strands-agents/sdk";

/** Shown when a turn ends without a reply the user saw in full. */
export const TURN_FALLBACK_TEXT = {
  maxTokens:
    "That answer was too long to finish in one reply. Ask for a summary, or for one part at a time.",
  limit:
    "I stopped because this request needed more steps than I can take in one reply. Commands I ran before stopping have already taken effect, so check what they changed before you ask me to run them again. Ask me to continue, or split the task into smaller parts.",
  noReply:
    "I couldn't finish a reply to that. Try again, or ask in a different way.",
} as const;

const LIMIT_STOP_REASONS = new Set<string>([
  "limitTurns",
  "limitTotalTokens",
  "limitOutputTokens",
]);

const PARAGRAPH_BREAK = "\n\n";

/** How a turn ended, after all of its chunks were yielded. */
export interface TurnEnding {
  stopReason: string;
  /** Agent-loop cycles in this invocation, not model attempts. */
  cycleCount: number | undefined;
  hasStreamedText: boolean;
  lastCallHasText: boolean;
  toolRan: boolean;
  /** The last model call's text plus any fallback, added to warm history when Strands left it on a user message. */
  replyToUser: string;
  usage: Usage | undefined;
}

/** The fields of a Strands stream event that streamTurn reads. */
interface StrandsStreamEvent {
  type?: string;
  event?: {
    type?: string;
    stopReason?: string;
    delta?: { type?: string; text?: string };
  };
}

export class TurnStreamError extends Error {
  constructor(
    cause: unknown,
    /** The last stop reason a model call reported, if any. */
    readonly modelStopReason: string | undefined,
    readonly cycleCount: number | undefined,
    readonly toolRan: boolean,
  ) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TurnStreamError";
  }
}

/** What the stream's final value or MaxTokensError says about the turn. */
interface StreamEnd {
  stopReason: string;
  unseenText: string;
  replyFromModel: string;
  invocation: Agent["metrics"]["latestAgentInvocation"];
  usage: Usage | undefined;
}

/**
 * Yields a chunk per text delta, then any text the user has not seen and the
 * stop-reason fallback. Returns undefined when Strands' invocation lock is
 * held on the first pull.
 */
export async function* streamTurn(
  stream: AsyncGenerator<unknown, unknown>,
  agent: Pick<Agent, "metrics">,
): AsyncGenerator<RuntimeStreamEvent, TurnEnding | undefined> {
  let hasStreamedText = false;
  // Text streamed by the latest model call; unseenSuffix compares it with that call's full text.
  let streamedCallText = "";
  let lastCallStreamedText = false;
  let modelStopReason: string | undefined;
  let toolRan = false;
  let streamEnd: StreamEnd;
  try {
    let next = await stream.next();
    while (!next.done) {
      const event = next.value as StrandsStreamEvent;
      if (isBeforeModelCall(event)) {
        modelStopReason = undefined;
        lastCallStreamedText = false;
      }
      if (isModelCallStart(event)) streamedCallText = "";
      if (event.type === "toolResultEvent") toolRan = true;
      modelStopReason = stopReasonOf(event) ?? modelStopReason;
      const text = textDelta(event);
      if (text) {
        hasStreamedText = true;
        lastCallStreamedText = true;
        streamedCallText += text;
        yield { type: "chunk", content: text };
      }
      next = await stream.next();
    }
    streamEnd = streamEndFromResult(
      next.value as AgentResult,
      streamedCallText,
    );
  } catch (err) {
    if (err instanceof ConcurrentInvocationError) return undefined;
    if (!(err instanceof MaxTokensError)) {
      throw new TurnStreamError(
        err,
        modelStopReason,
        agent.metrics.latestAgentInvocation?.cycles.length,
        toolRan,
      );
    }
    streamEnd = streamEndFromMaxTokens(err, agent, streamedCallText);
  }

  const hasReplyText =
    hasStreamedText || streamEnd.replyFromModel.trim() !== "";
  const fallback = fallbackText(streamEnd.stopReason, hasReplyText);
  const lastChunkText = lastChunkTextFor(
    streamEnd.unseenText,
    hasStreamedText,
    fallback,
  );
  if (lastChunkText) yield { type: "chunk", content: lastChunkText };

  return {
    stopReason: streamEnd.stopReason,
    cycleCount: streamEnd.invocation?.cycles.length,
    hasStreamedText,
    lastCallHasText:
      lastCallStreamedText || streamEnd.replyFromModel.trim() !== "",
    toolRan,
    replyToUser: [streamEnd.replyFromModel.trim(), fallback]
      .filter(Boolean)
      .join(PARAGRAPH_BREAK),
    usage: streamEnd.usage,
  };
}

/** Strands yields this before every model call, including a retry and a call that fails before its message starts. */
function isBeforeModelCall(event: StrandsStreamEvent): boolean {
  return event.type === "beforeModelCallEvent";
}

function isModelCallStart(event: StrandsStreamEvent): boolean {
  return (
    event.type === "modelStreamUpdateEvent" &&
    event.event?.type === "modelMessageStartEvent"
  );
}

function stopReasonOf(event: StrandsStreamEvent): string | undefined {
  if (event.type !== "modelStreamUpdateEvent") return undefined;
  return event.event?.type === "modelMessageStopEvent"
    ? event.event.stopReason
    : undefined;
}

/** The text delta the event carries, or undefined for any other event. */
function textDelta(event: StrandsStreamEvent): string | undefined {
  if (event.type !== "modelStreamUpdateEvent") return undefined;
  return event.event?.delta?.type === "textDelta"
    ? event.event.delta.text
    : undefined;
}

function streamEndFromResult(
  result: AgentResult,
  streamedCallText: string,
): StreamEnd {
  const finalText =
    result.lastMessage.role === "assistant"
      ? messageText(result.lastMessage, "")
      : "";
  // `latestAgentInvocation` is scoped to just this invocation.
  const invocation = result.metrics?.latestAgentInvocation;
  return {
    stopReason: result.stopReason,
    unseenText: unseenSuffix(finalText, streamedCallText),
    replyFromModel: finalText,
    invocation,
    usage: invocation?.usage,
  };
}

function streamEndFromMaxTokens(
  err: MaxTokensError,
  agent: Pick<Agent, "metrics">,
  streamedCallText: string,
): StreamEnd {
  const partialText = messageText(err.partialMessage, "");
  const invocation = agent.metrics.latestAgentInvocation;
  return {
    stopReason: "maxTokens",
    unseenText: unseenSuffix(partialText, streamedCallText),
    replyFromModel: partialText,
    invocation,
    // Strands throws before it adds this model call's usage to the invocation.
    usage: sumUsage(invocation?.usage, err.partialMessage.metadata?.usage),
  };
}

/** unseenText, then the fallback, with a paragraph break when the user already has text. */
function lastChunkTextFor(
  unseenText: string,
  hasStreamedText: boolean,
  fallback: string | undefined,
): string {
  if (!fallback) return unseenText;
  const userHasText = hasStreamedText || unseenText.trim() !== "";
  return unseenText + (userHasText ? PARAGRAPH_BREAK : "") + fallback;
}

/** The part of replyFromModel that streamedCallText did not already show the user. */
function unseenSuffix(
  replyFromModel: string,
  streamedCallText: string,
): string {
  return replyFromModel.startsWith(streamedCallText)
    ? replyFromModel.slice(streamedCallText.length)
    : replyFromModel;
}

/** Field-by-field sum, matching Strands' `accumulateUsage`, which it does not export. */
function sumUsage(
  invocationUsage: Usage | undefined,
  partialMessageUsage: Usage | undefined,
): Usage | undefined {
  if (!invocationUsage || !partialMessageUsage)
    return invocationUsage ?? partialMessageUsage;
  const sum: Usage = {
    inputTokens: invocationUsage.inputTokens + partialMessageUsage.inputTokens,
    outputTokens:
      invocationUsage.outputTokens + partialMessageUsage.outputTokens,
    totalTokens: invocationUsage.totalTokens + partialMessageUsage.totalTokens,
  };
  if (
    invocationUsage.cacheReadInputTokens !== undefined ||
    partialMessageUsage.cacheReadInputTokens !== undefined
  ) {
    sum.cacheReadInputTokens =
      (invocationUsage.cacheReadInputTokens ?? 0) +
      (partialMessageUsage.cacheReadInputTokens ?? 0);
  }
  if (
    invocationUsage.cacheWriteInputTokens !== undefined ||
    partialMessageUsage.cacheWriteInputTokens !== undefined
  ) {
    sum.cacheWriteInputTokens =
      (invocationUsage.cacheWriteInputTokens ?? 0) +
      (partialMessageUsage.cacheWriteInputTokens ?? 0);
  }
  return sum;
}

function fallbackText(
  stopReason: string,
  hasReplyText: boolean,
): string | undefined {
  if (stopReason === "maxTokens") return TURN_FALLBACK_TEXT.maxTokens;
  if (LIMIT_STOP_REASONS.has(stopReason)) return TURN_FALLBACK_TEXT.limit;
  if (hasReplyText || stopReason === "contentFiltered") return undefined;
  return TURN_FALLBACK_TEXT.noReply;
}

/**
 * Missing usage is reported as absent, never as zero. The Worker then charges
 * a lower-bound input-token estimate, continues the turn, and logs
 * AgentTurnMeteringFailed, which the metering-failure alarm counts.
 */
export function completeFrame(usage: Usage | undefined): RuntimeStreamEvent {
  return {
    type: "complete",
    usage: usage
      ? {
          inputTokens: usage.inputTokens,
          outputTokens: usage.outputTokens,
          cacheReadTokens: usage.cacheReadInputTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteInputTokens ?? 0,
          totalTokens: usage.totalTokens,
        }
      : undefined,
  };
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  streamTurn,
  TURN_FALLBACK_TEXT,
  type TurnEnding,
  TurnStreamError,
} from "@amzn/innovation-sandbox-agent-runtime/turn-stream.js";
import { RuntimeStreamEvent } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  Agent,
  ConcurrentInvocationError,
  MaxTokensError,
  Message,
  type StopReason,
  TextBlock,
  ToolResultBlock,
  type Usage,
} from "@strands-agents/sdk";

const USAGE: Usage = { inputTokens: 12, outputTokens: 5, totalTokens: 17 };

function textDelta(text: string) {
  return {
    type: "modelStreamUpdateEvent",
    event: {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    },
  };
}

const modelMessageStart = {
  type: "modelStreamUpdateEvent",
  event: { type: "modelMessageStartEvent", role: "assistant" },
};

/** Strands yields this before each model call, including a retried one. */
const modelCallStart = { type: "beforeModelCallEvent" };

const toolUseStop = {
  type: "modelStreamUpdateEvent",
  event: { type: "modelMessageStopEvent", stopReason: "toolUse" },
};

function invocation(cycleCount: number, usage: Usage) {
  return {
    cycles: Array.from({ length: cycleCount }, (_, i) => ({
      cycleId: `cycle-${i}`,
      duration: 1,
      usage,
    })),
    usage,
  };
}

function assistant(text: string): Message {
  return new Message({
    role: "assistant",
    content: text ? [new TextBlock(text)] : [],
  });
}

const toolResult = {
  type: "toolResultEvent",
  result: new ToolResultBlock({
    toolUseId: "t1",
    status: "success",
    content: [new TextBlock("tool output")],
  }),
};

const toolResultMessage = new Message({
  role: "user",
  content: [
    new ToolResultBlock({
      toolUseId: "t1",
      status: "success",
      content: [new TextBlock("tool output")],
    }),
  ],
});

/** Yields `events`, then returns the AgentResult Strands builds for a one-cycle turn. */
async function* completedStream(
  events: unknown[],
  stopReason: StopReason,
  lastMessage: Message,
): AsyncGenerator<unknown, unknown> {
  yield* events;
  return {
    stopReason,
    lastMessage,
    metrics: { latestAgentInvocation: invocation(1, USAGE) },
  };
}

async function* throwingStream(
  events: unknown[],
  error: Error,
): AsyncGenerator<unknown, unknown> {
  yield* events;
  throw error;
}

const PRIOR_CYCLE_USAGE: Usage = {
  inputTokens: 100,
  outputTokens: 20,
  totalTokens: 120,
  cacheReadInputTokens: 10,
};

/** Strands' meter after a MaxTokensError: the earlier cycle's usage, none of the cut-off call's. */
const agentAfterMaxTokens: Pick<Agent, "metrics"> = {
  metrics: { latestAgentInvocation: invocation(2, PRIOR_CYCLE_USAGE) },
} as Pick<Agent, "metrics">;

const unusedAgent = {} as Pick<Agent, "metrics">;

async function run(
  stream: AsyncGenerator<unknown, unknown>,
  agent: Pick<Agent, "metrics"> = unusedAgent,
): Promise<{ chunks: string[]; ending: TurnEnding | undefined }> {
  const chunks: string[] = [];
  const turn = streamTurn(stream, agent);
  let step: IteratorResult<RuntimeStreamEvent, TurnEnding | undefined>;
  while (!(step = await turn.next()).done) {
    if (step.value.type === "chunk") chunks.push(step.value.content);
  }
  return { chunks, ending: step.value };
}

describe("streamTurn", () => {
  describe("completed turns", () => {
    it("streams each text delta and adds nothing when the reply streamed", async () => {
      const { chunks, ending } = await run(
        completedStream(
          [textDelta("here are "), textDelta("your buckets")],
          "endTurn",
          assistant("here are your buckets"),
        ),
      );

      expect(chunks).toEqual(["here are ", "your buckets"]);
      expect(ending).toEqual({
        stopReason: "endTurn",
        cycleCount: 1,
        hasStreamedText: true,
        lastCallHasText: true,
        toolRan: false,
        replyToUser: "here are your buckets",
        usage: USAGE,
      });
    });

    it("streams final assistant text that never arrived as deltas", async () => {
      const withheld = "I withheld that tool's output because it was unsafe.";
      const { chunks, ending } = await run(
        completedStream([], "endTurn", assistant(withheld)),
      );

      expect(chunks).toEqual([withheld]);
      expect(ending).toMatchObject({
        hasStreamedText: false,
        replyToUser: withheld,
      });
    });

    it("streams an unstreamed final reply once when an earlier tool-use call streamed text", async () => {
      const { chunks, ending } = await run(
        completedStream(
          [modelMessageStart, textDelta("Let me check.")],
          "endTurn",
          assistant("You have 3 buckets."),
        ),
      );

      expect(chunks).toEqual(["Let me check.", "You have 3 buckets."]);
      expect(ending?.replyToUser).toBe("You have 3 buckets.");
    });

    it("adds nothing when the final model call streamed all of its text", async () => {
      const { chunks } = await run(
        completedStream(
          [
            modelMessageStart,
            textDelta("Let me check."),
            modelMessageStart,
            textDelta("You have "),
            textDelta("3 buckets."),
          ],
          "endTurn",
          assistant("You have 3 buckets."),
        ),
      );

      expect(chunks).toEqual(["Let me check.", "You have ", "3 buckets."]);
    });

    it("sends the no-reply fallback when the turn produced no text", async () => {
      const { chunks, ending } = await run(
        completedStream([], "endTurn", assistant("")),
      );

      expect(chunks).toEqual([TURN_FALLBACK_TEXT.noReply]);
      expect(ending?.replyToUser).toBe(TURN_FALLBACK_TEXT.noReply);
    });

    it.each<StopReason>([
      "limitTurns",
      "limitTotalTokens",
      "limitOutputTokens",
    ])(
      "appends the limit fallback after partial text on %s",
      async (stopReason) => {
        const { chunks, ending } = await run(
          completedStream(
            [textDelta("Checking your buckets.")],
            stopReason,
            toolResultMessage,
          ),
        );

        expect(chunks).toEqual([
          "Checking your buckets.",
          `\n\n${TURN_FALLBACK_TEXT.limit}`,
        ]);
        // The partial text is already in the assistant message Strands kept.
        expect(ending).toMatchObject({
          stopReason,
          replyToUser: TURN_FALLBACK_TEXT.limit,
        });
      },
    );

    it("sends only the limit fallback when nothing streamed", async () => {
      const { chunks } = await run(
        completedStream([], "limitTurns", toolResultMessage),
      );

      expect(chunks).toEqual([TURN_FALLBACK_TEXT.limit]);
    });

    it("sends no chunk when a filtered turn produced no text", async () => {
      const { chunks, ending } = await run(
        completedStream([], "contentFiltered", assistant("")),
      );

      expect(chunks).toEqual([]);
      expect(ending).toMatchObject({
        lastCallHasText: false,
        replyToUser: "",
      });
    });

    it("reports no last-call text when only an earlier model call streamed text", async () => {
      const { chunks, ending } = await run(
        completedStream(
          [
            modelCallStart,
            textDelta("Checking the caller identity."),
            toolUseStop,
            toolResult,
            modelCallStart,
          ],
          "contentFiltered",
          assistant(""),
        ),
      );

      expect(chunks).toEqual(["Checking the caller identity."]);
      expect(ending).toMatchObject({
        hasStreamedText: true,
        lastCallHasText: false,
        toolRan: true,
      });
    });

    it("reports last-call text when the last model call streamed text", async () => {
      const { ending } = await run(
        completedStream(
          [
            modelCallStart,
            textDelta("Checking the caller identity."),
            toolUseStop,
            toolResult,
            modelCallStart,
            textDelta("The account is 222222222222."),
          ],
          "contentFiltered",
          assistant("The account is 222222222222."),
        ),
      );

      expect(ending).toMatchObject({ lastCallHasText: true });
    });

    it("reports whether a tool ran in the turn", async () => {
      const withTool = await run(
        completedStream([toolResult], "endTurn", assistant("Done.")),
      );
      const withoutTool = await run(
        completedStream([], "endTurn", assistant("Done.")),
      );

      expect(withTool.ending?.toolRan).toBe(true);
      expect(withoutTool.ending?.toolRan).toBe(false);
    });

    it("sends no fallback when a filtered turn's reply arrived only in the final message", async () => {
      const { chunks, ending } = await run(
        completedStream(
          [],
          "contentFiltered",
          assistant("Here is part of it."),
        ),
      );

      expect(chunks).toEqual(["Here is part of it."]);
      expect(ending).toMatchObject({
        hasStreamedText: false,
        lastCallHasText: true,
      });
    });
  });

  describe("MaxTokensError", () => {
    it("streams the unseen part of the cut-off reply, then the too-long fallback", async () => {
      const partialMessage = new Message({
        role: "assistant",
        content: [new TextBlock("Here are the first items")],
        metadata: { usage: USAGE },
      });
      const { chunks, ending } = await run(
        throwingStream(
          [
            textDelta("Let me look."),
            modelMessageStart,
            textDelta("Here are the"),
          ],
          new MaxTokensError("max tokens", partialMessage),
        ),
        agentAfterMaxTokens,
      );

      expect(chunks).toEqual([
        "Let me look.",
        "Here are the",
        ` first items\n\n${TURN_FALLBACK_TEXT.maxTokens}`,
      ]);
      expect(ending?.replyToUser).toBe(
        `Here are the first items\n\n${TURN_FALLBACK_TEXT.maxTokens}`,
      );
    });

    it("sends only the too-long fallback when the cut-off reply had no text", async () => {
      const { chunks, ending } = await run(
        throwingStream(
          [],
          new MaxTokensError(
            "max tokens",
            new Message({ role: "assistant", content: [] }),
          ),
        ),
        agentAfterMaxTokens,
      );

      expect(chunks).toEqual([TURN_FALLBACK_TEXT.maxTokens]);
      expect(ending?.replyToUser).toBe(TURN_FALLBACK_TEXT.maxTokens);
    });

    it("adds the cut-off model call's usage, which Strands' meter never recorded, to earlier cycles' usage", async () => {
      const partialMessage = new Message({
        role: "assistant",
        content: [new TextBlock("partial")],
        metadata: {
          usage: { inputTokens: 30, outputTokens: 50, totalTokens: 80 },
        },
      });
      const { ending } = await run(
        throwingStream(
          [textDelta("partial")],
          new MaxTokensError("max tokens", partialMessage),
        ),
        agentAfterMaxTokens,
      );

      expect(ending).toMatchObject({
        stopReason: "maxTokens",
        cycleCount: 2,
        hasStreamedText: true,
        usage: {
          inputTokens: 130,
          outputTokens: 70,
          totalTokens: 200,
          cacheReadInputTokens: 10,
        },
      });
    });
  });

  it("returns undefined when Strands' invocation lock is held", async () => {
    const { chunks, ending } = await run(
      throwingStream([], new ConcurrentInvocationError("busy")),
    );

    expect(chunks).toEqual([]);
    expect(ending).toBeUndefined();
  });

  it("wraps any other model error with the last model stop reason and the cycle count", async () => {
    const cause = new Error("Stream ended");
    const contentFilterStop = {
      type: "modelStreamUpdateEvent",
      event: { type: "modelMessageStopEvent", stopReason: "contentFiltered" },
    };

    const failure = await run(
      throwingStream([textDelta("hi"), contentFilterStop], cause),
      agentAfterMaxTokens,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TurnStreamError);
    expect(failure).toMatchObject({
      cause,
      modelStopReason: "contentFiltered",
      cycleCount: 2,
      toolRan: false,
    });
  });

  it("reports that a tool ran when the stream fails after a tool result", async () => {
    const failure = await run(
      throwingStream(
        [modelCallStart, toolUseStop, toolResult, modelCallStart],
        new Error("Service unavailable."),
      ),
      agentAfterMaxTokens,
    ).catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TurnStreamError);
    expect(failure).toMatchObject({ toolRan: true });
  });

  it.each([
    ["after its message started", [modelCallStart, modelMessageStart]],
    ["before it streamed anything", [modelCallStart]],
  ])(
    "reports no stop reason when a later model call fails %s",
    async (_label, laterCallEvents) => {
      const failure = await run(
        throwingStream(
          [modelCallStart, modelMessageStart, toolUseStop, ...laterCallEvents],
          new Error("Service unavailable."),
        ),
        agentAfterMaxTokens,
      ).catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(TurnStreamError);
      expect(failure).toMatchObject({ modelStopReason: undefined });
    },
  );
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  beforeEach,
  describe,
  expect,
  it,
  type MockInstance,
  vi,
} from "vitest";

import { messageText } from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import {
  HubRegionNotManagedError,
  runAgentTurn,
} from "@amzn/innovation-sandbox-agent-runtime/main.js";
import { TURN_FALLBACK_TEXT } from "@amzn/innovation-sandbox-agent-runtime/turn-stream.js";
import { base64EncodeCompositeKey } from "@amzn/innovation-sandbox-commons/data/encoding.js";
import { RUNTIME_ERROR_CODES } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { BedrockAgentCoreClient } from "@aws-sdk/client-bedrock-agentcore";
import {
  ConcurrentInvocationError,
  MaxTokensError,
  Message,
  ModelError,
  type StopReason,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
  type Usage,
} from "@strands-agents/sdk";

const { buildAgentMock, bedrockAgentCoreMock, screenMock, runCommandMock } =
  vi.hoisted(() => ({
    buildAgentMock: vi.fn(),
    bedrockAgentCoreMock: vi.fn(),
    screenMock: vi.fn(),
    runCommandMock: vi.fn(),
  }));

vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js",
  () => ({ executeSandboxCli: runCommandMock }),
);

vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js",
  () => ({
    screenUserText: screenMock,
  }),
);

vi.mock("@amzn/innovation-sandbox-agent-runtime/agent.js", () => ({
  buildAgent: buildAgentMock,
  DEFAULT_INVOCATION_LIMITS: { turns: 25 },
}));

vi.mock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
  IsbClients: { bedrockAgentCore: bedrockAgentCoreMock },
}));

const { buildAgent: realBuildAgent } = await vi.importActual<
  typeof import("@amzn/innovation-sandbox-agent-runtime/agent.js")
>("@amzn/innovation-sandbox-agent-runtime/agent.js");

const env = {
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::111111111111:role/InnovationSandbox-myisb-IntermediateRole",
  SANDBOX_AGENT_ROLE_NAME: "SandboxAgentRole-myisb",
  HUB_ACCOUNT_ID: "111111111111",
  USER_AGENT_EXTRA: "test-agent",
  LEASE_TABLE_NAME: "isb-leases",
  ACCOUNT_TABLE_NAME: "isb-accounts",
  GUARDRAIL_ID: "gr-1",
  GUARDRAIL_VERSION: "1",
  AWS_REGION: "us-east-1",
} satisfies AgentRuntimeEnvironment;

const services = {} as never;

// A `<leaseUuid>_<userId>` shape: what the Worker passes as AgentCore's
// `runtimeSessionId`, which the service constrains to 33-256 characters. Regenerated per test
// in `beforeEach` so the module-scoped `cachedAgent` in `main.ts` misses
// on every case — otherwise a later test would silently reuse the agent
// from an earlier one and `buildAgent` wouldn't fire.
let LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";

// The owner-keyed lease key the Worker forwards in the payload. The session id is per caller.
const USER_ID = "6468b488-8041-70f5-1a43-d72b09d909aa";
const LEASE_UUID = "550e8400-e29b-41d4-a716-446655440000";
const LEASE_KEY = base64EncodeCompositeKey({
  userEmail: "owner@example.com",
  uuid: LEASE_UUID,
})!;

const payload = {
  leaseKey: LEASE_KEY,
  messages: [{ role: "user", content: "list my buckets" }],
  actorId: "alice-at-example-d-com",
  userId: USER_ID,
  modelId: "model-a",
  accountId: "222222222222",
  regions: ["us-east-1"],
};

/** A text delta in the shape Strands emits. */
function textDelta(text: string) {
  return {
    type: "modelStreamUpdateEvent",
    event: { delta: { type: "textDelta", text } },
  };
}

/**
 * Stands in for `agent.stream()`: yields events, then RETURNS the AgentResult
 * carrying token usage.
 */
const COMPLETE_USAGE = {
  inputTokens: 12,
  outputTokens: 5,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  totalTokens: 17,
};

/** The AgentResult Strands returns for a one-cycle turn ending on `stopReason`. */
function agentResult(
  events: unknown[],
  usage: Usage,
  stopReason: StopReason = "endTurn",
) {
  const text = events
    .map((event) => (event as ReturnType<typeof textDelta>).event?.delta)
    .map((delta) => (delta?.type === "textDelta" ? delta.text : ""))
    .join("");
  return {
    stopReason,
    lastMessage: new Message({
      role: "assistant",
      content: text ? [new TextBlock(text)] : [],
    }),
    metrics: {
      latestAgentInvocation: {
        cycles: [{ cycleId: "cycle-1", duration: 1, usage }],
        usage,
      },
    },
  };
}

/** Strands' usage for {@link COMPLETE_USAGE}. */
const STRANDS_USAGE: Usage = {
  inputTokens: 12,
  outputTokens: 5,
  totalTokens: 17,
};

function fakeStream(events: unknown[], usage: Usage = STRANDS_USAGE) {
  return {
    messages: [] as unknown[],
    // Params declared so assertions can read what main.ts passed through.
    stream: (_messages?: unknown, _options?: unknown) =>
      (async function* () {
        for (const event of events) {
          yield event;
        }
        return agentResult(events, usage);
      })(),
  };
}

async function collect(
  sessionId = LEASE_ID,
  body: unknown = payload,
  envArg: AgentRuntimeEnvironment = env,
) {
  const events = [];
  for await (const event of runAgentTurn(body, sessionId, services, envArg)) {
    events.push(event);
  }
  return events;
}

/**
 * Stands in for the object `buildAgent` returns: adds `messages` (so
 * rehydration can push onto it) and an optional `memoryManager` (so we can
 * assert `flush()` at turn end).
 */
function fakeAgent(
  events: unknown[] = [],
  opts: { memoryManager?: { flush: () => Promise<void> } } = {},
) {
  return {
    messages: [] as unknown[],
    stream: (_messages?: unknown, _options?: unknown) =>
      (async function* () {
        for (const event of events) yield event;
        return agentResult(events, {
          inputTokens: 1,
          outputTokens: 1,
          totalTokens: 2,
        });
      })(),
    memoryManager: opts.memoryManager,
  };
}

describe("runAgentTurn — turn in progress", () => {
  const TURN_IN_PROGRESS_FRAME = {
    error: expect.any(String),
    code: RUNTIME_ERROR_CODES.turnInProgress,
  };

  /** Starts a turn and holds it in input screening until `release` is called. */
  function startTurnHeldInScreening() {
    let release!: () => void;
    screenMock.mockImplementationOnce(
      (text: string) =>
        new Promise((resolve) => {
          release = () => resolve({ blocked: false, text });
        }),
    );
    const turn = runAgentTurn(payload, LEASE_ID, services, env);
    const firstPull = turn.next();
    return {
      async finish() {
        release();
        let step = await firstPull;
        while (!step.done) step = await turn.next();
      },
    };
  }

  beforeEach(() => {
    LEASE_ID = crypto.randomUUID();
    screenMock.mockReset();
    screenMock.mockImplementation(async (text: string) => ({
      blocked: false,
      text,
    }));
    buildAgentMock.mockReset();
    bedrockAgentCoreMock.mockReturnValue({
      send: vi.fn().mockResolvedValue({ events: [] }),
    });
  });

  it("rejects a turn that arrives while the first is still screening, without touching it", async () => {
    buildAgentMock.mockReturnValue(fakeAgent([textDelta("hi")]));
    await collect();
    const toolContext = buildAgentMock.mock.calls[0]![0].context;
    screenMock.mockClear();

    const first = startTurnHeldInScreening();
    // Another model and account would rebuild the agent and rewrite the tool
    // context if this turn got past the check.
    const second = await collect(LEASE_ID, {
      ...payload,
      modelId: "model-b",
      accountId: "999999999999",
    });

    expect(second).toEqual([TURN_IN_PROGRESS_FRAME]);
    expect(screenMock).toHaveBeenCalledOnce();
    expect(buildAgentMock).toHaveBeenCalledOnce();
    expect(toolContext.accountId).toBe(payload.accountId);

    await first.finish();
  });

  it("runs the next turn once the first has finished", async () => {
    buildAgentMock.mockReturnValue(fakeAgent([textDelta("hi")]));
    const first = startTurnHeldInScreening();
    await first.finish();

    expect(await collect()).not.toContainEqual(TURN_IN_PROGRESS_FRAME);
  });

  it("releases the Strands lock when the consumer abandons the turn", async () => {
    // Models Strands: the lock is taken on the first pull and released only in
    // the stream's own finally.
    let locked = false;
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      stream: () =>
        (async function* () {
          if (locked) throw new ConcurrentInvocationError("busy");
          locked = true;
          try {
            yield textDelta("a");
            yield textDelta("b");
            return agentResult([textDelta("ab")], STRANDS_USAGE);
          } finally {
            locked = false;
          }
        })(),
    });

    const turn = runAgentTurn(payload, LEASE_ID, services, env);
    await turn.next();
    expect(locked).toBe(true);
    // What the AgentCore SDK does when the client disconnects.
    await turn.return(undefined);

    expect(locked).toBe(false);
    // The next turn reuses the cached agent and runs instead of being rejected.
    expect(await collect()).not.toContainEqual(TURN_IN_PROGRESS_FRAME);
  });

  it("releases the session when the turn throws", async () => {
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      metrics: { latestAgentInvocation: undefined },
      stream: () =>
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new Error("model exploded");
        })(),
    });

    await expect(collect()).rejects.toThrow("model exploded");
    // A held claim would turn this into a TURN_IN_PROGRESS frame instead.
    await expect(collect()).rejects.toThrow("model exploded");
  });

  it("returns a MODEL_NOT_SUPPORTED frame when Bedrock rejects the model for chat", async () => {
    const bedrockError = Object.assign(
      new Error(
        "This action doesn't support the model that you provided. Try again with a supported text or chat model.",
      ),
      { name: "ValidationException" },
    );
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      metrics: { latestAgentInvocation: undefined },
      stream: () =>
        // eslint-disable-next-line require-yield
        (async function* () {
          // Strands wraps the SDK error; the classifier follows `cause`.
          throw new Error("model call failed", { cause: bedrockError });
        })(),
    });

    expect(await collect()).toEqual([
      { error: bedrockError.message, code: "MODEL_NOT_SUPPORTED" },
    ]);
    // The session is released: the next turn runs instead of TURN_IN_PROGRESS.
    expect(await collect()).not.toContainEqual(TURN_IN_PROGRESS_FRAME);
  });

  it("returns a turn-in-progress frame when Strands rejects the first pull with ConcurrentInvocationError", async () => {
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      stream: () =>
        // eslint-disable-next-line require-yield
        (async function* () {
          throw new ConcurrentInvocationError("busy");
        })(),
    });

    expect(await collect()).toEqual([TURN_IN_PROGRESS_FRAME]);
  });
});

describe("runAgentTurn — failed turns", () => {
  const STREAM_ENDED = "Stream ended without completing a message";
  const CONTENT_FILTER_STOP = {
    type: "modelStreamUpdateEvent",
    event: { type: "modelMessageStopEvent", stopReason: "contentFiltered" },
  };
  const TOOL_RESULT = {
    type: "toolResultEvent",
    result: new ToolResultBlock({
      toolUseId: "tool-1",
      status: "success",
      content: [new TextBlock("[]")],
    }),
  };

  function failingAgent(events: unknown[], error: Error, cycleCount = 1) {
    return {
      messages: [] as unknown[],
      metrics: {
        latestAgentInvocation: {
          cycles: Array.from({ length: cycleCount }, (_, i) => ({
            cycleId: `cycle-${i + 1}`,
          })),
        },
      },
      stream: () =>
        (async function* () {
          for (const event of events) yield event;
          throw error;
        })(),
    };
  }

  function failedTurnLogs(warn: MockInstance<typeof console.warn>) {
    return warn.mock.calls
      .map(([line]) => (typeof line === "string" ? line : ""))
      .filter((line) => line.includes("AgentTurnFailed"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
  }

  beforeEach(() => {
    LEASE_ID = crypto.randomUUID();
    screenMock.mockReset();
    screenMock.mockImplementation(async (text: string) => ({
      blocked: false,
      text,
    }));
    buildAgentMock.mockReset();
  });

  it("returns a MODEL_STREAM_ENDED frame when the stream ends before a message stop", async () => {
    buildAgentMock.mockReturnValue(
      failingAgent([], new ModelError(STREAM_ENDED)),
    );

    expect(await collect()).toEqual([
      { error: STREAM_ENDED, code: RUNTIME_ERROR_CODES.modelStreamEnded },
    ]);
  });

  it("returns a CONTENT_FILTERED frame when the stream ended on a content filter stop", async () => {
    buildAgentMock.mockReturnValue(
      failingAgent([CONTENT_FILTER_STOP], new ModelError(STREAM_ENDED)),
    );

    expect(await collect()).toEqual([
      { error: STREAM_ENDED, code: RUNTIME_ERROR_CODES.contentFiltered },
    ]);
  });

  it("logs the code, model stop reason and cycle count of a failed turn", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildAgentMock.mockReturnValue(
      failingAgent([CONTENT_FILTER_STOP], new ModelError(STREAM_ENDED), 2),
    );

    await collect();

    expect(failedTurnLogs(warn)).toEqual([
      expect.objectContaining({
        message: "AgentTurnFailed",
        code: RUNTIME_ERROR_CODES.contentFiltered,
        stopReason: "contentFiltered",
        cycleCount: 2,
      }),
    ]);
    warn.mockRestore();
  });

  it("logs an unclassified failure before rethrowing it", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildAgentMock.mockReturnValue(
      failingAgent([], new Error("model exploded")),
    );

    await expect(collect()).rejects.toThrow("model exploded");

    expect(failedTurnLogs(warn)).toEqual([
      expect.objectContaining({
        message: "AgentTurnFailed",
        code: "UNCLASSIFIED",
        errorMessage: "model exploded",
        cycleCount: 1,
        toolRan: false,
      }),
    ]);
    warn.mockRestore();
  });

  it("marks the frame when a tool ran before the stream failed", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildAgentMock.mockReturnValue(
      failingAgent([TOOL_RESULT], new ModelError(STREAM_ENDED), 2),
    );

    expect(await collect()).toEqual([
      {
        error: STREAM_ENDED,
        code: RUNTIME_ERROR_CODES.modelStreamEnded,
        toolRan: true,
      },
    ]);
    expect(failedTurnLogs(warn)).toEqual([
      expect.objectContaining({ toolRan: true }),
    ]);
    warn.mockRestore();
  });

  it("sends an unclassified failure after a tool ran as a frame, so the Worker knows a tool ran", async () => {
    buildAgentMock.mockReturnValue(
      failingAgent([TOOL_RESULT], new Error("model exploded"), 2),
    );

    expect(await collect()).toEqual([
      { error: "model exploded", toolRan: true },
    ]);
  });

  it("sends a CONTENT_FILTERED frame, not text and complete, when a turn ends contentFiltered with no text", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      stream: () =>
        (async function* () {
          yield CONTENT_FILTER_STOP;
          return agentResult([], STRANDS_USAGE, "contentFiltered");
        })(),
    });

    expect(await collect()).toEqual([
      {
        error: "The model's content filter stopped the model call.",
        code: RUNTIME_ERROR_CODES.contentFiltered,
      },
    ]);
    expect(failedTurnLogs(warn)).toEqual([
      expect.objectContaining({
        code: RUNTIME_ERROR_CODES.contentFiltered,
        stopReason: "contentFiltered",
        cycleCount: 1,
      }),
    ]);
    warn.mockRestore();
  });

  it("marks the CONTENT_FILTERED frame of a completed turn when a tool ran", async () => {
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      stream: () =>
        (async function* () {
          yield TOOL_RESULT;
          yield CONTENT_FILTER_STOP;
          return agentResult([], STRANDS_USAGE, "contentFiltered");
        })(),
    });

    expect(await collect()).toEqual([
      expect.objectContaining({
        code: RUNTIME_ERROR_CODES.contentFiltered,
        toolRan: true,
      }),
    ]);
  });

  it("does not count a content-filtered turn as failed when its final message reached the user", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    buildAgentMock.mockReturnValue({
      messages: [] as unknown[],
      stream: () =>
        (async function* () {
          yield CONTENT_FILTER_STOP;
          return {
            ...agentResult([], STRANDS_USAGE, "contentFiltered"),
            lastMessage: new Message({
              role: "assistant",
              content: [new TextBlock("Here is part of it.")],
            }),
          };
        })(),
    });

    expect(await collect()).toEqual([
      { type: "chunk", content: "Here is part of it." },
      { type: "complete", usage: COMPLETE_USAGE },
    ]);
    expect(failedTurnLogs(warn)).toEqual([]);
    warn.mockRestore();
  });

  it("saves memory once, before the frame, when a completed turn ends contentFiltered with no text", async () => {
    const order: string[] = [];
    const flush = vi.fn(async () => {
      order.push("flushed");
    });
    const agent = {
      messages: [] as unknown[],
      memoryManager: { flush },
      stream: () =>
        (async function* () {
          yield CONTENT_FILTER_STOP;
          return agentResult([], STRANDS_USAGE, "contentFiltered");
        })(),
    };
    buildAgentMock.mockReturnValue(agent);

    for await (const event of runAgentTurn(payload, LEASE_ID, services, env)) {
      order.push("error" in event ? `frame ${event.code}` : event.type);
    }

    expect(flush).toHaveBeenCalledOnce();
    expect(order).toEqual(["flushed", "frame CONTENT_FILTERED"]);
    expect(agent.messages).toEqual([]);
  });

  describe("with a real agent", () => {
    type ModelCall = () => AsyncGenerator<unknown>;

    const textThenCommand: ModelCall = async function* () {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield { type: "modelContentBlockStartEvent" };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "Checking the caller identity." },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield {
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: "execute_sandbox_cli",
          toolUseId: "tool-1",
        },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: {
          type: "toolUseInputDelta",
          input: JSON.stringify({ args: ["sts", "get-caller-identity"] }),
        },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
    };

    const filteredWithoutText: ModelCall = async function* () {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield { type: "modelMessageStopEvent", stopReason: "contentFiltered" };
    };

    const filteredAfterText: ModelCall = async function* () {
      yield { type: "modelMessageStartEvent", role: "assistant" };
      yield { type: "modelContentBlockStartEvent" };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "The account is 222222222222." },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "contentFiltered" };
    };

    function realAgentWithModelCalls(calls: ModelCall[]) {
      buildAgentMock.mockImplementation(
        (props: Parameters<typeof realBuildAgent>[0]) => {
          const agent = realBuildAgent(props);
          const queue = [...calls];
          vi.spyOn(agent.model, "stream").mockImplementation(() => {
            const next = queue.shift();
            if (!next) throw new Error("unexpected model call");
            return next() as ReturnType<typeof agent.model.stream>;
          });
          return agent;
        },
      );
    }

    beforeEach(() => {
      runCommandMock.mockReset();
      runCommandMock.mockResolvedValue({ status: "success", output: "{}" });
    });

    it("sends a CONTENT_FILTERED frame marked toolRan after the streamed text when the last call is filtered with no text", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      realAgentWithModelCalls([textThenCommand, filteredWithoutText]);

      expect(await collect()).toEqual([
        { type: "chunk", content: "Checking the caller identity." },
        {
          error: "The model's content filter stopped the model call.",
          code: RUNTIME_ERROR_CODES.contentFiltered,
          toolRan: true,
        },
      ]);
      expect(runCommandMock).toHaveBeenCalledOnce();
      expect(failedTurnLogs(warn)).toEqual([
        expect.objectContaining({
          code: RUNTIME_ERROR_CODES.contentFiltered,
          stopReason: "contentFiltered",
          cycleCount: 2,
          toolRan: true,
        }),
      ]);
      warn.mockRestore();
    });

    it("completes normally when the filtered last call streamed text", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      realAgentWithModelCalls([textThenCommand, filteredAfterText]);

      const events = await collect();

      expect(events.slice(0, -1)).toEqual([
        { type: "chunk", content: "Checking the caller identity." },
        { type: "chunk", content: "The account is 222222222222." },
      ]);
      expect(events.at(-1)).toMatchObject({ type: "complete" });
      expect(failedTurnLogs(warn)).toEqual([]);
      warn.mockRestore();
    });
  });
});

describe("runAgentTurn", () => {
  beforeEach(() => {
    // Fresh sessionId per test so main.ts's module-scoped `cachedAgent`
    // misses and rebuilds — see the `LEASE_ID` declaration above.
    LEASE_ID = crypto.randomUUID();
    screenMock.mockReset();
    screenMock.mockImplementation(async (text: string) => ({
      blocked: false,
      text,
    }));
    buildAgentMock.mockReset();
    buildAgentMock.mockReturnValue(
      fakeStream([textDelta("here are "), textDelta("your buckets")]),
    );
  });

  describe("stream events", () => {
    it("emits a chunk per text delta, then a complete with usage", async () => {
      expect(await collect()).toEqual([
        { type: "chunk", content: "here are " },
        { type: "chunk", content: "your buckets" },
        { type: "complete", usage: COMPLETE_USAGE },
      ]);
    });

    it("reports all four token types and the provider total", async () => {
      buildAgentMock.mockReturnValue(
        fakeStream([], {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadInputTokens: 300,
          cacheWriteInputTokens: 50,
          totalTokens: 364,
        }),
      );

      expect(await collect()).toContainEqual({
        type: "complete",
        usage: {
          inputTokens: 10,
          outputTokens: 4,
          cacheReadTokens: 300,
          cacheWriteTokens: 50,
          totalTokens: 364,
        },
      });
    });

    it("sends the no-reply fallback, then complete, when the model produced no text", async () => {
      buildAgentMock.mockReturnValue(fakeStream([]));

      // The Worker relies on `complete` to record usage and close the turn, so
      // it must arrive even for an empty response.
      expect(await collect()).toEqual([
        { type: "chunk", content: TURN_FALLBACK_TEXT.noReply },
        { type: "complete", usage: COMPLETE_USAGE },
      ]);
    });

    it("ignores non-text events such as tool-use deltas", async () => {
      buildAgentMock.mockReturnValue(
        fakeStream([
          { type: "beforeToolCallEvent" },
          {
            type: "modelStreamUpdateEvent",
            event: { delta: { type: "toolUseInputDelta", input: "{}" } },
          },
          textDelta("done"),
        ]),
      );

      const events = await collect();
      expect(events.filter((e) => "type" in e && e.type === "chunk")).toEqual([
        { type: "chunk", content: "done" },
      ]);
    });

    it("omits usage rather than reporting zero when metrics are absent", async () => {
      buildAgentMock.mockReturnValue({
        messages: [],
        stream: () =>
          (async function* () {
            yield textDelta("hi");
            return {
              ...agentResult([textDelta("hi")], STRANDS_USAGE),
              metrics: undefined,
            };
          })(),
      });

      expect(await collect()).toContainEqual({
        type: "complete",
        usage: undefined,
      });
    });
  });

  describe("turn endings", () => {
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

    /**
     * Keeps history the way Strands does: appends the user message, then runs
     * `turn` to append the rest and end the stream.
     */
    function historyAgent(
      turn: (messages: Message[]) => AsyncGenerator<unknown, unknown>,
    ) {
      const messages: Message[] = [];
      return {
        messages,
        stream: (input: { content: { text: string }[] }[]) => {
          messages.push(
            new Message({
              role: "user",
              content: [new TextBlock(input[0]!.content[0]!.text)],
            }),
          );
          return turn(messages);
        },
      };
    }

    async function* endTurn(messages: Message[]) {
      yield textDelta("ok");
      const reply = new Message({
        role: "assistant",
        content: [new TextBlock("ok")],
      });
      messages.push(reply);
      return {
        ...agentResult([textDelta("ok")], STRANDS_USAGE),
        lastMessage: reply,
      };
    }

    function roles(messages: Message[]) {
      return messages.map((message) => message.role);
    }

    it("closes history after a limit stop so the next warm turn alternates", async () => {
      let firstTurn = true;
      const agent = historyAgent(async function* (messages) {
        if (!firstTurn) return yield* endTurn(messages);
        firstTurn = false;
        yield textDelta("Checking.");
        messages.push(
          new Message({
            role: "assistant",
            content: [new TextBlock("Checking.")],
          }),
          toolResult,
        );
        return {
          ...agentResult([], STRANDS_USAGE, "limitTurns"),
          lastMessage: toolResult,
        };
      });
      buildAgentMock.mockReturnValue(agent);

      const first = await collect();
      expect(first).toContainEqual({
        type: "chunk",
        content: `\n\n${TURN_FALLBACK_TEXT.limit}`,
      });
      expect(first.at(-1)).toEqual({ type: "complete", usage: COMPLETE_USAGE });

      await collect();
      expect(roles(agent.messages)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(agent.messages[3]!.content).toEqual([
        new TextBlock(TURN_FALLBACK_TEXT.limit),
      ]);
    });

    it("closes history with the cut-off text after MaxTokensError so the next warm turn alternates", async () => {
      let firstTurn = true;
      const agent = historyAgent(async function* (messages) {
        if (!firstTurn) return yield* endTurn(messages);
        firstTurn = false;
        yield textDelta("Here are");
        throw new MaxTokensError(
          "max tokens",
          new Message({
            role: "assistant",
            content: [new TextBlock("Here are")],
            metadata: { usage: STRANDS_USAGE },
          }),
        );
      });
      buildAgentMock.mockReturnValue({
        ...agent,
        metrics: {
          latestAgentInvocation: {
            cycles: [{ cycleId: "c1", duration: 1, usage: STRANDS_USAGE }],
            usage: { inputTokens: 0, outputTokens: 0, totalTokens: 0 },
          },
        },
      });

      expect(await collect()).toEqual([
        { type: "chunk", content: "Here are" },
        { type: "chunk", content: `\n\n${TURN_FALLBACK_TEXT.maxTokens}` },
        { type: "complete", usage: COMPLETE_USAGE },
      ]);

      await collect();
      expect(roles(agent.messages)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
      expect(agent.messages[1]!.content).toEqual([
        new TextBlock(`Here are\n\n${TURN_FALLBACK_TEXT.maxTokens}`),
      ]);
    });

    it("sends withheld-tool endTurn text once and keeps Strands' assistant as the only reply", async () => {
      const withheld = "I withheld that tool's output because it was unsafe.";
      const agent = historyAgent(async function* (messages) {
        const reply = new Message({
          role: "assistant",
          content: [new TextBlock(withheld)],
        });
        messages.push(reply);
        return { ...agentResult([], STRANDS_USAGE), lastMessage: reply };
      });
      buildAgentMock.mockReturnValue(agent);

      expect(await collect()).toEqual([
        { type: "chunk", content: withheld },
        { type: "complete", usage: COMPLETE_USAGE },
      ]);
      expect(roles(agent.messages)).toEqual(["user", "assistant"]);
    });

    it("sends the context guard's message once, saves memory, then completes", async () => {
      const guardText =
        "I stopped because this request needed more room than this conversation has left. Commands I ran before stopping have already taken effect, so check what they changed before you ask me to run them again. Ask me to continue, or split the task into smaller parts.";
      const agent = historyAgent(async function* (messages) {
        // Strands ends the turn with the guard's text in place of the model call.
        const reply = new Message({
          role: "assistant",
          content: [new TextBlock(guardText)],
        });
        messages.push(
          new Message({
            role: "assistant",
            content: [
              new ToolUseBlock({
                name: "execute_sandbox_cli",
                toolUseId: "t1",
                input: {},
              }),
            ],
          }),
          toolResult,
          reply,
        );
        return { ...agentResult([], STRANDS_USAGE), lastMessage: reply };
      });
      const flush = vi.fn(async () => {});
      buildAgentMock.mockReturnValue({ ...agent, memoryManager: { flush } });

      expect(await collect()).toEqual([
        { type: "chunk", content: guardText },
        { type: "complete", usage: COMPLETE_USAGE },
      ]);
      expect(flush).toHaveBeenCalledOnce();
      expect(roles(agent.messages)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("drops a failed turn's message from the next warm turn and sends the current message once", async () => {
      let firstTurn = true;
      let modelContext: string[] = [];
      const agent = historyAgent(async function* (messages) {
        if (firstTurn) {
          firstTurn = false;
          // What Strands throws after Bedrock blocks the request.
          throw new Error("Stream ended without completing a message");
        }
        modelContext = messages.map((message) => messageText(message, ""));
        return yield* endTurn(messages);
      });
      buildAgentMock.mockReturnValue(agent);

      await expect(
        collect(LEASE_ID, {
          ...payload,
          messages: [{ role: "user", content: "blocked request" }],
        }),
      ).rejects.toThrow();
      await collect();

      expect(modelContext).toEqual(["list my buckets"]);
    });

    it("yields complete only after the memory flush finishes", async () => {
      const order: string[] = [];
      const flush = vi.fn(async () => {
        await new Promise((resolve) => setTimeout(resolve, 0));
        order.push("flushed");
      });
      buildAgentMock.mockReturnValue(
        fakeAgent([textDelta("ok")], { memoryManager: { flush } }),
      );

      for await (const event of runAgentTurn(
        payload,
        LEASE_ID,
        services,
        env,
      )) {
        if ("type" in event && event.type === "complete")
          order.push("complete");
      }

      expect(order).toEqual(["flushed", "complete"]);
    });

    it("logs how the turn ended", async () => {
      const info = vi.spyOn(console, "info").mockImplementation(() => {});

      await collect();

      expect(info).toHaveBeenCalledWith("Agent turn ended", {
        stopReason: "endTurn",
        cycleCount: 1,
        hasStreamedText: true,
      });
      info.mockRestore();
    });
  });

  describe("payload validation", () => {
    it.each([
      ["missing actorId", { ...payload, actorId: undefined }],
      ["missing modelId", { ...payload, modelId: undefined }],
      ["empty messages", { ...payload, messages: [] }],
      ["malformed accountId", { ...payload, accountId: "nope" }],
      ["missing leaseKey", { ...payload, leaseKey: undefined }],
    ])("rejects a payload with %s", async (_label, body) => {
      // actorId is the CloudTrail attribution, modelId is the required per-turn
      // model, and a message is required — none may be defaulted, so the runtime
      // rejects the turn before building the agent.
      await expect(collect(LEASE_ID, body)).rejects.toThrow();
      expect(buildAgentMock).not.toHaveBeenCalled();
    });
  });

  describe("fail-closed region guard", () => {
    // Unmanaged hub home region must refuse the turn before any model call, so
    // inference and its logs never land in a region aws-nuke skips on recycle.
    it("proceeds when the hub home region is in the managed region list", async () => {
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      const events = await collect(LEASE_ID, {
        ...payload,
        regions: ["us-west-2", "us-east-1"],
      });

      expect(buildAgentMock).toHaveBeenCalledTimes(1);
      expect(events.at(-1)).toMatchObject({ type: "complete" });
    });

    it("throws HubRegionNotManagedError and makes no model call when the hub home region is not managed", async () => {
      await expect(
        collect(LEASE_ID, { ...payload, regions: ["eu-west-1"] }),
      ).rejects.toBeInstanceOf(HubRegionNotManagedError);

      // Fail-closed: the agent is never built.
      expect(buildAgentMock).not.toHaveBeenCalled();
    });

    it("throws when the managed region list is empty", async () => {
      await expect(
        collect(LEASE_ID, { ...payload, regions: [] }),
      ).rejects.toBeInstanceOf(HubRegionNotManagedError);
      expect(buildAgentMock).not.toHaveBeenCalled();
    });

    it("does not echo request input in the error message", async () => {
      const error = await collect(LEASE_ID, {
        ...payload,
        regions: ["eu-west-1"],
      }).then(
        () => undefined,
        (e: unknown) => e as HubRegionNotManagedError,
      );

      expect(error).toBeInstanceOf(HubRegionNotManagedError);
      const message = error!.message;
      expect(message).not.toContain(payload.leaseKey);
      expect(message).not.toContain(payload.actorId);
      expect(message).not.toContain(payload.messages[0]!.content);
      expect(message).not.toContain("eu-west-1");
      expect(message).not.toContain(env.AWS_REGION);
    });
  });

  describe("identity and scope passed to the agent", () => {
    it("takes the lease from the payload lease key, not the caller session id", async () => {
      await collect();

      expect(buildAgentMock.mock.calls[0]![0].context).toMatchObject({
        actorId: "alice-at-example-d-com",
        leaseId: LEASE_KEY,
        accountId: "222222222222",
      });
    });

    it("wraps message content into blocks for the SDK", async () => {
      const streamFn = vi.fn(fakeStream([textDelta("ok")]).stream);
      buildAgentMock.mockReturnValue({ messages: [], stream: streamFn });

      await collect();

      // The shared contract carries content as a plain string, but Strands
      // expects an array of content blocks — passing the raw string through
      // would fail at the SDK boundary rather than here.
      expect(streamFn.mock.calls[0]![0]).toEqual([
        { role: "user", content: [{ type: "text", text: "list my buckets" }] },
      ]);
    });

    it("passes the masked user text to the agent, so the original is never kept or persisted", async () => {
      screenMock.mockResolvedValue({
        blocked: false,
        text: "my key is {AWS_SECRET_KEY}",
      });
      const streamFn = vi.fn(fakeStream([textDelta("ok")]).stream);
      buildAgentMock.mockReturnValue({ messages: [], stream: streamFn });

      await collect();

      expect(screenMock).toHaveBeenCalledWith("list my buckets", env);
      expect(streamFn.mock.calls[0]![0]).toEqual([
        {
          role: "user",
          content: [{ type: "text", text: "my key is {AWS_SECRET_KEY}" }],
        },
      ]);
    });

    it("answers a blocked message with an INPUT_BLOCKED frame without building or calling the agent", async () => {
      screenMock.mockResolvedValue({
        blocked: true,
        message: "Your request was blocked.",
        blockedBy: [{ type: "PROMPT_ATTACK", confidence: "MEDIUM" }],
      });

      expect(await collect()).toEqual([
        {
          error: expect.any(String),
          code: RUNTIME_ERROR_CODES.inputBlocked,
        },
      ]);
      expect(buildAgentMock).not.toHaveBeenCalled();
    });

    it("logs the policy type and confidence of a blocked message, never its text", async () => {
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
      screenMock.mockResolvedValue({
        blocked: true,
        message: "Your request was blocked.",
        blockedBy: [{ type: "PROMPT_ATTACK", confidence: "MEDIUM" }],
      });

      await collect();

      const lines = warn.mock.calls.map(([line]) => String(line));
      const blockedLogs = lines
        .filter((line) => line.includes("UserInputBlocked"))
        .map((line) => JSON.parse(line) as Record<string, unknown>);
      expect(blockedLogs).toEqual([
        {
          level: "warn",
          message: "UserInputBlocked",
          blockedBy: [{ type: "PROMPT_ATTACK", confidence: "MEDIUM" }],
        },
      ]);
      expect(lines.join("\n")).not.toContain("list my buckets");
      warn.mockRestore();
    });

    it("fails the turn without calling the agent when masking fails", async () => {
      screenMock.mockRejectedValue(new Error("ThrottlingException"));
      const streamFn = vi.fn(fakeStream([textDelta("ok")]).stream);
      buildAgentMock.mockReturnValue({ messages: [], stream: streamFn });

      await expect(collect()).rejects.toThrow("ThrottlingException");
      expect(streamFn).not.toHaveBeenCalled();
    });
  });

  it("applies the turn cap to bound invocation duration", async () => {
    const streamFn = vi.fn(fakeStream([textDelta("ok")]).stream);
    buildAgentMock.mockReturnValue({ messages: [], stream: streamFn });

    await collect();

    expect(streamFn.mock.calls[0]![1]).toMatchObject({
      limits: { turns: 25 },
    });
  });

  describe("per-turn model selection", () => {
    it.each(["model-a", "model-b"])(
      "passes the submitted modelId %s through to buildAgent",
      async (modelId) => {
        buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

        await collect(LEASE_ID, { ...payload, modelId });

        // The runtime invokes exactly the selected model — Model A invokes A,
        // Model B invokes B.
        expect(buildAgentMock.mock.calls[0]![0].modelId).toBe(modelId);
      },
    );

    it("uses the single submitted modelId for the whole streamed turn", async () => {
      // The turn carries one modelId captured at submit; buildAgent is called
      // once for the turn and the model cannot change mid-stream.
      buildAgentMock.mockReturnValue(
        fakeAgent([textDelta("part one "), textDelta("part two")]),
      );

      await collect(LEASE_ID, { ...payload, modelId: "model-a" });

      expect(buildAgentMock).toHaveBeenCalledTimes(1);
      expect(buildAgentMock.mock.calls[0]![0].modelId).toBe("model-a");
    });

    it("reuses the cached agent when the same model is submitted on a warm turn", async () => {
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      await collect(LEASE_ID, { ...payload, modelId: "model-a" });
      await collect(LEASE_ID, { ...payload, modelId: "model-a" });

      expect(buildAgentMock).toHaveBeenCalledTimes(1);
    });

    it("rebuilds the agent when a warm session switches models so the new model is invoked", async () => {
      // The model is baked into the Agent at construction, so a per-turn model
      // switch on the same session must rebuild rather than reuse the prior
      // model — otherwise Model B would be served by Model A's agent.
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      await collect(LEASE_ID, { ...payload, modelId: "model-a" });
      await collect(LEASE_ID, { ...payload, modelId: "model-b" });

      expect(buildAgentMock).toHaveBeenCalledTimes(2);
      expect(buildAgentMock.mock.calls[0]![0].modelId).toBe("model-a");
      expect(buildAgentMock.mock.calls[1]![0].modelId).toBe("model-b");
    });
  });

  describe("warm-turn cache", () => {
    it("reuses the built agent on a same-session second turn", async () => {
      await collect();
      await collect(); // same LEASE_ID → cache hit
      expect(buildAgentMock).toHaveBeenCalledTimes(1);
    });

    it("refreshes per-turn context fields on the cached tool context", async () => {
      // The CLI-tool closure captures `context` by reference, so a mid-session
      // permission-set change on turn 2 must show up on the same object.
      const policyA = {
        Version: "2012-10-17" as const,
        Statement: [
          { Effect: "Allow" as const, Action: "s3:*", Resource: "*" },
        ],
      };
      const policyB = {
        Version: "2012-10-17" as const,
        Statement: [{ Effect: "Deny" as const, Action: "s3:*", Resource: "*" }],
      };
      const first = { ...payload, permissionProfilePolicy: policyA };
      const second = {
        ...payload,
        permissionProfilePolicy: policyB,
        accountId: "333333333333",
      };
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      await collect(LEASE_ID, first);
      const ctx = buildAgentMock.mock.calls[0]![0].context;
      expect(ctx.permissionProfilePolicy).toEqual(policyA);

      await collect(LEASE_ID, second);
      // Same object, mutated in place — cache hit did not rebuild.
      expect(buildAgentMock).toHaveBeenCalledTimes(1);
      expect(ctx.permissionProfilePolicy).toEqual(policyB);
      expect(ctx.accountId).toBe("333333333333");
    });

    it("flushes MemoryManager at turn end", async () => {
      const flush = vi.fn(async () => {});
      buildAgentMock.mockReturnValue(
        fakeAgent([textDelta("ok")], { memoryManager: { flush } }),
      );
      await collect();
      expect(flush).toHaveBeenCalledTimes(1);
    });

    it("still completes the turn when flush throws", async () => {
      const flush = vi.fn(async () => {
        throw new Error("boom");
      });
      buildAgentMock.mockReturnValue(
        fakeAgent([textDelta("ok")], { memoryManager: { flush } }),
      );
      // Memory persistence is best-effort — a flush failure must not fail the turn.
      const events = await collect();
      expect(events.at(-1)).toMatchObject({ type: "complete" });
    });
  });

  describe("STM rehydration on cache miss", () => {
    const envWithMemory: AgentRuntimeEnvironment = {
      ...env,
      USER_MEMORY_ID: "mem-123",
    };
    let listEventsMock: ReturnType<typeof vi.fn>;

    beforeEach(() => {
      listEventsMock = vi.fn().mockResolvedValue({ events: [] });
      // `paginateListEvents` runs `instanceof BedrockAgentCoreClient` on the
      // client and throws otherwise, so we stub `send` on a real instance.
      const client = new BedrockAgentCoreClient({ region: "us-east-1" });
      (client as unknown as { send: unknown }).send = listEventsMock;
      bedrockAgentCoreMock.mockReturnValue(client);
    });

    function convEvent(role: "USER" | "ASSISTANT", text: string) {
      return { payload: [{ conversational: { role, content: { text } } }] };
    }

    function freshSessionId(): string {
      // Fresh id per test so main.ts's module-scoped cache misses.
      return `${crypto.randomUUID()}_${crypto.randomUUID()}`;
    }

    it("reverses newest-first ListEvents and filters non-conversational payloads", async () => {
      listEventsMock.mockResolvedValueOnce({
        events: [
          convEvent("ASSISTANT", "answer2"),
          { payload: [{ toolUse: { name: "cli" } }] }, // must be filtered
          convEvent("USER", "question2"),
          convEvent("ASSISTANT", "answer1"),
          convEvent("USER", "question1"),
        ],
      });
      const agent = fakeAgent([textDelta("ok")]);
      buildAgentMock.mockReturnValue(agent);

      await collect(freshSessionId(), payload, envWithMemory);

      // STM is read for the user id actor on the lease uuid session.
      expect(listEventsMock.mock.calls[0]![0].input).toMatchObject({
        actorId: USER_ID,
        sessionId: LEASE_UUID,
      });

      // Conversation order after reverse: q1, a1, q2, a2.
      expect(agent.messages.map((m: any) => m.role)).toEqual([
        "user",
        "assistant",
        "user",
        "assistant",
      ]);
    });

    it("drops an unanswered user message from rehydrated history", async () => {
      listEventsMock.mockResolvedValueOnce({
        events: [
          convEvent("USER", "blocked request"),
          convEvent("ASSISTANT", "answer1"),
          convEvent("USER", "question1"),
        ],
      });
      const agent = fakeAgent([textDelta("ok")]);
      buildAgentMock.mockReturnValue(agent);

      await collect(freshSessionId(), payload, envWithMemory);

      expect(
        (agent.messages as Message[]).map((message) =>
          messageText(message, ""),
        ),
      ).toEqual(["question1", "answer1"]);
    });

    it("restores only the latest 60 messages on a cold start", async () => {
      // 40 question-and-answer events, newest first.
      const events = Array.from({ length: 40 }, (_, i) => 40 - i).flatMap(
        (n) => [
          convEvent("ASSISTANT", `answer${n}`),
          convEvent("USER", `question${n}`),
        ],
      );
      listEventsMock.mockResolvedValueOnce({ events });
      const agent = fakeAgent([textDelta("ok")]);
      buildAgentMock.mockReturnValue(agent);

      await collect(freshSessionId(), payload, envWithMemory);

      const restored = (agent.messages as Message[]).map((message) =>
        messageText(message, ""),
      );
      expect(restored).toHaveLength(60);
      expect(restored[0]).toBe("question11");
      expect(restored.at(-1)).toBe("answer40");
    });

    it("starts restored history at a user message when the cut falls inside a long reply", async () => {
      // Newest first: a normal pair, then one question answered by 61 assistant
      // messages, so the limit leaves only assistant messages before the pair.
      const events = [
        convEvent("ASSISTANT", "answer2"),
        convEvent("USER", "question2"),
        ...Array.from({ length: 61 }, (_, i) =>
          convEvent("ASSISTANT", `step${61 - i}`),
        ),
        convEvent("USER", "question1"),
      ];
      listEventsMock.mockResolvedValueOnce({ events });
      const agent = fakeAgent([textDelta("ok")]);
      buildAgentMock.mockReturnValue(agent);

      await collect(freshSessionId(), payload, envWithMemory);

      expect(
        (agent.messages as Message[]).map((message) =>
          messageText(message, ""),
        ),
      ).toEqual(["question2", "answer2"]);
    });

    it("keys memory on the user id and lease uuid, not the email or per-caller session id", async () => {
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      await collect(freshSessionId(), payload, envWithMemory);

      expect(buildAgentMock.mock.calls[0]![0].memory).toMatchObject({
        actorId: USER_ID,
        sessionId: LEASE_UUID,
      });
    });

    it("degrades to memory-off when the lease key cannot be decoded", async () => {
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      // Not a base64url-encoded JSON — decode throws inside main.ts and the
      // turn falls through the memory-off branch.
      const events = await collect(
        freshSessionId(),
        { ...payload, leaseKey: "malformed-lease-key" },
        envWithMemory,
      );

      expect(listEventsMock).not.toHaveBeenCalled();
      expect(buildAgentMock.mock.calls[0]![0].memory).toBeUndefined();
      expect(events.at(-1)).toMatchObject({ type: "complete" });
    });

    it("degrades to memory-off when the lease key decodes but fails validation", async () => {
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      // Valid base64url JSON, but the uuid is not a UUID: it must never become
      // the memory session id.
      const badKey = base64EncodeCompositeKey({
        userEmail: "owner@example.com",
        uuid: "not-a-uuid",
      })!;
      await collect(
        freshSessionId(),
        { ...payload, leaseKey: badKey },
        envWithMemory,
      );

      expect(listEventsMock).not.toHaveBeenCalled();
      expect(buildAgentMock.mock.calls[0]![0].memory).toBeUndefined();
    });

    it("does not re-rehydrate on a warm turn", async () => {
      const sessionId = freshSessionId();
      buildAgentMock.mockReturnValue(fakeAgent([textDelta("ok")]));

      await collect(sessionId, payload, envWithMemory);
      await collect(sessionId, payload, envWithMemory);

      expect(listEventsMock).toHaveBeenCalledTimes(1);
      expect(buildAgentMock).toHaveBeenCalledTimes(1);
    });
  });
});

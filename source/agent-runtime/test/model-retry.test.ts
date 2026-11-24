// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  ConverseStreamCommand,
} from "@aws-sdk/client-bedrock-runtime";
import type { Message as EventStreamMessage } from "@smithy/types";
import { ModelError } from "@strands-agents/sdk";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgent } from "@amzn/innovation-sandbox-agent-runtime/agent.js";
import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import {
  streamTurn,
  TurnStreamError,
} from "@amzn/innovation-sandbox-agent-runtime/turn-stream.js";

const { runCommandMock } = vi.hoisted(() => ({ runCommandMock: vi.fn() }));
vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js",
  () => ({ executeSandboxCli: runCommandMock }),
);

const bedrock = mockClient(BedrockRuntimeClient);

const env: AgentRuntimeEnvironment = {
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::111111111111:role/InnovationSandbox-myisb-IntermediateRole",
  SANDBOX_AGENT_ROLE_NAME: "SandboxAgentRole-myisb",
  HUB_ACCOUNT_ID: "111111111111",
  USER_AGENT_EXTRA: "test-agent",
  GUARDRAIL_ID: "arn:aws:bedrock:us-east-1:111111111111:guardrail/gr-abc123",
  GUARDRAIL_VERSION: "1",
  AWS_REGION: "us-east-1",
  LEASE_TABLE_NAME: "isb-leases",
  ACCOUNT_TABLE_NAME: "isb-accounts",
};

const STREAM_ENDED = "Stream ended without completing a message";

type ModelCall = () => AsyncGenerator<unknown>;

const replyWith = (text: string): ModelCall =>
  async function* () {
    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "textDelta", text },
    };
    yield { type: "modelContentBlockStopEvent" };
    yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
  };

const runCommand: ModelCall = async function* () {
  yield { type: "modelMessageStartEvent", role: "assistant" };
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
      input: JSON.stringify({ args: ["s3", "mb", "s3://example-bucket"] }),
    },
  };
  yield { type: "modelContentBlockStopEvent" };
  yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
};

const streamEnds: ModelCall = async function* () {
  yield { type: "modelMessageStartEvent", role: "assistant" };
  throw new ModelError(STREAM_ENDED);
};

const stopsWithoutStart = (stopReason: string): ModelCall =>
  async function* () {
    yield { type: "modelMessageStopEvent", stopReason };
    throw new ModelError(STREAM_ENDED);
  };

const contentFiltered = stopsWithoutStart("contentFiltered");

const startsThenFails = (error: Error): ModelCall =>
  async function* () {
    yield { type: "modelMessageStartEvent", role: "assistant" };
    throw error;
  };

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

const textThenStreamEnds: ModelCall = async function* () {
  yield { type: "modelMessageStartEvent", role: "assistant" };
  yield { type: "modelContentBlockStartEvent" };
  yield {
    type: "modelContentBlockDeltaEvent",
    delta: { type: "textDelta", text: "Creating the bucket" },
  };
  throw new ModelError(STREAM_ENDED);
};

function testAgent() {
  return buildAgent({
    context: {
      actorId: "alice-at-example-d-com",
      leaseId: "lease-abc",
      accountId: "222222222222",
      regions: ["us-east-1"],
    },
    modelId: "eu.anthropic.claude-opus-5-5",
    services: {} as never,
    env,
  });
}

function agentWithModelCalls(calls: ModelCall[]) {
  const agent = testAgent();
  const queue = [...calls];
  const modelStream = vi.spyOn(agent.model, "stream").mockImplementation(() => {
    const next = queue.shift();
    if (!next) throw new Error("unexpected model call");
    return next() as ReturnType<typeof agent.model.stream>;
  });
  return { agent, modelStream };
}

async function runTurn(agent: ReturnType<typeof buildAgent>) {
  const stream = agent.stream("create a bucket");
  let next = await stream.next();
  while (!next.done) next = await stream.next();
  return next.value;
}

type ConverseStreamEvent = Record<string, unknown>;

const eventStreamMarshaller = new BedrockRuntimeClient({ region: "us-east-1" })
  .config.eventStreamMarshaller;

/** One encoded event-stream message per event, as Bedrock sends a ConverseStream body. */
async function encodeEvents(
  events: ConverseStreamEvent[],
): Promise<Uint8Array[]> {
  const source = (async function* () {
    yield* events;
  })();
  const encoded = eventStreamMarshaller.serialize(
    source,
    (event: ConverseStreamEvent): EventStreamMessage => {
      const [eventType] = Object.keys(event) as [string];
      return {
        headers: {
          ":event-type": { type: "string", value: eventType },
          ":message-type": { type: "string", value: "event" },
          ":content-type": { type: "string", value: "application/json" },
        },
        body: new TextEncoder().encode(JSON.stringify(event[eventType])),
      };
    },
  ) as AsyncIterable<Uint8Array>;
  const messages: Uint8Array[] = [];
  for await (const bytes of encoded) {
    if (bytes.length > 0) messages.push(bytes);
  }
  return messages;
}

function converseStreamOutput(body: Uint8Array[]) {
  const stream = eventStreamMarshaller.deserialize(
    (async function* () {
      yield* body;
    })(),
    async (message: Record<string, EventStreamMessage>) => {
      const [eventType] = Object.keys(message) as [string];
      return {
        [eventType]: JSON.parse(
          new TextDecoder().decode(message[eventType]!.body),
        ) as unknown,
      };
    },
  );
  return { stream } as never;
}

const replyEvents = (text: string): ConverseStreamEvent[] => [
  { messageStart: { role: "assistant" } },
  { contentBlockDelta: { contentBlockIndex: 0, delta: { text } } },
  { contentBlockStop: { contentBlockIndex: 0 } },
  { messageStop: { stopReason: "end_turn" } },
  {
    metadata: {
      usage: { inputTokens: 3, outputTokens: 4, totalTokens: 7 },
      metrics: { latencyMs: 1 },
    },
  },
];

describe("model call retry", () => {
  beforeEach(() => {
    vi.useFakeTimers({ shouldAdvanceTime: true, advanceTimeDelta: 1000 });
    bedrock.reset();
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE" } as never);
    runCommandMock.mockReset();
    runCommandMock.mockResolvedValue({ status: "success", output: "{}" });
  });

  it("retries once when the stream ends early before any tool ran", async () => {
    const { agent, modelStream } = agentWithModelCalls([
      streamEnds,
      replyWith("Here is the bucket."),
    ]);

    const result = await runTurn(agent);

    expect(modelStream).toHaveBeenCalledTimes(2);
    expect(result.stopReason).toBe("endTurn");
  });

  it("retries once when Bedrock's event stream is cut off partway through its first event", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const retryLines: string[] = [];
    const [firstEvent] = (await encodeEvents([
      { messageStart: { role: "assistant" } },
    ])) as [Uint8Array];
    bedrock
      .on(ConverseStreamCommand)
      .resolvesOnce(
        converseStreamOutput([
          firstEvent.slice(0, Math.floor(firstEvent.length / 2)),
        ]),
      )
      .resolvesOnce(
        converseStreamOutput(
          await encodeEvents(replyEvents("Here is the bucket.")),
        ),
      );

    const result = await runTurn(testAgent()).finally(() => {
      retryLines.push(...warn.mock.calls.map(([line]) => String(line)));
      warn.mockRestore();
    });

    expect(bedrock.commandCalls(ConverseStreamCommand)).toHaveLength(2);
    expect(result.stopReason).toBe("endTurn");
    expect(result.toString()).toBe("Here is the bucket.");
    const retryLogs = retryLines
      .filter((line) => line.includes("AgentModelCallRetried"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(retryLogs).toEqual([
      expect.objectContaining({
        code: "MODEL_STREAM_ENDED",
        errorName: "ModelError",
        errorMessage: "Truncated event message received.",
      }),
    ]);
  });

  it("does not retry a second time", async () => {
    const { agent, modelStream } = agentWithModelCalls([
      streamEnds,
      streamEnds,
      replyWith("unused"),
    ]);

    await expect(runTurn(agent)).rejects.toThrow(STREAM_ENDED);
    expect(modelStream).toHaveBeenCalledTimes(2);
  });

  it("does not retry after a tool ran in the turn", async () => {
    const { agent, modelStream } = agentWithModelCalls([
      runCommand,
      streamEnds,
      replyWith("unused"),
    ]);

    await expect(runTurn(agent)).rejects.toThrow(STREAM_ENDED);
    expect(runCommandMock).toHaveBeenCalledOnce();
    expect(modelStream).toHaveBeenCalledTimes(2);
  });

  it("does not retry a content filter stop", async () => {
    const { agent, modelStream } = agentWithModelCalls([
      contentFiltered,
      replyWith("unused"),
    ]);

    await expect(runTurn(agent)).rejects.toThrow(STREAM_ENDED);
    expect(modelStream).toHaveBeenCalledOnce();
  });

  it("does not retry after the user was shown text from the failed call", async () => {
    const { agent, modelStream } = agentWithModelCalls([
      textThenStreamEnds,
      replyWith("unused"),
    ]);

    await expect(runTurn(agent)).rejects.toThrow(STREAM_ENDED);
    expect(modelStream).toHaveBeenCalledOnce();
  });

  it("does not retry a validation error", async () => {
    const validation = Object.assign(new Error("bad input"), {
      name: "ValidationException",
    });
    const { agent, modelStream } = agentWithModelCalls([
      () => {
        throw validation;
      },
      replyWith("unused"),
    ]);

    await expect(runTurn(agent)).rejects.toThrow("bad input");
    expect(modelStream).toHaveBeenCalledOnce();
  });

  it("logs the code, stop reason and attempt count of a retried call", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const { agent } = agentWithModelCalls([
      stopsWithoutStart("endTurn"),
      replyWith("Here is the bucket."),
    ]);

    await runTurn(agent);

    const retryLogs = warn.mock.calls
      .map(([line]) => (typeof line === "string" ? line : ""))
      .filter((line) => line.includes("AgentModelCallRetried"))
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(retryLogs).toEqual([
      expect.objectContaining({
        code: "MODEL_STREAM_ENDED",
        stopReason: "endTurn",
        attemptCount: 1,
        errorName: "ModelError",
      }),
    ]);
    warn.mockRestore();
  });

  describe.each([
    ["a timeout", awsError("ModelTimeoutException", "Model timed out.")],
    [
      "a service failure",
      awsError("ServiceUnavailableException", "Service unavailable."),
    ],
  ])("on %s", (_label, error) => {
    it("retries once before any tool ran", async () => {
      const { agent, modelStream } = agentWithModelCalls([
        startsThenFails(error),
        replyWith("Here is the bucket."),
      ]);

      const result = await runTurn(agent);

      expect(modelStream).toHaveBeenCalledTimes(2);
      expect(result.stopReason).toBe("endTurn");
    });

    it("does not retry a second time", async () => {
      const { agent, modelStream } = agentWithModelCalls([
        startsThenFails(error),
        startsThenFails(error),
        replyWith("unused"),
      ]);

      await expect(runTurn(agent)).rejects.toThrow(error.message);
      expect(modelStream).toHaveBeenCalledTimes(2);
    });

    it("does not retry after a tool ran in the turn", async () => {
      const { agent, modelStream } = agentWithModelCalls([
        runCommand,
        startsThenFails(error),
        replyWith("unused"),
      ]);

      await expect(runTurn(agent)).rejects.toThrow(error.message);
      expect(runCommandMock).toHaveBeenCalledOnce();
      expect(modelStream).toHaveBeenCalledTimes(2);
    });
  });

  it("reports no stop reason when a model call after a tool fails before it streams", async () => {
    const { agent } = agentWithModelCalls([
      runCommand,
      () => {
        throw awsError("ValidationException", "bad input");
      },
    ]);

    const turn = streamTurn(agent.stream("create a bucket"), agent);
    const failure = await (async () => {
      let next = await turn.next();
      while (!next.done) next = await turn.next();
    })().catch((err: unknown) => err);

    expect(failure).toBeInstanceOf(TurnStreamError);
    expect(failure).toMatchObject({ modelStopReason: undefined });
  });

  it.each([
    ["after a tool ran", [runCommand, streamEnds, streamEnds], true],
    ["when no tool ran", [streamEnds, streamEnds], false],
  ])(
    "reports whether a tool ran when the turn fails %s",
    async (_label, calls, toolRan) => {
      const { agent } = agentWithModelCalls(calls);

      const turn = streamTurn(agent.stream("create a bucket"), agent);
      const failure = await (async () => {
        let next = await turn.next();
        while (!next.done) next = await turn.next();
      })().catch((err: unknown) => err);

      expect(failure).toBeInstanceOf(TurnStreamError);
      expect(failure).toMatchObject({ toolRan });
    },
  );
});

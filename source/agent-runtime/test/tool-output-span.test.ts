// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";
import { trace } from "@opentelemetry/api";
import {
  BasicTracerProvider,
  InMemorySpanExporter,
  SimpleSpanProcessor,
} from "@opentelemetry/sdk-trace-base";
import { Message, ToolResultBlock } from "@strands-agents/sdk";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const { RAW_SECRET, MASKED, storeSearch, cliMock } = vi.hoisted(() => ({
  RAW_SECRET: "AKIA" + "IOSFODNN7EXAMPLE",
  MASKED: "{AWS_ACCESS_KEY}",
  storeSearch: vi.fn(),
  cliMock: vi.fn(),
}));

vi.mock("bedrock-agentcore/memory/strands", () => ({
  createAgentCoreMemoryStores: () => [
    {
      name: "fake-ltm",
      writable: true,
      search: storeSearch,
      addMessages: async () => {},
    },
  ],
}));

vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js",
  async (importOriginal) => ({
    ...(await importOriginal<
      typeof import("@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js")
    >()),
    executeSandboxCli: cliMock,
  }),
);

import {
  buildAgent,
  MEMORY_ENTRY_WITHHELD_TEXT,
} from "@amzn/innovation-sandbox-agent-runtime/agent.js";
import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";

const bedrock = mockClient(BedrockRuntimeClient);
const spanExporter = new InMemorySpanExporter();

const BLOCKED_TOPIC = "example-blocked-topic";
const UNSCREENABLE_TOPIC = "example-unscreenable-topic";

const env: AgentRuntimeEnvironment = {
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::111111111111:role/InnovationSandbox-myisb-IntermediateRole",
  SANDBOX_AGENT_ROLE_NAME: "SandboxAgentRole-myisb",
  HUB_ACCOUNT_ID: "111111111111",
  USER_AGENT_EXTRA: "test-agent",
  GUARDRAIL_ID: "gr-abc123",
  GUARDRAIL_VERSION: "1",
  AWS_REGION: "us-east-1",
  LEASE_TABLE_NAME: "isb-leases",
  ACCOUNT_TABLE_NAME: "isb-accounts",
};

const memory = {
  memoryId: "mem-abc",
  actorId: "alice-at-example-d-com",
  sessionId: "550e8400-e29b-41d4-a716-446655440000",
  region: "us-east-1",
};

function build() {
  return buildAgent({
    context: {
      actorId: "alice-at-example-d-com",
      leaseId: "lease-abc",
      accountId: "222222222222",
      regions: ["us-east-1"],
    },
    modelId: "global.anthropic.claude-opus-4-1",
    services: {} as never,
    env,
    memory,
  });
}

type ToolSpanEnd = { toolResult?: ToolResultBlock };

/**
 * Runs one turn in which the model calls `toolName` once, and returns what
 * the SDK recorded on the tool span and what the model got back.
 */
async function runToolCall(toolName: string, input: unknown) {
  const agent = build();
  const tracer = (
    agent as unknown as {
      _tracer: { endToolCallSpan: (span: unknown, end?: ToolSpanEnd) => void };
    }
  )._tracer;
  const endToolCallSpan = vi.spyOn(tracer, "endToolCallSpan");
  const modelCalls: Message[][] = [];
  vi.spyOn(agent.model, "stream").mockImplementation(async function* (
    messages: Message[],
  ) {
    modelCalls.push(messages.map((m) => m));
    if (modelCalls.length > 1) throw new Error("stop after tool call");
    yield { type: "modelMessageStartEvent", role: "assistant" } as never;
    yield {
      type: "modelContentBlockStartEvent",
      start: { type: "toolUseStart", name: toolName, toolUseId: "t1" },
    } as never;
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "toolUseInputDelta", input: JSON.stringify(input) },
    } as never;
    yield { type: "modelContentBlockStopEvent" } as never;
    yield { type: "modelMessageStopEvent", stopReason: "toolUse" } as never;
  });

  await expect(agent.invoke("go")).rejects.toThrow("stop after tool call");

  const spanEnds = endToolCallSpan.mock.calls.map((call) => call[1]);
  expect(spanEnds).toHaveLength(1);
  return {
    recorded: JSON.stringify(spanEnds[0]?.toolResult),
    modelSaw: JSON.stringify(modelCalls[1]?.at(-1)),
  };
}

describe("tool output recorded on the tool span", () => {
  beforeAll(() => {
    trace.setGlobalTracerProvider(
      new BasicTracerProvider({
        spanProcessors: [new SimpleSpanProcessor(spanExporter)],
      }),
    );
  });

  beforeEach(() => {
    spanExporter.reset();
    bedrock.reset();
    bedrock.on(ApplyGuardrailCommand).callsFake((command) => {
      const text = command.content[0].text.text as string;
      if (text.includes(UNSCREENABLE_TOPIC)) {
        throw new Error("throttled");
      }
      if (text.includes(BLOCKED_TOPIC)) {
        return {
          action: "GUARDRAIL_INTERVENED",
          outputs: [{ text: "Blocked." }],
          assessments: [
            {
              topicPolicy: {
                topics: [{ name: "x", type: "DENY", action: "BLOCKED" }],
              },
            },
          ],
        };
      }
      return text.includes(RAW_SECRET)
        ? {
            action: "GUARDRAIL_INTERVENED",
            outputs: [{ text: text.replaceAll(RAW_SECRET, MASKED) }],
            assessments: [],
          }
        : { action: "NONE", outputs: [] };
    });
    storeSearch.mockReset();
    storeSearch.mockResolvedValue([{ content: `key ${RAW_SECRET}` }]);
    cliMock.mockReset();
    cliMock.mockResolvedValue({
      status: "success",
      stdout: `AWS_ACCESS_KEY_ID=${RAW_SECRET}\n`,
      stderr: "",
    });
  });

  it.each([
    ["execute_sandbox_cli", { args: ["sts", "get-caller-identity"] }],
    ["search_memory", { query: "keys" }],
  ])(
    "records the screened %s output, the same text the model gets",
    async (toolName, input) => {
      const { recorded, modelSaw } = await runToolCall(toolName, input);

      expect(modelSaw).not.toContain(RAW_SECRET);
      expect(modelSaw).toContain(MASKED);
      expect(recorded).not.toContain(RAW_SECRET);
      expect(recorded).toContain(MASKED);
    },
  );

  it("screens the execute_sandbox_cli output once", async () => {
    // Nothing to recall for the turn's message, so every guardrail call
    // comes from the tool result.
    storeSearch.mockImplementation(async (query: string) =>
      query === "go" ? [] : [{ content: `key ${RAW_SECRET}` }],
    );

    await runToolCall("execute_sandbox_cli", {
      args: ["sts", "get-caller-identity"],
    });

    expect(bedrock.commandCalls(ApplyGuardrailCommand)).toHaveLength(1);
  });

  it("screens each search_memory entry once and not the joined tool output", async () => {
    const entries = [`key ${RAW_SECRET}`, "region eu-central-1"];
    storeSearch.mockImplementation(async (query: string) =>
      query === "go" ? [] : entries.map((content) => ({ content })),
    );

    await runToolCall("search_memory", { query: "keys" });

    const screenedTexts = bedrock
      .commandCalls(ApplyGuardrailCommand)
      .map((call) => call.args[0].input.content?.[0]?.text?.text);
    expect(screenedTexts).toEqual(entries);
  });

  describe("memory entries recorded on the memory.search span", () => {
    function recordedMemorySearch(): string {
      const searchSpans = spanExporter
        .getFinishedSpans()
        .filter((span) => span.name === "memory.search");
      expect(searchSpans).toHaveLength(1);
      return JSON.stringify({
        attributes: searchSpans[0]!.attributes,
        events: searchSpans[0]!.events,
      });
    }

    it("records the masked entry in memory.results, the same text the model gets", async () => {
      const { modelSaw } = await runToolCall("search_memory", {
        query: "keys",
      });

      const recorded = recordedMemorySearch();
      expect(recorded).toContain("memory.results");
      expect(recorded).not.toContain(RAW_SECRET);
      expect(recorded).toContain(MASKED);
      expect(modelSaw).not.toContain(RAW_SECRET);
      expect(modelSaw).toContain(MASKED);
    });

    it("withholds an entry whose screening fails from memory.results and the tool result", async () => {
      storeSearch.mockResolvedValue([
        { content: `${UNSCREENABLE_TOPIC} key ${RAW_SECRET}` },
      ]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      const { recorded, modelSaw } = await runToolCall("search_memory", {
        query: "keys",
      });

      const recordedSearch = recordedMemorySearch();
      for (const text of [recordedSearch, recorded, modelSaw]) {
        expect(text).toContain(MEMORY_ENTRY_WITHHELD_TEXT);
        expect(text).not.toContain(UNSCREENABLE_TOPIC);
        expect(text).not.toContain(RAW_SECRET);
      }
      expect(warn).toHaveBeenCalledWith("Memory entry screening failed", {
        name: "Error",
        characters: `${UNSCREENABLE_TOPIC} key ${RAW_SECRET}`.length,
      });
      expect(JSON.stringify(warn.mock.calls)).not.toContain(UNSCREENABLE_TOPIC);
      expect(JSON.stringify(warn.mock.calls)).not.toContain(RAW_SECRET);
      warn.mockRestore();
    });

    it("logs a blocked entry's length and filter, without its content", async () => {
      const blockedContent = `note about ${BLOCKED_TOPIC}`;
      storeSearch.mockResolvedValue([{ content: blockedContent }]);
      const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

      await runToolCall("search_memory", { query: "keys" });

      expect(warn).toHaveBeenCalledWith(
        "Memory entry blocked by the guardrail",
        {
          characters: blockedContent.length,
          blockedBy: [{ type: "DENY" }],
        },
      );
      expect(JSON.stringify(warn.mock.calls)).not.toContain(BLOCKED_TOPIC);
      warn.mockRestore();
    });

    it("drops an entry the guardrail blocks from memory.results and the tool result", async () => {
      storeSearch.mockResolvedValue([
        { content: `note about ${BLOCKED_TOPIC}` },
        { content: `key ${RAW_SECRET}` },
      ]);

      const { recorded, modelSaw } = await runToolCall("search_memory", {
        query: "keys",
      });

      const recordedSearch = recordedMemorySearch();
      expect(recordedSearch).not.toContain(BLOCKED_TOPIC);
      expect(recordedSearch).toContain(MASKED);
      expect(recorded).not.toContain(BLOCKED_TOPIC);
      expect(modelSaw).not.toContain(BLOCKED_TOPIC);
      expect(modelSaw).toContain(MASKED);
    });
  });
});

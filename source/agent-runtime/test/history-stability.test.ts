// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
} from "@aws-sdk/client-bedrock-runtime";
import {
  AfterToolCallEvent,
  type ContentBlock,
  Message,
  TextBlock,
  ToolResultBlock,
  ToolUseBlock,
} from "@strands-agents/sdk";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { buildAgent } from "@amzn/innovation-sandbox-agent-runtime/agent.js";
import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";

// Each search returns a different fact, as a growing memory store would.
const { storeSearch } = vi.hoisted(() => ({ storeSearch: vi.fn() }));
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

const BOUND_ERROR =
  "Invalid `signature` in `thinking` block. The block is bound to a different conversation.";

function buildMemoryAgent() {
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
    memory: {
      memoryId: "mem-abc",
      actorId: "alice-at-example-d-com",
      sessionId: "550e8400-e29b-41d4-a716-446655440000",
      region: "us-east-1",
    },
  });
}

type RequestMessage = { role: string; content: ContentBlock[] };

/**
 * Stands in for Bedrock on a model that binds reasoning signatures. Each
 * reply carries a signed reasoning block, bound to the system prompt and
 * messages it was created from. A later request that sends the block with a
 * different history is rejected, as Bedrock does. A new user message gets a
 * tool call; a tool result gets a final answer, so every turn is a tool loop.
 */
function bindSignatures(agent: ReturnType<typeof buildAgent>) {
  const signed = new Map<string, string>();
  const requests: RequestMessage[][] = [];
  let calls = 0;
  vi.spyOn(agent.model, "stream").mockImplementation(async function* (
    messages: Message[],
    options?: { systemPrompt?: unknown },
  ) {
    requests.push(
      messages.map((m) => ({ role: m.role, content: [...m.content] })),
    );
    const history = (upTo: number) =>
      JSON.stringify({
        system: options?.systemPrompt,
        messages: messages
          .slice(0, upTo)
          .map((m) => ({ role: m.role, content: m.content })),
      });
    messages.forEach((message, i) => {
      for (const block of message.content) {
        if (block.type !== "reasoningBlock" || !block.signature) continue;
        const boundTo = signed.get(block.signature);
        if (boundTo !== undefined && boundTo !== history(i)) {
          throw new Error(BOUND_ERROR);
        }
      }
    });

    calls++;
    const signature = `sig-${calls}`;
    signed.set(signature, history(messages.length));
    const last = messages[messages.length - 1]!;
    const toolLoop = last.content.some((b) => b.type === "toolResultBlock");

    yield { type: "modelMessageStartEvent", role: "assistant" };
    yield { type: "modelContentBlockStartEvent" };
    yield {
      type: "modelContentBlockDeltaEvent",
      delta: { type: "reasoningContentDelta", text: "thinking", signature },
    };
    yield { type: "modelContentBlockStopEvent" };
    if (toolLoop) {
      yield { type: "modelContentBlockStartEvent" };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "textDelta", text: "done" },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "endTurn" };
    } else {
      yield {
        type: "modelContentBlockStartEvent",
        start: {
          type: "toolUseStart",
          name: "execute_sandbox_cli",
          toolUseId: `t${calls}`,
        },
      };
      yield {
        type: "modelContentBlockDeltaEvent",
        delta: { type: "toolUseInputDelta", input: "{}" },
      };
      yield { type: "modelContentBlockStopEvent" };
      yield { type: "modelMessageStopEvent", stopReason: "toolUse" };
    }
  } as never);
  return { callCount: () => calls, requests };
}

const GUARD_TEXT =
  "I stopped because this request needed more room than this conversation has left. Commands I ran before stopping have already taken effect, so check what they changed before you ask me to run them again. Ask me to continue, or split the task into smaller parts.";

/** Small enough that a few padded messages reach the trim and guard thresholds. */
const CONTEXT_WINDOW_LIMIT = 10_000;

function blockTokens(block: ContentBlock): number {
  if (block.type === "textBlock") return block.text.length;
  if (block.type !== "toolResultBlock") return 0;
  return block.content.reduce(
    (sum, item) => sum + (item.type === "textBlock" ? item.text.length : 0),
    0,
  );
}

/**
 * Counts one token per character of text and tool output, ignoring the
 * system prompt and tool specs, so each test sets utilization exactly.
 */
function countCharactersAsTokens(agent: ReturnType<typeof buildAgent>) {
  agent.model.updateConfig({ contextWindowLimit: CONTEXT_WINDOW_LIMIT });
  vi.spyOn(agent.model, "countTokens").mockImplementation(
    async (messages: Message[]) =>
      messages.reduce(
        (sum, message) =>
          sum +
          message.content.reduce(
            (blockSum, block) => blockSum + blockTokens(block),
            0,
          ),
        0,
      ),
  );
}

/** Replaces every tool result with `characters` characters of output. */
function returnToolOutput(
  agent: ReturnType<typeof buildAgent>,
  characters: number,
) {
  agent.addHook(AfterToolCallEvent, (event) => {
    event.result = new ToolResultBlock({
      toolUseId: event.toolUse.toolUseId,
      status: "success",
      content: [new TextBlock("o".repeat(characters))],
    });
  });
}

const user = (text: string) =>
  new Message({ role: "user", content: [new TextBlock(text)] });
const assistant = (text: string) =>
  new Message({ role: "assistant", content: [new TextBlock(text)] });

/** `turns` completed question-and-answer pairs, each message `characters` long. */
function completedTurns(turns: number, characters: number): Message[] {
  return Array.from({ length: turns }, () => [
    user("q".repeat(characters)),
    assistant("a".repeat(characters)),
  ]).flat();
}

function toolUseIds(message: RequestMessage): string[] {
  return message.content.flatMap((block) =>
    block.type === "toolUseBlock" ? [block.toolUseId] : [],
  );
}

function toolResultIds(message: RequestMessage): string[] {
  return message.content.flatMap((block) =>
    block.type === "toolResultBlock" ? [block.toolUseId] : [],
  );
}

/** Every tool use is answered by the next message, and every tool result answers the previous one. */
function toolPairsIntact(messages: RequestMessage[]): boolean {
  return messages.every((message, i) => {
    const uses = toolUseIds(message);
    const results = toolResultIds(message);
    const next = messages[i + 1];
    const previous = messages[i - 1];
    const usesAnswered = uses.every(
      (id) => next !== undefined && toolResultIds(next).includes(id),
    );
    const resultsMatched = results.every(
      (id) => previous !== undefined && toolUseIds(previous).includes(id),
    );
    return usesAnswered && resultsMatched;
  });
}

const NEW_QUESTION = "new question";

describe("reasoning signatures across a memory-on chat", () => {
  beforeEach(() => {
    bedrock.reset();
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE" } as never);
    let n = 0;
    storeSearch.mockReset();
    storeSearch.mockImplementation(async () => [{ content: `fact ${++n}` }]);
  });

  it("accepts every turn of a chat with tool calls", async () => {
    const agent = buildMemoryAgent();
    const model = bindSignatures(agent);
    await agent.invoke("list my buckets");
    await agent.invoke("now list my instances");
    await agent.invoke("and my Lambda functions");
    // 3 turns x (tool call + final answer)
    expect(model.callCount()).toBe(6);
  });

  it("survives an edit to an earlier turn", async () => {
    // Stands in for anything that changes old history, such as overflow
    // trimming: earlier reasoning must not be sent bound to the old history.
    const agent = buildMemoryAgent();
    bindSignatures(agent);
    await agent.invoke("list my buckets");
    agent.messages[0] = new Message({
      role: "user",
      content: [new TextBlock("[earlier messages trimmed]")],
    });
    await expect(agent.invoke("now list my instances")).resolves.toBeDefined();
  });
});

describe("history limits in a memory-on chat", () => {
  beforeEach(() => {
    bedrock.reset();
    bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE" } as never);
    storeSearch.mockReset();
    storeSearch.mockResolvedValue([]);
  });

  it("does not edit history between model calls of one reply when a tool result passes the trim threshold", async () => {
    const agent = buildMemoryAgent();
    const model = bindSignatures(agent);
    countCharactersAsTokens(agent);
    // 60% before the reply, 75% after the tool result: past the 70% trim
    // threshold, below the 90% guard.
    agent.messages.push(...completedTurns(3, 1000));
    returnToolOutput(agent, 1500);

    await expect(agent.invoke(NEW_QUESTION)).resolves.toBeDefined();

    expect(model.callCount()).toBe(2);
    const [firstRequest, secondRequest] = model.requests;
    expect(secondRequest!.slice(0, firstRequest!.length)).toEqual(firstRequest);
    const [toolUse, toolResult] = secondRequest!.slice(firstRequest!.length);
    expect(toolUse!.content.map((block) => block.type)).toEqual([
      "reasoningBlock",
      "toolUseBlock",
    ]);
    expect(toolResultIds(toolResult!)).toEqual(toolUseIds(toolUse!));
  });

  it("removes old messages on the first model call when a new reply starts above the trim threshold", async () => {
    const agent = buildMemoryAgent();
    const model = bindSignatures(agent);
    countCharactersAsTokens(agent);
    const characters = 850;
    // About 77% of the window, below the 100% overflow trigger. The latest
    // completed turn used a tool.
    const seeded = [
      ...completedTurns(3, characters),
      user("q".repeat(characters)),
      new Message({
        role: "assistant",
        content: [
          new ToolUseBlock({
            name: "execute_sandbox_cli",
            toolUseId: "old-tool",
            input: {},
          }),
        ],
      }),
      new Message({
        role: "user",
        content: [
          new ToolResultBlock({
            toolUseId: "old-tool",
            status: "success",
            content: [new TextBlock("o".repeat(characters))],
          }),
        ],
      }),
      assistant("a".repeat(characters)),
    ];
    agent.messages.push(...seeded);

    await agent.invoke(NEW_QUESTION);

    const firstRequest = model.requests[0]!;
    expect(firstRequest.length).toBeLessThan(seeded.length + 1);
    const tokens = firstRequest.reduce(
      (sum, message) =>
        sum + message.content.reduce((n, block) => n + blockTokens(block), 0),
      0,
    );
    expect(tokens / CONTEXT_WINDOW_LIMIT).toBeLessThan(0.7);
    const newest = firstRequest.at(-1)!;
    expect(newest.role).toBe("user");
    expect(newest.content).toEqual([new TextBlock(NEW_QUESTION)]);
    expect(toolPairsIntact(firstRequest)).toBe(true);
    expect(firstRequest.flatMap(toolUseIds)).toEqual(["old-tool"]);
    expect(firstRequest.flatMap(toolResultIds)).toEqual(["old-tool"]);
  });

  it("ends the reply with the guard message instead of a model call that would overfill the context", async () => {
    const agent = buildMemoryAgent();
    const model = bindSignatures(agent);
    countCharactersAsTokens(agent);
    // 68% before the reply, 92% after the tool result.
    agent.messages.push(...completedTurns(4, 850));
    returnToolOutput(agent, 2400);

    const result = await agent.invoke(NEW_QUESTION);

    expect(model.callCount()).toBe(1);
    expect(result.stopReason).toBe("endTurn");
    const [toolUse, toolResult, reply] = agent.messages.slice(-3);
    expect(reply!.role).toBe("assistant");
    expect(reply!.content).toEqual([new TextBlock(GUARD_TEXT)]);
    expect(toolUse!.content.map((block) => block.type)).toEqual([
      "reasoningBlock",
      "toolUseBlock",
    ]);
    expect(toolUseIds(toolUse!)).toEqual(["t1"]);
    expect(toolResultIds(toolResult!)).toEqual(["t1"]);
  });

  it("makes the next model call when the token estimate fails, even above the guard threshold", async () => {
    const agent = buildMemoryAgent();
    const model = bindSignatures(agent);
    countCharactersAsTokens(agent);
    // Only the pre-call estimate passes tool specs. Failing it leaves out the
    // projected token count; the context manager's own count still works.
    const countTokens = vi.mocked(agent.model.countTokens);
    const countCharacters = countTokens.getMockImplementation()!;
    let failedEstimates = 0;
    countTokens.mockImplementation(async (messages, options) => {
      if (options?.toolSpecs) {
        failedEstimates++;
        throw new Error("token estimate unavailable");
      }
      return countCharacters(messages, options);
    });
    // 68% before the reply, 92% after the tool result.
    agent.messages.push(...completedTurns(4, 850));
    returnToolOutput(agent, 2400);

    const result = await agent.invoke(NEW_QUESTION);

    expect(failedEstimates).toBe(2);
    expect(model.callCount()).toBe(2);
    expect(result.stopReason).toBe("endTurn");
    expect(agent.messages.at(-1)!.content).toContainEqual(
      new TextBlock("done"),
    );
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  isToolResultMessage,
  messageText,
} from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import { AgentRuntimeEnvironment } from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import {
  type GuardrailScreeningEnv,
  screenUserText,
} from "@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js";
import { modelRetryStrategies } from "@amzn/innovation-sandbox-agent-runtime/model-retry.js";
import {
  orchestratorPrompt,
  type PromptContext,
} from "@amzn/innovation-sandbox-agent-runtime/prompts.js";
import { buildInferenceSessionPolicy } from "@amzn/innovation-sandbox-agent-runtime/session-policy.js";
import {
  DEFAULT_TOOL_OUTPUT_NOTES,
  withScreenedOutput,
} from "@amzn/innovation-sandbox-agent-runtime/tool-output-guardrail.js";
import { ExecuteSandboxCliServices } from "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js";
import {
  buildSandboxCliTool,
  SANDBOX_CLI_OUTPUT_NOTES,
  SandboxCliToolContext,
} from "@amzn/innovation-sandbox-agent-runtime/tools/sandbox-cli-tool.js";
import { userMemoryNamespace } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import {
  fromTemporaryIsbSpokeCredentials,
  parsePartitionFromArn,
  sandboxAgentRoleArn,
} from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";
import {
  Agent,
  BeforeModelCallEvent,
  BeforeToolCallEvent,
  type ContextStrategy,
  InvokeOptions,
  type MemoryEntry,
  MemoryManager,
  type MemoryStore,
  Message,
  Offload,
  TextBlock,
} from "@strands-agents/sdk";
import { BedrockModel } from "@strands-agents/sdk/models/bedrock";
import { createAgentCoreMemoryStores } from "bedrock-agentcore/memory/strands";

/**
 * Builds a single Strands `Agent` for a turn. Memory identity is fixed at
 * construction time from the trusted invoke payload — a prompt cannot mutate it.
 */

/**
 * Bounds a single invocation so a tool loop cannot run until the Worker
 * Lambda's 15-minute timeout. Without a cap, a slow loop holds its SQS
 * message, saturating the Worker's reserved concurrency and spiking latency
 * for every active user.
 *
 * The SDK counts **turns** (one model call plus any tool execution that
 * follows), so this is not literally a cap on tool calls. Exceeding it returns
 * `stopReason: "limitTurns"`; the runtime sends the turn-limit fallback and a
 * normal complete frame.
 *
 * Applied at invoke time, not construction: the SDK exposes limits on
 * `invoke()`/`stream()` options rather than `AgentConfig`.
 */

/** Max memory entries recalled into the system prompt when a chat starts. */
const RECALL_MAX_ENTRIES = 5;

/** The name MemoryManager gives its search tool. */
const SEARCH_MEMORY_TOOL_NAME = "search_memory";

export const DEFAULT_INVOCATION_LIMITS: InvokeOptions["limits"] = {
  turns: 25,
};

const TURN_START_TRIM_UTILIZATION = 0.7; // 70%
const MID_TURN_GUARD_UTILIZATION = 0.9; // 90%

export const CONTEXT_GUARD_MESSAGE =
  "I stopped because this request needed more room than this conversation has left. Commands I ran before stopping have already taken effect, so check what they changed before you ask me to run them again. Ask me to continue, or split the task into smaller parts.";

export interface BuildAgentProps {
  /** Identity and scope for this invocation, from the Worker's payload. */
  context: SandboxCliToolContext;
  /**
   * The per-turn model the client selected, forwarded unchanged by the Worker.
   * Drives the orchestrator model so the selected model is the one invoked.
   */
  modelId: string;
  services: ExecuteSandboxCliServices;
  env: AgentRuntimeEnvironment;
  /**
   * AgentCore Memory identity — enables in-runtime STM persistence via
   * `AgentCoreMemoryStore`. Recall is through `search_memory`; new turns
   * are saved after each response.
   * Omit to disable memory (runtime remains stateless).
   */
  memory?: {
    memoryId: string;
    actorId: string;
    sessionId: string;
    region: string;
  };
}

/**
 * Creates the AgentCore Memory stores bound to the memory identity from the
 * invoke payload. Called only when the caller passes a `memory` block on
 * `BuildAgentProps`.
 *
 * The identity and resolved LTM namespace are baked into the store at
 * construction time, so cross-lease isolation depends on this function
 * receiving the right values from the trusted invoke payload — a prompt
 * cannot mutate them afterward.
 */
function createMemoryStores(
  memory: NonNullable<BuildAgentProps["memory"]>,
  env: GuardrailScreeningEnv,
): MemoryStore[] {
  const resolvedNamespace = userMemoryNamespace(
    memory.actorId,
    memory.sessionId,
  );

  return createAgentCoreMemoryStores({
    memoryId: memory.memoryId,
    actorId: memory.actorId,
    sessionId: memory.sessionId,
    region: memory.region,
    namespaces: [{ namespace: resolvedNamespace, writable: true }],
    extraction: true,
  }).map((memoryStore) => withScreenedSearch(memoryStore, env));
}

/**
 * Wraps `memoryStore` so `search()` returns masked entries, drops blocked
 * ones, and withholds ones that couldn't be screened. MemoryManager records
 * the entries on its `memory.search` span before `search_memory` returns, so
 * screening the tool result alone is too late.
 */
function withScreenedSearch(
  memoryStore: MemoryStore,
  env: GuardrailScreeningEnv,
): MemoryStore {
  const search: MemoryStore["search"] = async (query, options) =>
    screenMemoryEntries(await memoryStore.search(query, options), env);
  return new Proxy(memoryStore, {
    get: (target, property, receiver) =>
      property === "search" ? search : Reflect.get(target, property, receiver),
  });
}

export const MEMORY_ENTRY_WITHHELD_TEXT =
  "This saved memory can't be shown because the safety check that reviews memory failed to run. " +
  "Tell the user you couldn't read their saved memory right now.";

async function screenMemoryEntries(
  memoryEntries: MemoryEntry[],
  env: GuardrailScreeningEnv,
): Promise<MemoryEntry[]> {
  const screened = await Promise.all(
    memoryEntries.map(async (entry) => {
      let result: Awaited<ReturnType<typeof screenUserText>>;
      try {
        result = await screenUserText(entry.content, env);
      } catch (err) {
        console.warn("Memory entry screening failed", {
          characters: entry.content.length,
          name: err instanceof Error ? err.name : typeof err,
        });
        return [{ ...entry, content: MEMORY_ENTRY_WITHHELD_TEXT }];
      }
      if (result.blocked) {
        console.warn("Memory entry blocked by the guardrail", {
          characters: entry.content.length,
          blockedBy: result.blockedBy,
        });
        return [];
      }
      return [{ ...entry, content: result.text }];
    }),
  );
  return screened.flat();
}

/**
 * Builds the orchestrator agent for a single invocation.
 *
 * Per-invocation rather than module-scoped because the CLI tool closes over
 * caller identity: reusing one agent across callers would leak the first
 * caller's scope into later turns.
 */
export function buildAgent(props: BuildAgentProps): Agent {
  const { context, modelId, services, env, memory } = props;

  // `undefined` when memory is off; the agent then runs stateless.
  const memoryStores = memory ? createMemoryStores(memory, env) : undefined;
  // No auto-injection: it changes the user message between calls, which
  // breaks reasoning signatures. The model uses `search_memory` instead.
  const memoryManager = memoryStores
    ? new MemoryManager({ stores: memoryStores, injection: false })
    : undefined;

  const promptContext: PromptContext = {
    accountId: context.accountId,
    regions: context.regions,
    memoryEnabled: memoryManager !== undefined,
  };

  const sandboxCliTool = buildSandboxCliTool(context, services, env);

  const agent = new Agent({
    model: new BedrockModel({
      modelId,
      // Pinned to the hub home region so the system inference profile in
      // `modelId` resolves there under the assumed sandbox credentials.
      region: env.AWS_REGION,
      clientConfig: {
        credentials: buildInferenceCredentials(context, env),
      },
      guardrailConfig: {
        guardrailIdentifier: env.GUARDRAIL_ID,
        guardrailVersion: env.GUARDRAIL_VERSION,
        // Check only the newest user message. Re-checking the agent's old
        // replies can block every later turn.
        guardLatestUserMessage: true,
        // On a block, don't overwrite the last message; it can be a command
        // result. User input is already pre-screened.
        redaction: { input: false },
      },
      // Strands caches Anthropic/Claude model IDs only and skips others.
      cacheConfig: { strategy: "auto" },
    }),
    systemPrompt: orchestratorPrompt(promptContext),
    tools: [sandboxCliTool],
    // Trim large tool output; drop old messages only at a turn's start,
    // before it has signed reasoning. No summarizer: rewriting history
    // breaks reasoning signatures.
    contextManager: {
      strategies: ["largeToolOffloading", turnStartTrim()],
    },
    printer: false,
    memoryManager,
    retryStrategy: modelRetryStrategies(),
  });
  agent.addHook(BeforeModelCallEvent, (event) =>
    dropPriorTurnReasoning(event.agent.messages),
  );
  agent.addHook(BeforeModelCallEvent, endTurnBeforeContextOverflow);
  agent.addHook(BeforeToolCallEvent, (event) => {
    const tool = event.selectedTool ?? event.tool;
    // The memory stores already screen each entry search_memory returns.
    if (!tool || event.toolUse.name === SEARCH_MEMORY_TOOL_NAME) return;
    event.selectedTool = withScreenedOutput(
      tool,
      env,
      event.toolUse.name === sandboxCliTool.name
        ? SANDBOX_CLI_OUTPUT_NOTES
        : DEFAULT_TOOL_OUTPUT_NOTES,
    );
  });
  if (memoryStores) {
    addOneTimeRecall(agent, memoryStores, promptContext);
  }
  return agent;
}

/**
 * Drops old messages only on a turn's first model call. Trimming after a
 * tool result would change the history the current reasoning is signed over.
 */
function turnStartTrim(): ContextStrategy {
  const truncateOldMessages = Offload.truncate("*").when({
    utilization: TURN_START_TRIM_UTILIZATION,
    preserveRecent: 4,
  });
  return {
    name: "turn-start-trim",
    init: (agent, stash) => truncateOldMessages.init?.(agent, stash),
    apply: async (context) => {
      const latest = context.messages.at(-1);
      return latest !== undefined && isUserMessage(latest)
        ? truncateOldMessages.apply(context)
        : false;
    },
  };
}

/**
 * Ends the reply with a message instead of a mid-turn model call that would
 * overfill the context, before Strands' emergency trim edits signed history.
 */
function endTurnBeforeContextOverflow(event: BeforeModelCallEvent): void {
  const latest = event.agent.messages.at(-1);
  if (
    event.projectedInputTokens === undefined ||
    latest?.role !== "user" ||
    !isToolResultMessage(latest)
  ) {
    return;
  }
  if (
    event.model.estimateUtilization(event.projectedInputTokens) >=
    MID_TURN_GUARD_UTILIZATION
  ) {
    event.cancel = CONTEXT_GUARD_MESSAGE;
  }
}

/**
 * Recalls memory into the system prompt once, before the agent's first model
 * call. The prompt then stays fixed for the agent's life, so reasoning
 * signatures hold.
 */
function addOneTimeRecall(
  agent: Agent,
  memoryStores: MemoryStore[],
  promptContext: PromptContext,
): void {
  let recallStarted = false;
  agent.addHook(BeforeModelCallEvent, async () => {
    if (recallStarted) return;
    recallStarted = true;
    const query = latestUserText(agent.messages);
    if (!query) return;
    const recall = await recallMemory(memoryStores, query);
    if (recall.failed) {
      // Tell the model, so it asks instead of assuming there's no history.
      agent.systemPrompt = orchestratorPrompt({
        ...promptContext,
        memoryRecallFailed: true,
      });
    } else if (recall.memoryEntries.length > 0) {
      agent.systemPrompt = orchestratorPrompt({
        ...promptContext,
        recalledMemory: recall.memoryEntries,
      });
    }
  });
}

/**
 * Searches each store directly; MemoryManager.search hides store errors.
 * The stores return screened entries. Recall fails when every returned
 * entry was withheld.
 */
async function recallMemory(
  memoryStores: MemoryStore[],
  query: string,
): Promise<{ failed: true } | { failed: false; memoryEntries: string[] }> {
  let contents: string[];
  try {
    const results = await Promise.all(
      memoryStores.map((memoryStore) =>
        memoryStore.search(query, { maxSearchResults: RECALL_MAX_ENTRIES }),
      ),
    );
    contents = results.flat().map((entry) => entry.content);
  } catch (err) {
    console.warn("Memory recall failed", {
      name: err instanceof Error ? err.name : typeof err,
    });
    return { failed: true };
  }
  const memoryEntries = contents.filter(
    (content) => content !== MEMORY_ENTRY_WITHHELD_TEXT,
  );
  return memoryEntries.length === 0 && contents.length > 0
    ? { failed: true }
    : { failed: false, memoryEntries };
}

/** Text of the latest message the user sent. */
function latestUserText(messages: Message[]): string {
  const message = [...messages].reverse().find(isUserMessage);
  return message ? messageText(message, " ").trim() : "";
}

/** Replaces a reply that held only reasoning. */
export const REASONING_OMITTED_TEXT = "[reasoning omitted]";

/**
 * Drops reasoning from replies before the current user message, in place.
 * Old reasoning is tied to the exact history before it; if that history
 * changes, the model rejects every later turn. Current-turn reasoning is
 * kept because the model needs it. An emptied reply gets placeholder text.
 */
export function dropPriorTurnReasoning(messages: Message[]): void {
  let currentTurnStart = messages.length - 1;
  while (currentTurnStart >= 0 && !isUserMessage(messages[currentTurnStart]!)) {
    currentTurnStart--;
  }
  for (let i = 0; i < currentTurnStart; i++) {
    const message = messages[i]!;
    if (message.role !== "assistant") continue;
    const contentWithoutReasoning = message.content.filter(
      (block) => block.type !== "reasoningBlock",
    );
    if (contentWithoutReasoning.length === message.content.length) continue;
    messages[i] = new Message({
      role: message.role,
      content:
        contentWithoutReasoning.length > 0
          ? contentWithoutReasoning
          : [new TextBlock(REASONING_OMITTED_TEXT)],
      trackingId: message.trackingId,
      metadata: message.metadata,
    });
  }
}

/**
 * A message the user sent, not a tool result. Same rule the SDK uses to
 * pick the message the guardrail checks.
 */
function isUserMessage(message: Message): boolean {
  return (
    message.role === "user" &&
    message.content.some(
      (block) => block.type === "textBlock" || block.type === "imageBlock",
    )
  );
}

const INFERENCE_SESSION_NAME = "IsbSandboxInferenceSession";

/**
 * Returns a credentials provider (not resolved credentials) so the Bedrock
 * client re-assumes on its own when the 15-minute session expires — a cached
 * Agent can outlive a single assume.
 */
function buildInferenceCredentials(
  context: SandboxCliToolContext,
  env: AgentRuntimeEnvironment,
) {
  const partition = parsePartitionFromArn(env.INTERMEDIATE_ROLE_ARN);
  const sessionPolicy = buildInferenceSessionPolicy({ partition });

  // Assume SandboxAgentRole on its own call with the inference session policy,
  // so the CLI tool's session is never granted Bedrock. actorId is the
  // SourceIdentity on both hops for per-user attribution.
  return fromTemporaryIsbSpokeCredentials({
    intermediateRoleArn: env.INTERMEDIATE_ROLE_ARN,
    targetRoleArn: sandboxAgentRoleArn(
      partition,
      context.accountId,
      env.SANDBOX_AGENT_ROLE_NAME,
    ),
    sessionName: INFERENCE_SESSION_NAME,
    intermediateSessionName: INFERENCE_SESSION_NAME,
    sourceIdentity: context.actorId,
    sessionPolicy: JSON.stringify(sessionPolicy),
    customUserAgent: env.USER_AGENT_EXTRA,
  });
}

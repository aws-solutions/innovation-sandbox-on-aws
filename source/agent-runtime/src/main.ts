// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  paginateListEvents,
  type Event as AgentCoreEvent,
} from "@aws-sdk/client-bedrock-agentcore";
import { BedrockAgentCoreApp } from "bedrock-agentcore/runtime";

import {
  buildAgent,
  DEFAULT_INVOCATION_LIMITS,
} from "@amzn/innovation-sandbox-agent-runtime/agent.js";
import {
  dropUnansweredUserMessages,
  startAtFirstUserMessage,
} from "@amzn/innovation-sandbox-agent-runtime/conversation.js";
import {
  AgentRuntimeEnvironment,
  AgentRuntimeEnvironmentSchema,
} from "@amzn/innovation-sandbox-agent-runtime/environment.js";
import {
  screenUserText,
  type GuardrailBlock,
} from "@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js";
import { modelErrorFrame } from "@amzn/innovation-sandbox-agent-runtime/model-errors.js";
import { ExecuteSandboxCliServices } from "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js";
import { SandboxCliToolContext } from "@amzn/innovation-sandbox-agent-runtime/tools/sandbox-cli-tool.js";
import {
  completeFrame,
  streamTurn,
  TurnStreamError,
  type TurnEnding,
} from "@amzn/innovation-sandbox-agent-runtime/turn-stream.js";
import { IsbServices } from "@amzn/innovation-sandbox-commons/isb-services/index.js";
import {
  mapMemoryEventsToMessages,
  RUNTIME_ERROR_CODES,
  RuntimeErrorFrame,
  RuntimeInvokePayload,
  RuntimeInvokePayloadSchema,
  RuntimeStreamEvent,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { parseLeaseKey } from "@amzn/innovation-sandbox-commons/utils/lease-key.js";
import { Agent, Message, TextBlock } from "@strands-agents/sdk";
import AWSXRay from "aws-xray-sdk-core";

/**
 * Extracts `{ name, message }` from an unknown thrown value for structured
 * logging. Prefers `Error` narrowing so we don't type-assert against a shape
 * we don't own; falls back to `String(err)` for non-Error throws.
 */
function errMeta(err: unknown): { name?: string; message: string } {
  if (err instanceof Error) return { name: err.name, message: err.message };
  return { message: String(err) };
}

/** Logged as the code of a failure that matched no runtime error code, so every AgentTurnFailed record has one. */
const UNCLASSIFIED_FAILURE_CODE = "UNCLASSIFIED";

/** Logs one JSON record per failed turn, so failures can be counted by code in CloudWatch. */
function logFailedTurn(failure: {
  code: string | undefined;
  stopReason: string | undefined;
  cycleCount: number | undefined;
  toolRan: boolean;
  error?: unknown;
}): void {
  const { error, code, ...fields } = failure;
  const meta = error === undefined ? undefined : errMeta(error);
  console.warn(
    JSON.stringify({
      level: "warn",
      message: "AgentTurnFailed",
      code: code ?? UNCLASSIFIED_FAILURE_CODE,
      ...fields,
      errorName: meta?.name,
      errorMessage: meta?.message,
    }),
  );
}

/** Logs which guardrail policies blocked the user's message; `blockedBy` never carries the message or matched text. */
function logBlockedInput(blockedBy: GuardrailBlock[]): void {
  console.warn(
    JSON.stringify({ level: "warn", message: "UserInputBlocked", blockedBy }),
  );
}

function isFilteredWithoutReply(ending: TurnEnding): boolean {
  return ending.stopReason === "contentFiltered" && !ending.lastCallHasText;
}

function logTurnEnding(ending: TurnEnding): void {
  console.info("Agent turn ended", {
    stopReason: ending.stopReason,
    cycleCount: ending.cycleCount,
    hasStreamedText: ending.hasStreamedText,
  });
}

function withToolRan(
  frame: RuntimeErrorFrame,
  toolRan: boolean,
): RuntimeErrorFrame {
  return toolRan ? { ...frame, toolRan } : frame;
}

/** Undefined when the frame would add nothing to the one AgentCore sends for a thrown error. */
function streamFailureFrame(
  failure: TurnStreamError,
): RuntimeErrorFrame | undefined {
  const frame = modelErrorFrame(failure.cause, failure.modelStopReason);
  if (!frame && !failure.toolRan) return undefined;
  return withToolRan(
    frame ?? { error: errMeta(failure.cause).message },
    failure.toolRan,
  );
}

const LIST_EVENTS_PAGE_SIZE = 100;

/**
 * Hub home region is not an ISB-managed region.
 *
 * SECURITY-CRITICAL: inference is pinned to the hub home region, so any Bedrock
 * logs a user enables land there. aws-nuke only cleans managed regions on
 * recycle, so logs in an unmanaged home region survive into the next lease — a
 * cross-tenant leak. The message compares only operator-configured regions, no
 * request data, so it is safe to surface to the client.
 */
export class HubRegionNotManagedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HubRegionNotManagedError";
  }
}

const TURN_IN_PROGRESS_ERROR_FRAME: RuntimeErrorFrame = {
  error: "The agent is still processing a previous turn for this session.",
  code: RUNTIME_ERROR_CODES.turnInProgress,
};

const INPUT_BLOCKED_ERROR_FRAME: RuntimeErrorFrame = {
  error: "The guardrail blocked the user's message before the model ran.",
  code: RUNTIME_ERROR_CODES.inputBlocked,
};

const CONTENT_FILTERED_ERROR_FRAME: RuntimeErrorFrame = {
  error: "The model's content filter stopped the model call.",
  code: RUNTIME_ERROR_CODES.contentFiltered,
};

/**
 * True while a turn runs. AgentCore gives each session its own microVM, so this
 * process serves one session. Set before the first await, so a second turn
 * can't pass the check.
 */
let turnInFlight = false;

/** Throws {@link HubRegionNotManagedError} when the hub home region is not managed. */
function assertHubRegionManaged(
  hubHomeRegion: string,
  managedRegions: string[],
): void {
  if (!managedRegions.includes(hubHomeRegion)) {
    throw new HubRegionNotManagedError(
      "This sandbox's home region is not managed by Innovation Sandbox. " +
        "Sandbox Spaces is unavailable here — contact your administrator.",
    );
  }
}

/**
 * Cap on history reloaded from STM on cold start, to keep the first call cheap.
 */
const REHYDRATION_MESSAGE_LIMIT = 60;

/**
 * Fetches at least `limit` most-recent messages from STM and converts them
 * into Strands `Message` objects for rehydrating `agent.messages` on cold
 * start. Paginates `ListEvents` (newest-first) until enough events are
 * collected, reverses to chronological, then tail-slices to the last
 * `limit` messages so the model sees the most recent turns. Only text
 * `conversational` payloads are surfaced; extend for tool blocks if needed.
 *
 * Note one event can carry a user + an assistant payload, so we page by
 * events but slice by messages — `limit` events yields up to `2 * limit`
 * messages, and we keep the last `limit` of those.
 */
async function fetchRecentMessages(args: {
  env: AgentRuntimeEnvironment;
  memoryId: string;
  actorId: string;
  sessionId: string;
  limit: number;
}): Promise<Message[]> {
  const { env, memoryId, actorId, sessionId, limit } = args;
  // Use the shared factory so X-Ray tracing + `USER_AGENT_EXTRA` are applied
  // consistently with the other memory / runtime calls.
  const client = IsbClients.bedrockAgentCore(env);

  // `paginateListEvents` handles the `nextToken` bookkeeping; we still
  // early-break once we have `limit` events so we don't scan the whole
  // session on a long-running lease.
  const collected: AgentCoreEvent[] = [];
  const paginator = paginateListEvents(
    { client, pageSize: LIST_EVENTS_PAGE_SIZE },
    { memoryId, actorId, sessionId, includePayloads: true },
  );
  for await (const page of paginator) {
    for (const event of page.events ?? []) {
      collected.push(event);
      if (collected.length >= limit) break;
    }
    if (collected.length >= limit) break;
  }

  // ListEvents returns newest-first; reverse to chronological so the resulting
  // Message[] is ordered as the conversation actually happened.
  collected.reverse();
  const plain = dropUnansweredUserMessages(
    mapMemoryEventsToMessages(collected),
  );
  const messages = plain.map(
    (m) => new Message({ role: m.role, content: [new TextBlock(m.content)] }),
  );

  // Slice from the tail: chronological order after reverse() puts the OLDEST
  // turn at index 0, and `limit` events can produce up to `2 * limit`
  // messages. The cut can land inside one turn's assistant messages.
  return startAtFirstUserMessage(
    messages.slice(Math.max(0, messages.length - limit)),
  );
}

/**
 * Per-microVM cache of the built Agent instance. AgentCore Runtime pins each
 * session to a dedicated microVM, so this holds at most one Agent — for the
 * session this microVM serves. The cache dies with the microVM when the
 * session ends, so there is no cross-session leakage concern.
 *
 * `context` is stored by reference. `buildSandboxCliTool` closes over the same
 * object, so mutating `context.permissionProfilePolicy` etc. on a warm turn (see
 * `refreshPerTurnContext` below) is visible on the next tool call, keeping
 * per-turn policy resolution effective across warm turns instead of freezing at
 * first-turn values.
 */
let cachedAgent:
  | {
      sessionId: string;
      modelId: string;
      agent: Agent;
      context: SandboxCliToolContext;
    }
  | undefined;

/**
 * Refreshes the per-turn fields on the cached tool context. Called on every
 * turn (both cache-hit and cache-miss) so that a mid-session permission-set
 * change is picked up on the next tool call rather than at microVM recycle.
 * Fields that are stable for the session (`actorId`, `leaseId`,
 * `regions`) are left alone.
 */
function refreshPerTurnContext(
  context: SandboxCliToolContext,
  invoke: Pick<
    SandboxCliToolContext,
    | "accountId"
    | "permissionProfilePolicy"
    | "permissionProfileManagedPolicyArns"
  >,
): void {
  context.accountId = invoke.accountId;
  context.permissionProfilePolicy = invoke.permissionProfilePolicy;
  context.permissionProfileManagedPolicyArns =
    invoke.permissionProfileManagedPolicyArns;
}

/**
 * Rehydrates STM onto `agent.messages` on cache miss so a cold start (idle
 * timeout, max-lifetime recycle, first turn of a resumed session) restores
 * prior conversation context. Messages are pushed directly to bypass
 * `MessageAddedEvent` — otherwise the ExtractionCoordinator would re-buffer
 * them and duplicate them into STM on the next `flush()`. Capped at
 * `REHYDRATION_MESSAGE_LIMIT` so we don't fetch a huge history. Best-effort:
 * on failure we log and keep going with an empty history.
 */
async function rehydrateStm(
  agent: Agent,
  args: {
    env: AgentRuntimeEnvironment;
    memoryId: string;
    actorId: string;
    sessionId: string;
  },
): Promise<void> {
  try {
    const restored = await fetchRecentMessages({
      ...args,
      limit: REHYDRATION_MESSAGE_LIMIT,
    });
    for (const message of restored) {
      agent.messages.push(message);
    }
  } catch (err) {
    console.warn("STM rehydrate failed", errMeta(err));
  }
}

/**
 * Builds a fresh Agent for a cache miss. Decodes the memory sessionId,
 * constructs the tool context, wires AgentCore Memory (when USER_MEMORY_ID +
 * decoded sessionId are available), and rehydrates STM onto the new agent.
 */
async function buildAgentForTurn(args: {
  invoke: RuntimeInvokePayload;
  services: ExecuteSandboxCliServices;
  env: AgentRuntimeEnvironment;
}): Promise<{
  agent: Agent;
  context: SandboxCliToolContext;
}> {
  const { invoke, services, env } = args;

  const leaseKey = env.USER_MEMORY_ID
    ? parseLeaseKey(invoke.leaseKey)
    : undefined;
  if (env.USER_MEMORY_ID && !leaseKey) {
    console.warn("Invalid lease key — proceeding without memory");
  }
  const memorySessionId = leaseKey?.uuid;
  const memoryOn = Boolean(env.USER_MEMORY_ID && memorySessionId);

  const context: SandboxCliToolContext = {
    actorId: invoke.actorId,
    leaseId: invoke.leaseKey,
    accountId: invoke.accountId,
    regions: invoke.regions,
    permissionProfilePolicy: invoke.permissionProfilePolicy,
    permissionProfileManagedPolicyArns:
      invoke.permissionProfileManagedPolicyArns,
  };

  const agent = buildAgent({
    context,
    modelId: invoke.modelId,
    services,
    env,
    // Strands MemoryManager writes new turns via `MemoryManager.flush()` at
    // end-of-turn (see `flushMemory` below).
    ...(memoryOn
      ? {
          memory: {
            memoryId: env.USER_MEMORY_ID!,
            actorId: invoke.userId,
            sessionId: memorySessionId!,
            region: env.AWS_REGION,
          },
        }
      : {}),
  });

  if (memoryOn) {
    await rehydrateStm(agent, {
      env,
      memoryId: env.USER_MEMORY_ID!,
      actorId: invoke.userId,
      sessionId: memorySessionId!,
    });
  }

  return { agent, context };
}

/**
 * Strands MemoryManager buffers events via an ExtractionCoordinator that
 * writes on turn-based triggers in the background. In a single-turn-per-
 * invocation runtime like ours, that trigger may never fire before the
 * stream ends, so nothing reaches AgentCore Memory. Flushing at each turn
 * boundary forces the buffered messages to be persisted before we return.
 * Best-effort: a flush error must not fail the turn.
 */
async function flushMemory(agent: Agent): Promise<void> {
  if (!agent.memoryManager) return;
  await agent.memoryManager.flush().catch((err: unknown) => {
    // Structured JSON log picked up by the `MemoryWriteFailureMetricFilter`
    // in CDK (matches on `$.message = "MemoryWriteFailure"`).
    const meta = errMeta(err);
    console.error(
      JSON.stringify({
        level: "error",
        message: "MemoryWriteFailure",
        reason: "memoryManager.flush failed",
        errorName: meta.name,
        errorMessage: meta.message,
      }),
    );
  });
}

/**
 * Runs one agent turn, yielding stream events as they occur.
 *
 * Exported so tests can drive a turn without starting the HTTP server.
 */
export async function* runAgentTurn(
  payload: unknown,
  sessionId: string,
  services: ExecuteSandboxCliServices,
  env: AgentRuntimeEnvironment,
): AsyncGenerator<RuntimeStreamEvent | RuntimeErrorFrame, void, unknown> {
  const invoke = RuntimeInvokePayloadSchema.parse(payload);

  // Fail closed before any Bedrock call (including input screening, which
  // calls ApplyGuardrail), so nothing is attempted when the guard trips
  // (see HubRegionNotManagedError).
  assertHubRegionManaged(env.AWS_REGION, invoke.regions);

  if (turnInFlight) {
    yield TURN_IN_PROGRESS_ERROR_FRAME;
    return;
  }
  turnInFlight = true;
  let stream: AsyncGenerator<unknown, unknown> | undefined;
  try {
    // Screen user text before it can enter the conversation: what reaches
    // stream() is what Strands keeps and the MemoryManager persists. Masked text
    // replaces a pasted secret; a blocked message never reaches the agent, so the
    // turn adds nothing to the history or memory.
    const screened = await Promise.all(
      invoke.messages.map(async (message) =>
        message.role === "user"
          ? screenUserText(message.content, env)
          : { blocked: false as const, text: message.content },
      ),
    );
    const texts: string[] = [];
    for (const result of screened) {
      if (result.blocked) {
        logBlockedInput(result.blockedBy);
        yield INPUT_BLOCKED_ERROR_FRAME;
        return;
      }
      texts.push(result.text);
    }

    // Look up the cached agent for this session. On a cache hit the agent
    // retains its full message history (including all prior turns) and its
    // MemoryManager's ExtractionCoordinator buffers, so we just append the new
    // turn via stream(). On a warm turn we refresh the per-turn tool-context
    // fields so a mid-session permission-set change (design: "per-turn policy
    // resolution") reaches the next tool call via the CLI-tool closure.
    //
    // The cache is keyed on (sessionId, modelId): the model is baked into the
    // Agent at construction, so a turn that selects a different model must
    // rebuild rather than reuse the prior model. STM rehydration (memory-on)
    // restores history onto the rebuilt agent, so a model switch does not lose
    // prior context.
    let agent: Agent;
    if (
      cachedAgent?.sessionId === sessionId &&
      cachedAgent.modelId === invoke.modelId
    ) {
      refreshPerTurnContext(cachedAgent.context, invoke);
      agent = cachedAgent.agent;
      // A failed model call leaves its user message unanswered; drop it before
      // stream() appends the current one. Cold history is filtered on rehydration.
      agent.messages.splice(
        0,
        agent.messages.length,
        ...dropUnansweredUserMessages(agent.messages),
      );
    } else {
      const built = await buildAgentForTurn({ invoke, services, env });
      agent = built.agent;
      cachedAgent = {
        sessionId,
        modelId: invoke.modelId,
        agent,
        context: built.context,
      };
    }

    // Only the current-turn user message goes through stream(). On a cache hit,
    // agent.messages already carries the full conversation; on a cache miss,
    // STM rehydration has seeded it. Passing the whole invoke.messages list on a
    // cache hit would re-append prior turns via MessageAddedEvent and duplicate
    // them in the next flush.
    const messages = invoke.messages.map((message, i) => ({
      role: message.role,
      content: [
        {
          type: "text" as const,
          text: texts[i]!,
        },
      ],
    }));

    stream = agent.stream(messages, {
      limits: DEFAULT_INVOCATION_LIMITS,
    });
    let ending: TurnEnding | undefined;
    try {
      ending = yield* streamTurn(stream, agent);
    } catch (err) {
      if (!(err instanceof TurnStreamError)) throw err;
      const frame = streamFailureFrame(err);
      logFailedTurn({
        code: frame?.code,
        stopReason: err.modelStopReason,
        cycleCount: err.cycleCount,
        toolRan: err.toolRan,
        error: err.cause,
      });
      if (!frame) throw err.cause;
      yield frame;
      return;
    }
    if (!ending) {
      yield TURN_IN_PROGRESS_ERROR_FRAME;
      return;
    }
    logTurnEnding(ending);
    if (isFilteredWithoutReply(ending)) {
      logFailedTurn({
        code: RUNTIME_ERROR_CODES.contentFiltered,
        stopReason: ending.stopReason,
        cycleCount: ending.cycleCount,
        toolRan: ending.toolRan,
      });
      // No warm-history reply, because the user gets the error instead of one.
      await flushMemory(agent);
      yield withToolRan(CONTENT_FILTERED_ERROR_FRAME, ending.toolRan);
      return;
    }
    // Limit and MaxTokens endings leave history on a user message.
    if (agent.messages.at(-1)?.role === "user") {
      // Warm context only: pushed directly, so MemoryManager never saves it.
      agent.messages.push(
        new Message({
          role: "assistant",
          content: [new TextBlock(ending.replyToUser)],
        }),
      );
    }
    await flushMemory(agent);
    yield completeFrame(ending.usage);
  } finally {
    try {
      // If the consumer stopped early, closing runs Strands' own finally, which
      // releases its invocation lock. No-op when the stream already finished.
      await stream?.return(undefined);
    } finally {
      turnInFlight = false;
    }
  }
}

export function start(): void {
  const env = AgentRuntimeEnvironmentSchema.parse(process.env);

  // Silence X-Ray "Failed to get sub/segment from context" noise for background
  // AWS SDK calls (IMDS token fetch, DDB queries) that run outside any active segment.
  // These are non-fatal — the operations succeed regardless.
  AWSXRay.setContextMissingStrategy("IGNORE_ERROR");

  const services: ExecuteSandboxCliServices = {
    leaseStore: IsbServices.leaseStore(env),
  };

  const app = new BedrockAgentCoreApp({
    invocationHandler: {
      process: (payload, context) =>
        runAgentTurn(payload, context.sessionId, services, env),
    },
  });

  app.run();
}

// Entry point when the container starts. Guarded so importing this module in
// tests does not bind port 8080.
if (process.env.NODE_ENV !== "test") {
  start();
}

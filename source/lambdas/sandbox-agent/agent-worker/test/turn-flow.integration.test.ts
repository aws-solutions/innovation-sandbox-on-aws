// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Drives a chat turn from the Worker's SQS record through the Worker handler
 * (SSE parsing, error mapping, pricing, usage recording) and the agent
 * runtime's code in-process (`runAgentTurn`, `buildAgent`, Strands Agent and
 * BedrockModel, screening hooks, turn-stream). Bedrock, AgentCore and the
 * Worker's stores are faked; AgentCore's SSE framing is reproduced in the test.
 */

import { AgentWorkerLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/agent-worker-lambda-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import {
  ApiGatewayManagementApiClient,
  PostToConnectionCommand,
} from "@aws-sdk/client-apigatewaymanagementapi";
import {
  BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from "@aws-sdk/client-bedrock-agentcore";
import {
  ApplyGuardrailCommand,
  BedrockRuntimeClient,
  ConverseStreamCommand,
  type ConverseStreamCommandInput,
  type ConverseStreamOutput,
} from "@aws-sdk/client-bedrock-runtime";
import type { SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

// ─── Runtime source resolution ───────────────────────────────────────────────
//
// The runtime imports its own modules as `@amzn/innovation-sandbox-agent-runtime/<name>.js`,
// which only its own vitest alias maps to `src/`. Each id is redirected to the
// real source file here, so every importer shares one module instance. The
// specifier is computed so the Worker's `tsc` does not type-check runtime
// source against the Worker's path map.

const { runtimeModule, cliStub } = vi.hoisted(() => ({
  runtimeModule: (name: string): Promise<Record<string, unknown>> =>
    import(
      /* @vite-ignore */ `${import.meta.dirname}/../../../../agent-runtime/src/${name}.ts`
    ),
  cliStub: vi.fn(),
}));

vi.mock("@amzn/innovation-sandbox-agent-runtime/agent.js", () =>
  runtimeModule("agent"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/conversation.js", () =>
  runtimeModule("conversation"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/environment.js", () =>
  runtimeModule("environment"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/guardrail-screening.js", () =>
  runtimeModule("guardrail-screening"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/model-errors.js", () =>
  runtimeModule("model-errors"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/model-retry.js", () =>
  runtimeModule("model-retry"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/prompts.js", () =>
  runtimeModule("prompts"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/session-policy.js", () =>
  runtimeModule("session-policy"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/tool-output-guardrail.js", () =>
  runtimeModule("tool-output-guardrail"),
);
vi.mock("@amzn/innovation-sandbox-agent-runtime/turn-stream.js", () =>
  runtimeModule("turn-stream"),
);
vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/tools/sandbox-cli-tool.js",
  () => runtimeModule("tools/sandbox-cli-tool"),
);
// The CLI itself is stubbed: it would assume roles and spawn the AWS CLI.
vi.mock(
  "@amzn/innovation-sandbox-agent-runtime/tools/execute-sandbox-cli.js",
  async () => ({
    ...(await runtimeModule("tools/execute-sandbox-cli")),
    executeSandboxCli: cliStub,
  }),
);

// ─── Worker-side fakes (same seams as worker-handler.test.ts) ────────────────

const {
  connectionGet,
  configGetSection,
  configGetAgentModel,
  priceDiscoveredModels,
  recordTurnUsage,
  getLeaseUserUsage,
  validateAndRoute,
} = vi.hoisted(() => ({
  connectionGet: vi.fn(),
  configGetSection: vi.fn(),
  configGetAgentModel: vi.fn(),
  priceDiscoveredModels: vi.fn(),
  recordTurnUsage: vi.fn(),
  getLeaseUserUsage: vi.fn(),
  validateAndRoute: vi.fn(),
}));

vi.mock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
  IsbServices: {
    connectionStore: () => ({ get: connectionGet }),
    configStore: () => ({
      getSection: configGetSection,
      getAgentModel: configGetAgentModel,
    }),
    bedrockPriceCache: () => ({}),
    sandboxSpacesUsageStore: () => ({ recordTurnUsage, getLeaseUserUsage }),
    leaseStore: () => ({ get: vi.fn() }),
    accountPoolStackConfigStore: () => ({
      get: async () => ({ isbManagedRegions: ["us-east-1"] }),
    }),
    principalStore: () => ({
      getAssignmentsForPrincipalAndLease: async () => [
        {
          principalType: "USER",
          permissionSetArn: "arn:aws:sso:::permissionSet/ins-abc/ps-alice",
        },
      ],
    }),
    idcStackConfigStore: () => ({
      get: async () => ({ ssoInstanceArn: "arn:aws:sso:::instance/test" }),
    }),
  },
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/bedrock-model-catalog/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    priceDiscoveredModels,
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    validateAndRoute,
  }),
);

vi.mock(
  "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    resolvePermissionSetPolicy: async () => ({
      sessionPolicy: {
        Version: "2012-10-17",
        Statement: [{ Effect: "Allow", Action: "*", Resource: "*" }],
      },
      managedPolicyArns: [],
    }),
  }),
);

// No STS: the Worker's IDC chain and the runtime's inference chain get static credentials.
vi.mock(
  "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
  async (importOriginal) => ({
    ...(await importOriginal<Record<string, unknown>>()),
    fromTemporaryIsbIdcCredentials: () => async () => STATIC_CREDENTIALS,
    fromTemporaryIsbSpokeCredentials: () => async () => STATIC_CREDENTIALS,
  }),
);

const STATIC_CREDENTIALS = {
  accessKeyId: "AK",
  secretAccessKey: "SK",
  sessionToken: "ST",
};

// ─── AWS SDK fakes ───────────────────────────────────────────────────────────

const bedrock = mockClient(BedrockRuntimeClient);
const agentCore = mockClient(BedrockAgentCoreClient);
const apiGateway = mockClient(ApiGatewayManagementApiClient);

// ─── Fixtures ────────────────────────────────────────────────────────────────

const workerEnv = generateSchemaData(AgentWorkerLambdaEnvironmentSchema, {
  CONNECTIONS_TABLE_NAME: "test-connections",
  LEASE_TABLE_NAME: "test-leases",
  PRINCIPAL_TABLE_NAME: "test-principals",
  SANDBOX_SPACES_USAGE_TABLE_NAME: "test-usage",
  CONFIG_TABLE_NAME: "test-config",
  ACCOUNT_POOL_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/test-account-pool-config",
  IDC_ROLE_ARN:
    "arn:aws:iam::123456789012:role/InnovationSandbox-myisb-IdcRole",
  IDC_CONFIG_PARAM_ARN:
    "arn:aws:ssm:us-east-1:123456789012:parameter/test-idc-config",
  INTERMEDIATE_ROLE_ARN:
    "arn:aws:iam::123456789012:role/InnovationSandbox-myisb-IntermediateRole",
  WEBSOCKET_API_ENDPOINT:
    "https://test.execute-api.us-east-1.amazonaws.com/prod",
  AGENT_RUNTIME_ARN: "placeholder",
  COGNITO_USER_POOL_ID: "us-east-1_testpool",
  COGNITO_APP_CLIENT_ID: "test-client-id",
  ISB_NAMESPACE: "testns",
});

/** Runtime env with memory off (no USER_MEMORY_ID), as in main.test.ts. */
const runtimeEnv = {
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
};

const CONNECTION_ID = "conn-123";
const connection = {
  connectionId: CONNECTION_ID,
  actorId: "alice-at-example-d-com",
  role: "User" as const,
  email: "alice@example.com",
  userId: "22222222-2222-4222-8222-222222222222",
  protocolVersion: 1,
  ttl: Math.floor(Date.now() / 1000) + 7200,
};
const LEASE_UUID = "11111111-1111-4111-8111-111111111111";
const LEASE_ID = Buffer.from(
  JSON.stringify({ userEmail: "owner@example.com", uuid: LEASE_UUID }),
).toString("base64url");
const MODEL_ID = "model-a";
const RATES = {
  inputPricePer1KTokens: 0.003,
  outputPricePer1KTokens: 0.015,
  cacheReadPricePer1KTokens: 0.0003,
  cacheWritePricePer1KTokens: 0.00375,
};

/** What the user sees when the model's content filter stops a turn, whether the call fails or the turn completes with no text. */
const CONTENT_FILTERED_MESSAGE =
  "The model's content filter stopped this reply. Choose a different model and try again.";
const AFTER_TOOL_STREAM_ENDED_MESSAGE =
  "The model stopped responding before it finished its reply, and some commands may already have run. Check their results before trying again.";
const AFTER_TOOL_CONTENT_FILTERED_MESSAGE =
  "The model's content filter stopped this reply, and some commands may already have run. Check their results, then choose a different model and try again.";
const INPUT_BLOCKED_MESSAGE =
  "The safety filter blocked this message. Rephrase it as a plain request and try again.";
const WORKER_TURN_IN_PROGRESS_MESSAGE =
  "The agent is already working on a request for this Sandbox Space, possibly from another session. We recommend using a single session.";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function lambdaContext(): any {
  return {
    env: workerEnv,
    functionName: "test-worker",
    functionVersion: "$LATEST",
    invokedFunctionArn:
      "arn:aws:lambda:us-east-1:123456789012:function:test-worker",
    memoryLimitInMB: "512",
    awsRequestId: "test-request-id",
    logGroupName: "/aws/lambda/test-worker",
    logStreamName: "2024/01/01/[$LATEST]test",
    getRemainingTimeInMillis: () => 300_000,
    done: vi.fn(),
    fail: vi.fn(),
    succeed: vi.fn(),
    callbackWaitsForEmptyEventLoop: false,
  };
}

function sqsEvent(
  message: string,
  messageId = "msg-001",
  modelId = MODEL_ID,
): SQSEvent {
  return {
    Records: [
      {
        messageId,
        receiptHandle: "receipt-001",
        body: JSON.stringify({
          action: "sendMessage",
          message,
          leaseId: LEASE_ID,
          leaseUuid: LEASE_UUID,
          userId: connection.userId,
          modelId,
        }),
        attributes: {
          ApproximateReceiveCount: "1",
          SentTimestamp: "1234567890000",
          SenderId: "test",
          ApproximateFirstReceiveTimestamp: "1234567890000",
        },
        messageAttributes: {
          connectionId: { stringValue: CONNECTION_ID, dataType: "String" },
        },
        md5OfBody: "test",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:test-queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

// ─── Scripted Bedrock streams ────────────────────────────────────────────────

interface BedrockUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadInputTokens?: number;
  cacheWriteInputTokens?: number;
}

function metadata(usage: BedrockUsage): ConverseStreamOutput {
  return {
    metadata: {
      usage: { ...usage, totalTokens: usage.inputTokens + usage.outputTokens },
      metrics: { latencyMs: 5 },
    },
  };
}

function textCall(
  text: string,
  usage: BedrockUsage,
  stopReason: "end_turn" | "max_tokens" = "end_turn",
): ConverseStreamOutput[] {
  return [
    { messageStart: { role: "assistant" } },
    { contentBlockStart: { start: undefined, contentBlockIndex: 0 } },
    { contentBlockDelta: { delta: { text }, contentBlockIndex: 0 } },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason } },
    metadata(usage),
  ];
}

let toolUseCount = 0;
function toolUseCall(usage: BedrockUsage): ConverseStreamOutput[] {
  const toolUseId = `tooluse-${++toolUseCount}`;
  return [
    { messageStart: { role: "assistant" } },
    {
      contentBlockStart: {
        start: { toolUse: { toolUseId, name: "execute_sandbox_cli" } },
        contentBlockIndex: 0,
      },
    },
    {
      contentBlockDelta: {
        delta: {
          toolUse: { input: JSON.stringify({ args: ["s3", "ls"] }) },
        },
        contentBlockIndex: 0,
      },
    },
    { contentBlockStop: { contentBlockIndex: 0 } },
    { messageStop: { stopReason: "tool_use" } },
    metadata(usage),
  ];
}

/** As observed in dev: no messageStart, `content_filtered`, then usage. */
const BLOCKED_USAGE: BedrockUsage = { inputTokens: 4778, outputTokens: 0 };
function contentFilteredCall(): ConverseStreamOutput[] {
  return [
    { messageStop: { stopReason: "content_filtered" } },
    metadata(BLOCKED_USAGE),
  ];
}

async function* streamOf(events: ConverseStreamOutput[]) {
  for (const event of events) yield event;
}

/** Each ConverseStream call takes the next script; `gate`, if set, holds the call until it resolves. */
function scriptBedrock(
  next: (callIndex: number) => ConverseStreamOutput[],
  gate?: Promise<void>,
) {
  let calls = 0;
  bedrock.on(ConverseStreamCommand).callsFake(async () => {
    const events = next(calls++);
    if (gate) await gate;
    return { stream: streamOf(events) };
  });
}

function scriptSequence(calls: ConverseStreamOutput[][]) {
  scriptBedrock((i) => {
    const call = calls[i];
    if (!call) throw new Error(`Unscripted ConverseStream call ${i + 1}`);
    return call;
  });
}

function bedrockRequests(): ConverseStreamCommandInput[] {
  return bedrock
    .commandCalls(ConverseStreamCommand)
    .map((call) => call.args[0].input);
}

// ─── Runtime -> Worker hop ───────────────────────────────────────────────────

type RunAgentTurn = (
  payload: unknown,
  sessionId: string,
  services: unknown,
  env: typeof runtimeEnv,
) => AsyncGenerator<unknown, void, unknown>;

let runAgentTurn: RunAgentTurn;
let fallbackText: { maxTokens: string; limit: string; noReply: string };
let handler: (
  event: SQSEvent,
  context: unknown,
  callback: unknown,
) => Promise<{ batchItemFailures: unknown[] }>;

/**
 * One SSE message as `@fastify/sse` 0.4 `formatSSEMessage` writes it with its
 * default `JSON.stringify` serializer: optional `event:` line, one `data:` line
 * per line of the serialized data, then a blank line.
 */
function sseMessage(message: { event?: string; data: unknown }): string {
  let payload = message.event ? `event: ${message.event}\n` : "";
  for (const line of JSON.stringify(message.data).split("\n")) {
    payload += `data: ${line}\n`;
  }
  return `${payload}\n`;
}

/**
 * Serializes runtime frames as `BedrockAgentCoreApp._handleStreamingResponse`
 * (bedrock-agentcore 0.4.4, dist/src/runtime/app.js) does: every yielded frame
 * is a plain object without `data`, so `_normalizeSSEChunk` wraps it as
 * `{ data: frame }`; a throw mid-stream becomes `event: error` with `{ error }`.
 */
async function serializeAsAgentCoreApp(
  frames: AsyncGenerator<unknown, void, unknown>,
): Promise<string> {
  let body = "";
  try {
    for await (const frame of frames) body += sseMessage({ data: frame });
  } catch (error) {
    body += sseMessage({
      event: "error",
      data: {
        error: error instanceof Error ? error.message : "Unknown error",
      },
    });
  }
  return body;
}

const runtimeBodies: string[] = [];
function wireRuntime() {
  agentCore.on(InvokeAgentRuntimeCommand).callsFake(async (input) => {
    const payload = JSON.parse(new TextDecoder().decode(input.payload));
    const body = await serializeAsAgentCoreApp(
      runAgentTurn(
        payload,
        input.runtimeSessionId,
        { leaseStore: {} },
        runtimeEnv,
      ),
    );
    runtimeBodies.push(body);
    return { response: { transformToString: async () => body } };
  });
}

// ─── Captures ────────────────────────────────────────────────────────────────

interface ClientMessage {
  type: string;
  data?: string;
  error?: { code: string; message: string; retryable: boolean };
}

let sent: ClientMessage[] = [];

function chunkText(): string {
  return sent
    .filter((m) => m.type === "chunk" && m.data !== "##PROCESSING##")
    .map((m) => m.data)
    .join("");
}
function frames(type: string) {
  return sent.filter((m) => m.type === type);
}
function recordedTokens() {
  return recordTurnUsage.mock.calls.map(
    ([record]) => (record as { tokens: unknown }).tokens,
  );
}
function tokens(inputTokens: number, outputTokens: number) {
  return { inputTokens, outputTokens, cacheReadTokens: 0, cacheWriteTokens: 0 };
}

let sessionId: string;

/** What the client got, what was billed, and what the runtime sent, for failure messages. */
function observed(): string {
  return JSON.stringify(
    {
      clientMessages: sent.filter((m) => m.data !== "##PROCESSING##"),
      recordedTokens: recordedTokens(),
      bedrockCalls: bedrockRequests().length,
      runtimeSse: runtimeBodies,
    },
    null,
    2,
  );
}

async function runTurn(
  message: string,
  messageId = "msg-001",
  modelId = MODEL_ID,
) {
  return handler(
    sqsEvent(message, messageId, modelId),
    lambdaContext(),
    vi.fn(),
  );
}

// ─── Setup ───────────────────────────────────────────────────────────────────

beforeAll(async () => {
  bulkStubEnv(workerEnv);
  vi.stubEnv("AWS_REGION", "us-east-1");
  ({ runAgentTurn } = (await runtimeModule("main")) as unknown as {
    runAgentTurn: RunAgentTurn;
  });
  ({ TURN_FALLBACK_TEXT: fallbackText } = (await runtimeModule(
    "turn-stream",
  )) as unknown as { TURN_FALLBACK_TEXT: typeof fallbackText });
  ({ handler } =
    (await import("@amzn/innovation-sandbox-agent-worker/worker-handler.js")) as unknown as {
      handler: typeof handler;
    });
});

beforeEach(() => {
  vi.clearAllMocks();
  bedrock.reset();
  agentCore.reset();
  apiGateway.reset();
  sent = [];
  runtimeBodies.length = 0;

  // A fresh AgentCore session per test, so the runtime's warm-agent cache misses.
  sessionId = `${LEASE_UUID}_${crypto.randomUUID()}`;

  bedrock.on(ApplyGuardrailCommand).resolves({ action: "NONE" } as never);
  apiGateway.on(PostToConnectionCommand).callsFake(async (input) => {
    sent.push(JSON.parse(Buffer.from(input.Data as Uint8Array).toString()));
    return {};
  });
  wireRuntime();

  connectionGet.mockResolvedValue(connection);
  configGetSection.mockResolvedValue({ sandboxSpacesEnabled: true });
  configGetAgentModel.mockResolvedValue({
    modelId: MODEL_ID,
    enabled: true,
    displayName: "Model A",
  });
  priceDiscoveredModels.mockImplementation(
    async (models: { modelId: string }[]) =>
      new Map(
        models.map(({ modelId }) => [
          modelId,
          {
            ...RATES,
            pricingSource: "price-list",
            pricingRefreshedAt: "2026-09-10T12:00:00.000Z",
          },
        ]),
      ),
  );
  recordTurnUsage.mockResolvedValue(undefined);
  getLeaseUserUsage.mockResolvedValue(null);
  validateAndRoute.mockImplementation(async () => ({
    accountId: "123456789012",
    runtimeSessionId: sessionId,
  }));
  cliStub.mockResolvedValue({ status: "success", stdout: "[]" });
});

// ─── Scenarios ───────────────────────────────────────────────────────────────

describe("chat turn: Worker -> runtime -> Strands -> Bedrock", () => {
  it("1. forwards a tool-call turn and records the sum of both model calls", async () => {
    scriptSequence([
      toolUseCall({ inputTokens: 100, outputTokens: 20 }),
      textCall("You have no buckets.", { inputTokens: 150, outputTokens: 30 }),
    ]);

    await runTurn("list my buckets");

    expect(cliStub).toHaveBeenCalledOnce();
    expect(chunkText()).toBe("You have no buckets.");
    expect(frames("complete")).toHaveLength(1);
    expect(frames("error")).toHaveLength(0);
    expect(recordedTokens()).toEqual([tokens(250, 50)]);
  });

  it("2. tells the user the content filter stopped a filtered turn, without a retry", async () => {
    scriptBedrock(() => contentFilteredCall());

    await runTurn("list my buckets");

    expect(bedrockRequests(), observed()).toHaveLength(1);
    expect(frames("complete")).toHaveLength(0);
    expect(frames("error")).toEqual([
      expect.objectContaining({
        error: expect.objectContaining({
          code: "CONTENT_FILTERED",
          message: CONTENT_FILTERED_MESSAGE,
          retryable: false,
        }),
      }),
    ]);
  });

  it("2b. retries a stream that ends early once, and the turn completes", async () => {
    scriptSequence([
      [{ messageStart: { role: "assistant" } }],
      textCall("Here are your buckets.", { inputTokens: 40, outputTokens: 6 }),
    ]);

    await runTurn("list my buckets");

    expect(bedrockRequests(), observed()).toHaveLength(2);
    expect(chunkText()).toBe("Here are your buckets.");
    expect(frames("error")).toHaveLength(0);
    expect(frames("complete")).toHaveLength(1);
  });

  it("2c. sends the content-filter error when a filtered turn completes with no text", async () => {
    scriptSequence([
      [
        { messageStart: { role: "assistant" } },
        { messageStop: { stopReason: "content_filtered" } },
        metadata({ inputTokens: 40, outputTokens: 0 }),
      ],
    ]);

    await runTurn("list my buckets");

    expect(chunkText(), observed()).toBe("");
    expect(frames("complete")).toHaveLength(0);
    expect(frames("error")).toEqual([
      expect.objectContaining({
        error: {
          code: "CONTENT_FILTERED",
          message: CONTENT_FILTERED_MESSAGE,
          retryable: false,
        },
      }),
    ]);
  });

  it("2d. offers no retry when the content filter stops the reply after a tool ran", async () => {
    scriptSequence([
      toolUseCall({ inputTokens: 100, outputTokens: 20 }),
      contentFilteredCall(),
    ]);

    await runTurn("list my buckets");

    expect(cliStub).toHaveBeenCalledOnce();
    expect(frames("error"), observed()).toEqual([
      expect.objectContaining({
        error: {
          code: "CONTENT_FILTERED",
          message: AFTER_TOOL_CONTENT_FILTERED_MESSAGE,
          retryable: false,
        },
      }),
    ]);
  });

  it("2e. offers no retry when the stream ends after a tool ran", async () => {
    scriptSequence([
      toolUseCall({ inputTokens: 100, outputTokens: 20 }),
      [{ messageStart: { role: "assistant" } }],
    ]);

    await runTurn("list my buckets");

    expect(bedrockRequests(), observed()).toHaveLength(2);
    expect(frames("error")).toEqual([
      expect.objectContaining({
        error: {
          code: "MODEL_STREAM_ENDED",
          message: AFTER_TOOL_STREAM_ENDED_MESSAGE,
          retryable: false,
        },
      }),
    ]);
  });

  it("3. sends the too-long fallback after max_tokens and records every call", async () => {
    scriptSequence([
      toolUseCall({ inputTokens: 100, outputTokens: 20 }),
      textCall(
        "Here is a very long",
        { inputTokens: 150, outputTokens: 4096 },
        "max_tokens",
      ),
    ]);

    await runTurn("describe everything");

    expect(chunkText()).toContain(fallbackText.maxTokens);
    expect(frames("complete")).toHaveLength(1);
    expect(recordedTokens()).toEqual([tokens(250, 4116)]);
  });

  it("4. sends the step-limit fallback, then the warm agent completes the next turn", async () => {
    const perCall = { inputTokens: 10, outputTokens: 2 };
    let finalReplyNext = false;
    scriptBedrock(() =>
      finalReplyNext
        ? textCall("Continuing from where I stopped.", perCall)
        : toolUseCall(perCall),
    );

    await runTurn("do a long task", "msg-001");
    const firstTurnCalls = bedrockRequests().length;

    expect(chunkText()).toContain(fallbackText.limit);
    expect(frames("complete")).toHaveLength(1);
    expect(recordedTokens()).toEqual([
      tokens(perCall.inputTokens * firstTurnCalls, 2 * firstTurnCalls),
    ]);

    sent = [];
    finalReplyNext = true;
    await runTurn("continue", "msg-002");

    expect(chunkText()).toBe("Continuing from where I stopped.");
    expect(frames("complete")).toHaveLength(1);
    expect(frames("error")).toHaveLength(0);
    expect(recordedTokens()).toHaveLength(2);
  });

  it("5. rejects a second concurrent turn on the session and records nothing for it", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    let firstCallStarted!: () => void;
    const started = new Promise<void>(
      (resolve) => (firstCallStarted = resolve),
    );
    scriptBedrock(() => {
      firstCallStarted();
      return textCall("First turn reply.", {
        inputTokens: 40,
        outputTokens: 4,
      });
    }, gate);

    const first = runTurn("first", "msg-001");
    await started;

    await runTurn("second", "msg-002");
    const secondTurnMessages = [...sent];
    release();
    await first;

    expect(secondTurnMessages).toContainEqual(
      expect.objectContaining({
        type: "error",
        error: expect.objectContaining({
          code: "TURN_IN_PROGRESS",
          message: WORKER_TURN_IN_PROGRESS_MESSAGE,
        }),
      }),
    );
    expect(bedrockRequests()).toHaveLength(1);
    expect(frames("complete")).toHaveLength(1);
    expect(recordedTokens()).toEqual([tokens(40, 4)]);
  });

  it("6. keeps a blocked message out of the next turn's Bedrock request", async () => {
    const BLOCKED_TEXT = "message the model keeps filtering";
    let blocking = true;
    scriptBedrock(() =>
      blocking
        ? contentFilteredCall()
        : textCall("Sure.", { inputTokens: 30, outputTokens: 2 }),
    );

    await runTurn(BLOCKED_TEXT, "msg-001");
    const blockedCalls = bedrockRequests().length;
    blocking = false;
    await runTurn("something else", "msg-002");

    const nextRequest = bedrockRequests()[blockedCalls]!;
    // The newest user message is sent as guardContent (guardLatestUserMessage).
    const requestTexts = (nextRequest.messages ?? []).flatMap((message) =>
      (message.content ?? []).map(
        (block) => block.text ?? block.guardContent?.text?.text ?? "",
      ),
    );
    expect(
      requestTexts,
      `${JSON.stringify(requestTexts)}\n${observed()}`,
    ).toContain("something else");
    expect(requestTexts, JSON.stringify(requestTexts)).not.toContain(
      BLOCKED_TEXT,
    );
  });

  it("6b. tells the user the safety filter blocked the message, without calling the model or billing", async () => {
    bedrock.on(ApplyGuardrailCommand).resolves({
      action: "GUARDRAIL_INTERVENED",
      outputs: [{ text: "Your request was blocked." }],
      assessments: [
        {
          contentPolicy: {
            filters: [
              {
                type: "PROMPT_ATTACK",
                confidence: "MEDIUM",
                action: "BLOCKED",
              },
            ],
          },
        },
      ],
    } as never);

    await runTurn("list my buckets and go ahead without asking");

    expect(bedrockRequests(), observed()).toHaveLength(0);
    expect(chunkText()).toBe("");
    expect(frames("complete")).toHaveLength(0);
    expect(frames("error")).toEqual([
      expect.objectContaining({
        error: {
          code: "INPUT_BLOCKED",
          message: INPUT_BLOCKED_MESSAGE,
          retryable: false,
        },
      }),
    ]);
    expect(recordedTokens()).toEqual([]);
  });

  /** Runs one text-only turn on `modelId` and returns its single Bedrock request. */
  async function runTextTurnOn(modelId: string, usage: BedrockUsage) {
    configGetAgentModel.mockResolvedValue({
      modelId,
      enabled: true,
      displayName: modelId,
    });
    scriptSequence([textCall("Sure.", usage)]);
    await runTurn("list my buckets", "msg-001", modelId);
    expect(bedrockRequests(), observed()).toHaveLength(1);
    return bedrockRequests()[0]!;
  }

  function cachePointSections(request: ConverseStreamCommandInput) {
    return {
      system: (request.system ?? []).some((block) => block.cachePoint),
      tools: (request.toolConfig?.tools ?? []).some((tool) => tool.cachePoint),
      messages: (request.messages ?? []).some((message) =>
        (message.content ?? []).some((block) => block.cachePoint),
      ),
    };
  }

  it("7. caches the prompt on an Anthropic model and records its cache tokens", async () => {
    const request = await runTextTurnOn(
      "us.anthropic.claude-sonnet-4-5-20250929-v1:0",
      {
        inputTokens: 40,
        outputTokens: 4,
        cacheReadInputTokens: 300,
        cacheWriteInputTokens: 50,
      },
    );

    expect(cachePointSections(request)).toEqual({
      system: true,
      tools: true,
      messages: true,
    });
    expect(recordedTokens()).toEqual([
      {
        inputTokens: 40,
        outputTokens: 4,
        cacheReadTokens: 300,
        cacheWriteTokens: 50,
      },
    ]);
  });

  it("8. sends no cache points on a GPT model", async () => {
    const request = await runTextTurnOn("openai.gpt-oss-120b-1:0", {
      inputTokens: 40,
      outputTokens: 4,
    });

    expect(cachePointSections(request)).toEqual({
      system: false,
      tools: false,
      messages: false,
    });
  });
});

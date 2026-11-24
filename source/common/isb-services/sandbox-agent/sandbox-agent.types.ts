// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { PolicyDocumentSchema } from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { IdcPrincipalIdSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import { ConversationMessageSchema } from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";
import { createHash } from "node:crypto";
import { z } from "zod";

export * from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

/**
 * Payload the Worker Lambda sends on `InvokeAgentRuntime`. The runtime is
 * stateless across microVMs: conversation history is injected every turn
 * and the runtime never reads or writes AgentCore Memory itself.
 *
 * The caller's role is deliberately absent: role stays at the
 * authenticated app boundary, and the runtime derives its execution context —
 * a lease-bound session — from the verified session id, actor, account, and
 * permission profile rather than from a scope the Worker forwards.
 */
export const RuntimeInvokePayloadSchema = z.object({
  /** Bounded history window (last K turns) plus the new user message. */
  messages: z.array(ConversationMessageSchema).min(1),
  /** Sanitized caller email. Used for CloudTrail and logging. */
  actorId: z.string().min(1),
  /** Caller's IDC user id. */
  userId: IdcPrincipalIdSchema,
  // The per-turn model the Worker validated at the routing boundary, forwarded
  // unchanged so the runtime invokes exactly the selected model.
  modelId: z.string().min(1),
  accountId: AwsAccountIdSchema,
  leaseKey: z.string().min(1),
  regions: z.array(z.string()),
  // Strict schema at the trust boundary — a malformed policy is rejected at
  // parse time instead of surfacing as an opaque STS error at CLI-call time.
  permissionProfilePolicy: PolicyDocumentSchema.optional(),
  permissionProfileManagedPolicyArns: z.array(z.string()).optional(),
});
export type RuntimeInvokePayload = z.infer<typeof RuntimeInvokePayloadSchema>;

/**
 * Streaming events emitted by the runtime and consumed by the Worker:
 * repeated `chunk` events followed by a single `complete` event carrying
 * token usage.
 */
export const RuntimeStreamEventSchema = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("chunk"),
    content: z.string(),
  }),
  z.object({
    type: z.literal("complete"),
    usage: z
      .object({
        inputTokens: z.number().int().nonnegative(),
        outputTokens: z.number().int().nonnegative(),
        cacheReadTokens: z.number().int().nonnegative().default(0),
        cacheWriteTokens: z.number().int().nonnegative().default(0),
        totalTokens: z.number().int().nonnegative().optional(),
      })
      .optional(),
  }),
]);
export type RuntimeStreamEvent = z.infer<typeof RuntimeStreamEventSchema>;

/**
 * Codes the runtime attaches to an error frame it emits itself, so the Worker
 * can tell failure causes apart without matching message text.
 */
export const RUNTIME_ERROR_CODES = {
  /** The session's agent is still running a previous turn. */
  turnInProgress: "TURN_IN_PROGRESS",
  /** Bedrock can't serve the model for chat (for example, speech-to-speech models). */
  modelNotSupported: "MODEL_NOT_SUPPORTED",
  /** The model is legacy, or the account has no access to it. */
  modelUnavailable: "MODEL_UNAVAILABLE",
  /** The model stream failed or closed before its message stop, so the reply may be cut off. */
  modelStreamEnded: "MODEL_STREAM_ENDED",
  /** The model's content filter stopped the call; resending the same message usually meets it again. */
  contentFiltered: "CONTENT_FILTERED",
  /** Still throttled after Strands' own throttling retries. */
  modelThrottled: "MODEL_THROTTLED",
  /** Bedrock's model timeout or the HTTP client's request or socket timeout. */
  modelTimedOut: "MODEL_TIMED_OUT",
  /** Bedrock or the model failed on the service side; a later call may succeed. */
  modelServiceUnavailable: "MODEL_SERVICE_UNAVAILABLE",
  /** The guardrail blocked the user's message, so no model ran. */
  inputBlocked: "INPUT_BLOCKED",
} as const;

/**
 * Error frame for a turn that fails before or during streaming. AgentCore emits
 * it with only `error` when the runtime throws; the runtime adds a `code` for
 * failures it recognises ({@link RUNTIME_ERROR_CODES}), and `toolRan` when a
 * tool ran in the turn before it failed. It has no `type`, so it
 * is not part of {@link RuntimeStreamEventSchema}; the Worker matches it
 * separately so a failed turn is not reported as an empty success.
 *
 * `code` is a plain string, not an enum, so an unknown code from a newer
 * runtime still parses as an error.
 */
export const RuntimeErrorFrameSchema = z.object({
  error: z.string(),
  code: z.string().optional(),
  toolRan: z.boolean().optional(),
});
export type RuntimeErrorFrame = z.infer<typeof RuntimeErrorFrameSchema>;

/**
 * Namespace template configured on the User `CfnMemory` strategy.
 */
export const USER_MEMORY_NAMESPACE_TEMPLATE =
  "/lease/{sessionId}/user/{actorId}/";

/**
 * Must exactly match the `namespaceConfiguration.template` values on the
 * respective `CfnMemory` resources — a mismatch causes AgentCore Memory to
 * silently return empty recall results.
 */
export const AGENT_MEMORY_NAMESPACES = {
  /** `/lease/{sessionId}/user/{actorId}/` — must match `CfnMemory` strategy template. `{sessionId}` is the AgentCore placeholder; the application passes `leaseId` as that value. */
  USER_LEASE: USER_MEMORY_NAMESPACE_TEMPLATE,
} as const;

/**
 * Resolved per-user, per-lease namespace: the only path reads and writes may
 * use. Must exactly match the template above — a mismatched path makes memory
 * recall silently return empty results.
 */
export function userMemoryNamespace(actorId: string, leaseId: string): string {
  return USER_MEMORY_NAMESPACE_TEMPLATE.replace("{actorId}", actorId).replace(
    "{sessionId}",
    leaseId,
  );
}

/**
 * The parent of every user's namespace on one lease, for lease-termination
 * cleanup only.
 */
export function leaseMemoryNamespace(leaseId: string): string {
  return `/lease/${leaseId}/`;
}

/**
 * The session ID for the Admin persona — used for both AgentCore runtime
 * (runtimeSessionId) and AgentCore Memory
 * Must be ≥33 chars (AgentCore API constraint) and deterministic per actorId.
 */
export function adminSessionId(actorId: string): string {
  const base = `admin#${actorId}`;
  if (base.length >= 33) return base;
  return (
    base +
    createHash("sha256")
      .update(actorId)
      .digest("hex")
      .slice(0, 33 - base.length)
  );
}

/** STS `SourceIdentity` maximum length. */
export const MAX_SOURCE_IDENTITY_LENGTH = 64;

const SOURCE_IDENTITY_HASH_LENGTH = 20;
const SOURCE_IDENTITY_HASH_SEPARATOR = "-h-";

/**
 * Encodes an email address into a readable STS `SourceIdentity` used for
 * CloudTrail attribution and logging. Short values remain reversible. Values
 * over the 64-character STS limit retain a readable prefix and append a
 * hash of the complete email for deterministic disambiguation.
 *
 * Encoding: `-` → `--`, `.` → `-d-`, `@` → `-at-`, other non-word chars → `-x{hex}-`
 * Example: `alice@example.com` → `alice-at-example-d-com`
 */
export function sanitizeActorId(email: string): string {
  const encoded = email.replace(/\W/gu, (char) => {
    switch (char) {
      case "-":
        return "--";
      case "@":
        return "-at-";
      case ".":
        return "-d-";
      default:
        return `-x${char.codePointAt(0)!.toString(16)}-`;
    }
  });
  if (encoded.length <= MAX_SOURCE_IDENTITY_LENGTH) {
    return encoded;
  }

  const hashSuffix = `${SOURCE_IDENTITY_HASH_SEPARATOR}${createHash("sha256")
    .update(email)
    .digest("hex")
    .slice(0, SOURCE_IDENTITY_HASH_LENGTH)}`;
  const prefixLength = MAX_SOURCE_IDENTITY_LENGTH - hashSuffix.length;
  return `${encoded.slice(0, prefixLength)}${hashSuffix}`;
}

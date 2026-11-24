// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

// Browser-safe Sandbox Agent wire protocol: the constants, Zod schemas, and
// types shared by the frontend and the server. Nothing here may import a Node
// builtin or a server-only module — the frontend imports this file directly to
// avoid pulling the mixed `index.js` barrel (which reaches Node `crypto`).
import { z } from "zod";

import { enumErrorMap } from "../utils/zod.js";
import { IdcPrincipalIdSchema } from "./principal.js";

/**
 * WebSocket protocol version carried on every server→client message.
 * Breaking changes to `AgentRequest`/`AgentResponse` require incrementing
 * this and supporting N and N-1 in the server for one release cycle.
 */
export const AGENT_PROTOCOL_VERSION = 1;

/** `$connect` query parameter carrying the client's protocol version. */
export const AGENT_PROTOCOL_VERSION_QUERY_PARAM = "x-isb-protocol-version";

export const AGENT_KEEP_ALIVE_TOKEN = "##PROCESSING##";

export const ConversationMessageSchema = z.object({
  role: z.enum(["user", "assistant"], { error: enumErrorMap }),
  content: z.string(),
});
export type ConversationMessage = z.infer<typeof ConversationMessageSchema>;

/** Client → server message on the `sendMessage` route. */
export const AgentRequestSchema = z.object({
  action: z.literal("sendMessage"),
  message: z.string().min(1),
  leaseId: z.string().min(1),
  leaseUuid: z.uuid(),
  userId: IdcPrincipalIdSchema,
  /** Omitted for a new conversation. */
  conversationId: z.string().optional(),
  modelId: z.string().min(1),
});
export type AgentRequest = z.infer<typeof AgentRequestSchema>;

export const ToolUsageStatusSchema = z.enum(
  ["started", "completed", "failed"],
  { error: enumErrorMap },
);
export type ToolUsageStatus = z.infer<typeof ToolUsageStatusSchema>;

export const ToolUsageSchema = z.object({
  toolName: z.string(),
  status: ToolUsageStatusSchema,
  input: z.record(z.string(), z.unknown()).optional(),
  output: z.string().optional(),
});
export type ToolUsage = z.infer<typeof ToolUsageSchema>;

export const AgentResponseTypeSchema = z.enum(
  ["chunk", "complete", "error", "thinking", "tool_use"],
  { error: enumErrorMap },
);
export type AgentResponseType = z.infer<typeof AgentResponseTypeSchema>;

export const AgentErrorCodeSchema = z.enum([
  "CONNECTION_INTERRUPTED",
  "CONTENT_FILTERED",
  "FEATURE_DISABLED",
  "INPUT_BLOCKED",
  "INVALID_REQUEST",
  "LEASE_NOT_ACTIVE",
  "MESSAGE_TOO_LARGE",
  "MODEL_SERVICE_UNAVAILABLE",
  "MODEL_STREAM_ENDED",
  "MODEL_THROTTLED",
  "MODEL_TIMED_OUT",
  "RUNTIME_ERROR",
  "SESSION_EXPIRED",
  "TIME_LIMIT",
  "TURN_IN_PROGRESS",
  "UNKNOWN_ERROR",
]);
export type AgentErrorCode = z.infer<typeof AgentErrorCodeSchema>;

export const AgentErrorSchema = z.object({
  code: AgentErrorCodeSchema,
  message: z.string(),
  retryable: z.boolean(),
});
export type AgentError = z.infer<typeof AgentErrorSchema>;

export const AgentResponseSchema = z.object({
  version: z.number().int().positive(),
  type: AgentResponseTypeSchema,
  /** May carry the keep-alive token — filter before rendering. */
  data: z.string().optional(),
  error: AgentErrorSchema.optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  toolUsage: ToolUsageSchema.optional(),
  softLimitWarning: z.string().optional(),
  /** Caller's accumulated Sandbox Spaces estimated token cost at turn start plus this turn; concurrent turns may be missing. Omitted when the caller's record cannot be read and sent on billed terminal `complete` or `error` frames. */
  callerSandboxSpacesEstimatedTokenCostAccrued: z
    .number()
    .nonnegative()
    .optional(),
  /** The lease's current spend from `getCurrentLeaseSpend`, read when the turn started; excludes this turn. Sent on billed terminal `complete` or `error` frames. */
  leaseCurrentSpend: z.number().nonnegative().optional(),
});
export type AgentResponse = z.infer<typeof AgentResponseSchema>;

export const AgentHistoryMessageSchema = ConversationMessageSchema.extend({
  messageId: z.string().min(1),
  createdAt: z.iso.datetime(),
});
export type AgentHistoryMessage = z.infer<typeof AgentHistoryMessageSchema>;

/**
 * `data` payload of the history endpoint response. Messages are mapped
 * from AgentCore Memory STM events (`ListEvents`) by the Worker.
 */
export const AgentHistoryResponseSchema = z.object({
  leaseUuid: z.uuid().optional(),
  messages: z.array(AgentHistoryMessageSchema),
  /** Passthrough AgentCore Memory pagination token. */
  nextToken: z.string().optional(),
});
export type AgentHistoryResponse = z.infer<typeof AgentHistoryResponseSchema>;

/** Approximate characters per token for input size estimation */
export const CHARS_PER_TOKEN_ESTIMATE = 4;

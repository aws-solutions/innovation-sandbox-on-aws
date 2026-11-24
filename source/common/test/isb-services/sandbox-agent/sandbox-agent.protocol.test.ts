// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import { RuntimeErrorFrameSchema } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
// Imported directly from the protocol module (not the barrel) to assert the
// browser-safe surface resolves without pulling any server-only module.
import {
  AGENT_KEEP_ALIVE_TOKEN,
  AGENT_PROTOCOL_VERSION,
  AGENT_PROTOCOL_VERSION_QUERY_PARAM,
  AgentHistoryResponseSchema,
  AgentRequestSchema,
  AgentResponseSchema,
  CHARS_PER_TOKEN_ESTIMATE,
} from "@amzn/innovation-sandbox-shared/types/sandbox-agent.js";

describe("RuntimeErrorFrameSchema", () => {
  it("keeps the flag that says a tool ran before the turn failed", () => {
    expect(
      RuntimeErrorFrameSchema.parse({
        error: "Stream ended without completing a message",
        code: "MODEL_STREAM_ENDED",
        toolRan: true,
      }),
    ).toEqual({
      error: "Stream ended without completing a message",
      code: "MODEL_STREAM_ENDED",
      toolRan: true,
    });
  });
});

describe("protocol constants", () => {
  it("pins the wire protocol version and connect query param", () => {
    expect(AGENT_PROTOCOL_VERSION).toBe(1);
    expect(AGENT_PROTOCOL_VERSION_QUERY_PARAM).toBe("x-isb-protocol-version");
  });

  it("exposes the keep-alive token and token-estimate constant", () => {
    expect(AGENT_KEEP_ALIVE_TOKEN).toBe("##PROCESSING##");
    expect(CHARS_PER_TOKEN_ESTIMATE).toBe(4);
  });
});

const LEASE_UUID = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";
const USER_ID = "11111111-1111-4111-8111-111111111111";

describe("AgentRequestSchema", () => {
  const validRequest = {
    action: "sendMessage",
    message: "hello",
    leaseId: "lease-001",
    leaseUuid: LEASE_UUID,
    userId: USER_ID,
    modelId: "model-a",
  };

  it.each([
    ["leaseUuid", undefined],
    ["leaseUuid", "not-a-uuid"],
    ["userId", undefined],
    ["userId", "not-a-principal-id"],
  ])("rejects a request whose %s is %s", (field, value) => {
    const result = AgentRequestSchema.safeParse({
      ...validRequest,
      [field]: value,
    });
    expect(result.success).toBe(false);
  });

  it("accepts an IDC user id with the ten-character instance prefix", () => {
    const result = AgentRequestSchema.safeParse({
      ...validRequest,
      userId: `94481438c0-${USER_ID}`,
    });
    expect(result.success).toBe(true);
  });

  it("accepts a valid sendMessage request", () => {
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "List my S3 buckets",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      conversationId: "conv-123",
      modelId: "model-a",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a request without conversationId (new conversation)", () => {
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "hello",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      modelId: "model-a",
    });
    expect(result.success).toBe(true);
  });

  it("rejects a request without a modelId (required per turn)", () => {
    // modelId is captured at submit time and required on every turn; the server
    // re-validates it, so a request that omits it is rejected at the boundary.
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "hello",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty modelId", () => {
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "hello",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      modelId: "",
    });
    expect(result.success).toBe(false);
  });

  it("carries exactly one modelId scalar for the turn", () => {
    // The contract has a single scalar modelId — there is no per-message model
    // field or array, so a turn cannot express a mid-flight model change. The
    // parsed value is the one model that governs the whole submitted turn.
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "hello",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      modelId: "model-a",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.modelId).toBe("model-a");
    }
  });

  it("rejects an empty message", () => {
    const result = AgentRequestSchema.safeParse({
      action: "sendMessage",
      message: "",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      modelId: "model-a",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown action", () => {
    const result = AgentRequestSchema.safeParse({
      action: "somethingElse",
      message: "hello",
      leaseId: "lease-001",
      leaseUuid: LEASE_UUID,
      userId: USER_ID,
      modelId: "model-a",
    });
    expect(result.success).toBe(false);
  });
});

describe("AgentResponseSchema", () => {
  it("accepts a chunk message", () => {
    const result = AgentResponseSchema.safeParse({
      version: AGENT_PROTOCOL_VERSION,
      type: "chunk",
      data: "partial text",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a tool_use message with toolUsage details", () => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "tool_use",
      toolUsage: {
        toolName: "execute_sandbox_cli",
        status: "completed",
        input: { command: "aws s3 ls" },
        output: "bucket-a\nbucket-b",
      },
    });
    expect(result.success).toBe(true);
  });

  it("rejects a message without a version field", () => {
    const result = AgentResponseSchema.safeParse({
      type: "chunk",
      data: "text",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an unknown message type", () => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "unknown_type",
    });
    expect(result.success).toBe(false);
  });

  it("rejects an invalid toolUsage status", () => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "tool_use",
      toolUsage: { toolName: "execute_sandbox_cli", status: "running" },
    });
    expect(result.success).toBe(false);
  });
  it("accepts caller and lease spend on a billed terminal error", () => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "error",
      error: {
        code: "UNKNOWN_ERROR",
        message: "The response could not be fully delivered.",
        retryable: false,
      },
      callerSandboxSpacesEstimatedTokenCostAccrued: 0.5,
      leaseCurrentSpend: 12.5,
    });

    expect(result.success).toBe(true);
  });

  it.each([
    "CONTENT_FILTERED",
    "INPUT_BLOCKED",
    "MODEL_THROTTLED",
    "MODEL_TIMED_OUT",
    "MODEL_SERVICE_UNAVAILABLE",
    "MODEL_STREAM_ENDED",
  ])("accepts an error with the %s code", (code) => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "error",
      error: { code, message: "The model failed.", retryable: false },
    });

    expect(result.success).toBe(true);
  });

  it("rejects a negative lease spend", () => {
    const result = AgentResponseSchema.safeParse({
      version: 1,
      type: "complete",
      leaseCurrentSpend: -0.01,
    });

    expect(result.success).toBe(false);
  });
});

describe("AgentHistoryResponseSchema", () => {
  const LEASE_UUID = "550e8400-e29b-41d4-a716-446655440002";

  it("accepts a valid history response", () => {
    const result = AgentHistoryResponseSchema.safeParse({
      leaseUuid: LEASE_UUID,
      messages: [
        {
          messageId: "1748942330123#a84f09:0",
          role: "user",
          content: "List S3 buckets",
          createdAt: "2026-06-25T10:00:00Z",
        },
        {
          messageId: "1748942330123#a84f09:1",
          role: "assistant",
          content: "Here are your buckets...",
          createdAt: "2026-06-25T10:00:05Z",
        },
      ],
      nextToken: "opaque-token",
    });
    expect(result.success).toBe(true);
  });

  it("accepts an empty history without nextToken", () => {
    const result = AgentHistoryResponseSchema.safeParse({
      leaseUuid: LEASE_UUID,
      messages: [],
    });
    expect(result.success).toBe(true);
  });

  it("rejects a leaseUuid that is not a UUID", () => {
    const result = AgentHistoryResponseSchema.safeParse({
      leaseUuid: "lease-002",
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it("rejects a history message without a messageId", () => {
    const result = AgentHistoryResponseSchema.safeParse({
      leaseUuid: LEASE_UUID,
      messages: [
        {
          role: "user",
          content: "List S3 buckets",
          createdAt: "2026-06-25T10:00:00Z",
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it("rejects a message with a non-ISO createdAt", () => {
    const result = AgentHistoryResponseSchema.safeParse({
      leaseUuid: LEASE_UUID,
      messages: [
        {
          messageId: "1748942330123#a84f09:0",
          role: "user",
          content: "hi",
          createdAt: "June 25th, 2026",
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

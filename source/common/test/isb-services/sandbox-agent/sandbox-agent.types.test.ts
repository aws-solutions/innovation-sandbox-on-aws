// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { describe, expect, it } from "vitest";

import {
  AgentRequestSchema,
  RuntimeInvokePayloadSchema,
  RuntimeStreamEventSchema,
  USER_MEMORY_NAMESPACE_TEMPLATE,
  leaseMemoryNamespace,
  sanitizeActorId,
  userMemoryNamespace,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";

describe("protocol re-export", () => {
  it("keeps protocol schemas available through the server barrel", () => {
    expect(
      AgentRequestSchema.safeParse({
        action: "sendMessage",
        message: "hello",
        leaseId: "lease-001",
        leaseUuid: "6ba7b810-9dad-11d1-80b4-00c04fd430c8",
        userId: "11111111-1111-4111-8111-111111111111",
        modelId: "model-a",
      }).success,
    ).toBe(true);
  });
});

describe("RuntimeInvokePayloadSchema", () => {
  const validPayload = {
    messages: [
      { role: "user", content: "List my S3 buckets" },
      { role: "assistant", content: "Here are your buckets..." },
      { role: "user", content: "Delete the empty one" },
    ],
    actorId: "alice-at-example-d-com",
    userId: "6468b488-8041-70f5-1a43-d72b09d909aa",
    modelId: "model-a",
    accountId: "111111111111",
    leaseKey: "bGVhc2Uta2V5",
    regions: ["us-east-1", "us-west-2"],
  };

  it("accepts a valid user payload", () => {
    expect(RuntimeInvokePayloadSchema.safeParse(validPayload).success).toBe(
      true,
    );
  });

  it.each([undefined, ""])("rejects the modelId %p", (modelId) => {
    // The selected model must reach the runtime unchanged, so an absent or empty
    // modelId is rejected at the invoke boundary.
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      modelId,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a payload without accountId", () => {
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      accountId: undefined,
    });
    expect(result.success).toBe(false);
  });

  it.each([undefined, ""])("rejects the leaseKey %p", (leaseKey) => {
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      leaseKey,
    });
    expect(result.success).toBe(false);
  });

  it("rejects an empty messages array", () => {
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      messages: [],
    });
    expect(result.success).toBe(false);
  });

  it.each([undefined, ""])("rejects the actorId %p", (actorId) => {
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      actorId,
    });
    expect(result.success).toBe(false);
  });

  it("rejects a malformed accountId", () => {
    const result = RuntimeInvokePayloadSchema.safeParse({
      ...validPayload,
      accountId: "not-an-account",
    });
    expect(result.success).toBe(false);
  });
});

describe("RuntimeStreamEventSchema", () => {
  it("accepts a chunk event", () => {
    const result = RuntimeStreamEventSchema.safeParse({
      type: "chunk",
      content: "partial text",
    });
    expect(result.success).toBe(true);
  });

  it("accepts a complete event with usage", () => {
    const result = RuntimeStreamEventSchema.safeParse({
      type: "complete",
      usage: { inputTokens: 1514, outputTokens: 46 },
    });
    expect(result.success).toBe(true);
  });

  it("accepts a complete event without usage so the Worker can fail closed", () => {
    const result = RuntimeStreamEventSchema.safeParse({ type: "complete" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ type: "complete" });
  });

  it("defaults cache token types to zero for a runtime that omits them", () => {
    const result = RuntimeStreamEventSchema.parse({
      type: "complete",
      usage: { inputTokens: 5, outputTokens: 2 },
    });
    expect(result).toEqual({
      type: "complete",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    });
  });

  it("parses all four token types and the provider total", () => {
    const result = RuntimeStreamEventSchema.parse({
      type: "complete",
      usage: {
        inputTokens: 5,
        outputTokens: 2,
        cacheReadTokens: 300,
        cacheWriteTokens: 40,
        totalTokens: 347,
      },
    });
    expect(result).toMatchObject({
      usage: { cacheReadTokens: 300, cacheWriteTokens: 40, totalTokens: 347 },
    });
  });

  it("rejects negative token counts", () => {
    const result = RuntimeStreamEventSchema.safeParse({
      type: "complete",
      usage: { inputTokens: -1, outputTokens: 46 },
    });
    expect(result.success).toBe(false);
  });
});

describe("sanitizeActorId", () => {
  it("encodes @ and . with dedicated codes", () => {
    expect(sanitizeActorId("alice@example.com")).toBe("alice-at-example-d-com");
    expect(sanitizeActorId("bob.jones@corp.co")).toBe(
      "bob-d-jones-at-corp-d-co",
    );
  });

  it("escapes literal hyphens so encoded emails cannot collide", () => {
    expect(sanitizeActorId("bob-jones@corp.co")).toBe(
      "bob--jones-at-corp-d-co",
    );
    expect(sanitizeActorId("bob-jones@corp.co")).not.toBe(
      sanitizeActorId("bob.jones@corp.co"),
    );
  });

  it("hex-escapes email-legal characters without a dedicated code", () => {
    expect(sanitizeActorId("alice+tag@example.com")).toBe(
      "alice-x2b-tag-at-example-d-com",
    );
  });

  it("preserves underscores supported by STS SourceIdentity", () => {
    expect(sanitizeActorId("first_last@example.com")).toBe(
      "first_last-at-example-d-com",
    );
  });

  it("keeps representative short email encodings distinct", () => {
    const emails = [
      "bob.jones@corp.co",
      "bob-jones@corp.co",
      "bob+jones@corp.co",
      "bob=jones@corp.co",
      "bob--jones@corp.co",
      "bob.-jones@corp.co",
      "bob-.jones@corp.co",
      "a-at-b@corp.co",
      "a@t-b.corp.co",
    ];
    const actorIds = emails.map(sanitizeActorId);
    expect(new Set(actorIds).size).toBe(emails.length);
  });

  it("handles consecutive dots", () => {
    expect(sanitizeActorId("a..b@x.com")).toBe("a-d--d-b-at-x-d-com");
  });

  it("produces output matching the supported SourceIdentity alphabet", () => {
    for (const email of [
      "first.last@sub.domain.example.com",
      "first_last@example.com",
      "alice+tag@example.com",
      "o'brien@example.com",
      "user=equals@example.com",
      "a--b@x.com",
    ]) {
      expect(sanitizeActorId(email)).toMatch(/^[a-zA-Z0-9_-]+$/);
    }
  });

  it("compacts a long email to a valid SourceIdentity", () => {
    const email = "team-name+long-service-pipeline-test-user@example.com";

    expect(sanitizeActorId(email)).toBe(
      "team--name-x2b-long--service--pipeline--t-h-60b0166968e4bea27463",
    );
    expect(sanitizeActorId(email)).toHaveLength(64);
  });

  it("distinguishes long emails with the same readable prefix", () => {
    const sharedPrefix = "a".repeat(50);

    const first = sanitizeActorId(`${sharedPrefix}+first@example.com`);
    const second = sanitizeActorId(`${sharedPrefix}+second@example.com`);
    const hashSeparator = "-h-";

    expect(first).toHaveLength(64);
    expect(second).toHaveLength(64);
    expect(first).toContain(hashSeparator);
    expect(second).toContain(hashSeparator);
    expect(first.split(hashSeparator)[0]).toBe(second.split(hashSeparator)[0]);
    expect(first).not.toBe(second);
  });

  it("accepts an email that encodes to exactly the limit", () => {
    // 54×"a" + "-at-"(4) + "x"(1) + "-d-"(3) + "co"(2) = 64
    const email = `${"a".repeat(54)}@x.co`;
    expect(sanitizeActorId(email).length).toBe(64);
  });
});

describe("memory namespaces", () => {
  it("resolves the user namespace to match the CfnMemory template shape", () => {
    expect(userMemoryNamespace("alice-at-example-com", "lease-001")).toBe(
      "/lease/lease-001/user/alice-at-example-com/",
    );
    expect(USER_MEMORY_NAMESPACE_TEMPLATE).toBe(
      "/lease/{sessionId}/user/{actorId}/",
    );
  });

  it("resolves the lease namespace as the parent of every user on the lease", () => {
    expect(leaseMemoryNamespace("lease-001")).toBe("/lease/lease-001/");
  });

  it("keeps each user's namespace under the lease namespace", () => {
    // The invariant lease-termination cleanup depends on: one `namespacePath`
    // sweep of the lease namespace reaches every user's records. If the
    // template is ever reordered, this fails rather than cleanup silently
    // matching nothing.
    const lease = leaseMemoryNamespace("lease-001");
    for (const actor of ["alice-at-example-com", "bob-at-example-com"]) {
      expect(userMemoryNamespace(actor, "lease-001").startsWith(lease)).toBe(
        true,
      );
    }
    // Distinct per user, so a read scoped to one user cannot reach another's.
    expect(userMemoryNamespace("alice-at-example-com", "lease-001")).not.toBe(
      userMemoryNamespace("bob-at-example-com", "lease-001"),
    );
  });
});

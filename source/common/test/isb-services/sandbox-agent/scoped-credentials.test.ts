// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { mockClient } from "aws-sdk-client-mock";
import { beforeEach, describe, expect, it } from "vitest";

import {
  acquireHistoryMemoryCredentials,
  acquireLeaseMemoryCleanupCredentials,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/scoped-credentials.js";

// ─── Setup ────────────────────────────────────────────────────────────────────

const stsClient = new STSClient({});
const mockSts = mockClient(stsClient);

const MEMORY_RESOURCE_ARN =
  "arn:aws:bedrock-agentcore:us-east-1:123456789012:memory/MEM123";
const MEMORY_ACCESS_ROLE_ARN =
  "arn:aws:iam::123456789012:role/MemoryAccessRole";
const ACTOR_ID = "alice-at-example-d-com";
const LEASE_ID = "11111111-2222-4333-8444-555555555555";
const MEMORY_SESSION_ID = LEASE_ID;

const validCredentials = {
  AccessKeyId: "AKIAIOSFODNN7EXAMPLE",
  SecretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
  SessionToken: "AQoDYXdzEJr//test-session-token",
  Expiration: new Date(),
};

beforeEach(() => {
  mockSts.reset();
});

// ─── Session policy structure ─────────────────────────────────────────────────

describe("acquireHistoryMemoryCredentials — session policy", () => {
  it("STM statement: actorId + sessionId conditions (no namespacePath)", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    const call = mockSts.calls()[0]!;
    const policy = JSON.parse(
      (call.args[0] as AssumeRoleCommand).input.Policy!,
    );

    // Statement[0] is STM (ListEvents)
    const stmStatement = policy.Statement[0];
    expect(stmStatement.Action).toContain("bedrock-agentcore:ListEvents");
    const stmCondition = stmStatement.Condition;
    expect(stmCondition.StringEquals["bedrock-agentcore:actorId"]).toBe(
      ACTOR_ID,
    );
    expect(stmCondition.StringEquals["bedrock-agentcore:sessionId"]).toBe(
      MEMORY_SESSION_ID,
    );
    expect(stmCondition.StringLike).toBeUndefined(); // no namespacePath on STM (not supported by SAR)
  });

  it("grants no LTM access (nothing reads LTM through these credentials)", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    const actions = grantedActions();
    expect(actions).not.toContain("bedrock-agentcore:RetrieveMemoryRecords");
    expect(actions).not.toContain("bedrock-agentcore:ListMemoryRecords");
  });

  it("policy Resource is the full memory ARN for the STM statement", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    const call = mockSts.calls()[0]!;
    const policy = JSON.parse(
      (call.args[0] as AssumeRoleCommand).input.Policy!,
    );
    expect(policy.Statement[0].Resource).toBe(MEMORY_RESOURCE_ARN);
  });

  it("AssumeRole is called with correct RoleArn and DurationSeconds", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    const input = (mockSts.calls()[0]!.args[0] as AssumeRoleCommand).input;
    expect(input.RoleArn).toBe(MEMORY_ACCESS_ROLE_ARN);
    expect(input.DurationSeconds).toBe(900);
  });
});

// ─── Credential extraction ────────────────────────────────────────────────────

describe("acquireHistoryMemoryCredentials — credential handling", () => {
  it("returns credentials when STS responds with all three fields", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    const result = await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    expect(result).toEqual({
      accessKeyId: validCredentials.AccessKeyId,
      secretAccessKey: validCredentials.SecretAccessKey,
      sessionToken: validCredentials.SessionToken,
    });
  });

  it("returns null when Credentials is absent from the STS response", async () => {
    mockSts.on(AssumeRoleCommand).resolves({});

    const result = await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    expect(result).toBeNull();
  });

  it("returns null when AccessKeyId is missing from credentials", async () => {
    mockSts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: undefined,
        SecretAccessKey: "sk",
        SessionToken: "st",
        Expiration: new Date(),
      },
    });

    const result = await acquireHistoryMemoryCredentials({
      stsClient,
      memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
      memoryResourceArn: MEMORY_RESOURCE_ARN,
      actorId: ACTOR_ID,
      memorySessionId: MEMORY_SESSION_ID,
    });

    expect(result).toBeNull();
  });

  it("propagates STS errors to the caller (no swallowing)", async () => {
    mockSts.on(AssumeRoleCommand).rejects(new Error("AccessDenied"));

    await expect(
      acquireHistoryMemoryCredentials({
        stsClient,
        memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
        memoryResourceArn: MEMORY_RESOURCE_ARN,
        actorId: ACTOR_ID,
        memorySessionId: MEMORY_SESSION_ID,
      }),
    ).rejects.toThrow("AccessDenied");
  });
});

// ─── Write access ─────────────────────────────────────────────────────────────

/** All actions a captured session policy grants, flattened across statements. */
function grantedActions(): string[] {
  const call = mockSts.calls().at(-1)!;
  const policy = JSON.parse((call.args[0] as AssumeRoleCommand).input.Policy!);
  return policy.Statement.flatMap((st: { Action: string[] }) => st.Action);
}

function policyStatements(): Array<{
  Action: string[];
  Condition?: Record<string, Record<string, string>>;
}> {
  const call = mockSts.calls().at(-1)!;
  return JSON.parse((call.args[0] as AssumeRoleCommand).input.Policy!)
    .Statement;
}

describe("acquireHistoryMemoryCredentials — read-only", () => {
  const base = {
    stsClient,
    memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
    memoryResourceArn: MEMORY_RESOURCE_ARN,
    actorId: ACTOR_ID,
    memorySessionId: MEMORY_SESSION_ID,
  };

  it("grants no write or delete (the history API reads only)", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireHistoryMemoryCredentials(base);

    const actions = grantedActions();
    expect(actions).not.toContain("bedrock-agentcore:CreateEvent");
    expect(actions).not.toContain("bedrock-agentcore:DeleteEvent");
    expect(actions).not.toContain("bedrock-agentcore:BatchDeleteMemoryRecords");
  });
});

describe("acquireLeaseMemoryCleanupCredentials", () => {
  const props = {
    stsClient,
    memoryAccessRoleArn: MEMORY_ACCESS_ROLE_ARN,
    memoryResourceArn: MEMORY_RESOURCE_ARN,
    leaseId: LEASE_ID,
  };

  it("grants only the LTM list and delete, and no read that serves a user", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireLeaseMemoryCleanupCredentials(props);

    const memoryActions = grantedActions().filter((a) =>
      a.startsWith("bedrock-agentcore:"),
    );
    expect(memoryActions.sort()).toEqual([
      "bedrock-agentcore:BatchDeleteMemoryRecords",
      "bedrock-agentcore:ListMemoryRecords",
    ]);
  });

  it("scopes the list to the lease hierarchy with namespacePath", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireLeaseMemoryCleanupCredentials(props);

    const list = policyStatements().find((st) =>
      st.Action.includes("bedrock-agentcore:ListMemoryRecords"),
    )!;
    expect(list.Condition).toEqual({
      StringLike: {
        "bedrock-agentcore:namespacePath": `/lease/${LEASE_ID}/*`,
      },
    });
  });

  it("allows deleting a record only when its namespace is in the lease", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireLeaseMemoryCleanupCredentials(props);

    const del = policyStatements().find((st) =>
      st.Action.includes("bedrock-agentcore:BatchDeleteMemoryRecords"),
    )!;
    // Evaluated per record against its single namespace. Plain StringLike
    // fails when the key is absent, so a record without a namespace is denied.
    expect(del.Condition).toEqual({
      StringLike: {
        "bedrock-agentcore:namespace": `/lease/${LEASE_ID}/*`,
      },
    });
  });

  it("allows the KMS calls AgentCore makes with the caller's credentials", async () => {
    mockSts.on(AssumeRoleCommand).resolves({ Credentials: validCredentials });

    await acquireLeaseMemoryCleanupCredentials(props);

    const kmsActions = grantedActions().filter((a) => a.startsWith("kms:"));
    // DescribeKey: without it ListMemoryRecords fails with "Missing permission
    // for encryption key" on a memory encrypted with a customer managed key.
    expect(kmsActions.sort()).toEqual([
      "kms:Decrypt",
      "kms:DescribeKey",
      "kms:GenerateDataKey",
    ]);
  });

  it("rejects an invalid lease id before requesting credentials", async () => {
    await expect(
      acquireLeaseMemoryCleanupCredentials({
        ...props,
        leaseId: "*",
      }),
    ).rejects.toThrow();
    expect(mockSts.commandCalls(AssumeRoleCommand)).toHaveLength(0);
  });
});

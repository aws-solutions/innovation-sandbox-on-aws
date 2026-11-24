// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import {
  BedrockAgentCoreClient,
  ListMemoryRecordsCommand,
  type MemoryRecordSummary,
} from "@aws-sdk/client-bedrock-agentcore";
import { AssumeRoleCommand, STSClient } from "@aws-sdk/client-sts";
import { SQSEvent } from "aws-lambda";
import { mockClient } from "aws-sdk-client-mock";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { EventDetailTypes } from "@amzn/innovation-sandbox-commons/events/index.js";
import { MemoryCleanupError } from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { SandboxAgentMemoryCleanupLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-memory-cleanup-lambda-environment.js";
import { IsbClients } from "@amzn/innovation-sandbox-commons/sdk-clients/index.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";

import { handler } from "@amzn/innovation-sandbox-sandbox-agent-memory-cleanup/memory-cleanup-handler.js";

const testEnv = generateSchemaData(
  SandboxAgentMemoryCleanupLambdaEnvironmentSchema,
  { MAX_RECEIVE_COUNT: "3" },
);

// Stub envs at module-load time so the lambda's baseMiddlewareBundle sees them
// before any request fires.
bulkStubEnv(testEnv);

const LEASE_UUID = "11111111-1111-4111-8111-111111111111";

function sqsEvent(userEmail: string, receiveCount = "1"): SQSEvent {
  return {
    Records: [
      {
        attributes: { ApproximateReceiveCount: receiveCount },
        body: JSON.stringify({
          "detail-type": EventDetailTypes.LeaseTerminated,
          detail: {
            leaseId: { userEmail, uuid: LEASE_UUID },
            accountId: "123456789012",
            reason: { type: "UserTerminated", comment: "Terminated by user" },
          },
        }),
      } as SQSEvent["Records"][number],
    ],
  };
}

describe("SandboxAgentMemoryCleanup handler", () => {
  const stsClient = new STSClient({});
  const mockSts = mockClient(stsClient);
  const bedrockClient = new BedrockAgentCoreClient({});
  const mockBedrock = mockClient(bedrockClient);

  beforeEach(() => {
    bulkStubEnv(testEnv);
    mockSts.reset();
    mockBedrock.reset();
    mockSts.on(AssumeRoleCommand).resolves({
      Credentials: {
        AccessKeyId: "AKIA",
        SecretAccessKey: "secret",
        SessionToken: "token",
        Expiration: new Date(),
      },
    });
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolves({ memoryRecordSummaries: [] });
    vi.spyOn(IsbClients, "sts").mockReturnValue(stsClient);
    vi.spyOn(IsbClients, "bedrockAgentCore").mockReturnValue(bedrockClient);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("sweeps the lease's whole LTM hierarchy by its uuid", async () => {
    await handler(sqsEvent("alice@example.com"), mockContext(testEnv));

    const listCall = mockBedrock.commandCalls(ListMemoryRecordsCommand)[0]!;
    expect(listCall.args[0].input).toMatchObject({
      namespacePath: `/lease/${LEASE_UUID}/`,
    });
  });

  it("cleans even when the owner's email cannot be encoded as an actorId", async () => {
    // Cleanup is lease-scoped, so it no longer derives an actorId from the
    // owner's email; a lease with an un-encodable owner is still cleaned.
    const tooLong = `${"a".repeat(60)}@e.com`;
    await handler(sqsEvent(tooLong), mockContext(testEnv));

    expect(mockSts.commandCalls(AssumeRoleCommand)).toHaveLength(1);
    expect(mockBedrock.commandCalls(ListMemoryRecordsCommand)).not.toHaveLength(
      0,
    );
  });

  it("rethrows a cleanup failure so SQS retries the message", async () => {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: [] }) // delete pass
      .resolves({
        memoryRecordSummaries: [
          { memoryRecordId: "late" } as MemoryRecordSummary,
        ],
      }); // verify

    await expect(
      handler(sqsEvent("alice@example.com"), mockContext(testEnv)),
    ).rejects.toBeInstanceOf(MemoryCleanupError);
  });

  function failVerify() {
    mockBedrock
      .on(ListMemoryRecordsCommand)
      .resolvesOnce({ memoryRecordSummaries: [] }) // delete pass
      .resolves({
        memoryRecordSummaries: [
          { memoryRecordId: "late" } as MemoryRecordSummary,
        ],
      }); // verify
  }

  it("logs a completed cleanup with its attempt", async () => {
    const infoSpy = vi.spyOn(Logger.prototype, "info");

    await handler(sqsEvent("alice@example.com", "2"), mockContext(testEnv));

    expect(infoSpy).toHaveBeenCalledWith(
      "Memory cleanup complete",
      expect.objectContaining({
        logDetailType: "MemoryCleanupComplete",
        leaseId: LEASE_UUID,
        ltmDeleted: 0,
        attempt: 2,
      }),
    );
  });

  it("reports MemoryCleanupFailed when the last allowed attempt fails", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    failVerify();

    await expect(
      handler(sqsEvent("alice@example.com", "3"), mockContext(testEnv)),
    ).rejects.toBeInstanceOf(MemoryCleanupError);

    expect(errorSpy).toHaveBeenCalledWith(
      "Memory cleanup failed",
      expect.objectContaining({
        logDetailType: "MemoryCleanupFailed",
        phase: "verify",
        attempt: 3,
      }),
    );
  });

  it("logs an earlier failed attempt as a retry, not MemoryCleanupFailed", async () => {
    const errorSpy = vi.spyOn(Logger.prototype, "error");
    const warnSpy = vi.spyOn(Logger.prototype, "warn");
    failVerify();

    await expect(
      handler(sqsEvent("alice@example.com", "2"), mockContext(testEnv)),
    ).rejects.toBeInstanceOf(MemoryCleanupError);

    expect(errorSpy).not.toHaveBeenCalledWith(
      "Memory cleanup failed",
      expect.anything(),
    );
    expect(warnSpy).toHaveBeenCalledWith(
      "Memory cleanup attempt failed; SQS will retry",
      expect.objectContaining({ phase: "verify", attempt: 2 }),
    );
  });

  it("rejects a batch of more than one record", async () => {
    const event = sqsEvent("alice@example.com");
    event.Records.push(event.Records[0]!);

    await expect(handler(event, mockContext(testEnv))).rejects.toThrow(
      "Only one event is supported per invocation",
    );
  });
});

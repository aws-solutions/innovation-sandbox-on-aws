// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { handlePublishResult } from "@amzn/innovation-sandbox-blueprint-deployment-orchestrator/actions/publish-deployment-result.js";
import { BlueprintItemSchema } from "@amzn/innovation-sandbox-commons/data/blueprint/blueprint.js";
import { DynamoBlueprintStore } from "@amzn/innovation-sandbox-commons/data/blueprint/dynamo-blueprint-store.js";
import { DynamoLeaseStore } from "@amzn/innovation-sandbox-commons/data/lease/dynamo-lease-store.js";
import { MonitoredLeaseSchema } from "@amzn/innovation-sandbox-commons/data/lease/lease.js";
import { IsbEventBridgeClient } from "@amzn/innovation-sandbox-commons/sdk-clients/event-bridge-client.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mockEnv = {
  USER_AGENT_EXTRA: "test",
  ISB_EVENT_BUS: "test-bus",
  ISB_NAMESPACE: "test",
};

const mockLogger = new Logger();
const mockTracer = new Tracer();

const mockSendIsbEvent = vi.fn();

beforeEach(() => {
  vi.spyOn(IsbEventBridgeClient.prototype, "sendIsbEvent").mockImplementation(
    mockSendIsbEvent,
  );
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
});

describe("publish-deployment-result action", () => {
  describe("Success path", () => {
    it("should publish BlueprintDeploymentSucceededEvent", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        status: "Provisioning",
      });
      const blueprint = generateSchemaData(BlueprintItemSchema, {
        tags: {}, // Override to prevent random long tag keys
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint,
          stackSets: [],
        },
      });

      const event = {
        action: "PUBLISH_RESULT" as const,
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        blueprintId: blueprint.blueprintId,
        blueprintName: blueprint.name,
        accountId: lease.awsAccountId,
        operationId: "12345678-1234-1234-1234-123456789ghi",
        status: "SUCCEEDED" as const,
      };

      const result = await handlePublishResult(
        event,
        mockEnv,
        mockLogger,
        mockTracer,
      );

      expect(result).toEqual({ published: true, status: "SUCCEEDED" });
      expect(mockSendIsbEvent).toHaveBeenCalledWith(
        mockTracer,
        expect.objectContaining({
          DetailType: "BlueprintDeploymentSucceeded",
          Detail: expect.objectContaining({
            leaseId: { userEmail: event.userEmail, uuid: event.leaseId },
            blueprintId: event.blueprintId,
            operationId: "12345678-1234-1234-1234-123456789ghi",
            duration: 0,
          }),
        }),
      );
    });
  });

  describe("Failure path", () => {
    it("should publish BlueprintDeploymentFailedEvent", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema, {
        status: "Provisioning",
      });
      const blueprint = generateSchemaData(BlueprintItemSchema, {
        tags: {}, // Override to prevent random long tag keys
      });

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: {
          blueprint,
          stackSets: [],
        },
      });

      const event = {
        action: "PUBLISH_RESULT" as const,
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        blueprintId: blueprint.blueprintId,
        blueprintName: blueprint.name,
        accountId: lease.awsAccountId,
        operationId: "12345678-1234-1234-1234-123456789ghi",
        status: "FAILED" as const,
        errorMessage: "StackSet not found",
      };

      const result = await handlePublishResult(
        event,
        mockEnv,
        mockLogger,
        mockTracer,
      );

      expect(result).toEqual({ published: true, status: "FAILED" });
      expect(mockSendIsbEvent).toHaveBeenCalledWith(
        mockTracer,
        expect.objectContaining({
          DetailType: "BlueprintDeploymentFailed",
          Detail: expect.objectContaining({
            leaseId: { userEmail: event.userEmail, uuid: event.leaseId },
            blueprintId: event.blueprintId,
            errorType: "DeploymentFailed",
            errorMessage: "StackSet not found",
          }),
        }),
      );
    });
  });

  describe("Event publishing without validation", () => {
    it("should publish event even when lease not found (no validation)", async () => {
      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = {
        action: "PUBLISH_RESULT" as const,
        leaseId: "550e8400-e29b-41d4-a716-446655440000",
        userEmail: "user@example.com",
        blueprintId: "650e8400-e29b-41d4-a716-446655440000",
        accountId: "123456789012",
        operationId: "12345678-1234-1234-1234-123456789ghi",
        status: "SUCCEEDED" as const,
        blueprintName: "test-blueprint",
      };

      const result = await handlePublishResult(
        event,
        mockEnv,
        mockLogger,
        mockTracer,
      );

      expect(result).toEqual({ published: true, status: "SUCCEEDED" });
    });

    it("should publish event even when blueprint not found (no validation)", async () => {
      const lease = generateSchemaData(MonitoredLeaseSchema);

      vi.spyOn(DynamoLeaseStore.prototype, "get").mockResolvedValue({
        result: lease,
      });
      vi.spyOn(DynamoBlueprintStore.prototype, "get").mockResolvedValue({
        result: undefined,
      });

      const event = {
        action: "PUBLISH_RESULT" as const,
        leaseId: lease.uuid,
        userEmail: lease.userEmail,
        blueprintId: "650e8400-e29b-41d4-a716-446655440000",
        accountId: lease.awsAccountId,
        operationId: "12345678-1234-1234-1234-123456789ghi",
        status: "SUCCEEDED" as const,
        blueprintName: "test-blueprint",
      };

      const result = await handlePublishResult(
        event,
        mockEnv,
        mockLogger,
        mockTracer,
      );

      expect(result).toEqual({ published: true, status: "SUCCEEDED" });
    });
  });
});

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ValidationException } from "@amzn/innovation-sandbox-commons/data/global-config/global-config-utils.js";
import { AssignmentWorkerEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/assignment-worker-environment.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import { mockContext } from "@amzn/innovation-sandbox-commons/test/lambdas/fixtures.js";
import { bulkStubEnv } from "@amzn/innovation-sandbox-commons/test/lambdas/utils.js";
import type { SQSEvent } from "aws-lambda";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const MAX_RECEIVE_COUNT = 3;
const testEnv = {
  ...generateSchemaData(AssignmentWorkerEnvironmentSchema),
  ASSIGNMENT_MAX_RECEIVE_COUNT: String(MAX_RECEIVE_COUNT),
};
const testContext = mockContext(testEnv);

const TEST_LEASE_ID = "550e8400-e29b-41d4-a716-446655440000";
const TEST_OWNER_EMAIL = "owner@example.com";
const TEST_REQUESTER_EMAIL = "admin@example.com";
const TEST_ACCOUNT_ID = "999888777666";
const TEST_BUILT_IN_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-1111111111111111";
const TEST_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-2222222222222222";
const TEST_ADMIN_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-3333333333333333";
const TEST_MANAGER_PERMISSION_SET_ARN =
  "arn:aws:sso:::permissionSet/ssoins-1234567890abcdef/ps-4444444444444444";
const TEST_EXECUTION_ARN =
  "arn:aws:states:us-east-1:123456789012:execution:AssignmentWorker:abc123";
const TEST_USER_ID = "a1b2c3d4e5-550e8400-e29b-41d4-a716-446655440000";

// --- Mocks ---
// The JIT decision (resolveAssignmentAction) is tested in the service test;
// here we mock it and focus on the worker's orchestration: reporting results
// back to the Step Function and SQS retry / last-attempt behavior.

const mockResolveAssignmentAction = vi.fn();
const mockProcessAssignment = vi.fn();
const mockSfnSend = vi.fn();
const mockIdcConfigGet = vi.fn();

let handler: typeof import("@amzn/innovation-sandbox-assignment-worker/assignment-worker-handler.js").handler;

beforeAll(async () => {
  bulkStubEnv(testEnv);

  vi.doMock(
    "@amzn/innovation-sandbox-commons/isb-services/lease-assignment/index.js",
    () => ({
      resolveAssignmentAction: mockResolveAssignmentAction,
      processAssignment: mockProcessAssignment,
    }),
  );

  // Pass-through p-throttle so unit tests don't incur the 1/sec rate window
  // (the throttle is module-scoped and would otherwise serialize calls across
  // tests). p-throttle is a third-party lib and is not under test here.
  vi.doMock("p-throttle", () => ({
    default: () => (fn: unknown) => fn,
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/isb-services/index.js", () => ({
    IsbServices: {
      principalStore: vi.fn(() => ({})),
      leaseStore: vi.fn(() => ({})),
      idcStackConfigStore: vi.fn(() => ({ get: mockIdcConfigGet })),
    },
  }));

  vi.doMock("@amzn/innovation-sandbox-commons/sdk-clients/index.js", () => ({
    IsbClients: {
      stepFunctions: vi.fn(() => ({ send: mockSfnSend })),
      ssoAdmin: vi.fn(() => ({})),
    },
  }));

  vi.doMock(
    "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js",
    () => ({
      fromTemporaryIsbIdcCredentials: vi.fn(() => ({})),
    }),
  );

  const module =
    await import("@amzn/innovation-sandbox-assignment-worker/assignment-worker-handler.js");
  handler = module.handler;
});

afterAll(() => {
  vi.restoreAllMocks();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockSfnSend.mockResolvedValue({});
  mockIdcConfigGet.mockResolvedValue({
    userPermissionSetArn: TEST_BUILT_IN_PERMISSION_SET_ARN,
    adminPermissionSetArn: TEST_ADMIN_PERMISSION_SET_ARN,
    managerPermissionSetArn: TEST_MANAGER_PERMISSION_SET_ARN,
  });
});

// --- Test Helpers ---

function createMessage(overrides: Record<string, unknown> = {}) {
  return {
    leaseId: TEST_LEASE_ID,
    intent: "UPDATE",
    executionArn: TEST_EXECUTION_ARN,
    requestedBy: TEST_REQUESTER_EMAIL,
    requestedAt: "2026-01-01T00:00:00Z",
    principalId: TEST_USER_ID,
    principalType: "USER",
    accountId: TEST_ACCOUNT_ID,
    permissionSetArn: TEST_PERMISSION_SET_ARN,
    leaseOwnerEmail: TEST_OWNER_EMAIL,
    email: "usera@example.com",
    displayName: "User A",
    taskToken: "task-token-1",
    ...overrides,
  };
}

function createSqsEvent(
  body: Record<string, unknown>,
  receiveCount = 1,
): SQSEvent {
  return {
    Records: [
      {
        messageId: "msg-0",
        receiptHandle: "receipt-0",
        body: JSON.stringify(body),
        attributes: {
          ApproximateReceiveCount: String(receiveCount),
        } as any,
        messageAttributes: {},
        md5OfBody: "",
        eventSource: "aws:sqs",
        eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
        awsRegion: "us-east-1",
      },
    ],
  };
}

/** Returns the inputs of every command sent to the (mocked) Step Functions client. */
function sfnCommandInputs(): Record<string, unknown>[] {
  return mockSfnSend.mock.calls.map((call) => call[0].input);
}

describe("action handling", () => {
  it("uses the ARN-only message contract and resolves lookup context locally", async () => {
    mockResolveAssignmentAction.mockResolvedValue("NO_OP");

    const result = await handler(createSqsEvent(createMessage()), testContext);

    expect(mockProcessAssignment).not.toHaveBeenCalled();
    expect(mockResolveAssignmentAction).toHaveBeenCalledWith(
      expect.objectContaining({
        permissionSetArn: TEST_PERMISSION_SET_ARN,
        defaultPermissionSetArn: TEST_BUILT_IN_PERMISSION_SET_ARN,
        builtInPermissionSetArn: TEST_BUILT_IN_PERMISSION_SET_ARN,
      }),
      expect.anything(),
    );
    const inputs = sfnCommandInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.output).toContain("SKIPPED");
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it.each(["UPDATE", "PUBLISH", "UNFREEZE"])(
    "fails a deregistered %s grant immediately without retrying the denied operation",
    async (intent) => {
      mockResolveAssignmentAction.mockResolvedValue("GRANT");
      mockProcessAssignment.mockRejectedValue(
        new ValidationException("Permission set is not registered"),
      );
      const result = await handler(
        createSqsEvent(createMessage({ intent })),
        testContext,
      );
      expect(result.batchItemFailures).toEqual([]);
      expect(sfnCommandInputs()).toEqual([
        expect.objectContaining({
          error: "ValidationException",
          cause: "Permission set is not registered",
        }),
      ]);
    },
  );

  it("retries a policy rejection only if reporting the task failure fails", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockRejectedValue(
      new ValidationException("Permission set is not registered"),
    );
    mockSfnSend.mockRejectedValueOnce(new Error("callback unavailable"));
    const result = await handler(createSqsEvent(createMessage()), testContext);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("retries a transient registration read failure without reporting success", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockRejectedValue(
      new Error("registration read unavailable"),
    );
    const result = await handler(createSqsEvent(createMessage()), testContext);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
    expect(sfnCommandInputs()).toEqual([]);
  });

  it("performs the IDC operation and reports success for GRANT", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockResolvedValue({
      status: "SUCCEEDED",
      principalId: TEST_USER_ID,
      principalType: "USER",
      action: "GRANT",
    });

    const result = await handler(createSqsEvent(createMessage()), testContext);

    expect(mockProcessAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ action: "GRANT", principalId: TEST_USER_ID }),
      expect.anything(),
    );
    const inputs = sfnCommandInputs();
    expect(inputs).toHaveLength(1);
    expect(inputs[0]!.output).toBeDefined();
    expect(inputs[0]!.error).toBeUndefined();
    expect(result.batchItemFailures).toHaveLength(0);
  });

  it("passes the resolved REVOKE action to processAssignment", async () => {
    mockResolveAssignmentAction.mockResolvedValue("REVOKE");
    mockProcessAssignment.mockResolvedValue({
      status: "SUCCEEDED",
      principalId: TEST_USER_ID,
      principalType: "USER",
      action: "REVOKE",
    });

    await handler(createSqsEvent(createMessage()), testContext);

    expect(mockProcessAssignment).toHaveBeenCalledWith(
      expect.objectContaining({ action: "REVOKE" }),
      expect.anything(),
    );
  });

  it.each([
    ["administrator", TEST_ADMIN_PERMISSION_SET_ARN],
    ["manager", TEST_MANAGER_PERMISSION_SET_ARN],
  ])(
    "rejects a %s system-role grant before calling the IDC operation",
    async (_role, permissionSetArn) => {
      mockResolveAssignmentAction.mockResolvedValue("GRANT");

      const result = await handler(
        createSqsEvent(createMessage({ permissionSetArn })),
        testContext,
      );

      expect(mockProcessAssignment).not.toHaveBeenCalled();
      expect(sfnCommandInputs()).toEqual([
        expect.objectContaining({
          taskToken: "task-token-1",
          error: "SystemPermissionSetGrantDenied",
          cause: expect.stringContaining(
            `Refusing to grant ISB system permission set ${permissionSetArn}`,
          ),
        }),
      ]);
      expect(result.batchItemFailures).toEqual([]);
    },
  );

  it("retries a system-role rejection only when its task-failure callback fails", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockSfnSend.mockRejectedValueOnce(
      new Error("SendTaskFailure temporarily unavailable"),
    );

    const result = await handler(
      createSqsEvent(
        createMessage({ permissionSetArn: TEST_ADMIN_PERMISSION_SET_ARN }),
      ),
      testContext,
    );

    expect(mockProcessAssignment).not.toHaveBeenCalled();
    expect(sfnCommandInputs()).toEqual([
      expect.objectContaining({
        taskToken: "task-token-1",
        error: "SystemPermissionSetGrantDenied",
      }),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it.each([
    ["administrator", TEST_ADMIN_PERMISSION_SET_ARN],
    ["manager", TEST_MANAGER_PERMISSION_SET_ARN],
  ])(
    "allows a %s system-role revocation for remediation",
    async (_role, permissionSetArn) => {
      mockResolveAssignmentAction.mockResolvedValue("REVOKE");
      mockProcessAssignment.mockResolvedValue({
        status: "SUCCEEDED",
        principalId: TEST_USER_ID,
        principalType: "USER",
        action: "REVOKE",
      });

      await handler(
        createSqsEvent(createMessage({ permissionSetArn })),
        testContext,
      );

      expect(mockProcessAssignment).toHaveBeenCalledWith(
        expect.objectContaining({ action: "REVOKE", permissionSetArn }),
        expect.anything(),
      );
    },
  );
});

describe("failure handling", () => {
  it("does NOT call SendTaskFailure on a non-final attempt, but reports a batch item failure", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockRejectedValue(new Error("IDC throttled"));

    const result = await handler(
      createSqsEvent(createMessage(), 1), // first attempt
      testContext,
    );

    expect(sfnCommandInputs().some((i) => i.error !== undefined)).toBe(false);
    // Confirm NO Step Functions calls were made at all (neither Success nor Failure)
    expect(sfnCommandInputs()).toHaveLength(0);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("calls SendTaskFailure on the final attempt and reports a batch item failure", async () => {
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockRejectedValue(new Error("IDC throttled"));

    const result = await handler(
      createSqsEvent(createMessage(), MAX_RECEIVE_COUNT), // final attempt
      testContext,
    );

    const failureInputs = sfnCommandInputs().filter(
      (i) => i.error !== undefined,
    );
    expect(failureInputs).toHaveLength(1);
    expect(failureInputs[0]!.taskToken).toBe("task-token-1");
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("fails the task and reports a batch item failure for an invalid message", async () => {
    const event: SQSEvent = {
      Records: [
        {
          messageId: "msg-0",
          receiptHandle: "receipt-0",
          body: JSON.stringify({ taskToken: "task-token-1", foo: "bar" }),
          attributes: { ApproximateReceiveCount: "1" } as any,
          messageAttributes: {},
          md5OfBody: "",
          eventSource: "aws:sqs",
          eventSourceARN: "arn:aws:sqs:us-east-1:123456789012:queue",
          awsRegion: "us-east-1",
        },
      ],
    };

    const result = await handler(event, testContext);

    expect(mockResolveAssignmentAction).not.toHaveBeenCalled();
    expect(mockProcessAssignment).not.toHaveBeenCalled();
    const failureInputs = sfnCommandInputs().filter(
      (i) => i.error !== undefined,
    );
    expect(failureInputs).toHaveLength(1);
    expect(failureInputs[0]!.error).toBe("InvalidMessage");
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("rejects a malformed permission set ARN before resolving the action", async () => {
    const result = await handler(
      createSqsEvent(
        createMessage({ permissionSetArn: "not-a-permission-set-arn" }),
      ),
      testContext,
    );

    expect(mockIdcConfigGet).not.toHaveBeenCalled();
    expect(mockResolveAssignmentAction).not.toHaveBeenCalled();
    expect(mockProcessAssignment).not.toHaveBeenCalled();
    expect(sfnCommandInputs()).toEqual([
      expect.objectContaining({
        taskToken: "task-token-1",
        error: "InvalidMessage",
      }),
    ]);
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });

  it("does NOT fire SendTaskFailure when SendTaskSuccess itself fails (avoids double-callback on the same token)", async () => {
    // The IDC op succeeded, but the SFN callback failed (throttle / 5xx).
    // The reject handler must only see IDC failures, so SendTaskFailure must
    // not be issued on a token we just tried to succeed — even on the final
    // SQS attempt. The message is reported as a batch item failure so SQS
    // retries it.
    mockResolveAssignmentAction.mockResolvedValue("GRANT");
    mockProcessAssignment.mockResolvedValue({
      status: "SUCCEEDED",
      principalId: TEST_USER_ID,
      principalType: "USER",
      action: "GRANT",
    });
    mockSfnSend.mockRejectedValueOnce(new Error("SendTaskSuccess throttled"));

    const result = await handler(
      createSqsEvent(createMessage(), MAX_RECEIVE_COUNT), // final attempt
      testContext,
    );

    const inputs = sfnCommandInputs();
    expect(inputs).toHaveLength(1); // only the failed SendTaskSuccess
    expect(inputs[0]!.error).toBeUndefined(); // confirm it was Success, not Failure
    expect(result.batchItemFailures).toEqual([{ itemIdentifier: "msg-0" }]);
  });
});

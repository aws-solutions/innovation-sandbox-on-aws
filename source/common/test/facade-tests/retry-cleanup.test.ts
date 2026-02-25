// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SandboxAccountSchema } from "@amzn/innovation-sandbox-commons/data/sandbox-account/sandbox-account.js";
import { CleanAccountRequest } from "@amzn/innovation-sandbox-commons/events/clean-account-request.js";
import { InnovationSandbox } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";
import { generateSchemaData } from "@amzn/innovation-sandbox-commons/test/generate-schema-data.js";
import {
  mockedAccountStore,
  mockedIsbEventBridge,
  mockedOrgsService,
} from "@amzn/innovation-sandbox-commons/test/mocking/common-mocks.js";
import { createMockOf } from "@amzn/innovation-sandbox-commons/test/mocking/mock-utils.js";
import { Logger } from "@aws-lambda-powertools/logger";
import { Tracer } from "@aws-lambda-powertools/tracer";
import { DateTime } from "luxon";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

function createMockContext() {
  return {
    sandboxAccountStore: mockedAccountStore(),
    orgsService: mockedOrgsService(),
    eventBridgeClient: mockedIsbEventBridge(),
    logger: createMockOf(Logger),
    tracer: new Tracer(),
  };
}

const currentDateTime = DateTime.fromISO("2024-12-20T08:45:00.000Z", {
  zone: "utc",
}) as DateTime<true>;

describe("InnovationSandbox.retryCleanup()", () => {
  let mockContext: ReturnType<typeof createMockContext>;

  beforeEach(() => {
    mockContext = createMockContext();
    vi.useFakeTimers();
    vi.setSystemTime(currentDateTime.toJSDate());
  });

  afterEach(() => {
    vi.resetAllMocks();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  test("HappyPath - RetryCleanup on account in Quarantine", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "Quarantine",
    });

    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).toHaveBeenCalledWith(
      account,
      "Quarantine",
      "CleanUp",
    );

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: "RETRY_FAILED_CLEANUP",
      }),
    );
  });

  test("HappyPath - RetryCleanup on account already in CleanUp OU", async () => {
    const account = generateSchemaData(SandboxAccountSchema, {
      status: "CleanUp",
    });

    await InnovationSandbox.retryCleanup(
      {
        sandboxAccount: account,
      },
      mockContext,
    );

    expect(mockContext.orgsService.moveAccount).not.toHaveBeenCalled();

    expect(mockContext.eventBridgeClient.sendIsbEvents).toHaveBeenCalledWith(
      mockContext.tracer,
      new CleanAccountRequest({
        accountId: account.awsAccountId,
        reason: "RETRY_FAILED_CLEANUP",
      }),
    );
  });
});

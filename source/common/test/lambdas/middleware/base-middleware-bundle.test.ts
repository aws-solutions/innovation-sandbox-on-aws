// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { injectLambdaContextMock } = vi.hoisted(() => ({
  injectLambdaContextMock: vi.fn(() => ({ before: vi.fn() })),
}));

vi.mock("@aws-lambda-powertools/logger/middleware", () => ({
  injectLambdaContext: injectLambdaContextMock,
}));

vi.mock("@aws-lambda-powertools/tracer/middleware", () => ({
  captureLambdaHandler: vi.fn(() => ({ before: vi.fn() })),
}));

vi.mock(
  "@amzn/innovation-sandbox-commons/lambda/middleware/environment-validator.js",
  () => ({
    default: vi.fn(() => ({ before: vi.fn() })),
  }),
);

import baseMiddlewareBundle from "@amzn/innovation-sandbox-commons/lambda/middleware/base-middleware-bundle.js";

describe("baseMiddlewareBundle event logging", () => {
  const originalLogLevel = process.env.AWS_LAMBDA_LOG_LEVEL;
  const logger = {
    appendKeys: vi.fn(),
  };
  const options = {
    logger,
    tracer: {},
    moduleName: "test",
    environmentSchema: {},
  } as any;

  beforeEach(() => {
    injectLambdaContextMock.mockClear();
    process.env.AWS_LAMBDA_LOG_LEVEL = "DEBUG";
  });

  afterEach(() => {
    if (originalLogLevel === undefined) {
      delete process.env.AWS_LAMBDA_LOG_LEVEL;
    } else {
      process.env.AWS_LAMBDA_LOG_LEVEL = originalLogLevel;
    }
  });

  it("preserves DEBUG event logging by default", () => {
    baseMiddlewareBundle(options);

    expect(injectLambdaContextMock).toHaveBeenCalledWith(logger, {
      logEvent: true,
      resetKeys: true,
    });
  });
});

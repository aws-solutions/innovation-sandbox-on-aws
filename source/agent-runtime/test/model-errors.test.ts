// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ModelError, ModelThrottledError } from "@strands-agents/sdk";
import { describe, expect, it } from "vitest";

import {
  isTransientModelError,
  modelErrorFrame,
} from "@amzn/innovation-sandbox-agent-runtime/model-errors.js";

function awsError(name: string, message: string): Error {
  return Object.assign(new Error(message), { name });
}

function streamEndedError(): ModelError {
  return new ModelError("Stream ended without completing a message");
}

const TRUNCATED_EVENT = "Truncated event message received.";

function truncatedEventStreamError(): ModelError {
  const cause = new Error(TRUNCATED_EVENT);
  return new ModelError(cause.message, { cause });
}

describe("modelErrorFrame", () => {
  it("flags a model Converse doesn't support", () => {
    const err = awsError(
      "ValidationException",
      "This action doesn't support the model that you provided. Try again with a supported text or chat model.",
    );
    expect(modelErrorFrame(err)).toEqual({
      error: err.message,
      code: "MODEL_NOT_SUPPORTED",
    });
  });

  it.each([
    "Access denied. This Model is marked by provider as Legacy and you have not been actively using the model in the last 30 days.",
    "You don't have access to the model with the specified model ID.",
  ])("flags a model the account can't use: %s", (message) => {
    expect(modelErrorFrame(awsError("AccessDeniedException", message))).toEqual(
      { error: message, code: "MODEL_UNAVAILABLE" },
    );
  });

  it("follows the cause chain of a wrapped error", () => {
    const cause = awsError(
      "AccessDeniedException",
      "marked by provider as Legacy",
    );
    expect(modelErrorFrame(new Error("ModelError", { cause }))?.code).toBe(
      "MODEL_UNAVAILABLE",
    );
  });

  it.each([
    awsError("ValidationException", "Input is too long for requested model."),
    awsError(
      "AccessDeniedException",
      "User is not authorized to perform: bedrock:InvokeModelWithResponseStream",
    ),
    new Error("model exploded"),
    "not an error",
  ])("leaves other errors to the generic handling (%#)", (err) => {
    expect(modelErrorFrame(err)).toBeUndefined();
  });

  it("flags a stream that ended before the model finished its message", () => {
    expect(modelErrorFrame(streamEndedError())).toEqual({
      error: "Stream ended without completing a message",
      code: "MODEL_STREAM_ENDED",
    });
  });

  it("flags a stream that ended after Bedrock reported a content filter stop", () => {
    expect(modelErrorFrame(streamEndedError(), "contentFiltered")).toEqual({
      error: "Stream ended without completing a message",
      code: "CONTENT_FILTERED",
    });
  });

  it.each([
    new ModelThrottledError("Request was throttled by the model provider"),
    awsError("ThrottlingException", "Too many requests"),
  ])("flags throttling (%#)", (err) => {
    expect(modelErrorFrame(err)?.code).toBe("MODEL_THROTTLED");
  });

  it.each(["ModelTimeoutException", "TimeoutError"])(
    "flags a model call that timed out: %s",
    (name) => {
      expect(modelErrorFrame(awsError(name, "timed out"))?.code).toBe(
        "MODEL_TIMED_OUT",
      );
    },
  );

  it.each([
    "ServiceUnavailableException",
    "InternalServerException",
    "ModelNotReadyException",
    "ModelErrorException",
  ])("flags a model service failure: %s", (name) => {
    expect(modelErrorFrame(awsError(name, "try later"))?.code).toBe(
      "MODEL_SERVICE_UNAVAILABLE",
    );
  });

  it("flags a Bedrock stream failure as a stream that ended", () => {
    expect(
      modelErrorFrame(awsError("ModelStreamErrorException", "stream failed"))
        ?.code,
    ).toBe("MODEL_STREAM_ENDED");
  });

  it("flags an event stream cut off partway through an event as a stream that ended", () => {
    expect(modelErrorFrame(truncatedEventStreamError())).toEqual({
      error: TRUNCATED_EVENT,
      code: "MODEL_STREAM_ENDED",
    });
  });

  it("flags a cut-off event stream from its message alone, without Strands' wrapper", () => {
    expect(modelErrorFrame(new Error(TRUNCATED_EVENT))?.code).toBe(
      "MODEL_STREAM_ENDED",
    );
  });

  it.each(["RequestTimeout", "RequestTimeoutException"])(
    "leaves %s, which neither Bedrock nor Strands throws, to the generic handling",
    (name) => {
      expect(modelErrorFrame(awsError(name, "timed out"))).toBeUndefined();
    },
  );
});

describe("isTransientModelError", () => {
  it.each([
    ["a stream that ended early", streamEndedError()],
    [
      "a Bedrock stream failure",
      awsError("ModelStreamErrorException", "stream failed"),
    ],
    ["a timeout", awsError("ModelTimeoutException", "timed out")],
    ["a service failure", awsError("ServiceUnavailableException", "later")],
    [
      "a model processing failure",
      awsError("ModelErrorException", "model failed"),
    ],
    [
      "an event stream cut off partway through an event",
      truncatedEventStreamError(),
    ],
  ])("is true for %s", (_label, err) => {
    expect(isTransientModelError(err)).toBe(true);
  });

  it.each([
    ["a validation error", awsError("ValidationException", "bad input")],
    ["an unknown error", new Error("model exploded")],
    [
      "in-stream throttling, which Strands' default strategy retries",
      new ModelThrottledError("throttled"),
    ],
  ])("is false for %s", (_label, err) => {
    expect(isTransientModelError(err)).toBe(false);
  });

  it("is false for a stream that ended on a content filter stop", () => {
    expect(isTransientModelError(streamEndedError(), "contentFiltered")).toBe(
      false,
    );
  });
});

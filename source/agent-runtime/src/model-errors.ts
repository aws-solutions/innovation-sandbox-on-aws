// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  RUNTIME_ERROR_CODES,
  RuntimeErrorFrame,
} from "@amzn/innovation-sandbox-commons/isb-services/sandbox-agent/index.js";
import { ModelThrottledError } from "@strands-agents/sdk";

const TRANSIENT_MODEL_ERROR_CODES: ReadonlySet<string> = new Set([
  RUNTIME_ERROR_CODES.modelStreamEnded,
  RUNTIME_ERROR_CODES.modelTimedOut,
  RUNTIME_ERROR_CODES.modelServiceUnavailable,
]);

/** Bedrock's ModelTimeoutException, and the TimeoutError @smithy/node-http-handler throws for a request or socket timeout. */
const TIMEOUT_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ModelTimeoutException",
  "TimeoutError",
]);

const SERVICE_ERROR_NAMES: ReadonlySet<string> = new Set([
  "ServiceUnavailableException",
  "InternalServerException",
  "ModelNotReadyException",
  "ModelErrorException",
]);

/** Strands' ModelError text. */
function isStreamEnded(error: Error): boolean {
  return (
    error.name === "ModelError" &&
    /stream ended without completing a message/i.test(error.message)
  );
}

/** @smithy/core's event-stream decoder throws a plain Error, so only its message identifies a body cut off mid-event. */
function isTruncatedEventStream(error: Error): boolean {
  return /truncated event message received/i.test(error.message);
}

interface ModelErrorRule {
  code: string;
  matches: (error: Error, modelStopReason: string | undefined) => boolean;
}

/** Checked in order against each error in the cause chain; the first match wins. */
const MODEL_ERROR_RULES: readonly ModelErrorRule[] = [
  {
    // Converse rejects models it can't serve, such as speech-to-speech models.
    code: RUNTIME_ERROR_CODES.modelNotSupported,
    matches: (error) =>
      error.name === "ValidationException" &&
      /doesn't support the model/i.test(error.message),
  },
  {
    // Legacy models the account hasn't used recently, and models it has no access to.
    code: RUNTIME_ERROR_CODES.modelUnavailable,
    matches: (error) =>
      error.name === "AccessDeniedException" &&
      /legacy|access to the model/i.test(error.message),
  },
  {
    // The model's content filter can stop a call before its message starts; Strands then reports a stream that ended.
    code: RUNTIME_ERROR_CODES.contentFiltered,
    matches: (error, modelStopReason) =>
      modelStopReason === "contentFiltered" && isStreamEnded(error),
  },
  {
    code: RUNTIME_ERROR_CODES.modelStreamEnded,
    matches: (error) =>
      isStreamEnded(error) ||
      isTruncatedEventStream(error) ||
      error.name === "ModelStreamErrorException",
  },
  {
    code: RUNTIME_ERROR_CODES.modelThrottled,
    matches: (error) =>
      error instanceof ModelThrottledError ||
      error.name === "ThrottlingException",
  },
  {
    code: RUNTIME_ERROR_CODES.modelTimedOut,
    matches: (error) => TIMEOUT_ERROR_NAMES.has(error.name),
  },
  {
    code: RUNTIME_ERROR_CODES.modelServiceUnavailable,
    matches: (error) => SERVICE_ERROR_NAMES.has(error.name),
  },
];

/** The error, then each `cause` it wraps (Strands wraps SDK errors in ModelError). */
function* errorChain(err: unknown): Generator<Error> {
  const seen = new Set<unknown>();
  let current = err;
  while (current instanceof Error && !seen.has(current)) {
    seen.add(current);
    yield current;
    current = current.cause;
  }
}

/** `modelStopReason` is needed because a content-filtered call fails with the same error as a cut stream. */
export function modelErrorFrame(
  err: unknown,
  modelStopReason?: string,
): RuntimeErrorFrame | undefined {
  for (const error of errorChain(err)) {
    const rule = MODEL_ERROR_RULES.find((candidate) =>
      candidate.matches(error, modelStopReason),
    );
    if (rule) return { error: error.message, code: rule.code };
  }
  return undefined;
}

export function isTransientModelError(
  err: unknown,
  modelStopReason?: string,
): boolean {
  const code = modelErrorFrame(err, modelStopReason)?.code;
  return code !== undefined && TRANSIENT_MODEL_ERROR_CODES.has(code);
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { Logger } from "@aws-lambda-powertools/logger";

/** Remediation appended to a failed call's error, keyed by SDK error name. */
export type CallErrorHints = Partial<Record<string, string>>;

/**
 * Wraps a custom resource's AWS calls so a failure names the call that failed in
 * the reason CloudFormation shows, which the raw SDK message rarely does, and
 * appends the remediation `hints` holds for that error name.
 */
export function customResourceCalls(
  logger: Logger,
  hints: CallErrorHints = {},
) {
  function wrap(what: string, error: unknown): Error {
    logger.error({ message: `${what} failed`, error: error as Error });
    const { name, message } = error as Error;
    return new Error(
      `${what} failed: ${name}: ${message}${hints[name] ?? ""}`,
      {
        cause: error,
      },
    );
  }

  async function calling<T>(what: string, call: () => Promise<T>): Promise<T> {
    try {
      return await call();
    } catch (error) {
      throw wrap(what, error);
    }
  }

  return { calling, wrap };
}

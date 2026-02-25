// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Logger } from "@aws-lambda-powertools/logger";
import { CloudFormationServiceException } from "@aws-sdk/client-cloudformation";
import { backOff, IBackOffOptions } from "exponential-backoff";

/**
 * Executes a CloudFormation operation with exponential backoff and jitter.
 *
 * Only retries on transient errors:
 * - Throttling errors (rate limiting)
 * - 503 Service Unavailable errors
 *
 * Does NOT retry on:
 * - Validation errors (invalid parameters)
 * - Resource conflicts (stack already exists)
 * - Permission errors (insufficient IAM permissions)
 *
 * Uses exponential backoff with full jitter to prevent thundering herd issues
 * when multiple concurrent requests are throttled.
 *
 * @param operation - The async CloudFormation operation to execute
 * @param logger - Logger instance for logging retry attempts
 * @param context - Context information for logging (e.g., operationId, stackSetName)
 * @returns Promise resolving to the operation result
 *
 * @example
 * ```typescript
 * const response = await withCloudFormationBackoff(
 *   async () => cfnClient.send(new CreateStackInstancesCommand({...})),
 *   logger,
 *   { stackSetName: 'my-stack-set', accountId: '123456789012' }
 * );
 * ```
 */
export async function withCloudFormationBackoff<T>(
  operation: () => Promise<T>,
  logger: Logger,
  context: Record<string, unknown>,
): Promise<T> {
  const backoffOptions: Partial<IBackOffOptions> = {
    numOfAttempts: 5,
    jitter: "full",
    startingDelay: 1000,
    retry(error: Error) {
      if (error instanceof CloudFormationServiceException) {
        const isRetryable =
          error.$retryable?.throttling ||
          error.$metadata?.httpStatusCode === 503;

        if (isRetryable) {
          logger.warn(
            "CloudFormation operation throttled, retrying with backoff",
            {
              error: error.message,
              ...context,
            },
          );
          return true;
        }
      }
      return false;
    },
  };

  return await backOff(operation, backoffOptions);
}

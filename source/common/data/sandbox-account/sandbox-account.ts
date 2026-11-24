// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";
import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/utils/zod.js";
import { ResourceLockSchema } from "@amzn/innovation-sandbox-shared/types/resource-lock.js";
import {
  ActiveCleanupSchema,
  CurrentLeaseSchema,
  SandboxAccountStatusSchema,
} from "@amzn/innovation-sandbox-shared/types/sandbox-account.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const SandboxAccountSchemaVersion = 2;

// Define supported version range for backwards compatibility
const SandboxAccountSupportedVersionsSchema = createVersionRangeSchema(
  1,
  SandboxAccountSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const SandboxAccountItemWithMetadataSchema = createItemWithMetadataSchema(
  SandboxAccountSupportedVersionsSchema,
);

export const PersistedSandboxAccountKeySchema = z.strictObject({
  awsAccountId: AwsAccountIdSchema,
});

export const PersistedSandboxAccountSchema = z.strictObject({
  ...PersistedSandboxAccountKeySchema.shape,
  email: z.email().optional(),
  name: z.string().max(50).optional(),
  /**
   * @deprecated Legacy field from the Step Function cleanup flow. Retained for backward
   * compatibility with existing DynamoDB records. New cleanup executions use `activeCleanup`
   * instead. This field is not written by the durable function but is preserved on existing
   * records (since `put()` spreads the full item). To remove: strip it from the spread in
   * `acquire-account-lock.ts` after the Step Function source code is deleted (Milestone 5).
   * The field will then be naturally cleaned from each account record on its next cleanup cycle.
   */
  cleanupExecutionContext: z
    .object({
      stateMachineExecutionArn: z.string(),
      stateMachineExecutionStartTime: z.iso.datetime(),
    })
    .optional(),
  activeCleanup: ActiveCleanupSchema.optional(),
  lastCleanupCompletedAt: z.iso.datetime().optional(),
  currentLease: CurrentLeaseSchema.optional(),
  status: SandboxAccountStatusSchema,
  driftAtLastScan: z.boolean().optional(),
  resourceLock: ResourceLockSchema.optional(),
  ...SandboxAccountItemWithMetadataSchema.shape,
});
export type PersistedSandboxAccount = z.infer<
  typeof PersistedSandboxAccountSchema
>;

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { AwsAccountIdSchema } from "@amzn/innovation-sandbox-commons/data/common-schemas.js";
import {
  createItemWithMetadataSchema,
  createVersionRangeSchema,
} from "@amzn/innovation-sandbox-commons/data/metadata.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const SandboxAccountSchemaVersion = 1;

// Define supported version range for backwards compatibility
const SandboxAccountSupportedVersionsSchema = createVersionRangeSchema(
  1,
  SandboxAccountSchemaVersion,
);

// Create ItemWithMetadata schema with version validation
const SandboxAccountItemWithMetadataSchema = createItemWithMetadataSchema(
  SandboxAccountSupportedVersionsSchema,
);

export const IsbOuSchema = z.enum([
  "Available",
  "Active",
  "CleanUp",
  "Quarantine",
  "Frozen",
  "Entry",
  "Exit",
]);

export const SandboxAccountStatusSchema = IsbOuSchema.exclude([
  "Entry",
  "Exit",
]);

export const SandboxAccountSchema = z
  .object({
    awsAccountId: AwsAccountIdSchema,
    email: z.string().email().optional(),
    name: z.string().max(50).optional(),
    cleanupExecutionContext: z
      .object({
        stateMachineExecutionArn: z.string(),
        stateMachineExecutionStartTime: z.string().datetime(),
      })
      .optional(),
    status: SandboxAccountStatusSchema,
    driftAtLastScan: z.boolean().optional(),
  })
  .merge(SandboxAccountItemWithMetadataSchema)
  .strict();

export type SandboxAccount = z.infer<typeof SandboxAccountSchema>;
export type IsbOu = z.infer<typeof IsbOuSchema>;
export type SandboxAccountStatus = z.infer<typeof SandboxAccountStatusSchema>;

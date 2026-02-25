// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Schema for Account Pool Stack configuration stored in SSM Parameter Store.
 * This configuration is created by the Account Pool Stack and consumed by other stacks.
 *
 * Note: isbManagedRegions is stored as a JSON string in SSM (e.g., '["us-east-1","us-west-2"]')
 * but automatically transformed to a string array when parsed.
 */
export const AccountPoolConfigSchema = z.object({
  sandboxOuId: z.string(),
  availableOuId: z.string(),
  activeOuId: z.string(),
  frozenOuId: z.string(),
  cleanupOuId: z.string(),
  quarantineOuId: z.string(),
  entryOuId: z.string(),
  exitOuId: z.string(),
  solutionVersion: z.string(),
  supportedSchemas: z.string(),
  isbManagedRegions: z
    .string()
    .transform((regions) => regions.split(",").map((region) => region.trim())),
});

export type AccountPoolConfig = z.output<typeof AccountPoolConfigSchema>;
export type TokenSafeAccountPoolConfig = z.input<
  typeof AccountPoolConfigSchema
>;

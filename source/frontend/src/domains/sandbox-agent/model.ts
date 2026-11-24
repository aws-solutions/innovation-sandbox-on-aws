// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

/** One user's estimated Sandbox Spaces token cost on a lease, in US dollars. */
export const SandboxSpacesUserSpendViewSchema = z.strictObject({
  userId: z.string().min(1),
  sandboxSpacesEstimatedTokenCostAccrued: z.number().nonnegative(),
});

/**
 * Read model for `GET /sandboxAgent/usage`. Users receive only their own row;
 * Admins and Managers receive a row per user with recorded usage.
 */
export const SandboxSpacesUsageViewSchema = z.strictObject({
  spendByUsers: z.array(SandboxSpacesUserSpendViewSchema),
});

export type SandboxSpacesUserSpendView = z.infer<
  typeof SandboxSpacesUserSpendViewSchema
>;
export type SandboxSpacesUsageView = z.infer<
  typeof SandboxSpacesUsageViewSchema
>;

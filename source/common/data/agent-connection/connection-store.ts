// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { IdcPrincipalIdSchema } from "@amzn/innovation-sandbox-shared/types/principal.js";
import { IsbRoleSchema } from "@amzn/innovation-sandbox-shared/utils/auth-utils.js";

export const ConnectionRecordSchema = z
  .object({
    connectionId: z.string().min(1).max(128),
    actorId: z
      .string()
      .regex(/^[a-zA-Z0-9_-]+$/)
      .min(2)
      .max(64),
    role: IsbRoleSchema,
    email: z.email(),
    userId: IdcPrincipalIdSchema,
    protocolVersion: z.number().int().positive(),
    ttl: z.number().int().positive(),
  })
  // .strict() is safe: the table uses connectionId as the raw partition key (no
  // separate pk/sk), so DynamoDB returns exactly these fields — nothing extra.
  .strict();

export type ConnectionRecord = z.infer<typeof ConnectionRecordSchema>;

export interface ConnectionStore {
  save(record: ConnectionRecord): Promise<void>;
  delete(connectionId: string): Promise<void>;
  get(connectionId: string): Promise<ConnectionRecord | null>;
}

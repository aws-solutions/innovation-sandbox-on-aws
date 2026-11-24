// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { PersistedLastSavedBySchema } from "@amzn/innovation-sandbox-commons/data/config/config.js";
import { MetadataSchema } from "@amzn/innovation-sandbox-commons/data/metadata.js";

/** Increment when the per-model row shape changes in a breaking way. */
export const AgentModelCatalogSchemaVersion = 1;

export const AGENT_MODELS_SECTION = "agentModels" as const;

export const AGENT_MODEL_SK_PREFIX = "MODEL#";

const AgentModelIdSchema = z.string().min(1).max(300);

const AgentModelCatalogSortKeySchema = z
  .string()
  .startsWith(AGENT_MODEL_SK_PREFIX)
  .min(AGENT_MODEL_SK_PREFIX.length + 1)
  .max(AGENT_MODEL_SK_PREFIX.length + 300);

export const PersistedAgentModelCatalogKeySchema = z.strictObject({
  section: z.literal(AGENT_MODELS_SECTION),
  sk: AgentModelCatalogSortKeySchema,
});

export function agentModelSk(modelId: string): string {
  return `${AGENT_MODEL_SK_PREFIX}${modelId}`;
}

export const AgentModelTypeSchema = z.enum([
  "foundation-model",
  "inference-profile",
]);
export type AgentModelType = z.infer<typeof AgentModelTypeSchema>;

/**
 * Reuses the shared MetadataSchema. `lastEditTime` is the OCC token for the
 * admin enable/disable guard.
 */
export const AgentModelMetaSchema = MetadataSchema.required();
export type AgentModelMeta = z.infer<typeof AgentModelMetaSchema>;

const adminFieldsShape = {
  enabled: z.boolean(),
  addedAt: z.iso.datetime(),
  lastSavedBy: PersistedLastSavedBySchema,
} as const;

/** Identity fields written once at discovery; neither writer modifies these. */
const identityFieldsShape = {
  modelId: AgentModelIdSchema,
  displayName: z.string().min(1).max(200),
  provider: z.string().min(1).max(100),
  availability: z.string().min(1).max(50),
  description: z.string().max(1000).optional(),
  // Optional: rows created before these fields existed lack them.
  modelType: AgentModelTypeSchema.optional(),
  /** Foundation model this entry invokes; price lookups match Price List rows on it. */
  foundationModelId: z.string().min(1).max(300).optional(),
  foundationModelName: z.string().min(1).max(200).optional(),
} as const;

/**
 * A catalog row holds the model's identity and the admin's choices. It has no
 * composite key: to parse a DynamoDB item, which carries `section` and `sk`,
 * use {@link parseAgentModelRow}.
 */
export const PersistedAgentModelCatalogRowSchema = z
  .object({
    ...identityFieldsShape,
    ...adminFieldsShape,
    meta: AgentModelMetaSchema,
  })
  .strict();

export type PersistedAgentModelCatalogRow = z.infer<
  typeof PersistedAgentModelCatalogRowSchema
>;

export function parseAgentModelRow(
  item: Record<string, unknown>,
): PersistedAgentModelCatalogRow {
  const { section: _section, sk: _sk, ...row } = item;
  return PersistedAgentModelCatalogRowSchema.parse(row);
}

/** Discovery/create write — identity and the initial enabled state. */
export const AgentModelCreateSchema = z
  .object({
    ...identityFieldsShape,
    enabled: adminFieldsShape.enabled.optional().default(false), // new models arrive disabled
  })
  .strict();

export type AgentModelCreate = z.infer<typeof AgentModelCreateSchema>;

/** Admin toggle — only `enabled`; server stamps `lastSavedBy` and `meta`. */
export const AgentModelAdminUpdateSchema = z
  .object({
    enabled: adminFieldsShape.enabled,
  })
  .strict();

export type AgentModelAdminUpdate = z.infer<typeof AgentModelAdminUpdateSchema>;

/**
 * Strict request body; model identity and display metadata are server-owned.
 * A create (no `expectedLastEditTime`) must name the `modelType` Bedrock is
 * asked for; an update must not, because it never reads Bedrock.
 */
export const AgentModelUpsertBodySchema = AgentModelAdminUpdateSchema.extend({
  expectedLastEditTime: z.string().min(1).optional(),
  modelType: AgentModelTypeSchema.optional(),
}).superRefine((body, ctx) => {
  if (body.expectedLastEditTime === undefined && body.modelType === undefined) {
    ctx.addIssue({
      code: "custom",
      message: "modelType is required when creating a catalog entry.",
      path: ["modelType"],
    });
  }
  if (body.expectedLastEditTime !== undefined && body.modelType !== undefined) {
    ctx.addIssue({
      code: "custom",
      message: "modelType can only be set when creating a catalog entry.",
      path: ["modelType"],
    });
  }
});

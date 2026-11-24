// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

import { createVersionRangeSchema } from "@amzn/innovation-sandbox-commons/data/metadata.js";
import {
  LeaseTemplateMetadataSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";

// IMPORTANT -- this value must be updated whenever the schema changes.
export const LeaseTemplateSchemaVersion = 5; // v1.4.0

const PersistedLeaseTemplateSupportedVersionsSchema = createVersionRangeSchema(
  1,
  LeaseTemplateSchemaVersion,
);

export const PersistedLeaseTemplateMetadataSchema =
  LeaseTemplateMetadataSchema.extend({
    schemaVersion: PersistedLeaseTemplateSupportedVersionsSchema,
  });

export const PersistedLeaseTemplateKeySchema = z.strictObject({
  uuid: z.uuid(),
});

export const PersistedLeaseTemplateSchema = z.strictObject({
  ...PersistedLeaseTemplateKeySchema.shape,
  ...LeaseTemplateWritableSchema.shape,
  createdBy: z.email(),
  blueprintName: z.string().nullable().optional(), // Resolved from blueprint store on create/update (not client-provided)
  meta: PersistedLeaseTemplateMetadataSchema.optional(),
});

export type PersistedLeaseTemplate = z.infer<
  typeof PersistedLeaseTemplateSchema
>;

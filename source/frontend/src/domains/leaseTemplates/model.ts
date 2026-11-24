// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import {
  LeaseTemplateMetadataSchema,
  LeaseTemplateWritableSchema,
} from "@amzn/innovation-sandbox-shared/types/lease-template.js";
import {
  MAX_ALLOWED_PERMISSION_SETS,
  PermissionSetReferenceSchema,
} from "@amzn/innovation-sandbox-shared/types/permission-set.js";

const LeaseTemplateMetadataViewSchema = LeaseTemplateMetadataSchema.partial();

export type LeaseTemplateMetadataView = z.infer<
  typeof LeaseTemplateMetadataViewSchema
>;

/**
 * Canonical lease-template representation consumed by frontend code.
 *
 * It shares business fields with the neutral domain type, but normalizes the
 * HTTP response for UI use: blueprint absence is `undefined` and metadata
 * timestamps are ISO strings rather than generated-client `Date` objects.
 */
export const LeaseTemplateViewSchema = z.strictObject({
  ...LeaseTemplateWritableSchema.omit({
    blueprintId: true,
    defaultPermissionSetArn: true,
    allowedPermissionSetArns: true,
  }).shape,
  uuid: z.uuid(),
  createdBy: z.email(),
  blueprintId: z.uuid().optional(),
  blueprintName: z.string().optional(),
  defaultPermissionSet: PermissionSetReferenceSchema.optional(),
  allowedPermissionSets: z
    .array(PermissionSetReferenceSchema)
    .max(MAX_ALLOWED_PERMISSION_SETS)
    .optional(),
  meta: LeaseTemplateMetadataViewSchema.optional(),
});

export type LeaseTemplateView = z.infer<typeof LeaseTemplateViewSchema>;

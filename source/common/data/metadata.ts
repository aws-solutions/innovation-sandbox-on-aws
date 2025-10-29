// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { nowAsIsoDatetimeString } from "@amzn/innovation-sandbox-commons/utils/time-utils.js";
import { z } from "zod";

export class SchemaMismatchException extends Error {}

export const MetadataSchema = z.object({
  createdTime: z.string().datetime().optional(),
  lastEditTime: z.string().datetime().optional(),
  schemaVersion: z.number().int(),
});

export const ItemWithMetadataSchema = z.object({
  meta: MetadataSchema.optional(),
});

export type Metadata = z.infer<typeof MetadataSchema>;
export type ItemWithMetadata = z.infer<typeof ItemWithMetadataSchema>;

/**
 * Creates a schema that validates schema versions within a specified range
 * @param minVersion minimum supported version (inclusive)
 * @param maxVersion maximum supported version (inclusive)
 * @returns Zod schema that validates the version range
 */
export function createVersionRangeSchema(
  minVersion: number,
  maxVersion: number,
) {
  return z.number().int().min(minVersion).max(maxVersion);
}

/**
 * Creates a metadata schema with version validation
 * @param versionSchema Zod schema that defines valid version range/values
 * @returns Metadata schema with version validation
 */
export function createMetadataSchemaWithVersionValidation(
  versionSchema: z.ZodSchema<number>,
) {
  return z.object({
    createdTime: z.string().datetime().optional(),
    lastEditTime: z.string().datetime().optional(),
    schemaVersion: versionSchema,
  });
}

/**
 * Creates an ItemWithMetadata schema with version validation
 * @param versionSchema Zod schema that defines valid version range/values
 * @returns ItemWithMetadata schema with version validation
 */
export function createItemWithMetadataSchema(
  versionSchema: z.ZodSchema<number>,
) {
  return z.object({
    meta: createMetadataSchemaWithVersionValidation(versionSchema).optional(),
  });
}

/**
 * Validates that an item's schema version matches the provided version schema
 * @param item the item to validate
 * @param versionSchema Zod schema that defines valid version range/values
 */
export function checkSchemaVersion<T extends ItemWithMetadata>(
  item: T,
  versionSchema: z.ZodSchema<number>,
): void {
  if (item.meta?.schemaVersion) {
    const result = versionSchema.safeParse(item.meta.schemaVersion);
    if (!result.success) {
      const errorMessage = result.error.errors
        .map((err) => err.message)
        .join(", ");
      throw new SchemaMismatchException(
        `Schema version ${item.meta.schemaVersion} is not supported. ${errorMessage}`,
      );
    }
  }
}

export function withUpdatedMetadata<T extends ItemWithMetadata>(
  item: T,
  schemaVersion: number,
): T {
  const now = nowAsIsoDatetimeString();

  return {
    ...item,
    meta: {
      schemaVersion,
      createdTime: item.meta?.createdTime ?? now,
      lastEditTime: now,
    },
  };
}

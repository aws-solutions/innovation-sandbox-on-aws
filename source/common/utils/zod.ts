// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

export const FreeTextSchema = z.string().max(1000);

export const AwsAccountIdSchema = z.string().regex(/^\d{12}$/, {
  message: "AWS Account ID must be exactly 12 digits",
});

/**
 * Creates a custom error map for Zod enum schemas to prevent user input reflection in error messages.
 *
 * @returns A ZodErrorMap function for use with z.enum()
 *
 * @example
 * const ActionSchema = z.enum(["Approve", "Deny"], {
 *   errorMap: enumErrorMap
 * });
 * // Error message: "Invalid enum value. Expected one of the following values: Approve, Deny"
 */
export const enumErrorMap: z.ZodErrorMap = (issue, ctx) => {
  if (issue.code === "invalid_enum_value") {
    return {
      message: `Invalid value. Expected one of the following: ${issue.options.join(", ")}`,
    };
  }
  return { message: ctx.defaultError };
};

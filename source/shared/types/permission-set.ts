// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { z } from "zod";

export const PERMISSION_SET_ID_PATTERN = "ps-[a-zA-Z0-9-./]{16}";
export const MAX_ALLOWED_PERMISSION_SETS = 20;
const PERMISSION_SET_ARN_PATTERN = new RegExp(
  String.raw`^arn:aws(?:-[a-z]{1,5}){0,3}:sso:::permissionSet\/(?:sso)?ins-([a-zA-Z0-9.-]{16})\/(${PERMISSION_SET_ID_PATTERN})$`,
);
const PERMISSION_SET_NAME_PATTERN = /^[\w+=,.@-]+$/;
const PERMISSION_SET_DESCRIPTION_PATTERN =
  /^[\u0009\u000a\u000d\u0020-\u007e\u00a1-\u00ff]*$/; // NOSONAR typescript:S6324: Preserve the IAM Identity Center API pattern.
const PERMISSION_SET_SESSION_DURATION_PATTERN =
  /^-?P(?=\d|T\d)(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)([DW]))?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+(?:\.\d+)?)S)?)?$/; // NOSONAR typescript:S5843: Preserve the IAM Identity Center duration pattern; input is limited to 100 characters.

export const PermissionSetIdSchema = z
  .string()
  .regex(
    new RegExp(`^${PERMISSION_SET_ID_PATTERN}$`),
    "Must be a valid permission set ID",
  );
export const PermissionSetArnSchema = z
  .string()
  .min(10)
  .max(1224)
  .regex(
    PERMISSION_SET_ARN_PATTERN,
    "Must be a valid IAM Identity Center permission set ARN",
  );
export const PermissionSetNameSchema = z
  .string()
  .min(1)
  .max(32)
  .regex(PERMISSION_SET_NAME_PATTERN);
export const PermissionSetDescriptionSchema = z
  .string()
  .min(1)
  .max(700)
  .regex(PERMISSION_SET_DESCRIPTION_PATTERN);
export const PermissionSetSessionDurationSchema = z
  .string()
  .min(1)
  .max(100)
  .regex(PERMISSION_SET_SESSION_DURATION_PATTERN);

export function permissionSetIdFromArn(arn: string): string | undefined {
  return PERMISSION_SET_ARN_PATTERN.exec(arn)?.[2];
}

export function permissionSetInstanceIdFromArn(
  arn: string,
): string | undefined {
  return PERMISSION_SET_ARN_PATTERN.exec(arn)?.[1];
}

export const PermissionSetAvailabilitySchema = z.enum([
  "AVAILABLE",
  "UNAVAILABLE",
]);
export const PermissionSetReferenceSchema = z
  .object({
    permissionSetArn: PermissionSetArnSchema,
    permissionSetId: PermissionSetIdSchema,
    name: PermissionSetNameSchema.optional(),
    description: PermissionSetDescriptionSchema.optional(),
    sessionDuration: PermissionSetSessionDurationSchema.optional(),
    availability: PermissionSetAvailabilitySchema,
  })
  .strict()
  .refine(
    ({ permissionSetArn, permissionSetId }) =>
      permissionSetIdFromArn(permissionSetArn) === permissionSetId,
    {
      path: ["permissionSetId"],
      message: "permissionSetId must match permissionSetArn",
    },
  );

export type PermissionSetReference = z.infer<
  typeof PermissionSetReferenceSchema
>;

export const PermissionSetSummarySchema = z
  .object({
    permissionSetArn: PermissionSetArnSchema,
    permissionSetId: PermissionSetIdSchema,
    name: PermissionSetNameSchema,
    description: PermissionSetDescriptionSchema.optional(),
    sessionDuration: PermissionSetSessionDurationSchema.optional(),
  })
  .strict();

export type PermissionSetSummary = z.infer<typeof PermissionSetSummarySchema>;

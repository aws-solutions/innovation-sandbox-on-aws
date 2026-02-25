// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

/**
 * Validation schema for requesting a new lease
 */
export const RequestLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string()
    .min(1, "You must choose a lease template")
    .uuid("You must choose a valid lease template"),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
});

export type RequestLeaseFormValues = z.infer<
  typeof RequestLeaseValidationSchema
>;

/**
 * Validation schema for assigning a lease to another user
 */
export const AssignLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string()
    .min(1, "You must choose a lease template")
    .uuid("You must choose a valid lease template"),
  userEmail: z
    .string()
    .min(1, "You must provide a user email")
    .email("You must provide a valid email address"),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
});

export type AssignLeaseFormValues = z.infer<typeof AssignLeaseValidationSchema>;

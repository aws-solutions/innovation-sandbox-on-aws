// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { z } from "zod";

import { assignmentPrincipalKey } from "@amzn/innovation-sandbox-frontend/domains/leases/assignments/assignmentPermissionSets";
import { MAX_ASSIGNMENTS } from "@amzn/innovation-sandbox-shared/types/lease.js";
import { PermissionSetArnSchema } from "@amzn/innovation-sandbox-shared/types/permission-set.js";
import {
  IdcPrincipalIdSchema,
  PrincipalTypeSchema,
} from "@amzn/innovation-sandbox-shared/types/principal.js";

const AssignmentPrincipalRefSchema = z.object({
  principalId: IdcPrincipalIdSchema,
  principalType: PrincipalTypeSchema,
  // Display fields kept alongside the wire-required fields so the wizard
  // step can render the staged-rows table without re-fetching. Stripped
  // from the POST body before submit.
  displayName: z.string().optional(),
  email: z.string().optional(),
  permissionSetArn: PermissionSetArnSchema,
});

const SelectedUserSchema = z.object(
  {
    principalId: IdcPrincipalIdSchema,
    email: z.email("You must provide a valid email address"),
    displayName: z.string().optional(),
  },
  { error: "You must provide a valid user" },
);

const AssignmentsSchema = z
  .array(AssignmentPrincipalRefSchema)
  .max(
    MAX_ASSIGNMENTS,
    `A lease can have at most ${MAX_ASSIGNMENTS} assignments`,
  )
  .refine((assignments) => {
    const uniqueAssignments = new Set(
      assignments.map((assignment) => assignmentPrincipalKey(assignment)),
    );
    return uniqueAssignments.size === assignments.length;
  }, "Each principal may only be added once")
  .optional();

/**
 * Validation schema for requesting a new lease
 */
export const RequestLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string({
      error: (issue) => (issue.input === undefined ? "Required" : undefined),
    })
    .min(1, "You must choose a lease template")
    .check(z.uuid("You must choose a valid lease template")),
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
  assignments: AssignmentsSchema,
});

export type RequestLeaseFormValues = z.infer<
  typeof RequestLeaseValidationSchema
>;

/**
 * Validation schema for assigning a lease to another user
 */
export const AssignLeaseValidationSchema = z.object({
  leaseTemplateUuid: z
    .string({
      error: (issue) => (issue.input === undefined ? "Required" : undefined),
    })
    .min(1, "You must choose a lease template")
    .check(z.uuid("You must choose a valid lease template")),
  selectedUser: SelectedUserSchema,
  acceptTerms: z.boolean().refine((val) => val === true, {
    message: "You must accept the terms of service to continue",
  }),
  comments: z.string().optional(),
  assignments: AssignmentsSchema,
});

export type AssignLeaseFormValues = z.infer<typeof AssignLeaseValidationSchema>;

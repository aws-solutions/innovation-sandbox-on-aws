// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { SSOAdminClient } from "@aws-sdk/client-sso-admin";
import { z } from "zod";

import { InnovationSandboxError } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";

/**
 * Runtime schema for an IAM policy statement. Used at trust boundaries — e.g.,
 * the runtime invoke payload — so a malformed statement is rejected at parse
 * time rather than surfacing as an opaque STS error at CLI time.
 *
 * Supports the full IAM statement grammar including NotAction/NotResource.
 * Action/NotAction and Resource/NotResource are mutually exclusive in IAM but
 * both are accepted here — STS validates the semantics; our job is only to
 * confirm the structure is parseable.
 */
export const PolicyStatementSchema = z.object({
  Sid: z.string().optional(),
  Effect: z.enum(["Allow", "Deny"]),
  Action: z.union([z.string(), z.array(z.string())]).optional(),
  NotAction: z.union([z.string(), z.array(z.string())]).optional(),
  Resource: z.union([z.string(), z.array(z.string())]).optional(),
  NotResource: z.union([z.string(), z.array(z.string())]).optional(),
  Condition: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
});
export type PolicyStatement = z.infer<typeof PolicyStatementSchema>;

/**
 * Runtime schema for an IAM policy document as used in `sts:AssumeRole` and
 * `PutPermissionSetInlinePolicy`. `Statement` is required to be an array so
 * callers downstream can iterate uniformly.
 */
export const PolicyDocumentSchema = z.object({
  Version: z.literal("2012-10-17"),
  Statement: z.array(PolicyStatementSchema),
});
export type PolicyDocument = z.infer<typeof PolicyDocumentSchema>;

export interface ResolvedPermissionSetPolicy {
  /**
   * Inline policy document from the permission set.
   * Undefined when the permission set has no inline policy (only managed policies).
   * Callers MUST NOT pass an empty Statement[] to STS AssumeRole — omit the
   * Policy parameter entirely and pass only PolicyArns.
   */
  sessionPolicy?: PolicyDocument;
  /**
   * ARNs of all managed policies — both AWS-managed and customer-managed.
   * Passed as `PolicyArns` in `sts:AssumeRole`.
   */
  managedPolicyArns: string[];
}

export interface ResolvePermissionSetPolicyServices {
  ssoAdminClient: SSOAdminClient;
}

/** Thrown when the assembled inline session policy exceeds the 2,048-char packed limit. */
export class PermissionSetPolicyTooLargeError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "PermissionSetPolicyTooLargeError";
  }
}

/**
 * Thrown when a permission set has any boundary, including an empty shape,
 * because Sandbox Spaces cannot reproduce boundary semantics.
 */
export class UnsupportedPermissionSetBoundaryError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "UnsupportedPermissionSetBoundaryError";
  }
}

/** Thrown when the inline policy from SSO Admin cannot be parsed or is structurally invalid. */
export class InvalidPermissionSetPolicyError extends InnovationSandboxError {
  constructor(message: string) {
    super(message);
    this.name = "InvalidPermissionSetPolicyError";
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Domain function module: permission set policy resolution.
 *
 * Reads the SSO Admin APIs for a permission set and assembles a
 * session-policy-compatible PolicyDocument for use in the final STS hop.
 *
 * AWS-managed and customer-managed policies are returned as PolicyArns
 * (saves the 2,048-char inline session-policy budget).
 * Only the inline policy document is returned as Statement[].
 * When there are no inline statements, sessionPolicy is returned as undefined
 * so the type system prevents the caller from accidentally passing an empty
 * Statement[] to STS AssumeRole.
 *
 * Fails closed if the assembled inline policy exceeds the effective inline
 * limit (STS 2,048-char limit minus reserved headroom for base-deny statements
 * appended by buildSessionPermissions() downstream), or if managed policy ARN count
 * exceeds the STS 10-PolicyArns cap.
 */

import {
  GetInlinePolicyForPermissionSetCommand,
  GetPermissionsBoundaryForPermissionSetCommand,
  paginateListCustomerManagedPolicyReferencesInPermissionSet,
  paginateListManagedPoliciesInPermissionSet,
  ResourceNotFoundException,
  type PermissionsBoundary,
} from "@aws-sdk/client-sso-admin";
import { z } from "zod";

import { parsePartitionFromArn } from "@amzn/innovation-sandbox-commons/utils/cross-account-roles.js";

import {
  InvalidPermissionSetPolicyError,
  PermissionSetPolicyTooLargeError,
  PolicyDocument,
  PolicyStatement,
  PolicyStatementSchema,
  ResolvedPermissionSetPolicy,
  ResolvePermissionSetPolicyServices,
  UnsupportedPermissionSetBoundaryError,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/permission-policy.types.js";

// ─── Constants ────────────────────────────────────────────────────────────────

const SESSION_POLICY_MAX_CHARS = 2048;

/**
 * Headroom reserved for statements appended by buildSessionPermissions() downstream
 * (IsbControlPlaneDeny + document wrapper). The STS 2,048-char limit applies
 * to the final merged document, not just the inline statements returned here.
 * Measured from the serialized IsbControlPlaneDeny statement (~175 chars) plus
 * JSON wrapper overhead (~40 chars); rounded up to 400 for safety.
 */
const SESSION_POLICY_BASE_DENY_OVERHEAD = 400;

/** Effective limit for the inline portion so the merged document stays under 2,048 chars. */
const SESSION_POLICY_INLINE_MAX_CHARS =
  SESSION_POLICY_MAX_CHARS - SESSION_POLICY_BASE_DENY_OVERHEAD;

/** STS AssumeRole accepts at most 10 PolicyArns per session. */
const MAX_MANAGED_POLICY_ARNS = 10;

/**
 * Statement schema for parsing a RAW inline policy JSON returned by SSO
 * Admin's `GetInlinePolicyForPermissionSet`. Extends the strict
 * `PolicyStatementSchema` (used at internal trust boundaries) with the
 * optional `Principal` / `NotPrincipal` fields that IAM syntactically
 * permits — STS validates the semantics; our job here is only to confirm
 * the payload is structurally parseable.
 *
 * `Version` is intentionally NOT enforced: SSO Admin sometimes omits it,
 * and we normalize downstream by returning our own `PolicyDocument` with
 * `Version: "2012-10-17"` baked in.
 */
const InlinePolicyStatementSchema = PolicyStatementSchema.extend({
  Principal: z.unknown().optional(),
  NotPrincipal: z.unknown().optional(),
});

const InlinePolicyDocumentSchema = z.object({
  // IAM allows Statement to be a single object or an array — accept both and
  // normalize to an array so the rest of the code always sees PolicyStatement[].
  Statement: z.union([
    InlinePolicyStatementSchema,
    z.array(InlinePolicyStatementSchema),
  ]),
});

/**
 * Collects all managed policy ARNs from paginated SSO Admin responses.
 * AWS-managed ARNs are taken directly; customer-managed ARNs are constructed
 * from name + path + sandboxAccountId (partition-aware for gov/cn).
 */
async function collectManagedPolicyArns(
  paginatorConfig: {
    client: ResolvePermissionSetPolicyServices["ssoAdminClient"];
    pageSize: number;
  },
  listParams: { InstanceArn: string; PermissionSetArn: string },
  sandboxAccountId: string,
  partition: string,
): Promise<string[]> {
  const [awsManagedPages, customerManagedPages] = await Promise.all([
    (async () => {
      const pages = [];
      for await (const page of paginateListManagedPoliciesInPermissionSet(
        paginatorConfig,
        listParams,
      )) {
        pages.push(page);
      }
      return pages;
    })(),
    (async () => {
      const pages = [];
      for await (const page of paginateListCustomerManagedPolicyReferencesInPermissionSet(
        paginatorConfig,
        listParams,
      )) {
        pages.push(page);
      }
      return pages;
    })(),
  ]);

  const arns: string[] = [];

  for (const page of awsManagedPages) {
    for (const policy of page.AttachedManagedPolicies ?? []) {
      if (policy.Arn) arns.push(policy.Arn);
    }
  }

  for (const page of customerManagedPages) {
    for (const ref of page.CustomerManagedPolicyReferences ?? []) {
      if (ref.Name) {
        const path = ref.Path ?? "/";
        arns.push(
          `arn:${partition}:iam::${sandboxAccountId}:policy${path}${ref.Name}`,
        );
      }
    }
  }

  return arns;
}

/**
 * Treats ResourceNotFoundException from this API as no boundary.
 * Other permission-set reads still reject a missing permission set.
 */
async function getPermissionsBoundary(
  client: ResolvePermissionSetPolicyServices["ssoAdminClient"],
  params: { InstanceArn: string; PermissionSetArn: string },
): Promise<PermissionsBoundary | undefined> {
  try {
    const result = await client.send(
      new GetPermissionsBoundaryForPermissionSetCommand(params),
    );
    return result.PermissionsBoundary;
  } catch (error) {
    if (error instanceof ResourceNotFoundException) {
      return undefined;
    }
    throw error;
  }
}

/**
 * Parses and validates the raw inline policy JSON from SSO Admin.
 * Returns normalized PolicyStatement[] (always an array, never a single object).
 * Throws InvalidPermissionSetPolicyError on malformed JSON or missing Statement.
 */
function parseInlinePolicy(
  inlineJson: string,
  permissionSetArn: string,
): PolicyStatement[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(inlineJson);
  } catch {
    throw new InvalidPermissionSetPolicyError(
      `Inline policy for permission set ${permissionSetArn} is not valid JSON.`,
    );
  }

  const validated = InlinePolicyDocumentSchema.safeParse(parsed);
  if (!validated.success) {
    throw new InvalidPermissionSetPolicyError(
      `Inline policy for permission set ${permissionSetArn} failed statement validation: ` +
        validated.error.issues
          .map((i) => `${i.path.join(".")}: ${i.message}`)
          .join("; "),
    );
  }

  return Array.isArray(validated.data.Statement)
    ? validated.data.Statement
    : [validated.data.Statement];
}

export async function resolvePermissionSetPolicy(
  props: {
    permissionSetArn: string;
    ssoInstanceArn: string;
    /** Account ID of the sandbox account — used to construct customer-managed policy ARNs. */
    sandboxAccountId: string;
  },
  services: ResolvePermissionSetPolicyServices,
): Promise<ResolvedPermissionSetPolicy> {
  const { permissionSetArn, ssoInstanceArn, sandboxAccountId } = props;
  const { ssoAdminClient } = services;

  const partition = parsePartitionFromArn(
    permissionSetArn,
    () =>
      new InvalidPermissionSetPolicyError(
        `Cannot derive AWS partition from permission set ARN: ${permissionSetArn}`,
      ),
  );

  const paginatorConfig = { client: ssoAdminClient, pageSize: 100 };
  const listParams = {
    InstanceArn: ssoInstanceArn,
    PermissionSetArn: permissionSetArn,
  };

  const [boundaryOutcome, inlineOutcome, managedPoliciesOutcome] =
    await Promise.allSettled([
      getPermissionsBoundary(ssoAdminClient, listParams),
      ssoAdminClient.send(
        new GetInlinePolicyForPermissionSetCommand(listParams),
      ),
      collectManagedPolicyArns(
        paginatorConfig,
        listParams,
        sandboxAccountId,
        partition,
      ),
    ]);

  if (boundaryOutcome.status === "rejected") {
    throw boundaryOutcome.reason;
  }

  // Session policies cannot reproduce boundaries; a confirmed boundary takes precedence.
  if (boundaryOutcome.value !== undefined) {
    throw new UnsupportedPermissionSetBoundaryError(
      `Permission set ${permissionSetArn} has a permissions boundary, ` +
        `which Sandbox Spaces does not support.`,
    );
  }

  if (inlineOutcome.status === "rejected") {
    throw inlineOutcome.reason;
  }
  if (managedPoliciesOutcome.status === "rejected") {
    throw managedPoliciesOutcome.reason;
  }

  const inlineResult = inlineOutcome.value;
  const managedPolicyArns = managedPoliciesOutcome.value;

  if (managedPolicyArns.length > MAX_MANAGED_POLICY_ARNS) {
    throw new PermissionSetPolicyTooLargeError(
      `Permission set ${permissionSetArn} has ${managedPolicyArns.length} managed policies, ` +
        `exceeding the STS limit of ${MAX_MANAGED_POLICY_ARNS} PolicyArns per session. ` +
        `Reduce the number of managed policies on the permission set.`,
    );
  }

  const inlineJson = inlineResult.InlinePolicy?.trim();
  if (!inlineJson) {
    // No inline policy — return only managed policy ARNs.
    return { sessionPolicy: undefined, managedPolicyArns };
  }

  const statements = parseInlinePolicy(inlineJson, permissionSetArn);
  if (statements.length === 0) {
    // Empty Statement[] is treated the same as no inline policy — return only
    // managed policy ARNs. Passing an empty Statement[] to STS AssumeRole would
    // be rejected, and buildSessionPermissions would have no allow set to merge.
    return { sessionPolicy: undefined, managedPolicyArns };
  }

  const sessionPolicy: PolicyDocument = {
    Version: "2012-10-17",
    Statement: statements,
  };

  // Fail closed if inline policy exceeds the effective limit.
  // SESSION_POLICY_INLINE_MAX_CHARS reserves headroom for the base-deny
  // statements that buildSessionPermissions() appends before the final AssumeRole
  // call — the STS 2,048-char limit applies to that merged document.
  const packed = JSON.stringify(sessionPolicy);
  if (packed.length > SESSION_POLICY_INLINE_MAX_CHARS) {
    throw new PermissionSetPolicyTooLargeError(
      `Inline session policy for permission set ${permissionSetArn} is ` +
        `${packed.length} chars, exceeding the ${SESSION_POLICY_INLINE_MAX_CHARS}-char ` +
        `limit (${SESSION_POLICY_MAX_CHARS}-char STS limit minus ${SESSION_POLICY_BASE_DENY_OVERHEAD}-char base-deny overhead). ` +
        `Reduce the number of inline statements.`,
    );
  }

  return { sessionPolicy, managedPolicyArns };
}

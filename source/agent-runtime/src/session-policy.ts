// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

/**
 * Session policy for the final STS hop into a sandbox account.
 *
 * The base deny protects ISB control-plane resources living inside sandbox
 * accounts from the agent, regardless of what SandboxAgentRole permits.
 * It is ALWAYS applied. The user's permission set (a `PermissionProfile`) is
 * split here: its inline policy is merged into the session policy document and
 * its managed policies are returned separately as `PolicyArns`. STS combines
 * the two.
 *
 * This is IAM-layer enforcement: the session policies intersect with the
 * role's permissions, so nothing here can grant beyond SandboxAgentRole.
 */

import type {
  PolicyDocument,
  PolicyStatement,
} from "@amzn/innovation-sandbox-commons/isb-services/permission-policy/index.js";

/**
 * Statements protecting ISB-owned resources inside sandbox accounts and
 * blocking identity/org control-plane services entirely.
 *
 * The resource-level deny protects ISB roles regardless of SandboxAgentRole
 * permissions. The action-level denies are defense-in-depth — SCPs already
 * cover these on the non-exempt SandboxAgentRole, but the session policy
 * should not rely solely on SCPs.
 */
function baseDenyStatements(partition: string): PolicyStatement[] {
  return [
    {
      Sid: "IsbControlPlaneDeny",
      Effect: "Deny",
      Action: "*",
      Resource: [
        `arn:${partition}:iam::*:role/InnovationSandbox-*`,
        `arn:${partition}:iam::*:role/aws-reserved/sso.amazonaws.com/*`,
      ],
    },
    {
      Sid: "IdentityAndOrgControlPlaneDeny",
      Effect: "Deny",
      Action: [
        "organizations:*",
        "sso:*",
        "sso-admin:*",
        "identitystore:*",
        "account:*",
      ],
      Resource: "*",
    },
  ];
}

/**
 * A user's resolved permission set. A set can carry an inline policy, managed
 * policies, or both.
 */
export interface PermissionProfile {
  /**
   * Inline policy of the permission set. Its statements define what is
   * allowed. Absent for managed-only permission sets.
   */
  inlinePolicy?: PolicyDocument;
  /** Managed policy ARNs of the permission set; may be empty. */
  managedPolicyArns: string[];
}

/** True when the profile grants something. A profile with neither part must not start a session. */
export function hasPermissions(profile: PermissionProfile): boolean {
  return !!profile.inlinePolicy || profile.managedPolicyArns.length > 0;
}

export interface SessionPermissions {
  /** Inline session policy: the profile's inline statements plus the base deny. */
  policy: PolicyDocument;
  /** Managed session policies; undefined when the profile has none. */
  policyArns?: string[];
}

export interface BuildSessionPermissionsOptions {
  /**
   * ARN partition for the base deny resources. Must match the deployment
   * partition (`aws`, `aws-us-gov`, `aws-cn`) or the deny will not match
   * ISB resources and control-plane protection silently disables.
   */
  partition?: string;
}

/**
 * Builds the session policies for the final AssumeRole hop, deciding in one
 * place how the profile splits between the inline `Policy` and `PolicyArns`.
 *
 * The inline policy never adds an allow of its own. STS combines it and
 * `PolicyArns` as one set where any allow counts, so an allow-all baseline
 * would nullify a managed-only permission set such as ReadOnlyAccess. With no
 * inline policy the document holds the base deny only: the session gets
 * exactly what the managed policies allow, and nothing if there are none.
 * The base deny is appended regardless, and wins over any allow.
 */
export function buildSessionPermissions(
  profile: PermissionProfile,
  options: BuildSessionPermissionsOptions = {},
): SessionPermissions {
  const { partition = "aws" } = options;

  return {
    policy: {
      Version: "2012-10-17",
      Statement: [
        ...(profile.inlinePolicy?.Statement ?? []),
        ...baseDenyStatements(partition),
      ],
    },
    policyArns:
      profile.managedPolicyArns.length > 0
        ? profile.managedPolicyArns
        : undefined,
  };
}

// GetGuardrail/ApplyGuardrail are needed to apply the hub guardrail cross-account.
const INFERENCE_ACTIONS = [
  "bedrock:InvokeModel",
  "bedrock:InvokeModelWithResponseStream",
  "bedrock:ApplyGuardrail",
  "bedrock:GetGuardrail",
];

/**
 * Inference session policy, used on its OWN AssumeRole call separate from the
 * CLI tool's `buildSessionPermissions`, so the CLI session is never granted
 * Bedrock. `SandboxAgentRole` is `*:*`, so this policy is what scopes the session.
 */
export function buildInferenceSessionPolicy(
  options: BuildSessionPermissionsOptions = {},
): PolicyDocument {
  const { partition = "aws" } = options;
  return {
    Version: "2012-10-17",
    Statement: [
      {
        Sid: "SandboxInferenceAllow",
        Effect: "Allow",
        Action: INFERENCE_ACTIONS,
        Resource: "*",
      },
      ...baseDenyStatements(partition),
    ],
  };
}

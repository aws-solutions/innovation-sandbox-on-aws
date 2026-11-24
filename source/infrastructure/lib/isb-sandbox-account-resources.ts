// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  AccountPrincipal,
  CfnRole,
  CompositePrincipal,
  Effect,
  PolicyDocument,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  getIntermediateRoleName,
  getSandboxAccountRoleName,
  getSandboxAgentRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

export interface IsbSandboxAccountResourcesProps {
  hubAccountId: string;
  namespace: string;
}

export function addIsbSandboxAccountResources(
  scope: Construct,
  props: IsbSandboxAccountResourcesProps,
) {
  const { hubAccountId, namespace } = props;

  // Shared trust statement shape: allow assume + SetSourceIdentity from
  // IntermediateRole. Used as the base for both role overrides.
  const intermediateRoleArn = Stack.of(scope).formatArn({
    service: "iam",
    resource: "role",
    region: "",
    account: hubAccountId,
    resourceName: getIntermediateRoleName(namespace),
  });

  const hubAccountRootArn = Stack.of(scope).formatArn({
    service: "iam",
    resource: "root",
    region: "",
    account: hubAccountId,
  });

  const sandboxAccountRole = new Role(scope, "SandboxAccountRole", {
    roleName: getSandboxAccountRoleName(namespace),
    description: "Role to be assumed when operating on sandbox accounts",
    // CloudFormation trust is required so that aws-nuke's UseCurrentRoleToDeleteStack
    // feature can pass this role as RoleARN on DeleteStack calls. Without it,
    // CloudFormation cannot assume the spoke role to perform stack deletion.
    // Confused deputy is mitigated by the ProtectIsbControlPlaneResources SCP on
    // sandboxOu, which denies all actions on ISB role resources from non-ISB principals.
    assumedBy: new CompositePrincipal(
      new PrincipalWithConditions(new AccountPrincipal(hubAccountId), {
        ArnEquals: {
          "aws:PrincipalArn": intermediateRoleArn,
        },
      }),
      new ServicePrincipal("cloudformation.amazonaws.com"),
    ),
    inlinePolicies: {
      SandboxAccountAdministration: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["*"], // NOSONAR typescript:S6302 - this is a full access role used by the account cleaner
            resources: ["*"],
          }),
        ],
      }),
    },
  });

  // The first CDK-generated trust statement belongs to the intermediate
  // role. Add SourceIdentity support without replacing the second statement,
  // which allows CloudFormation to use this role for stack deletion.
  const cfnSandboxAccountRole = sandboxAccountRole.node.defaultChild as CfnRole;
  cfnSandboxAccountRole.addPropertyOverride(
    "AssumeRolePolicyDocument.Statement.0.Action",
    ["sts:AssumeRole", "sts:SetSourceIdentity"],
  );

  addCfnGuardSuppression(sandboxAccountRole, [
    "CFN_NO_EXPLICIT_RESOURCE_NAMES",
    "IAM_NO_INLINE_POLICY_CHECK",
    "IAM_POLICYDOCUMENT_NO_WILDCARD_RESOURCE",
  ]);

  // SandboxAgentRole — assumed by the agent runtime (via IntermediateRole) to
  // execute CLI commands in the sandbox account on behalf of the user.
  const sandboxAgentRole = new Role(scope, "SandboxAgentRole", {
    roleName: getSandboxAgentRoleName(namespace),
    description:
      "Assumed by the agent runtime (via IntermediateRole) for per-user scoped access to sandbox accounts.",
    // Minimal placeholder — the real trust policy including ArnEquals,
    // SetSourceIdentity, and SourceIdentity conditions is set by
    // addPropertyOverride below, which is the authoritative document.
    assumedBy: new AccountPrincipal(hubAccountId),
    inlinePolicies: {
      SandboxAgentAccess: new PolicyDocument({
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            // Ceiling enforced by session policy (per-user scoped) + SCPs
            // This wildcard is intentional — the session policy applied by the agent
            // runtime scopes it to the minimum required for each invocation.
            actions: ["*"], // NOSONAR typescript:S6302 - ceiling enforced by session policy + SCPs
            resources: ["*"],
          }),
        ],
      }),
    },
  });

  // Override trust policy to require non-empty sts:SourceIdentity.
  // This ensures every agent action is attributed to a real user in CloudTrail.
  const cfnSandboxAgentRole = sandboxAgentRole.node.defaultChild as CfnRole;
  cfnSandboxAgentRole.addPropertyOverride(
    "AssumeRolePolicyDocument.Statement",
    [
      {
        Effect: "Allow",
        Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
        Principal: { AWS: hubAccountRootArn },
        Condition: {
          ArnEquals: { "aws:PrincipalArn": intermediateRoleArn },
          // Require SourceIdentity to be both present and non-empty so every
          // sandbox action is attributed to a real user in CloudTrail.
          // StringNotEquals alone is insufficient — negated conditions evaluate
          // to true when the key is absent. The Null condition ensures the key
          // exists before StringNotEquals checks its value.
          Null: { "sts:SourceIdentity": "false" },
          StringNotEquals: { "sts:SourceIdentity": "" },
        },
      },
    ],
  );

  addCfnGuardSuppression(sandboxAgentRole, [
    "CFN_NO_EXPLICIT_RESOURCE_NAMES",
    "IAM_NO_INLINE_POLICY_CHECK",
    "IAM_POLICYDOCUMENT_NO_WILDCARD_RESOURCE",
  ]);
}

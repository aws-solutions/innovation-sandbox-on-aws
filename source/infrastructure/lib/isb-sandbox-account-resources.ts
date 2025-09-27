// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  AccountPrincipal,
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
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

export interface IsbSandboxAccountResourcesProps {
  hubAccountId: string;
  namespace: string;
}

export class IsbSandboxAccountResources {
  constructor(scope: Construct, props: IsbSandboxAccountResourcesProps) {
    const sandboxAccountRole = new Role(scope, "SandboxAccountRole", {
      roleName: getSandboxAccountRoleName(props.namespace),
      description: "Role to be assumed when operating on sandbox accounts",
      assumedBy: new PrincipalWithConditions(
        new AccountPrincipal(props.hubAccountId),
        {
          ArnEquals: {
            "aws:PrincipalArn": Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: props.hubAccountId,
              resourceName: getIntermediateRoleName(props.namespace),
            }),
          },
        },
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

    addCfnGuardSuppression(sandboxAccountRole, [
      "CFN_NO_EXPLICIT_RESOURCE_NAMES",
      "IAM_NO_INLINE_POLICY_CHECK",
      "IAM_POLICYDOCUMENT_NO_WILDCARD_RESOURCE",
    ]);

    // ECS Service Linked Role
    // This ensures ECS clusters can be created without permission issues
    const ecsServiceLinkedRole = new Role(scope, "ECSServiceLinkedRole", {
      roleName: "AWSServiceRoleForECS",
      description: "Service-linked role for Amazon ECS",
      assumedBy: new ServicePrincipal("ecs.amazonaws.com"),
      managedPolicies: [
        {
          managedPolicyArn: "arn:aws:iam::aws:policy/aws-service-role/ECSServiceRolePolicy",
        },
      ],
      path: "/aws-service-role/ecs.amazonaws.com/",
    });

    addCfnGuardSuppression(ecsServiceLinkedRole, [
      "CFN_NO_EXPLICIT_RESOURCE_NAMES",
      "IAM_NO_INLINE_POLICY_CHECK",
    ]);
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Stack } from "aws-cdk-lib";
import {
  AccountRootPrincipal,
  CfnRole,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

type IntermediateRoleProps = {
  namespace: string;
  idcAccountId: string;
  orgMgtAccountId: string;
};

export function getIntermediateRoleName(namespace: string) {
  return `InnovationSandbox-${namespace}-IntermediateRole`;
}

export function getIdcRoleName(namespace: string) {
  return `InnovationSandbox-${namespace}-IdcRole`;
}

export function getOrgMgtRoleName(namespace: string) {
  return `InnovationSandbox-${namespace}-OrgMgtRole`;
}

export function getSandboxAccountRoleName(namespace: string) {
  return `InnovationSandbox-${namespace}-SandboxAccountRole`;
}

export function getOrgMgtRoleArn(
  scope: Construct,
  namespace: string,
  orgMgtAccountId: string,
) {
  return Stack.of(scope).formatArn({
    service: "iam",
    resource: "role",
    region: "",
    account: orgMgtAccountId,
    resourceName: getOrgMgtRoleName(namespace),
  });
}

export function getIdcRoleArn(
  scope: Construct,
  namespace: string,
  idcAccountId: string,
) {
  return Stack.of(scope).formatArn({
    service: "iam",
    resource: "role",
    region: "",
    account: idcAccountId,
    resourceName: getIdcRoleName(namespace),
  });
}

export class IntermediateRole {
  private static instance = undefined as undefined | Role;
  private static readonly trustedRoles: Role[] = [];
  public static getInstance(
    scope: Construct,
    props: IntermediateRoleProps,
  ): Role {
    if (!IntermediateRole.instance) {
      IntermediateRole.instance = new Role(scope, "IntermediateRole", {
        roleName: getIntermediateRoleName(props.namespace),
        // assumedBy can't be empty on role creation. But we don't have the lambda execution roles yet.
        // create it with a dummy placeholder and override it later when the roles register (addATrustedRole)
        assumedBy: new PrincipalWithConditions(new AccountRootPrincipal(), {
          ArnEquals: {
            "aws:PrincipalArn": Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: props.idcAccountId,
              resourceName: "PlaceHolder",
            }),
          },
        }),
      });
      IntermediateRole.instance.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: props.idcAccountId,
              resourceName: getIdcRoleName(props.namespace),
            }),
          ],
        }),
      );
      IntermediateRole.instance.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: props.orgMgtAccountId,
              resourceName: getOrgMgtRoleName(props.namespace),
            }),
          ],
        }),
      );
      IntermediateRole.instance.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole"],
          resources: [
            Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: "*",
              resourceName: getSandboxAccountRoleName(props.namespace),
            }),
          ],
        }),
      );
    }
    return IntermediateRole.instance;
  }
  public static addTrustedRole(role: Role) {
    if (!IntermediateRole.instance) {
      throw new Error("IntermediateRole not created yet");
    }
    IntermediateRole.trustedRoles.push(role);
    const cfnRole = IntermediateRole.instance.node.defaultChild as CfnRole;
    cfnRole.addPropertyOverride("AssumeRolePolicyDocument.Statement", [
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: {
          AWS: {
            "Fn::Join": [
              "",
              [
                "arn:",
                {
                  Ref: "AWS::Partition",
                },
                ":iam::",
                {
                  Ref: "AWS::AccountId",
                },
                ":root",
              ],
            ],
          },
        },
        Condition: {
          "ForAnyValue:StringEquals": {
            "aws:PrincipalArn": IntermediateRole.trustedRoles.map(
              (role) => role.roleArn,
            ),
          },
        },
      },
      {
        Effect: "Allow",
        Action: "sts:AssumeRole",
        Principal: {
          Service: "cloudformation.amazonaws.com",
        },
      },
    ]);

    IntermediateRole.instance.grantAssumeRole(role);
  }
  public static getRoleArn(): string {
    if (!IntermediateRole.instance) {
      throw new Error("IntermediateRole not created yet");
    }
    return IntermediateRole.instance.roleArn;
  }
}

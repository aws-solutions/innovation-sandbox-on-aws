// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Stack } from "aws-cdk-lib";
import {
  AccountRootPrincipal,
  CfnRole,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
} from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";

import {
  getIsbTagValue,
  isbTagName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";

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

export function getPermissionSetEventForwardingRoleName(namespace: string) {
  return `${namespace}-PermissionSetEventForwardingRole`;
}

/**
 * Role name for the sandbox agent role.
 * Does not start with InnovationSandbox-{namespace} — as the SCP denies actions
 * on `InnovationSandbox-{namespace}*` roles, so this role must use a different
 * prefix to remain accessible from within the sandbox account.
 */
export function getSandboxAgentRoleName(namespace: string) {
  return `SandboxAgentRole-${namespace}`;
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

export function getPermissionSetEventForwardingRoleArn(
  scope: Construct,
  namespace: string,
  idcAccountId: string,
) {
  return Stack.of(scope).formatArn({
    service: "iam",
    resource: "role",
    region: "",
    account: idcAccountId,
    resourceName: getPermissionSetEventForwardingRoleName(namespace),
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
  });
}

export class IntermediateRole {
  private static instance = undefined as undefined | Role;
  private static namespace = undefined as undefined | string;
  public static getInstance(
    scope: Construct,
    props: IntermediateRoleProps,
  ): Role {
    if (!IntermediateRole.instance) {
      IntermediateRole.namespace = props.namespace;
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
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
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
      IntermediateRole.instance.addToPolicy(
        new PolicyStatement({
          actions: ["sts:AssumeRole", "sts:SetSourceIdentity"],
          resources: [
            Stack.of(scope).formatArn({
              service: "iam",
              resource: "role",
              region: "",
              account: "*",
              resourceName: getSandboxAgentRoleName(props.namespace),
            }),
          ],
        }),
      );
    }
    return IntermediateRole.instance;
  }
  public static addTrustedRole(role: Role) {
    if (
      !IntermediateRole.instance ||
      IntermediateRole.namespace === undefined
    ) {
      throw new Error("IntermediateRole not created yet");
    }
    const cfnRole = IntermediateRole.instance.node.defaultChild as CfnRole;
    cfnRole.addPropertyOverride("AssumeRolePolicyDocument.Statement", [
      {
        Effect: "Allow",
        Action: ["sts:AssumeRole", "sts:SetSourceIdentity"],
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
          StringEquals: {
            [`aws:PrincipalTag/${isbTagName}`]: getIsbTagValue(
              IntermediateRole.namespace,
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
        // Scope the CloudFormation service trust to StackSets in this (hub)
        // account. Without a source-account/source-ARN condition, any external
        // account's CloudFormation service could name this role as a StackSet
        // administration role and assume it (confused deputy), which is
        // dangerous because this role can assume into every sandbox account,
        // the IDC account, and the Org Management account.
        Condition: {
          StringEquals: {
            "aws:SourceAccount": {
              Ref: "AWS::AccountId",
            },
          },
          ArnLike: {
            "aws:SourceArn": {
              "Fn::Join": [
                "",
                [
                  "arn:",
                  {
                    Ref: "AWS::Partition",
                  },
                  ":cloudformation:*:",
                  {
                    Ref: "AWS::AccountId",
                  },
                  ":stackset/*",
                ],
              ],
            },
          },
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

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Fn, Stack, aws_ram, aws_ssm } from "aws-cdk-lib";
import { EventBus, Rule } from "aws-cdk-lib/aws-events";
import { EventBus as EventBusTarget } from "aws-cdk-lib/aws-events-targets";
import {
  AccountPrincipal,
  Effect,
  Policy,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { ParameterTier } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import { IdcConfig } from "@amzn/innovation-sandbox-commons/data/idc-stack-config/idc-stack-config.js";
import { sharedIdcSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { IdcConfigurer } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/idc-configurer";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  getIsbEventBusArn,
  getPermissionSetEventsForwarderArn,
  getPermissionSetEventsForwarderName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-events";
import {
  getIdcRoleName,
  getIntermediateRoleName,
  getPermissionSetEventForwardingRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";

const supportedSchemas = ["1"];

export interface IsbIdcResourcesProps {
  orgMgtAccountId: string;
  hubAccountId: string;
  identityStoreId: string;
  ssoInstanceArn: string;
  adminGroupName: string;
  managerGroupName: string;
  userGroupName: string;
  namespace: string;
  solutionVersion: string;
}

export function addIsbIdcResources(
  scope: Construct,
  props: IsbIdcResourcesProps,
) {
  const identityStoreArn = Stack.of(scope).formatArn({
    service: "identitystore",
    resource: "identitystore",
    region: "",
    account: props.orgMgtAccountId,
    arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
    resourceName: props.identityStoreId,
  });
  const instanceId = Fn.select(1, Fn.split("/", props.ssoInstanceArn));
  const hubEventBusArn = getIsbEventBusArn(
    scope,
    props.namespace,
    props.hubAccountId,
  );

  const idcConfigurer = new IdcConfigurer(scope, "IdcConfigurer", {
    orgMgtAccountId: props.orgMgtAccountId,
    namespace: props.namespace,
    ssoInstanceArn: props.ssoInstanceArn,
    identityStoreId: props.identityStoreId,
    adminGroupName: props.adminGroupName,
    managerGroupName: props.managerGroupName,
    userGroupName: props.userGroupName,
  });

  const idcRole = new Role(scope, "IdcRole", {
    roleName: getIdcRoleName(props.namespace),
    description: "Role to be assumed for IDC operations",
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
  });

  idcRole.attachInlinePolicy(
    new Policy(scope, "IdcRolePolicy", {
      statements: [
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "identitystore:GetUserId",
            "identitystore:DescribeUser",
            "identitystore:ListUsers",
          ],
          resources: [
            identityStoreArn,
            Stack.of(scope).formatArn({
              service: "identitystore",
              region: "",
              account: "",
              resource: "user",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
          ],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["tag:GetResources"],
          resources: ["*"],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: ["sso:ListPermissionSetsProvisionedToAccount"],
          resources: [
            props.ssoInstanceArn,
            Stack.of(scope).formatArn({
              service: "sso",
              account: "",
              region: "",
              resource: "account",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
          ],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "identitystore:ListGroups",
            "identitystore:GetGroupId",
            "identitystore:DescribeGroup",
          ],
          resources: [
            identityStoreArn,
            Stack.of(scope).formatArn({
              service: "identitystore",
              region: "",
              account: "",
              resource: "group",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
          ],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "identitystore:ListGroupMembershipsForMember",
            "identitystore:ListGroupMemberships",
          ],
          resources: [
            identityStoreArn,
            Stack.of(scope).formatArn({
              service: "identitystore",
              region: "",
              account: "",
              resource: "group",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
            Stack.of(scope).formatArn({
              service: "identitystore",
              region: "",
              account: "",
              resource: "membership",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
            Stack.of(scope).formatArn({
              service: "identitystore",
              region: "",
              account: "",
              resource: "user",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
          ],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "sso:ListPermissionSets",
            "sso:DescribePermissionSet",
            "sso:ListTagsForResource",
            "sso:GetInlinePolicyForPermissionSet",
            "sso:ListManagedPoliciesInPermissionSet",
            "sso:ListCustomerManagedPolicyReferencesInPermissionSet",
            "sso:GetPermissionsBoundaryForPermissionSet",
          ],
          resources: [
            props.ssoInstanceArn,
            Stack.of(scope).formatArn({
              service: "sso",
              account: "",
              region: "",
              resource: "permissionSet",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: `${instanceId}/*`,
            }),
          ],
        }),
        new PolicyStatement({
          effect: Effect.ALLOW,
          actions: [
            "sso:CreateAccountAssignment",
            "sso:DeleteAccountAssignment",
            "sso:DescribeAccountAssignmentCreationStatus",
            "sso:ListAccountAssignmentCreationStatus",
            "sso:DescribeAccountAssignmentDeletionStatus",
            "sso:ListAccountAssignments",
          ],
          resources: [
            props.ssoInstanceArn,
            Stack.of(scope).formatArn({
              service: "sso",
              account: "",
              region: "",
              resource: "account",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: "*",
            }),
            Stack.of(scope).formatArn({
              service: "sso",
              account: "",
              region: "",
              resource: "permissionSet",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
              resourceName: `${instanceId}/*`,
            }),
          ],
        }),
      ],
    }),
  );

  addCfnGuardSuppression(idcRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

  const permissionSetEventsForwarderName = getPermissionSetEventsForwarderName(
    props.namespace,
  );
  const eventForwardingRole = new Role(
    scope,
    "PermissionSetEventForwardingRole",
    {
      roleName: getPermissionSetEventForwardingRoleName(props.namespace),
      assumedBy: new PrincipalWithConditions(
        new ServicePrincipal("events.amazonaws.com"),
        {
          StringEquals: {
            "aws:SourceAccount": Stack.of(scope).account,
          },
          ArnEquals: {
            "aws:SourceArn": getPermissionSetEventsForwarderArn(
              scope,
              props.namespace,
              Stack.of(scope).account,
            ),
          },
        },
      ),
    },
  );
  addCfnGuardSuppression(eventForwardingRole, [
    "CFN_NO_EXPLICIT_RESOURCE_NAMES",
  ]);
  eventForwardingRole.addToPolicy(
    new PolicyStatement({
      actions: ["events:PutEvents"],
      resources: [hubEventBusArn],
    }),
  );

  new Rule(scope, "PermissionSetEventsForwarder", {
    ruleName: permissionSetEventsForwarderName,
    description:
      "Forwards IAM Identity Center permission set lifecycle events to the ISB hub",
    eventPattern: {
      source: ["aws.sso"],
      detailType: ["AWS API Call via CloudTrail"],
      detail: {
        eventSource: ["sso.amazonaws.com"],
        eventName: [
          "CreatePermissionSet",
          "TagResource",
          "UntagResource",
          "DeletePermissionSet",
          "UpdatePermissionSet",
        ],
        errorCode: [{ exists: false }],
        errorMessage: [{ exists: false }],
      },
    },
    targets: [
      new EventBusTarget(
        EventBus.fromEventBusArn(
          scope,
          "HubPermissionSetEventBus",
          hubEventBusArn,
        ),
        { role: eventForwardingRole },
      ),
    ],
  });

  const ssmParamIdcConfiguration = new aws_ssm.StringParameter(
    scope,
    "IdcConfiguration",
    {
      parameterName: sharedIdcSsmParamName(props.namespace),
      description: "The IDC configuration for Innovation Sandbox",
      stringValue: JSON.stringify({
        identityStoreId: props.identityStoreId,
        ssoInstanceArn: props.ssoInstanceArn,
        adminGroupId: idcConfigurer.adminGroupId,
        adminPermissionSetArn: idcConfigurer.adminPermissionSetArn,
        managerGroupId: idcConfigurer.managerGroupId,
        managerPermissionSetArn: idcConfigurer.managerPermissionSetArn,
        userGroupId: idcConfigurer.userGroupId,
        userPermissionSetArn: idcConfigurer.userPermissionSetArn,
        solutionVersion: props.solutionVersion,
        supportedSchemas: JSON.stringify(supportedSchemas),
      } satisfies IdcConfig),
      tier: ParameterTier.ADVANCED,
      simpleName: true,
    },
  );

  new aws_ram.CfnResourceShare(scope, "IdcConfigParameterShare", {
    name: `Isb-${props.namespace}-IdcConfigShare`,
    principals: [props.hubAccountId],
    resourceArns: [ssmParamIdcConfiguration.parameterArn],
    allowExternalPrincipals: false,
    permissionArns: [
      "arn:aws:ram::aws:permission/AWSRAMDefaultPermissionSSMParameterReadOnly",
    ],
  });
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  App,
  ArnFormat,
  aws_ram,
  aws_ssm,
  Fn,
  IStackSynthesizer,
  Stack,
} from "aws-cdk-lib";
import { CfnStackSet } from "aws-cdk-lib/aws-cloudformation";
import {
  AccountPrincipal,
  Policy,
  PolicyStatement,
  PrincipalWithConditions,
  Role,
} from "aws-cdk-lib/aws-iam";
import {
  CfnOrganizationalUnit,
  CfnPolicy,
} from "aws-cdk-lib/aws-organizations";
import { Asset } from "aws-cdk-lib/aws-s3-assets";
import { ParameterTier } from "aws-cdk-lib/aws-ssm";
import { Construct } from "constructs";

import { sharedAccountPoolSsmParamName } from "@amzn/innovation-sandbox-commons/types/isb-types.js";
import { CostAllocationTagActivator } from "@amzn/innovation-sandbox-infrastructure/components/custom-resources/cost-allocation-tag-activator";
import {
  getInnovationSandboxAwsNukeSupportedServicesScp,
  getInnovationSandboxLimitRegionsScp,
  getInnovationSandboxProtectScp,
  getInnovationSandboxRestrictionsScp,
  getInnovationSandboxWriteProtectionScp,
} from "@amzn/innovation-sandbox-infrastructure/components/service-control-policies/isb-get-scp";
import {
  getContextFromMapping,
  getSolutionContext,
} from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  getIntermediateRoleName,
  getOrgMgtRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { IsbSandboxAccountStack } from "@amzn/innovation-sandbox-infrastructure/isb-sandbox-account-stack";
import { AccountPoolConfig } from "@amzn/innovation-sandbox-shared-json-param-parser/src/shared-json-param-parser-handler.js";
import path from "path";

/*
When adding new OUs/SCPs in a backwards compatible fashion, increment the current schema version and list all
previous schemas that would still be compatible with this account pool

if deleting/modifying an OU/SCP in a way that would break older schemas, remove that schema from the list below
after incrementing to a new version.
*/
const supportedSchemas = ["1"];

export interface IsbAccountPoolResourcesProps {
  readonly namespace: string;
  readonly parentOuId: string;
  readonly hubAccountId: string;
  readonly isbManagedRegions: string[];
  readonly synthesizer?: IStackSynthesizer;
}

export class IsbAccountPoolResources {
  constructor(scope: Construct, props: IsbAccountPoolResourcesProps) {
    // Organizational Units
    const sandboxOu = new CfnOrganizationalUnit(
      scope,
      "InnovationSandboxAccountPoolOu",
      {
        name: `${props.namespace}_InnovationSandboxAccountPool`,
        parentId: props.parentOuId,
      },
    );

    const availableOu = new CfnOrganizationalUnit(scope, "AvailableOu", {
      name: "Available",
      parentId: sandboxOu.attrId,
    });

    const activeOu = new CfnOrganizationalUnit(scope, "ActiveOu", {
      name: "Active",
      parentId: sandboxOu.attrId,
    });

    const cleanUpOu = new CfnOrganizationalUnit(scope, "CleanUpOu", {
      name: "CleanUp",
      parentId: sandboxOu.attrId,
    });

    const quarantineOu = new CfnOrganizationalUnit(scope, "QuarantineOu", {
      name: "Quarantine",
      parentId: sandboxOu.attrId,
    });

    const entryOu = new CfnOrganizationalUnit(scope, "EntryOu", {
      name: "Entry",
      parentId: sandboxOu.attrId,
    });

    const exitOu = new CfnOrganizationalUnit(scope, "ExitOu", {
      name: "Exit",
      parentId: sandboxOu.attrId,
    });

    const frozenOu = new CfnOrganizationalUnit(scope, "FrozenOu", {
      name: "Frozen",
      parentId: sandboxOu.attrId,
    });

    const organizationId = Fn.select(1, Fn.split("/", sandboxOu.attrArn));

    // Service Control Policies (SCPs)

    const allowedServicesScp = getInnovationSandboxAwsNukeSupportedServicesScp({
      namespace: props.namespace,
    });

    new CfnPolicy(scope, "InnovationSandboxAwsNukeSupportedServicesScp", {
      name: `InnovationSandboxAwsNukeSupportedServicesScp_${props.namespace}`,
      description:
        "Service Control Policy (SCP) to allow only services supported by AWS Nuke clean workflow. ",
      type: "SERVICE_CONTROL_POLICY",
      content: allowedServicesScp.toJSON(),
      targetIds: [sandboxOu.attrId],
    });

    const restrictionScp = getInnovationSandboxRestrictionsScp({
      namespace: props.namespace,
    });

    new CfnPolicy(scope, "InnovationSandboxRestrictionsScp", {
      name: "InnovationSandboxRestrictionsScp",
      description:
        "Service Control Policy (SCP) to add restrictions for security, isolation, cost and operations related resources.",
      type: "SERVICE_CONTROL_POLICY",
      content: restrictionScp.toJSON(),
      targetIds: [sandboxOu.attrId],
    });

    const protectionScp = getInnovationSandboxProtectScp({
      namespace: props.namespace,
    });

    new CfnPolicy(scope, "InnovationSandboxProtectISBScp", {
      name: "InnovationSandboxProtectISBResourcesScp",
      description:
        "Service Control Policy (SCP) for Innovation Sandbox to protect ISB control plane resources.",
      type: "SERVICE_CONTROL_POLICY",
      content: protectionScp.toJSON(),
      targetIds: [sandboxOu.attrId],
    });

    const limitRegionsScp = getInnovationSandboxLimitRegionsScp({
      namespace: props.namespace,
      isbManagedRegions: props.isbManagedRegions,
    });

    new CfnPolicy(scope, "InnovationSandboxLimitRegionsScp", {
      name: "InnovationSandboxLimitRegionsScp",
      description:
        "Service Control Policy (SCP) for Innovation Sandbox to limit use of AWS Regions.",
      type: "SERVICE_CONTROL_POLICY",
      content: limitRegionsScp.toJSON(),
      targetIds: [sandboxOu.attrId],
    });

    const writeProtectionScp = getInnovationSandboxWriteProtectionScp({
      namespace: props.namespace,
    });

    new CfnPolicy(scope, "InnovationSandboxWriteProtectionScp", {
      name: "InnovationSandboxWriteProtectionScp",
      description:
        "Service Control Policy (SCP) for Innovation Sandbox to restrict all resource to create or modify actions.",
      type: "SERVICE_CONTROL_POLICY",
      content: writeProtectionScp.toJSON(),
      targetIds: [
        availableOu.attrId,
        cleanUpOu.attrId,
        quarantineOu.attrId,
        entryOu.attrId,
        exitOu.attrId,
      ],
    });

    const orgMgtRole = new Role(scope, "OrgMgtRole", {
      roleName: getOrgMgtRoleName(props.namespace),
      description:
        "Role to be assumed for operations on the org management account",
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

    orgMgtRole.attachInlinePolicy(
      new Policy(scope, "OrganizationsPolicy", {
        statements: [
          new PolicyStatement({
            actions: [
              "organizations:ListOrganizationalUnitsForParent",
              "organizations:ListAccountsForParent",
            ],
            resources: [
              sandboxOu.attrArn,
              availableOu.attrArn,
              activeOu.attrArn,
              cleanUpOu.attrArn,
              quarantineOu.attrArn,
              entryOu.attrArn,
              exitOu.attrArn,
              frozenOu.attrArn,
            ],
          }),
          new PolicyStatement({
            actions: ["organizations:MoveAccount"],
            resources: [
              availableOu.attrArn,
              activeOu.attrArn,
              cleanUpOu.attrArn,
              quarantineOu.attrArn,
              entryOu.attrArn,
              exitOu.attrArn,
              frozenOu.attrArn,
              Stack.of(scope).formatArn({
                service: "organizations",
                region: "",
                resource: "account",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                resourceName: `${organizationId}/*`,
              }),
              Stack.of(scope).formatArn({
                service: "organizations",
                region: "",
                resource: "root",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                resourceName: `${organizationId}/*`,
              }),
            ],
          }),
          new PolicyStatement({
            actions: ["organizations:DescribeAccount"],
            resources: [
              Stack.of(scope).formatArn({
                service: "organizations",
                region: "",
                resource: "account",
                arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
                resourceName: `${organizationId}/*`,
              }),
            ],
          }),
        ],
      }),
    );
    orgMgtRole.attachInlinePolicy(
      new Policy(scope, "CostExplorerPolicy", {
        statements: [
          new PolicyStatement({
            actions: ["ce:GetCostAndUsage"],
            resources: ["*"], // We cannot use a custom billing view to effectively constrain this permission
          }),
        ],
      }),
    );

    addCfnGuardSuppression(orgMgtRole, ["CFN_NO_EXPLICIT_RESOURCE_NAMES"]);

    const ssmParamAccountPoolConfiguration = new aws_ssm.StringParameter(
      scope,
      "AccountPoolConfiguration",
      {
        parameterName: sharedAccountPoolSsmParamName(props.namespace),
        description: "The Account pool configuration for Innovation Sandbox",
        stringValue: JSON.stringify({
          sandboxOuId: sandboxOu.attrId,
          solutionVersion: getContextFromMapping(scope, "version"),
          supportedSchemas: JSON.stringify(supportedSchemas),
          isbManagedRegions: Fn.join(",", props.isbManagedRegions),
        } satisfies AccountPoolConfig),
        tier: ParameterTier.ADVANCED,
        simpleName: true,
      },
    );

    new aws_ram.CfnResourceShare(scope, "AccountPoolConfigParameterShare", {
      name: `Isb-${props.namespace}-AccountPoolConfigShare`,
      principals: [props.hubAccountId],
      resourceArns: [ssmParamAccountPoolConfiguration.parameterArn],
      allowExternalPrincipals: false,
      permissionArns: [
        "arn:aws:ram::aws:permission/AWSRAMDefaultPermissionSSMParameterReadOnly",
      ],
    });
    const outdir = App.of(scope)!.outdir;
    const sandboxAccountStackApp = new App({ outdir });
    const context = getSolutionContext(sandboxAccountStackApp.node);
    const sandboxAccountStack = new IsbSandboxAccountStack(
      sandboxAccountStackApp,
      "InnovationSandbox-SandboxAccount",
      {
        description: `(${context.solutionId}-SandboxAccount) ${context.solutionName} ${context.version}`,
        synthesizer: props.synthesizer,
      },
    );
    sandboxAccountStackApp.synth();

    const sandboxAccountTemplateAsset = new Asset(
      scope,
      "SandboxAccountTemplateAsset",
      {
        path: path.join(outdir, sandboxAccountStack.templateFile),
      },
    );

    new CfnStackSet(scope, "IsbStackSet", {
      stackSetName: `Isb-${props.namespace}-SandboxAccountResources`,
      permissionModel: "SERVICE_MANAGED",
      capabilities: ["CAPABILITY_NAMED_IAM"],
      description: "StackSet for Innovation Sandbox",
      autoDeployment: {
        enabled: true,
        retainStacksOnAccountRemoval: false,
      },
      stackInstancesGroup: [
        {
          deploymentTargets: {
            organizationalUnitIds: [sandboxOu.attrId],
          },
          regions: [Stack.of(scope).region],
        },
      ],
      parameters: [
        {
          parameterKey: "Namespace",
          parameterValue: props.namespace,
        },
        {
          parameterKey: "HubAccountId",
          parameterValue: props.hubAccountId,
        },
      ],
      operationPreferences: {
        concurrencyMode: "SOFT_FAILURE_TOLERANCE",
        failureTolerancePercentage: 100,
        maxConcurrentPercentage: 100,
        regionConcurrencyType: "PARALLEL",
      },
      managedExecution: {
        Active: true,
      },
      templateUrl: sandboxAccountTemplateAsset.httpUrl,
    });

    new CostAllocationTagActivator(scope, "CostAllocationTagActivator", {
      namespace: props.namespace,
    });
  }
}

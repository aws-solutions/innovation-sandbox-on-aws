// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { BaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/base-lambda-environment";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import { ArnFormat, CustomResource, Stack } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "node:path";

export interface OrganizationIntegrationsProps {
  namespace: string;
}

const STACKSETS_SERVICE_PRINCIPAL = "stacksets.cloudformation.amazonaws.com";
const RAM_SERVICE_PRINCIPAL = "ram.amazonaws.com";

/**
 * Enables the two AWS Organizations integrations this stack depends on:
 * StackSets trusted access, which every service-managed StackSet needs, and
 * RAM sharing within the organization, which the config parameter share
 * needs. Runs in the AccountPool stack because only the organization
 * management account may enable them. An integration that is already on is
 * left as it is, and neither is ever turned off on delete.
 */
export class OrganizationIntegrations extends Construct {
  readonly customResource: CustomResource;

  constructor(
    scope: Construct,
    id: string,
    props: OrganizationIntegrationsProps,
  ) {
    super(scope, id);

    const integrations = new IsbLambdaFunctionCustomResource(
      this,
      "OrganizationIntegrations",
      {
        description:
          "Custom resource lambda that enables StackSets trusted access and RAM sharing with AWS Organizations",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "custom-resources",
          "organization-integrations",
          "src",
          "organization-integrations-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        environment: {},
        envSchema: BaseLambdaEnvironmentSchema,
        customResourceType: "Custom::OrganizationIntegrations",
      },
    );
    this.customResource = integrations.customResource;

    const statements = [
      // None of these actions have resource-level permissions. CloudFormation
      // and RAM call DescribeOrganization and ListRoots on the caller's behalf
      // while activating.
      new PolicyStatement({
        actions: [
          "cloudformation:DescribeOrganizationsAccess",
          "cloudformation:ActivateOrganizationsAccess",
          "ram:EnableSharingWithAwsOrganization",
          "organizations:ListAWSServiceAccessForOrganization",
          "organizations:DescribeOrganization",
          "organizations:ListRoots",
        ],
        resources: ["*"],
      }),
      // Each activation enables its service principals in Organizations and
      // creates that service's service-linked role in the management account.
      new PolicyStatement({
        actions: ["organizations:EnableAWSServiceAccess"],
        resources: ["*"],
        conditions: {
          StringEquals: {
            "organizations:ServicePrincipal": [
              STACKSETS_SERVICE_PRINCIPAL,
              `member.org.${STACKSETS_SERVICE_PRINCIPAL}`,
              RAM_SERVICE_PRINCIPAL,
            ],
          },
        },
      }),
      ...this.serviceLinkedRoleStatements(
        STACKSETS_SERVICE_PRINCIPAL,
        "AWSServiceRoleForCloudFormationStackSetsOrgAdmin",
      ),
      ...this.serviceLinkedRoleStatements(
        RAM_SERVICE_PRINCIPAL,
        "AWSServiceRoleForResourceAccessManager",
      ),
    ];
    for (const statement of statements) {
      integrations.lambdaFunction.addToRolePolicy(statement);
    }
  }

  /**
   * Activation reads the service-linked role before creating it, and the
   * service-name condition only exists on the create request. IAM authorizes
   * the read of a role that does not exist yet against the path-less ARN and
   * of an existing one against its path, so GetRole needs both.
   */
  private serviceLinkedRoleStatements(
    servicePrincipal: string,
    roleName: string,
  ): PolicyStatement[] {
    const roleArn = (resourceName: string) =>
      Stack.of(this).formatArn({
        service: "iam",
        region: "",
        resource: "role",
        arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
        resourceName,
      });
    const pathQualifiedArn = roleArn(
      `aws-service-role/${servicePrincipal}/${roleName}`,
    );
    return [
      new PolicyStatement({
        actions: ["iam:GetRole"],
        resources: [pathQualifiedArn, roleArn(roleName)],
      }),
      new PolicyStatement({
        actions: ["iam:CreateServiceLinkedRole"],
        resources: [pathQualifiedArn],
        conditions: {
          StringEquals: { "iam:AWSServiceName": servicePrincipal },
        },
      }),
    ];
  }
}

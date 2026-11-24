// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, Stack } from "aws-cdk-lib";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { LeaseLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getIdcRoleArn,
  getOrgMgtRoleArn,
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantCfnStackSetCleanupPermissions,
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class LeasesApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      leaseTemplateTable,
      leaseTable,
      leaseCostHistoryTable,
      accountTable,
      principalTable,
      sandboxSpacesUsageTable,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leasesLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "LeasesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for leases resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "leases",
          "src",
          "leases-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          ISB_NAMESPACE: namespace,
          ACCOUNT_TABLE_NAME: accountTable,
          LEASE_TABLE_NAME: leaseTable,
          LEASE_COST_HISTORY_TABLE_NAME: leaseCostHistoryTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          PRINCIPAL_TABLE_NAME: principalTable,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(scope, namespace, props.idcAccountId),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            namespace,
            props.orgMgtAccountId,
          ),
          BLUEPRINT_TABLE_NAME:
            IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          SANDBOX_SPACES_USAGE_TABLE_NAME: sandboxSpacesUsageTable,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
        },
        envSchema: LeaseLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = leasesLambdaFunction.lambdaFunction;

    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );
    grantIsbSsmParameterRead(
      leasesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );
    grantIsbDbReadWrite(
      scope,
      leasesLambdaFunction,
      leaseTable,
      leaseTemplateTable,
      accountTable,
      IsbComputeStack.sharedSpokeConfig.data.blueprintTable,
      principalTable,
      sandboxSpacesUsageTable,
    );
    grantIsbDbReadOnly(
      scope,
      leasesLambdaFunction,
      configTableName,
      leaseCostHistoryTable,
    );

    props.isbEventBus.grantPutEventsTo(leasesLambdaFunction.lambdaFunction);

    // Grant CloudFormation StackSet read-only permissions for blueprint validation
    leasesLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:DescribeStackSet"],
        resources: [
          Stack.of(scope).formatArn({
            service: "cloudformation",
            resource: "stackset",
            resourceName: "*:*",
          }),
        ],
      }),
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      leasesLambdaFunction.lambdaFunction,
    );

    // Grant CloudFormation permissions for stack instance cleanup during manual lease termination.
    // POST /leases/{leaseId}/terminate calls deleteStackInstancesMetadata() which needs DeleteStackInstances.
    grantCfnStackSetCleanupPermissions(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );

    IntermediateRole.addTrustedRole(
      leasesLambdaFunction.lambdaFunction.role! as Role,
    );
  }
}

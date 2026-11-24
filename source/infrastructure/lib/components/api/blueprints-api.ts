// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { Role } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { BlueprintLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  getSandboxAccountRoleName,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantCfnStackSetReadOnly,
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class BlueprintsApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      leaseTemplateTable,
      blueprintTable,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const blueprintsLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "BlueprintsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for blueprints resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "blueprints",
          "src",
          "blueprints-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          ISB_NAMESPACE: namespace,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
          ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
        },
        envSchema: BlueprintLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = blueprintsLambdaFunction.lambdaFunction;

    // Grant DynamoDB permissions
    grantIsbDbReadWrite(
      scope,
      blueprintsLambdaFunction,
      blueprintTable,
      leaseTemplateTable,
    );
    grantIsbDbReadOnly(scope, blueprintsLambdaFunction, configTableName);

    // Grant CloudFormation read-only permissions for StackSet discovery and validation
    grantCfnStackSetReadOnly(
      blueprintsLambdaFunction.lambdaFunction.role! as Role,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      blueprintsLambdaFunction.lambdaFunction,
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { Role } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { PrincipalsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principals-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class PrincipalsApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      principalTable,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const principalsLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "PrincipalsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for principals search. Reads from DynamoDB cache for fast typeahead.",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "principals",
          "src",
          "principals-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          PRINCIPAL_TABLE_NAME: principalTable,
          CONFIG_TABLE_NAME: configTableName,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          ISB_NAMESPACE: namespace,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          IDC_ROLE_ARN: getIdcRoleArn(scope, namespace, props.idcAccountId),
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        },
        envSchema: PrincipalsLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = principalsLambdaFunction.lambdaFunction;

    // Read-only on config table; read-write on principal table for cache write-through
    grantIsbDbReadOnly(scope, principalsLambdaFunction, configTableName);
    grantIsbDbReadWrite(scope, principalsLambdaFunction, principalTable);

    grantIsbSsmParameterRead(
      principalsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    // Allow the Principals Lambda to assume the IntermediateRole for JIT IDC lookups.
    IntermediateRole.addTrustedRole(
      principalsLambdaFunction.lambdaFunction.role! as Role,
    );
  }
}

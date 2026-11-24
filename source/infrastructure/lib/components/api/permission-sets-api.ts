// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { Role } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { PermissionSetsLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/permission-sets-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  grantIsbDbReadOnly,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class PermissionSetsApi {
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
    const idcConfigParamArn =
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn;

    const permissionSetsLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "PermissionSetsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for the permission set catalog.",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "permission-sets",
          "src",
          "permission-sets-handler.ts",
        ),
        handler: "handler",
        namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          PRINCIPAL_TABLE_NAME: principalTable,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          ISB_NAMESPACE: namespace,
          IDC_CONFIG_PARAM_ARN: idcConfigParamArn,
        },
        envSchema: PermissionSetsLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = permissionSetsLambdaFunction.lambdaFunction;

    grantIsbDbReadOnly(
      scope,
      permissionSetsLambdaFunction,
      configTableName,
      principalTable,
    );
    grantIsbSsmParameterRead(
      permissionSetsLambdaFunction.lambdaFunction.role! as Role,
      idcConfigParamArn,
    );
  }
}

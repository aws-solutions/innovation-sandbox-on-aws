// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { Role } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { LeaseTemplateLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/lease-template-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class LeaseTemplatesApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      leaseTemplateTable,
      blueprintTable,
      principalTable,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const leaseTemplatesLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "LeaseTemplatesLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for lease-templates resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "lease-templates",
          "src",
          "lease-templates-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          LEASE_TEMPLATE_TABLE_NAME: leaseTemplateTable,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          PRINCIPAL_TABLE_NAME: principalTable,
          IDC_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          ISB_NAMESPACE: namespace,
        },
        envSchema: LeaseTemplateLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = leaseTemplatesLambdaFunction.lambdaFunction;

    grantIsbDbReadWrite(
      scope,
      leaseTemplatesLambdaFunction,
      leaseTemplateTable,
    );
    grantIsbDbReadOnly(
      scope,
      leaseTemplatesLambdaFunction,
      configTableName,
      blueprintTable,
      principalTable,
    );
    grantIsbSsmParameterRead(
      leaseTemplatesLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      leaseTemplatesLambdaFunction.lambdaFunction,
    );
  }
}

// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws, CfnCondition, Fn } from "aws-cdk-lib";
import {
  CfnPolicy,
  Effect,
  Policy,
  PolicyStatement,
  Role,
} from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { ConfigurationLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/config-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class ConfigurationsApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      configTableName,
      awsAccessPortalUrl,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const configurationsLambdaFunction = new IsbApiLambdaFunction(
      scope,
      "ConfigurationsLambdaFunction",
      {
        description:
          "Lambda used as API GW method integration for configurations resources",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "configurations",
          "src",
          "configurations-handler.ts",
        ),
        handler: "handler",
        namespace: namespace,
        environment: {
          CONFIG_TABLE_NAME: configTableName,
          BEDROCK_REGIONAL_PRICE_TABLE_NAME:
            IsbComputeResources.bedrockPriceTable.tableName,
          AWS_ACCESS_PORTAL_URL: awsAccessPortalUrl,
          ACCOUNT_POOL_CONFIG_PARAM_ARN:
            IsbComputeStack.sharedSpokeConfig.parameterArns
              .accountPoolConfigParamArn,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          ISB_NAMESPACE: namespace,
          SES_IDENTITY_ARN: props.sesIdentityArn,
        },
        envSchema: ConfigurationLambdaEnvironmentSchema,
      },
    );
    this.lambdaFunction = configurationsLambdaFunction.lambdaFunction;

    // Configurations Lambda both reads and writes config sections.
    grantIsbDbReadWrite(scope, configurationsLambdaFunction, configTableName);

    IsbComputeResources.bedrockPriceTable.grant(
      configurationsLambdaFunction.lambdaFunction,
      "dynamodb:BatchGetItem",
    );

    // Resolve model identity and display metadata from Bedrock before creating
    // a catalog row
    configurationsLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:GetFoundationModel"],
        resources: [
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}::foundation-model/*`,
        ],
      }),
    );
    configurationsLambdaFunction.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:GetInferenceProfile"],
        resources: [
          `arn:${Aws.PARTITION}:bedrock:${Aws.REGION}:${Aws.ACCOUNT_ID}:inference-profile/*`,
        ],
      }),
    );

    // Grant access to read AccountPoolConfiguration SSM parameter for isbManagedRegions
    grantIsbSsmParameterRead(
      configurationsLambdaFunction.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      configurationsLambdaFunction.lambdaFunction,
    );

    // Hub-account verification calls SES; delegated identity coverage is local.
    const usesHubSesIdentity = new CfnCondition(scope, "UsesHubSesIdentity", {
      expression: Fn.conditionEquals(props.sesIdentityArn, ""),
    });
    const sesVerificationPolicy = new Policy(
      scope,
      "ConfigurationsSesVerificationPolicy",
      {
        statements: [
          new PolicyStatement({
            effect: Effect.ALLOW,
            actions: ["ses:GetIdentityVerificationAttributes"],
            // This SES API does not support resource-level permissions.
            resources: ["*"],
          }),
        ],
      },
    );
    sesVerificationPolicy.attachToRole(
      configurationsLambdaFunction.lambdaFunction.role!,
    );
    (
      sesVerificationPolicy.node.defaultChild as CfnPolicy
    ).cfnOptions.condition = usesHubSesIdentity;
  }
}

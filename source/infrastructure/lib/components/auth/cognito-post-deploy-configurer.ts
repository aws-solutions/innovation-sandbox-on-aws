// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { PolicyStatement } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "node:path";

import { CognitoPostDeployEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/cognito-post-deploy-environment.js";
import { IsbLambdaFunctionCustomResource } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function-custom-resource";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";

export interface CognitoPostDeployConfigurerProps {
  namespace: string;
  userPoolId: string;
  appClientId: string;
  preTokenGenLambdaArn: string;
  callbackUrls: string[];
  logoutUrls: string[];
}

export class CognitoPostDeployConfigurer extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: CognitoPostDeployConfigurerProps,
  ) {
    super(scope, id);

    const customResource = new IsbLambdaFunctionCustomResource(
      this,
      "CognitoConfigurer",
      {
        logGroup: IsbLogGroups.authLogGroup(scope, props.namespace),
        description:
          "Custom resource that attaches the Pre Token Generation trigger and updates App Client URLs",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "..",
          "source",
          "lambdas",
          "custom-resources",
          "cognito-post-deploy-configurer",
          "src",
          "cognito-post-deploy-configurer-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        envSchema: CognitoPostDeployEnvironmentSchema,
        environment: {},
        customResourceType: "Custom::CognitoPostDeployConfigurer",
        customResourceProperties: {
          UserPoolId: props.userPoolId,
          AppClientId: props.appClientId,
          PreTokenGenLambdaArn: props.preTokenGenLambdaArn,
          CallbackUrls: props.callbackUrls,
          LogoutUrls: props.logoutUrls,
          // Force update on every synth so URLs stay in sync
          forceUpdate: Date.now(),
        },
      },
    );

    customResource.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        actions: [
          "cognito-idp:DescribeUserPool",
          "cognito-idp:UpdateUserPool",
          "cognito-idp:UpdateUserPoolClient",
          "cognito-idp:DescribeUserPoolClient",
        ],
        resources: [
          `arn:${Aws.PARTITION}:cognito-idp:${Aws.REGION}:${Aws.ACCOUNT_ID}:userpool/${props.userPoolId}`,
        ],
      }),
    );
  }
}

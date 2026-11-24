// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Role } from "aws-cdk-lib/aws-iam";
import { CfnPermission } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { PreTokenGenerationEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/pre-token-generation-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbLogGroups } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-groups";
import {
  IntermediateRole,
  getIdcRoleArn,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { grantIsbSsmParameterRead } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface PreTokenGenerationLambdaProps {
  namespace: string;
  idcAccountId: string;
  cognitoUserPoolArn: string;
}

export class PreTokenGenerationLambda extends Construct {
  public readonly lambda: IsbLambdaFunction<
    typeof PreTokenGenerationEnvironmentSchema
  >;

  constructor(
    scope: Construct,
    id: string,
    props: PreTokenGenerationLambdaProps,
  ) {
    super(scope, id);

    this.lambda = new IsbLambdaFunction(scope, "PreTokenGeneration", {
      logGroup: IsbLogGroups.authLogGroup(scope, props.namespace),
      description:
        "Cognito Pre Token Generation trigger - resolves IDC group memberships and injects ISB roles into tokens",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "..",
        "source",
        "lambdas",
        "auth",
        "pre-token-generation",
        "src",
        "pre-token-generation-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        POWERTOOLS_SERVICE_NAME: "PreTokenGeneration",
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        ISB_NAMESPACE: props.namespace,
      },
      envSchema: PreTokenGenerationEnvironmentSchema,
    });

    // Grant SSM parameter read for IDC config
    grantIsbSsmParameterRead(
      this.lambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    // Allow the Lambda to assume the IntermediateRole for cross-account IDC access
    IntermediateRole.addTrustedRole(this.lambda.lambdaFunction.role! as Role);

    // Resource-based policy allowing Cognito to invoke this Lambda
    new CfnPermission(this, "CognitoInvokePermission", {
      action: "lambda:InvokeFunction",
      functionName: this.lambda.lambdaFunction.functionName,
      principal: "cognito-idp.amazonaws.com",
      sourceArn: props.cognitoUserPoolArn,
    });
  }
}

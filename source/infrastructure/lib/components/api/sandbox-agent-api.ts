// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Aws } from "aws-cdk-lib";
import { ArnPrincipal, Effect, PolicyStatement } from "aws-cdk-lib/aws-iam";
import { IFunction } from "aws-cdk-lib/aws-lambda";
import { Construct } from "constructs";
import path from "node:path";

import { SandboxAgentApiLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/sandbox-agent-api-lambda-environment.js";
import type { RestApiProps } from "@amzn/innovation-sandbox-infrastructure/components/api/rest-api-all";
import { IsbApiLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { grantIsbDbReadOnly } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export class SandboxAgentApi {
  public readonly lambdaFunction: IFunction;

  constructor(scope: Construct, props: RestApiProps) {
    const { namespace } = props;
    const {
      leaseTable,
      sandboxSpacesUsageTable,
      configTableName,
      cognitoUserPoolId,
      cognitoAppClientId,
      cognitoMcpClientId,
    } = IsbComputeStack.sharedSpokeConfig.data;

    const sandboxAgent = IsbComputeResources.sandboxAgent;

    const sandboxAgentApiLambda = new IsbApiLambdaFunction(
      scope,
      "SandboxAgentApiLambdaFunction",
      {
        description:
          "Sandbox Agent REST API: GET /sandboxAgent/history and GET /sandboxAgent/usage",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "api",
          "sandbox-agent",
          "src",
          "sandbox-agent-handler.ts",
        ),
        handler: "handler",
        namespace,
        environment: {
          LEASE_TABLE_NAME: leaseTable,
          SANDBOX_SPACES_USAGE_TABLE_NAME: sandboxSpacesUsageTable,
          CONFIG_TABLE_NAME: configTableName,
          BEDROCK_REGIONAL_PRICE_TABLE_NAME:
            IsbComputeResources.bedrockPriceTable.tableName,
          MEMORY_ACCESS_ROLE_ARN: sandboxAgent.memoryAccessRole.roleArn,
          USER_MEMORY_ARN: sandboxAgent.userMemoryArn,
          COGNITO_USER_POOL_ID: cognitoUserPoolId,
          COGNITO_APP_CLIENT_ID: cognitoAppClientId,
          COGNITO_MCP_CLIENT_ID: cognitoMcpClientId,
          HUB_ACCOUNT_ID: Aws.ACCOUNT_ID,
          ISB_NAMESPACE: namespace,
        },
        logGroup: IsbComputeResources.globalLogGroup,
        envSchema: SandboxAgentApiLambdaEnvironmentSchema,
      },
    );

    this.lambdaFunction = sandboxAgentApiLambda.lambdaFunction;

    // Read access to Lease, Config, and Sandbox Spaces Usage tables.
    grantIsbDbReadOnly(
      scope,
      sandboxAgentApiLambda,
      leaseTable,
      configTableName,
      sandboxSpacesUsageTable,
    );

    IsbKmsKeys.get(scope, namespace).grantEncryptDecrypt(
      sandboxAgentApiLambda.lambdaFunction,
    );

    // Allow Lambda to assume the Memory Access Role for scoped AgentCore credentials.
    sandboxAgentApiLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        resources: [sandboxAgent.memoryAccessRole.roleArn],
      }),
    );
    sandboxAgent.memoryAccessRole.assumeRolePolicy?.addStatements(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["sts:AssumeRole"],
        principals: [
          new ArnPrincipal(sandboxAgentApiLambda.lambdaFunction.role!.roleArn),
        ],
      }),
    );

    IsbComputeResources.bedrockPriceTable.grant(
      sandboxAgentApiLambda.lambdaFunction,
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
    );

    // Bedrock control-plane for GET /sandboxAgent/models:
    // ListFoundationModels and ListInferenceProfiles do not support resource-level restrictions.
    sandboxAgentApiLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "bedrock:ListFoundationModels",
          "bedrock:ListInferenceProfiles",
        ],
        resources: ["*"],
      }),
    );
    sandboxAgentApiLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["bedrock:ListFoundationModelAgreementOffers"],
        resources: ["*"],
      }),
    );
    sandboxAgentApiLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["pricing:GetProducts"],
        resources: ["*"],
      }),
    );
  }
}

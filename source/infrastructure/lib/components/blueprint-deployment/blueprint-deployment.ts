// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { Duration, Stack } from "aws-cdk-lib";
import { IEventBus } from "aws-cdk-lib/aws-events";
import { Effect, PolicyStatement, Role } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "path";

import { BlueprintDeploymentOrchestratorEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/blueprint-deployment-orchestrator-environment.js";
import { BlueprintDeploymentStepFunction } from "@amzn/innovation-sandbox-infrastructure/components/blueprint-deployment/step-function.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function.js";
import {
  IntermediateRole,
  getSandboxAccountRoleName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { grantIsbDbReadWrite } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

const LAMBDA_TIMEOUT_MINUTES = 5;
const STEPFUNCTION_TIMEOUT_MINUTES = 8 * 60; // 8 hours max for complex blueprint deployments

interface BlueprintDeploymentProps {
  eventBus: IEventBus;
  namespace: string;
  orgManagementAccountId: string;
  hubAccountId: string;
}

/**
 * Blueprint Deployment component.
 *
 * Creates the deployment orchestrator Lambda and Step Functions workflow
 * for deploying CloudFormation StackSets to sandbox accounts.
 */
export class BlueprintDeployment extends Construct {
  constructor(scope: Construct, id: string, props: BlueprintDeploymentProps) {
    super(scope, id);

    const { eventBus, namespace, orgManagementAccountId, hubAccountId } = props;

    const { leaseTable, blueprintTable } =
      IsbComputeStack.sharedSpokeConfig.data;

    // Deployment Orchestrator Lambda
    const deploymentOrchestratorLambda = new IsbLambdaFunction(
      this,
      "DeploymentOrchestratorLambda",
      {
        entry: path.join(
          __dirname,
          "../../../../lambdas/blueprint-deployment/deployment-orchestrator/src/deployment-orchestrator-handler.ts",
        ),
        description:
          "Orchestrates blueprint deployments via CloudFormation StackSets",
        namespace,
        timeout: Duration.minutes(LAMBDA_TIMEOUT_MINUTES),
        envSchema: BlueprintDeploymentOrchestratorEnvironmentSchema,
        environment: {
          ISB_EVENT_BUS: eventBus.eventBusName,
          ISB_NAMESPACE: namespace,
          LEASE_TABLE_NAME: leaseTable,
          BLUEPRINT_TABLE_NAME: blueprintTable,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          SANDBOX_ACCOUNT_ROLE_NAME: getSandboxAccountRoleName(namespace),
          ORG_MGT_ACCOUNT_ID: orgManagementAccountId,
          HUB_ACCOUNT_ID: hubAccountId,
        },
        logGroup: IsbComputeResources.globalLogGroup,
      },
    );

    // Grant read permissions for CloudFormation StackSet operations
    deploymentOrchestratorLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "cloudformation:DescribeStackSet",
          "cloudformation:DescribeStackSetOperation",
          "cloudformation:ListStackInstances",
        ],
        resources: [
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "stackset",
            resourceName: "*:*",
          }),
        ],
      }),
    );

    // Grant write permissions for CloudFormation StackSet operations
    deploymentOrchestratorLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudformation:CreateStackInstances"],
        resources: [
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "stackset",
            resourceName: "*:*",
          }),
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "stackset-target",
            resourceName: "*",
          }),
          Stack.of(this).formatArn({
            service: "cloudformation",
            resource: "type",
            resourceName: "resource/*",
          }),
        ],
      }),
    );

    // Grant permission to publish events to EventBridge
    deploymentOrchestratorLambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["events:PutEvents"],
        resources: [eventBus.eventBusArn],
      }),
    );

    // Grant DynamoDB read/write access for blueprint health metrics updates
    grantIsbDbReadWrite(this, deploymentOrchestratorLambda, blueprintTable);

    // Add Lambda to intermediate role trust policy for cross-account operations
    IntermediateRole.addTrustedRole(
      deploymentOrchestratorLambda.lambdaFunction.role! as Role,
    );

    // Create Step Functions workflow
    new BlueprintDeploymentStepFunction(this, "StepFunction", {
      eventBus,
      deploymentOrchestratorLambda: deploymentOrchestratorLambda.lambdaFunction,
      logGroup: IsbComputeResources.globalLogGroup,
      stepFunctionTimeoutMinutes: STEPFUNCTION_TIMEOUT_MINUTES,
    });
  }
}

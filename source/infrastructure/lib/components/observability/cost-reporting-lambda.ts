// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { Construct } from "constructs";
import path from "node:path";

import { CostReportingLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/cost-reporting-lambda-environment.js";
import { grantIsbDbReadOnly } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import {
  getIsbTagValue,
  isbTagName,
} from "@amzn/innovation-sandbox-infrastructure/helpers/tagging-helper";
import { Stack } from "aws-cdk-lib";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";

export interface CostReportingLambdaProps {
  readonly orgMgtAccountId: string;
  readonly idcAccountId: string;
  readonly namespace: string;
}

export class CostReportingLambda extends Construct {
  constructor(scope: Construct, id: string, props: CostReportingLambdaProps) {
    super(scope, id);
    const costReportingLambda = new IsbLambdaFunction(this, id, {
      description:
        "Scans the accounts and reports / logs aggregated monthly cost",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "metrics",
        "cost-reporting",
        "src",
        "cost-reporting-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        ACCOUNT_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.accountTable,
        ISB_NAMESPACE: props.namespace,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgMgtAccountId,
        ),
        ISB_TAG_NAME: isbTagName,
        ISB_TAG_VALUE: `${getIsbTagValue(props.namespace)}`,
        IDC_ACCOUNT_ID: props.idcAccountId,
        ORG_MGT_ACCOUNT_ID: props.orgMgtAccountId,
        HUB_ACCOUNT_ID: `${Stack.of(scope).account}`,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: CostReportingLambdaEnvironmentSchema,
      reservedConcurrentExecutions: 1,
    });

    const role = new Role(scope, "CostReportingLambdaInvokeRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's CostMonitoring lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    costReportingLambda.lambdaFunction.grantInvoke(role);
    IntermediateRole.addTrustedRole(
      costReportingLambda.lambdaFunction.role! as Role,
    );

    grantIsbDbReadOnly(
      scope,
      costReportingLambda,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
    );

    new CfnSchedule(scope, "CostReportingScheduledEvent", {
      description: "triggers Cost Monitoring on the forth day of every month",
      scheduleExpression: "cron(25 1 4 * ? *)", // Runs at 01:25 UTC on the 4th of every month
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 6 * 60, // 6 hours
      },
      target: {
        retryPolicy: {
          maximumRetryAttempts: 5,
        },
        arn: costReportingLambda.lambdaFunction.functionArn,
        roleArn: role.roleArn,
      },
    });
  }
}

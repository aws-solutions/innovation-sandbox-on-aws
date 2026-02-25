// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "path";

import { AccountDriftMonitoringEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/account-drift-monitoring-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  IntermediateRole,
  getOrgMgtRoleArn,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface AccountDriftMonitoringLambdaProps {
  isbEventBus: EventBus;
  readonly namespace: string;
  orgMgtAccountId: string;
}

export class AccountDriftMonitoringLambda extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: AccountDriftMonitoringLambdaProps,
  ) {
    super(scope, id);
    const driftLambda = new IsbLambdaFunction(this, id, {
      description:
        "Scans the sandbox ous and accounts and checks if there is any drift with what is in the database",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "account-drift-monitoring",
        "src",
        "account-drift-monitoring-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        ACCOUNT_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.accountTable,
        ISB_NAMESPACE: props.namespace,
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
          scope,
          props.namespace,
          props.orgMgtAccountId,
        ),
        ACCOUNT_POOL_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns
            .accountPoolConfigParamArn,
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: AccountDriftMonitoringEnvironmentSchema,
      reservedConcurrentExecutions: 1,
    });
    props.isbEventBus.grantPutEventsTo(driftLambda.lambdaFunction);

    const role = new Role(scope, "AccountDriftMonitoringLambdaInvokeRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's AccountDriftMonitoring lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    driftLambda.lambdaFunction.grantInvoke(role);
    IntermediateRole.addTrustedRole(driftLambda.lambdaFunction.role! as Role);

    grantIsbDbReadWrite(
      scope,
      driftLambda,
      IsbComputeStack.sharedSpokeConfig.data.accountTable,
    );
    grantIsbSsmParameterRead(
      driftLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.accountPoolConfigParamArn,
    );

    new CfnSchedule(scope, "AccountDriftMonitoringScheduledEvent", {
      description: "triggers Drift Monitoring every 6 hours",
      scheduleExpression: "rate(6 hour)",
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 30,
      },
      target: {
        retryPolicy: {
          maximumRetryAttempts: 10,
        },
        arn: driftLambda.lambdaFunction.functionArn,
        roleArn: role.roleArn,
      },
    });
  }
}

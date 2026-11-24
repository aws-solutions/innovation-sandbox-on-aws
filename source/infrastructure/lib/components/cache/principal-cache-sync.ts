// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Duration } from "aws-cdk-lib";
import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { IEventBus, Rule } from "aws-cdk-lib/aws-events";
import { LambdaFunction as LambdaFunctionTarget } from "aws-cdk-lib/aws-events-targets";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "node:path";

import { PrincipalCacheSyncEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/principal-cache-sync-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { getContextFromMapping } from "@amzn/innovation-sandbox-infrastructure/helpers/cdk-context";
import {
  getIdcRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import {
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface PrincipalCacheSyncProps {
  namespace: string;
  idcAccountId: string;
  eventBus: IEventBus;
}

export class PrincipalCacheSync extends Construct {
  constructor(scope: Construct, id: string, props: PrincipalCacheSyncProps) {
    super(scope, id);

    const { principalTable } = IsbComputeStack.sharedSpokeConfig.data;

    const syncLambda = new IsbLambdaFunction(this, "SyncLambdaFunction", {
      description:
        "Syncs IDC principals and assignable permission sets to DynamoDB cache",
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "cache",
        "principal-cache-sync",
        "src",
        "principal-cache-sync-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      timeout: Duration.minutes(15),
      environment: {
        PRINCIPAL_TABLE_NAME: principalTable,
        IDC_CONFIG_PARAM_ARN:
          IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
        IDC_ROLE_ARN: getIdcRoleArn(scope, props.namespace, props.idcAccountId),
        INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
        IDC_ACCOUNT_ID: props.idcAccountId,
        ISB_NAMESPACE: props.namespace,
      },
      envSchema: PrincipalCacheSyncEnvironmentSchema,
      logGroup: IsbComputeResources.globalLogGroup,
    });

    // Grant DynamoDB read/write on Principal Table
    grantIsbDbReadWrite(this, syncLambda, principalTable);

    // Grant SSM read for IDC configuration
    grantIsbSsmParameterRead(
      syncLambda.lambdaFunction.role! as Role,
      IsbComputeStack.sharedSpokeConfig.parameterArns.idcConfigParamArn,
    );

    // Grant KMS for table encryption
    IsbKmsKeys.get(scope, props.namespace).grantEncryptDecrypt(
      syncLambda.lambdaFunction,
    );

    // Grant cross-account IDC access via IntermediateRole
    IntermediateRole.addTrustedRole(syncLambda.lambdaFunction.role! as Role);

    new Rule(this, "PermissionSetEvents", {
      description:
        "Routes forwarded IAM Identity Center permission set events to cache sync",
      eventBus: props.eventBus,
      eventPattern: {
        account: [props.idcAccountId],
        source: ["aws.sso"],
        detailType: ["AWS API Call via CloudTrail"],
        detail: {
          eventSource: ["sso.amazonaws.com"],
          eventName: [
            "CreatePermissionSet",
            "TagResource",
            "UntagResource",
            "DeletePermissionSet",
            "UpdatePermissionSet",
          ],
          errorCode: [{ exists: false }],
          errorMessage: [{ exists: false }],
        },
      },
      targets: [new LambdaFunctionTarget(syncLambda.lambdaFunction)],
    });

    // EventBridge Scheduler: invoke every hour
    const schedulerRole = new Role(this, "SchedulerInvokeRole", {
      description:
        "Allows EventBridge Scheduler to invoke the Principal Cache Sync Lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    const invokeGrant = syncLambda.lambdaFunction.grantInvoke(schedulerRole);

    // A new release changes the name, replacing the schedule. With no start
    // date, the replacement starts immediately and then repeats every hour.
    const schedule = new CfnSchedule(this, "HourlySyncSchedule", {
      name: `${props.namespace}-PrincipalCacheSyncHourlySyncSchedule-${getContextFromMapping(this, "version")}`,
      description:
        "Syncs IDC principals and assignable permission sets to DynamoDB cache every hour",
      scheduleExpression: "rate(1 hour)",
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 5,
      },
      target: {
        input: JSON.stringify({ source: "scheduled" }),
        retryPolicy: {
          maximumRetryAttempts: 2,
        },
        arn: syncLambda.lambdaFunction.functionArn,
        roleArn: schedulerRole.roleArn,
      },
    });

    // Apply invocation permissions before the schedule can start.
    invokeGrant.applyBefore(schedule);

    new Alarm(this, "CacheSyncFailure", {
      alarmDescription:
        "Principal or permission-set cache synchronization failed for two consecutive hourly runs. Investigate the Principal Cache Sync Lambda logs and IDC permissions.",
      metric: syncLambda.lambdaFunction.metricErrors({
        period: Duration.hours(1),
        statistic: "Sum",
      }),
      threshold: 0,
      evaluationPeriods: 2,
      datapointsToAlarm: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}

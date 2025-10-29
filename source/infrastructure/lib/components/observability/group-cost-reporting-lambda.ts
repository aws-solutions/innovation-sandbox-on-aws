// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { GroupCostReportingLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/group-cost-reporting-lambda-environment.js";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { IsbKmsKeys } from "@amzn/innovation-sandbox-infrastructure/components/kms";
import { addCfnGuardSuppression } from "@amzn/innovation-sandbox-infrastructure/helpers/cfn-guard";
import {
  getOrgMgtRoleArn,
  IntermediateRole,
} from "@amzn/innovation-sandbox-infrastructure/helpers/isb-roles";
import { grantIsbDbReadOnly } from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";
import { Duration } from "aws-cdk-lib";
import { EventBus } from "aws-cdk-lib/aws-events";
import { Role, ServicePrincipal } from "aws-cdk-lib/aws-iam";
import {
  BlockPublicAccess,
  Bucket,
  BucketEncryption,
} from "aws-cdk-lib/aws-s3";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Queue, QueueEncryption } from "aws-cdk-lib/aws-sqs";
import { Construct } from "constructs";
import path from "path";

export interface GroupCostReportingLambdaProps {
  readonly orgMgtAccountId: string;
  readonly isbEventBus: EventBus;
  readonly namespace: string;
}

export class GroupCostReportingLambda extends Construct {
  constructor(
    scope: Construct,
    id: string,
    props: GroupCostReportingLambdaProps,
  ) {
    super(scope, id);

    const reportBucket = new Bucket(this, "GroupCostReportingBucket", {
      encryption: BucketEncryption.KMS,
      encryptionKey: IsbKmsKeys.get(scope, props.namespace),
      enforceSSL: true,
      blockPublicAccess: BlockPublicAccess.BLOCK_ALL,
      versioned: true,
    });
    addCfnGuardSuppression(reportBucket, ["S3_BUCKET_LOGGING_ENABLED"]);

    const dlq = new Queue(this, "GroupCostReportingDLQ", {
      encryption: QueueEncryption.KMS,
      encryptionMasterKey: IsbKmsKeys.get(scope, props.namespace),
      retentionPeriod: Duration.days(14),
      visibilityTimeout: Duration.minutes(5),
    });

    const groupCostReportingLambda = new IsbLambdaFunction(
      this,
      "GroupCostReportingLambda",
      {
        description:
          "Generates monthly CSV cost reports aggregated by cost report groups",
        entry: path.join(
          __dirname,
          "..",
          "..",
          "..",
          "..",
          "lambdas",
          "metrics",
          "group-cost-reporting",
          "src",
          "group-cost-reporting-handler.ts",
        ),
        handler: "handler",
        namespace: props.namespace,
        timeout: Duration.minutes(15),
        memorySize: 1024,
        environment: {
          LEASE_TABLE_NAME: IsbComputeStack.sharedSpokeConfig.data.leaseTable,
          ISB_EVENT_BUS: props.isbEventBus.eventBusName,
          ISB_NAMESPACE: props.namespace,
          REPORT_BUCKET_NAME: reportBucket.bucketName,
          INTERMEDIATE_ROLE_ARN: IntermediateRole.getRoleArn(),
          ORG_MGT_ROLE_ARN: getOrgMgtRoleArn(
            scope,
            props.namespace,
            props.orgMgtAccountId,
          ),
        },
        logGroup: IsbComputeResources.globalLogGroup,
        envSchema: GroupCostReportingLambdaEnvironmentSchema,
        reservedConcurrentExecutions: 1,
        deadLetterQueue: dlq,
      },
    );

    grantIsbDbReadOnly(
      scope,
      groupCostReportingLambda,
      IsbComputeStack.sharedSpokeConfig.data.leaseTable,
    );
    props.isbEventBus.grantPutEventsTo(groupCostReportingLambda.lambdaFunction);
    reportBucket.grantWrite(groupCostReportingLambda.lambdaFunction);
    IsbKmsKeys.get(scope, props.namespace).grantDecrypt(
      groupCostReportingLambda.lambdaFunction,
    );

    IntermediateRole.addTrustedRole(
      groupCostReportingLambda.lambdaFunction.role! as Role,
    );

    const role = new Role(this, "GroupCostReportingScheduleRole", {
      description:
        "Allows EventBridgeScheduler to invoke Group Cost Reporting Lambda",
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com"),
    });

    groupCostReportingLambda.lambdaFunction.grantInvoke(role);

    new CfnSchedule(scope, "GroupCostReportingScheduledEvent", {
      description: "triggers Cost Monitoring on the fifth day of every month",
      scheduleExpression: "cron(25 1 2 * ? *)", // Runs at 01:25 UTC on the 2nd of every month
      flexibleTimeWindow: {
        mode: "FLEXIBLE",
        maximumWindowInMinutes: 6 * 60, // 6 hours
      },
      target: {
        retryPolicy: {
          maximumRetryAttempts: 5,
        },
        arn: groupCostReportingLambda.lambdaFunction.functionArn,
        roleArn: role.roleArn,
        deadLetterConfig: {
          arn: dlq.queueArn,
        },
      },
    });
  }
}

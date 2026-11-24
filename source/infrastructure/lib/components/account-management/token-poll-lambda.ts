// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ArnFormat, Duration, Stack } from "aws-cdk-lib";
import { ITable } from "aws-cdk-lib/aws-dynamodb";
import { EventBus } from "aws-cdk-lib/aws-events";
import {
  Effect,
  PolicyStatement,
  Role,
  ServicePrincipal,
} from "aws-cdk-lib/aws-iam";
import { CfnSchedule } from "aws-cdk-lib/aws-scheduler";
import { Construct } from "constructs";
import path from "node:path";

import { TokenPollEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/token-poll-environment.js";
import { TOKEN_POLL_INTERVAL } from "@amzn/innovation-sandbox-infrastructure/components/account-management/token-poll-constants";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import {
  grantIsbDbReadOnly,
  grantIsbDbReadWrite,
  grantIsbSsmParameterRead,
} from "@amzn/innovation-sandbox-infrastructure/helpers/policy-generators";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { IsbComputeStack } from "@amzn/innovation-sandbox-infrastructure/isb-compute-stack";

export interface TokenPollLambdaProps {
  readonly isbEventBus: EventBus;
  readonly namespace: string;
  readonly bedrockPriceTable: ITable;
  /** The sink custom resource's region-to-sink-id map, handed to the poll as is. */
  readonly sinkIdsJson: string;
}

/**
 * Reads every monitored lease's Bedrock token counts from this account's
 * observability sinks every ten minutes. The sinks are in the hub, so the
 * function reads them on its own execution role and assumes nothing: it is
 * granted no sts:AssumeRole and holds no session policy.
 */
export class TokenPollLambda extends Construct {
  constructor(scope: Construct, id: string, props: TokenPollLambdaProps) {
    super(scope, id);
    const { data, parameterArns } = IsbComputeStack.sharedSpokeConfig;

    const lambda = new IsbLambdaFunction(this, id, {
      description: `Reads the Bedrock token usage of monitored leases from the hub's observability sinks every ${TOKEN_POLL_INTERVAL.toMinutes()} minutes`,
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "account-management",
        "token-poll",
        "src",
        "token-poll-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      environment: {
        ISB_EVENT_BUS: props.isbEventBus.eventBusName,
        CONFIG_TABLE_NAME: data.configTableName,
        LEASE_TABLE_NAME: data.leaseTable,
        LEASE_COST_HISTORY_TABLE_NAME: data.leaseCostHistoryTable,
        BEDROCK_REGIONAL_PRICE_TABLE_NAME: props.bedrockPriceTable.tableName,
        ISB_NAMESPACE: props.namespace,
        ACCOUNT_POOL_CONFIG_PARAM_ARN: parameterArns.accountPoolConfigParamArn,
        OAM_SINK_IDS_JSON: props.sinkIdsJson,
        TOKEN_POLL_INTERVAL_MINUTES: String(TOKEN_POLL_INTERVAL.toMinutes()),
      },
      logGroup: IsbComputeResources.globalLogGroup,
      envSchema: TokenPollEnvironmentSchema,
      // One run at a time is correctness, not cost control: two overlapping
      // runs read the same anchor, request the same window and both count it,
      // and the cumulative they write is what every later run builds on.
      reservedConcurrentExecutions: 1,
      // Under the tick: while a run is still going the next tick waits on it
      // rather than starting a second run.
      timeout: TOKEN_POLL_INTERVAL.minus(Duration.minutes(1)),
    });

    props.isbEventBus.grantPutEventsTo(lambda.lambdaFunction);
    grantIsbDbReadWrite(
      scope,
      lambda,
      data.leaseTable,
      data.leaseCostHistoryTable,
    );
    // The price cache reads by key and saves whole items, nothing else.
    props.bedrockPriceTable.grant(
      lambda.lambdaFunction,
      "dynamodb:BatchGetItem",
      "dynamodb:BatchWriteItem",
    );
    props.bedrockPriceTable.encryptionKey!.grantEncryptDecrypt(
      lambda.lambdaFunction,
    );
    grantIsbDbReadOnly(scope, lambda, data.configTableName);
    grantIsbSsmParameterRead(
      lambda.lambdaFunction.role! as Role,
      parameterArns.accountPoolConfigParamArn,
    );
    // Reads the token metrics the sandbox accounts share into this account's
    // sinks, and lists the models an account has emitted them for. Neither
    // action has resource-level scoping.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["cloudwatch:GetMetricData", "cloudwatch:ListMetrics"],
        resources: ["*"],
      }),
    );
    // The cross-account reads above resolve through the sinks, and the
    // liveness check lists the links attached to each one. Every sink the poll
    // touches is in this account.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["oam:GetSink", "oam:ListAttachedLinks"],
        resources: [
          Stack.of(this).formatArn({
            service: "oam",
            region: "*",
            resource: "sink",
            resourceName: "*",
          }),
        ],
      }),
    );
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: ["oam:ListSinks"],
        resources: ["*"], // no resource-level permissions for this action
      }),
    );
    // Refreshes the regional prices. Prices come from the Price List and
    // agreement offers, and the model and inference profile lists identify the
    // models to fetch prices for. None supports resource-level permissions.
    lambda.lambdaFunction.addToRolePolicy(
      new PolicyStatement({
        effect: Effect.ALLOW,
        actions: [
          "pricing:GetProducts",
          "bedrock:ListFoundationModelAgreementOffers",
          "bedrock:ListFoundationModels",
          "bedrock:ListInferenceProfiles",
        ],
        resources: ["*"],
      }),
    );

    const scheduleRole = new Role(this, "TokenPollScheduleRole", {
      description:
        "allows EventBridgeScheduler to invoke Innovation Sandbox's TokenPoll lambda",
      // Only a schedule in this account's default schedule group can assume
      // the role, so a schedule elsewhere cannot name it as its execution role
      // to invoke the poll. Scheduler presents the schedule group's ARN as the
      // source, never the schedule's, so the group is what the condition names.
      assumedBy: new ServicePrincipal("scheduler.amazonaws.com", {
        conditions: {
          StringEquals: {
            "aws:SourceAccount": Stack.of(this).account,
            "aws:SourceArn": Stack.of(this).formatArn({
              service: "scheduler",
              resource: "schedule-group",
              resourceName: "default",
              arnFormat: ArnFormat.SLASH_RESOURCE_NAME,
            }),
          },
        },
      }),
    });
    lambda.lambdaFunction.grantInvoke(scheduleRole);

    new CfnSchedule(scope, "TokenPollScheduledEvent", {
      description: `triggers TokenPoll every ${TOKEN_POLL_INTERVAL.toMinutes()} minutes`,
      scheduleExpression: `rate(${TOKEN_POLL_INTERVAL.toMinutes()} minutes)`,
      // Every other schedule here runs in a flexible window, which jitters the
      // interval. This interval is the only thing between a runaway Bedrock
      // spend and its detection, so the tick lands on time.
      flexibleTimeWindow: { mode: "OFF" },
      target: {
        retryPolicy: {
          maximumRetryAttempts: 20,
        },
        arn: lambda.lambdaFunction.functionArn,
        roleArn: scheduleRole.roleArn,
      },
    });
  }
}

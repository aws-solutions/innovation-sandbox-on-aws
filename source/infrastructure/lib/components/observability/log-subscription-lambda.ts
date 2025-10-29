// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LogSubscriberLambdaEnvironmentSchema } from "@amzn/innovation-sandbox-commons/lambda/environments/log-subscriber-lambda-environment";
import { IsbLambdaFunction } from "@amzn/innovation-sandbox-infrastructure/components/isb-lambda-function";
import { AnonymizedMetricsProps } from "@amzn/innovation-sandbox-infrastructure/components/observability/anonymized-metrics-reporting";
import { IsbComputeResources } from "@amzn/innovation-sandbox-infrastructure/isb-compute-resources";
import { Duration } from "aws-cdk-lib";
import { FilterPattern, SubscriptionFilter } from "aws-cdk-lib/aws-logs";
import { LambdaDestination } from "aws-cdk-lib/aws-logs-destinations";
import { Construct } from "constructs";
import path from "path";

export class LogMetricsSubscriber extends Construct {
  public readonly lambdaHandler: IsbLambdaFunction<any>;

  constructor(scope: Construct, id: string, props: AnonymizedMetricsProps) {
    super(scope, id);

    this.lambdaHandler = new IsbLambdaFunction(this, "LogProcessor", {
      entry: path.join(
        __dirname,
        "..",
        "..",
        "..",
        "..",
        "lambdas",
        "metrics",
        "log-subscriber",
        "src",
        "log-subscription-handler.ts",
      ),
      handler: "handler",
      namespace: props.namespace,
      timeout: Duration.minutes(5),
      environment: {
        METRICS_URL: props.metricsUrl,
        SOLUTION_ID: props.solutionId,
        SOLUTION_VERSION: props.solutionVersion,
        METRICS_UUID: props.deploymentUUID,
        HUB_ACCOUNT_ID: props.hubAccountId,
      },
      envSchema: LogSubscriberLambdaEnvironmentSchema,
      logGroup: IsbComputeResources.globalLogGroup,
    });

    new SubscriptionFilter(this, "LogSubscription", {
      logGroup: IsbComputeResources.globalLogGroup,
      destination: new LambdaDestination(this.lambdaHandler.lambdaFunction),
      filterPattern: FilterPattern.all(FilterPattern.exists("$.logDetailType")),
    });
  }
}

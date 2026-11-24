// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { ITopic } from "aws-cdk-lib/aws-sns";
import { Construct } from "constructs";

import { DeploymentSummaryLambda } from "@amzn/innovation-sandbox-infrastructure/components/observability/deployment-summary-lambda";
import { LogMetricsSubscriber } from "@amzn/innovation-sandbox-infrastructure/components/observability/log-subscription-lambda";

export type AnonymizedMetricsProps = {
  namespace: string;
  metricsUrl: string;
  solutionId: string;
  solutionVersion: string;
  deploymentUUID: string;
  hubAccountId: string;
  orgManagementAccountId: string;
  isStableTaggingEnabled: string;
  wafWebAclName: string;
  notificationIntegrationTopic: ITopic;
  /** Empty uses hub-account SES sending. */
  sesIdentityArn: string;
};

export class AnonymizedMetricsReporting extends Construct {
  constructor(scope: Construct, id: string, props: AnonymizedMetricsProps) {
    super(scope, id);

    new DeploymentSummaryLambda(this, "HeartbeatMetrics", props);
    new LogMetricsSubscriber(this, "LogMetrics", props);
  }
}

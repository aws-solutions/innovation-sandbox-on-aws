// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  Alarm,
  ComparisonOperator,
  TreatMissingData,
} from "aws-cdk-lib/aws-cloudwatch";
import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

import { LogPatterns } from "@amzn/innovation-sandbox-commons/observability/logging";
import { TOKEN_POLL_INTERVAL } from "@amzn/innovation-sandbox-infrastructure/components/account-management/token-poll-constants";

export interface TokenPollObservabilityAlarmsProps {
  /** Shared Compute log group that receives TokenPoll structured logs. */
  readonly globalLogGroup: LogGroup;

  /** Deployment namespace used to isolate these metrics from other ISB deployments. */
  readonly namespace: string;
}

/**
 * Alarms when TokenPoll repeatedly finds a monitored lease whose sandbox
 * account is not linked to the hub's OAM sink in a managed Region, and when it
 * repeatedly cannot inspect links or read token metrics in a managed Region.
 *
 * No alarm actions are attached. Operators subscribe after deployment through
 * their preferred notification mechanism.
 */
export class TokenPollObservabilityAlarms extends Construct {
  public readonly linkMissingAlarm: Alarm;
  public readonly regionUnreadableAlarm: Alarm;

  constructor(
    scope: Construct,
    id: string,
    props: TokenPollObservabilityAlarmsProps,
  ) {
    super(scope, id);

    this.linkMissingAlarm = this.createAlarm(
      props,
      LogPatterns.ObservabilityLinkMissing,
      "TokenPoll found a token-monitored lease whose sandbox account has no " +
        "OAM link to the hub sink after successfully listing attached links " +
        `in the managed Region during two of three ${TOKEN_POLL_INTERVAL.toMinutes()}-minute periods. ` +
        "Confirm whether the account has enabled the Region. If it has, " +
        "Bedrock token usage in that account and Region is not visible to the " +
        "hub. Search the Compute stack's ISB log group for messages beginning " +
        "'Observability Link Missing:' and use leaseId, awsAccountId, and " +
        "region to identify the affected " +
        "Isb-<namespace>-ObservabilityLinks stack instance.",
    );

    this.regionUnreadableAlarm = this.createAlarm(
      props,
      LogPatterns.ObservabilityRegionUnreadable,
      "TokenPoll could not list attached OAM links or read Bedrock token " +
        `metrics in a managed Region in two of three ${TOKEN_POLL_INTERVAL.toMinutes()}-minute periods. The ` +
        "Region was skipped, so newly observed Bedrock usage there is omitted " +
        "until a later successful poll. Search the Compute stack's ISB log " +
        "group for messages beginning 'Observability Region Unreadable:' and " +
        "use region, leasesAffected, errorName, and error to identify the " +
        "failed operation and cause.",
    );
  }

  private createAlarm(
    props: TokenPollObservabilityAlarmsProps,
    logPattern: { readonly patternName: string; readonly pattern: string },
    alarmDescription: string,
  ): Alarm {
    const filter = new MetricFilter(this, `${logPattern.patternName}Filter`, {
      logGroup: props.globalLogGroup,
      metricNamespace: `InnovationSandbox/Observability/${props.namespace}`,
      metricName: logPattern.patternName,
      filterPattern: FilterPattern.stringValue(
        "$.message",
        "=",
        `${logPattern.pattern}:*`,
      ),
      metricValue: "1",
      defaultValue: 0,
    });

    return new Alarm(this, `${logPattern.patternName}Alarm`, {
      alarmDescription,
      metric: filter.metric({
        period: TOKEN_POLL_INTERVAL,
        statistic: "Sum",
      }),
      threshold: 1,
      evaluationPeriods: 3,
      datapointsToAlarm: 2,
      comparisonOperator: ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      treatMissingData: TreatMissingData.NOT_BREACHING,
    });
  }
}

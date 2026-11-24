// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import {
  CloudWatchClient,
  GetMetricDataCommand,
} from "@aws-sdk/client-cloudwatch";

import {
  WAF_HUMAN_CALLS_METRIC_NAME,
  WAF_M2M_CALLS_METRIC_NAME,
  WAFV2_COUNTED_REQUESTS_METRIC,
  WAFV2_METRIC_NAMESPACE,
} from "@amzn/innovation-sandbox-commons/observability/waf-auth-metrics.js";

import {
  ONE_DAY_SECONDS,
  previousUtcDayWindow,
  sumMetricDataValues,
} from "./daily-metric-window.js";

export interface ApiCallsByAuthType {
  m2m: number;
  user: number;
}

/**
 * Reads WAF-allowed API call counts by caller type from the two count-rule
 * CountedRequests metrics, over the previous full UTC day (not a rolling 24h,
 * which would overlap/gap as the heartbeat's schedule drifts).
 */
export async function collectApiCallsByAuthType(
  cloudWatch: CloudWatchClient,
  webAclName: string,
  region: string,
): Promise<ApiCallsByAuthType> {
  const { startTime, endTime } = previousUtcDayWindow();

  const dimensions = (ruleMetricName: string) => [
    { Name: "WebACL", Value: webAclName },
    { Name: "Region", Value: region },
    { Name: "Rule", Value: ruleMetricName },
  ];

  const response = await cloudWatch.send(
    new GetMetricDataCommand({
      StartTime: startTime,
      EndTime: endTime,
      MetricDataQueries: [
        {
          Id: "user",
          MetricStat: {
            Metric: {
              Namespace: WAFV2_METRIC_NAMESPACE,
              MetricName: WAFV2_COUNTED_REQUESTS_METRIC,
              Dimensions: dimensions(WAF_HUMAN_CALLS_METRIC_NAME),
            },
            Period: ONE_DAY_SECONDS,
            Stat: "Sum",
          },
        },
        {
          Id: "m2m",
          MetricStat: {
            Metric: {
              Namespace: WAFV2_METRIC_NAMESPACE,
              MetricName: WAFV2_COUNTED_REQUESTS_METRIC,
              Dimensions: dimensions(WAF_M2M_CALLS_METRIC_NAME),
            },
            Period: ONE_DAY_SECONDS,
            Stat: "Sum",
          },
        },
      ],
    }),
  );

  return {
    m2m: sumMetricDataValues(response, "m2m"),
    user: sumMetricDataValues(response, "user"),
  };
}

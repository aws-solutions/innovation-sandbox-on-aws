// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import { IsbContext } from "@amzn/innovation-sandbox-commons/innovation-sandbox.js";

export type AnonymizedAwsMetric = {
  timestamp: string;
  uuid: string;
  hub_account_id: string;
  solution: string;
  version: string;
  event_name: string;
  context_version: number;
  context: Record<string, any>;
};

export type AnonymizedAWSMetricData = {
  event_name: string;
  context_version: number;
  context: Record<string, any>;
};

export async function sendAnonymizedMetricToAWS(
  metricData: AnonymizedAWSMetricData,
  isbContext: IsbContext<{
    env: {
      METRICS_URL: string;
      METRICS_UUID: string;
      HUB_ACCOUNT_ID: string;
      SOLUTION_ID: string;
      SOLUTION_VERSION: string;
    };
  }>,
) {
  const metricUrl = isbContext.env.METRICS_URL;

  const awsMetric: AnonymizedAwsMetric = {
    timestamp: new Date().toISOString(),
    uuid: isbContext.env.METRICS_UUID,
    hub_account_id: isbContext.env.HUB_ACCOUNT_ID,
    solution: isbContext.env.SOLUTION_ID,
    version: isbContext.env.SOLUTION_VERSION,
    ...metricData,
  };

  isbContext.logger.info(
    `reporting anonymized metric to ${metricUrl}: ${JSON.stringify(awsMetric, undefined, 2)}`,
  );

  return fetch(metricUrl, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(awsMetric),
  });
}

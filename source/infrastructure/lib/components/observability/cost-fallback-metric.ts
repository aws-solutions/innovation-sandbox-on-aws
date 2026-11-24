// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { FilterPattern, LogGroup, MetricFilter } from "aws-cdk-lib/aws-logs";
import { Construct } from "constructs";

export interface CostFallbackMetricProps {
  /**
   * Log group receiving `LeaseCostFallback` structured logs from the hourly
   * lease-monitoring scan.
   */
  readonly globalLogGroup: LogGroup;
}

/**
 * Counts monitoring runs that could not read a lease's spend from the
 * tag-grouped Cost Explorer report and re-summed it by account instead. Such a
 * lease gets no per-day figures and no service breakdown, and its cumulative
 * total carries a prefix of untagged spend that no tagged bucket will ever
 * account for.
 *
 * A metric and no alarm, deliberately. Cost Explorer will not activate a cost
 * allocation tag key until it has observed one, so every fresh deployment spends
 * up to a day serving every lease from the fallback: an alarm on the occurrence
 * would fire on day one of every install. The signal operators want is
 * persistence -- a non-zero count long after deployment means tags never
 * activated, or were stripped from an account -- which is a graph or an operator
 * threshold over this metric, not a per-occurrence trip.
 */
export class CostFallbackMetric extends Construct {
  public readonly filter: MetricFilter;

  constructor(scope: Construct, id: string, props: CostFallbackMetricProps) {
    super(scope, id);

    this.filter = new MetricFilter(this, "LeaseCostFallbackFilter", {
      logGroup: props.globalLogGroup,
      metricNamespace: "InnovationSandbox/CostAttribution",
      metricName: "LeaseCostFallbackRuns",
      filterPattern: FilterPattern.stringValue(
        "$.logDetailType",
        "=",
        "LeaseCostFallback",
      ),
      metricValue: "1",
      defaultValue: 0,
    });
  }
}

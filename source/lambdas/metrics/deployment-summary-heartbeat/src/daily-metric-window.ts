// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0
import type { GetMetricDataCommandOutput } from "@aws-sdk/client-cloudwatch";
import { DateTime } from "luxon";

export const ONE_DAY_SECONDS = 86_400;

/** Returns the previous midnight-aligned UTC day. */
export function previousUtcDayWindow(): { startTime: Date; endTime: Date } {
  const endTime = DateTime.utc().startOf("day");
  return {
    startTime: endTime.minus({ days: 1 }).toJSDate(),
    endTime: endTime.toJSDate(),
  };
}

export function sumMetricDataValues(
  response: GetMetricDataCommandOutput,
  id: string,
): number {
  // Stat: "Sum" aggregates within a period; this sums across the returned
  // datapoints (a midnight-aligned day yields one, but the window could widen)
  // and normalizes the no-datapoint case (quiet rule) to 0.
  return (
    response.MetricDataResults?.find((result) => result.Id === id)?.Values ?? []
  ).reduce((total, value) => total + value, 0);
}

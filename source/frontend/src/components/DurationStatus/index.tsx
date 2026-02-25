// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Popover, StatusIndicator } from "@cloudscape-design/components";
import { DateTime, Duration } from "luxon";

interface DurationStatusProps {
  date?: Date | string;
  durationInHours?: number;
  expired?: boolean;
}

export const DurationStatus = ({
  date,
  durationInHours,
  expired,
}: DurationStatusProps) => {
  if (date) {
    const dateTime =
      typeof date === "string"
        ? DateTime.fromISO(date)
        : DateTime.fromJSDate(date);
    const isLessThanOneHourFromNow =
      dateTime.diff(DateTime.now(), "hours").hours < 1 && !expired;

    return (
      <Popover
        position="top"
        size="large"
        dismissButton={false}
        content={`This lease ${dateTime < DateTime.now() ? "expired" : "will expire"} on ${dateTime.toLocaleString(DateTime.DATETIME_MED)}`}
      >
        {isLessThanOneHourFromNow ? "expiring soon" : dateTime.toRelative()}
      </Popover>
    );
  }

  if (durationInHours) {
    return (
      <Box>
        <Box>{Duration.fromObject({ hours: durationInHours }).toHuman()}</Box>
        <Box>
          <small data-muted>after approval</small>
        </Box>
      </Box>
    );
  }

  return <StatusIndicator type="warning">{"No expiry"}</StatusIndicator>;
};

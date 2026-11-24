// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Popover } from "@cloudscape-design/components";
import { DateTime } from "luxon";

/** Renders who last saved a configuration section and when. */
export function LastSavedDescription({
  data,
}: Readonly<{
  data: { lastSavedBy: string | null; meta?: { lastEditTime?: string } };
}>) {
  if (!data.lastSavedBy) return null;

  const date = data.meta?.lastEditTime
    ? DateTime.fromISO(data.meta.lastEditTime)
    : undefined;
  if (!date?.isValid) {
    return (
      <Box variant="small" color="text-body-secondary">
        {`Last edited by ${data.lastSavedBy}`}
      </Box>
    );
  }

  return (
    <Box variant="small" color="text-body-secondary">
      {`Last edited by ${data.lastSavedBy} `}
      <Popover
        dismissButton={false}
        position="top"
        size="small"
        triggerType="text"
        content={date.toLocaleString(DateTime.DATETIME_MED)}
      >
        <Box variant="span" fontSize="body-s" color="text-body-secondary">
          {date.toRelative()}
        </Box>
      </Popover>
    </Box>
  );
}

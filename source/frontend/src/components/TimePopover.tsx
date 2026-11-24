// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, Popover } from "@cloudscape-design/components";

import {
  formatAbsoluteTime,
  formatRelativeTime,
} from "@amzn/innovation-sandbox-shared/utils/format-utils.js";

interface TimePopoverProps {
  time: string;
}

export const TimePopover = ({ time }: TimePopoverProps) => (
  <Popover
    position="top"
    size="large"
    dismissButton={false}
    content={formatAbsoluteTime(time)}
  >
    <Box>{formatRelativeTime(time)}</Box>
  </Popover>
);

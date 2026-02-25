// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Box, StatusIndicator } from "@cloudscape-design/components";

export const BlueprintName = ({
  blueprintName,
}: {
  blueprintName?: string | null;
}) => {
  return blueprintName ? (
    <Box>{blueprintName}</Box>
  ) : (
    <StatusIndicator type="info">No Blueprint</StatusIndicator>
  );
};

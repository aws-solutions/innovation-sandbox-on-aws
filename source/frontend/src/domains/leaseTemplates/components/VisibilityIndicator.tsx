// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { LeaseTemplate } from "@amzn/innovation-sandbox-commons/data/lease-template/lease-template";
import { Box, Icon, SpaceBetween } from "@cloudscape-design/components";

/**
 * Reusable visibility cell component for displaying lease template visibility
 * @param item - The lease template item
 * @returns JSX element with visibility indicator
 */
export const VisibilityIndicator = ({ item }: { item: LeaseTemplate }) => {
  const isPublic = item.visibility === "PUBLIC";

  return (
    <SpaceBetween direction="horizontal" size="xs" alignItems="center">
      <Icon
        name={isPublic ? "unlocked" : "lock-private"}
        size="small"
        variant={isPublic ? "success" : "link"}
      />
      <Box color={isPublic ? "text-status-success" : "text-status-info"}>
        {isPublic ? "Public" : "Private"}
      </Box>
    </SpaceBetween>
  );
};

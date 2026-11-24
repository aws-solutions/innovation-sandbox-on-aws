// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { Popover, StatusIndicator } from "@cloudscape-design/components";

/** Fits the longest label, "Disabled (overridden)", with its icon. */
export const FEATURE_STATUS_MIN_WIDTH = 190;

/**
 * Renders a per-resource feature flag (e.g. lease sharing, Sandbox Spaces) that
 * a global setting can override. Handles three states:
 * - Enabled (feature globally on + resource on)
 * - Disabled (overridden) (resource on, global off — popover explains why)
 * - Disabled
 *
 * Never wraps, so "Disabled (overridden)" stays on one line in narrow table
 * columns; tables give these columns a matching `minWidth`.
 */
export function FeatureStatusIndicator({
  featureName,
  enabled,
  globallyEnabled = true,
}: Readonly<{
  /** Shown in the override explanation, e.g. "Lease sharing". */
  featureName: string;
  enabled?: boolean;
  globallyEnabled?: boolean;
}>) {
  if (globallyEnabled && enabled) {
    return (
      <StatusIndicator wrapText={false} type="success">
        Enabled
      </StatusIndicator>
    );
  }

  if (enabled) {
    return (
      <Popover
        dismissButton={false}
        position="top"
        size="small"
        content={`${featureName} is enabled on this resource, but it is disabled globally, so it has no effect. Enable it in global configuration for this setting to take effect.`}
      >
        <StatusIndicator wrapText={false} type="stopped">
          Disabled (overridden)
        </StatusIndicator>
      </Popover>
    );
  }

  return (
    <StatusIndicator wrapText={false} type="stopped">
      Disabled
    </StatusIndicator>
  );
}

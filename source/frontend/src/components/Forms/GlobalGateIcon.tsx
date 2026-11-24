// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import {
  LiveRegion,
  Popover,
  StatusIndicator,
} from "@cloudscape-design/components";

import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";

const gateOffUnused = (settingsArea: string) =>
  `Globally disabled. An administrator can allow this under ${settingsArea} on the Settings page.`;
const gateOffInUse = (settingsArea: string, variant: SettingsFormVariant) =>
  `Globally disabled. This ${variant} still uses this feature. If you turn it off and save, you cannot turn it on again until an administrator allows it under ${settingsArea} on the Settings page.`;
const gateOffSwitchedOff = (settingsArea: string) =>
  `Globally disabled. If you save with this feature off, you cannot turn it on again until an administrator allows it under ${settingsArea} on the Settings page.`;

function globalGateNotice(
  settingsArea: string,
  variant: SettingsFormVariant,
  persistedEnabled?: boolean,
  enabled?: boolean,
): { type: "info" | "warning"; content: string } {
  if (!persistedEnabled) {
    return { type: "info", content: gateOffUnused(settingsArea) };
  }
  if (enabled) {
    return { type: "info", content: gateOffInUse(settingsArea, variant) };
  }
  return { type: "warning", content: gateOffSwitchedOff(settingsArea) };
}

/**
 * The info or warning icon shown next to a template or lease toggle whose
 * feature is globally disabled; undefined while the global setting allows it.
 * `settingsArea` names where on the Settings page an administrator allows it.
 */
export function globalGateIcon({
  featureName,
  allowed,
  persistedEnabled,
  enabled,
  settingsArea,
  variant,
}: {
  featureName: string;
  allowed: boolean;
  persistedEnabled?: boolean;
  enabled?: boolean;
  settingsArea: string;
  variant: SettingsFormVariant;
}) {
  if (allowed) {
    return undefined;
  }
  const { type, content } = globalGateNotice(
    settingsArea,
    variant,
    persistedEnabled,
    enabled,
  );
  const ariaLabel =
    type === "warning"
      ? `Warning: ${featureName} globally disabled`
      : `${featureName} globally disabled`;
  return (
    <span>
      <Popover
        dismissButton={false}
        position="top"
        size="medium"
        triggerType="text"
        triggerAriaLabel={ariaLabel}
        content={content}
      >
        <StatusIndicator type={type} />
      </Popover>
      {type === "warning" && (
        <LiveRegion hidden>{`Warning: ${featureName}. ${content}`}</LiveRegion>
      )}
    </span>
  );
}

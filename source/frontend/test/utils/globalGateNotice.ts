// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { expect } from "vitest";

import type { SettingsFormVariant } from "@amzn/innovation-sandbox-frontend/components/Forms/types";

export const gateOffUnused = (settingsArea: string) =>
  `Globally disabled. An administrator can allow this under ${settingsArea} on the Settings page.`;
export const gateOffInUse = (
  settingsArea: string,
  variant: SettingsFormVariant,
) =>
  `Globally disabled. This ${variant} still uses this feature. If you turn it off and save, you cannot turn it on again until an administrator allows it under ${settingsArea} on the Settings page.`;
export const gateOffSwitchedOff = (settingsArea: string) =>
  `Globally disabled. If you save with this feature off, you cannot turn it on again until an administrator allows it under ${settingsArea} on the Settings page.`;

/**
 * Checks the icon next to a toggle whose feature is globally disabled, and
 * the text its popover opens with.
 */
export async function expectGateNotice(
  user: ReturnType<typeof userEvent.setup>,
  featureName: string,
  iconType: "info" | "warning",
  content: string,
) {
  const trigger = screen.getByRole("button", {
    name:
      iconType === "warning"
        ? `Warning: ${featureName} globally disabled`
        : `${featureName} globally disabled`,
  });
  expect(trigger.querySelector(`[class*="status-${iconType}"]`)).not.toBeNull();
  const popover = createWrapper()
    .findAllPopovers()
    .find((candidate) => candidate.findTrigger().getElement() === trigger)!;
  await user.click(trigger);
  await waitFor(() =>
    expect(popover.findContent()?.getElement()).toHaveTextContent(content),
  );
}

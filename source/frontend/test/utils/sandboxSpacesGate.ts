// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import userEvent from "@testing-library/user-event";

import {
  expectGateNotice,
  gateOffInUse,
  gateOffSwitchedOff,
  gateOffUnused,
} from "@amzn/innovation-sandbox-frontend-test/utils/globalGateNotice";

export const SANDBOX_SPACES_GATE_OFF_UNUSED = gateOffUnused("Sandbox Spaces");
export const SANDBOX_SPACES_GATE_OFF_IN_USE = gateOffInUse(
  "Sandbox Spaces",
  "template",
);
export const SANDBOX_SPACES_GATE_OFF_SWITCHED_OFF =
  gateOffSwitchedOff("Sandbox Spaces");

/**
 * Checks the icon next to the Sandbox Spaces toggle while Sandbox Spaces is
 * globally disabled, and the text its popover opens with.
 */
export async function expectSandboxSpacesGateNotice(
  user: ReturnType<typeof userEvent.setup>,
  iconType: "info" | "warning",
  content: string,
) {
  await expectGateNotice(user, "Sandbox Spaces", iconType, content);
}

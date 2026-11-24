// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import createWrapper from "@cloudscape-design/components/test-utils/dom";
import { screen, within } from "@testing-library/react";
import { expect } from "vitest";

const STAYS_ON_HEADER = "Bedrock token monitoring stays on";
const TURNED_OFF_HEADER = "Bedrock token monitoring turned off";
const EXISTING_LEASES_NOTE =
  " Existing leases from this template keep their current settings.";

/**
 * `existingLeasesNote` expects the sentence added while Sandbox Spaces is
 * globally disabled.
 */
interface MessageOptions {
  existingLeasesNote?: boolean;
}

function expectMessage(header: string, body: string) {
  const alert = createWrapper()
    .findAllAlerts()
    .find(
      (wrapper) => wrapper.findHeader()?.getElement().textContent === header,
    );
  expect(alert, `message "${header}"`).toBeDefined();
  const message = within(alert!.getElement());
  // A link's external icon adds a non-breaking space, so whitespace is
  // collapsed before the exact comparison.
  expect(
    alert!.findContent().getElement().textContent?.replace(/\s+/g, " ").trim(),
  ).toBe(body);
  expect(message.queryByRole("checkbox")).not.toBeInTheDocument();
  // Screen readers get the same text through a live region.
  expect(
    createWrapper()
      .findAllLiveRegions()
      .map((region) => region.getElement().textContent),
  ).toContain(`${header}. ${body}`);
  return message;
}

/**
 * Checks the stays-on message's exact text, that it has no toggle, and that
 * the turned-off message is not shown with it.
 */
export function expectStaysOnMessage({
  existingLeasesNote = false,
}: MessageOptions = {}) {
  expect(screen.queryByText(TURNED_OFF_HEADER)).not.toBeInTheDocument();
  expectMessage(
    STAYS_ON_HEADER,
    "Bedrock token monitoring stays on when you disable Sandbox Spaces. You can turn it off in the budget settings." +
      (existingLeasesNote ? EXISTING_LEASES_NOTE : ""),
  );
}

/**
 * Checks the turned-off message's exact text, that it has no toggle, and that
 * the stays-on message is not shown with it.
 */
export function expectTurnedOffMessage({
  existingLeasesNote = false,
}: MessageOptions = {}) {
  expect(screen.queryByText(STAYS_ON_HEADER)).not.toBeInTheDocument();
  const message = expectMessage(
    TURNED_OFF_HEADER,
    "Bedrock token monitoring is turned off when you disable Sandbox Spaces, because Allow Bedrock token monitoring is off in Settings." +
      (existingLeasesNote ? EXISTING_LEASES_NOTE : ""),
  );
  // The setting link opens a new tab, keeping the form's unsaved changes.
  const link = message.getByRole("link", {
    name: /Allow Bedrock token monitoring/,
  });
  expect(link).toHaveAttribute(
    "href",
    "/settings#setting-leases-allowBedrockTokenMonitoring",
  );
  expect(link).toHaveAttribute("target", "_blank");
}

export function expectNoMonitoringMessage() {
  expect(screen.queryByText(STAYS_ON_HEADER)).not.toBeInTheDocument();
  expect(screen.queryByText(TURNED_OFF_HEADER)).not.toBeInTheDocument();
}

/** Checks that no Bedrock token monitoring toggle is shown. */
export function expectNoMonitoringToggle() {
  expect(
    screen.queryByRole("checkbox", { name: /bedrock token monitoring/i }),
  ).not.toBeInTheDocument();
}

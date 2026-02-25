// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { screen } from "@testing-library/react";
import { describe, expect, test } from "vitest";

import { AccountStatusIndicator } from "@amzn/innovation-sandbox-frontend/domains/accounts/components/AccountStatusIndicator";
import { renderWithQueryClient } from "@amzn/innovation-sandbox-frontend/setupTests";
import { DateTime } from "luxon";
describe("AccountStatusIndicator", () => {
  test("renders error status for Quarantine, Frozen, Entry, and Exit", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status={"Quarantine"}
      />,
    );
    expect(screen.getByText("Quarantine")).toBeInTheDocument();
  });

  test("renders warning status for CleanUp", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="CleanUp"
      />,
    );
    expect(screen.getByText("Clean Up")).toBeInTheDocument();
  });

  test("renders success status for Available", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="Available"
      />,
    );
    expect(screen.getByText("Available")).toBeInTheDocument();
  });

  test("renders info status for Active", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="Active"
      />,
    );
    expect(screen.getByText("Active")).toBeInTheDocument();
  });

  test("renders popover for CleanUp status", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="CleanUp"
      />,
    );
    expect(screen.getByText("Clean Up")).toBeInTheDocument();
    const popoverTrigger = screen.getByRole("button");
    expect(popoverTrigger).toBeInTheDocument();
    expect(popoverTrigger).toHaveAttribute("aria-haspopup", "dialog");
  });

  test("does not render popover for non-CleanUp statuses", () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="Available"
      />,
    );
    expect(screen.queryByRole("button")).not.toBeInTheDocument();
  });

  test("renders correct text in CleanUp popover", async () => {
    renderWithQueryClient(
      <AccountStatusIndicator
        lastCleanupStartTime={DateTime.now().toString()}
        status="CleanUp"
      />,
    );

    const trigger = screen.getByRole("button");
    trigger.click();

    const popoverContent = await screen.findByText(
      "This account is being cleaned up and will be ready to use soon.",
    );
    expect(popoverContent).toBeInTheDocument();
  });
});

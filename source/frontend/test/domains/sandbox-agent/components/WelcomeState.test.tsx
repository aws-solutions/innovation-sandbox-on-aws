// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { WelcomeState } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/components/WelcomeState";

describe("WelcomeState", () => {
  it("renders the heading and description", () => {
    render(
      <WelcomeState
        heading="Welcome to your Sandbox Space"
        description="Describe what you want to build."
        examplePrompts={[]}
        onPromptSelect={vi.fn()}
      />,
    );

    expect(screen.getByText("Welcome to your Sandbox Space")).toBeVisible();
    expect(screen.getByText("Describe what you want to build.")).toBeVisible();
  });

  it("sends the selected example prompt", async () => {
    const user = userEvent.setup();
    const onPromptSelect = vi.fn();

    render(
      <WelcomeState
        heading="Welcome"
        description="Get started"
        examplePrompts={["Create an S3 bucket"]}
        onPromptSelect={onPromptSelect}
      />,
    );

    await user.click(screen.getByText("Create an S3 bucket"));

    expect(onPromptSelect).toHaveBeenCalledWith("Create an S3 bucket");
  });
});

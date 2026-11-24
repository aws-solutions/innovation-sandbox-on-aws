// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";

import { SandboxAgent } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/pages/SandboxAgent";
import type { HistoryDisplayMessage } from "@amzn/innovation-sandbox-frontend/domains/sandbox-agent/types";

const messages: HistoryDisplayMessage[] = [
  {
    kind: "history",
    messageId: "event-1:0",
    role: "user",
    content: "Create an S3 bucket for my dataset",
    createdAt: "2026-09-09T00:00:00.000Z",
  },
];

describe("SandboxAgent", () => {
  it("renders the page shell header", () => {
    render(<SandboxAgent />);

    expect(
      screen.getByRole("heading", { name: "Sandbox Space" }),
    ).toBeVisible();
  });

  it("shows the welcome state with no messages", () => {
    render(<SandboxAgent />);

    expect(screen.getByText("Welcome to your Sandbox Space")).toBeVisible();
    expect(
      screen.getByRole("textbox", { name: "Chat message input" }),
    ).toBeInTheDocument();
  });

  it("composes the chat panel with provided messages", () => {
    render(<SandboxAgent messages={messages} />);

    const chat = within(screen.getByRole("region", { name: "Chat" }));
    expect(chat.getByText("Create an S3 bucket for my dataset")).toBeVisible();
    expect(
      screen.queryByText("Welcome to your Sandbox Space"),
    ).not.toBeInTheDocument();
  });

  it("makes no network call", () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");

    try {
      render(<SandboxAgent messages={messages} />);

      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
    }
  });

  it("renders the lease name and AWS account in the header", () => {
    render(
      <SandboxAgent
        leaseName="Data Science (a57dbb39)"
        awsAccountId="123456789012"
      />,
    );

    expect(
      screen.getByRole("heading", { name: "Data Science (a57dbb39)" }),
    ).toBeVisible();
    expect(screen.getByText("AWS account 123456789012")).toBeVisible();
  });

  it("offers the account Login link only when an AWS account is present", () => {
    const { rerender } = render(<SandboxAgent awsAccountId="123456789012" />);

    expect(screen.getByRole("button", { name: "Login" })).toBeVisible();

    rerender(<SandboxAgent />);

    expect(
      screen.queryByRole("button", { name: "Login" }),
    ).not.toBeInTheDocument();
  });

  it("renders the model selector when models are provided", () => {
    render(
      <SandboxAgent
        models={[{ modelId: "m0", displayName: "Model Zero" }]}
        selectedModelId="m0"
        onSelectModel={vi.fn()}
      />,
    );

    expect(
      screen.getByRole("button", { name: /Select model/ }),
    ).toHaveTextContent("Model Zero");
  });

  it("omits the model selector when no models are provided", () => {
    render(<SandboxAgent />);

    expect(
      screen.queryByRole("button", { name: /Select model/ }),
    ).not.toBeInTheDocument();
  });

  describe("lease budget tracker", () => {
    it("opens overall lease spend and caller agent spend", async () => {
      const user = userEvent.setup();
      render(
        <SandboxAgent
          leaseCurrentSpend={12.34}
          maxSpend={100}
          callerEstimatedAgentSpend={3.5}
        />,
      );

      expect(
        screen.queryByText("USD 12.34 of USD 100.00"),
      ).not.toBeInTheDocument();

      await user.click(screen.getByRole("button", { name: /lease budget/i }));

      expect(screen.getByText("USD 12.34 of USD 100.00")).toBeVisible();
      expect(
        screen.getByText(
          "Your Sandbox Space has used an estimated USD 3.50 of the lease budget.",
        ),
      ).toBeVisible();
    });

    it("shows caller loading independently from lease spend", async () => {
      const user = userEvent.setup();
      render(
        <SandboxAgent
          leaseCurrentSpend={10}
          isAgentSpendLoading
          maxSpend={50}
        />,
      );

      await user.click(screen.getByRole("button", { name: /lease budget/i }));

      expect(screen.getByText("USD 10.00 of USD 50.00")).toBeVisible();
      expect(screen.getByText("Loading Sandbox Spaces spend")).toBeVisible();
    });
  });

  it("disables the model selector while responding", () => {
    render(
      <SandboxAgent
        models={[{ modelId: "m0", displayName: "Model Zero" }]}
        selectedModelId="m0"
        onSelectModel={vi.fn()}
        isResponding
      />,
    );

    expect(screen.getByRole("button", { name: /Select model/ })).toBeDisabled();
    expect(
      screen.getByRole("button", { name: /lease budget/i }),
    ).not.toBeDisabled();
  });
});

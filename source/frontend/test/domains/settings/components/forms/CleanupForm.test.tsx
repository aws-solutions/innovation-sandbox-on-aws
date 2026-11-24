// Copyright Amazon.com, Inc. or its affiliates. All Rights Reserved.
// SPDX-License-Identifier: Apache-2.0

import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CleanupForm as CleanupFormFields,
  cleanupFormSearchFields,
} from "@amzn/innovation-sandbox-frontend/domains/settings/components/forms/CleanupForm";
import type { ConfigurationSectionView } from "@amzn/innovation-sandbox-frontend/domains/settings/model";
import { mockAdminConfig } from "@amzn/innovation-sandbox-frontend/mocks/handlers/configurationHandlers";
import { createQueryClientWrapper } from "@amzn/innovation-sandbox-frontend/setupTests";
import { CONFIG_BOUNDS } from "@amzn/innovation-sandbox-shared/types/configuration.js";

import { ConfigurationFormHarness } from "./ConfigurationFormHarness";

function CleanupForm({ data }: { data: ConfigurationSectionView<"cleanup"> }) {
  return (
    <ConfigurationFormHarness section="cleanup" data={data}>
      <CleanupFormFields />
    </ConfigurationFormHarness>
  );
}

const adminUser = {
  status: "authenticated",
  user: { type: "user", email: "a@b.com", userId: "a1", roles: ["Admin"] },
};
const managerUser = {
  status: "authenticated",
  user: { type: "user", email: "m@b.com", userId: "m1", roles: ["Manager"] },
};
const getCurrentUser = vi.fn().mockResolvedValue(adminUser);

vi.mock("@amzn/innovation-sandbox-frontend/helpers/CognitoAuthService", () => ({
  CognitoAuthService: {
    getCurrentUser: () => getCurrentUser(),
    getIdToken: vi.fn().mockResolvedValue("mock-id-token"),
    getCredentials: vi.fn().mockResolvedValue({
      accessKeyId: "test-access-key",
      secretAccessKey: "test-secret-not-a-real-key",
      sessionToken: "test-session-token",
    }),
    login: vi.fn(),
    logout: vi.fn(),
  },
}));

beforeEach(() => {
  vi.clearAllMocks();
  getCurrentUser.mockResolvedValue(adminUser);
});

describe("CleanupForm", () => {
  it("renders exactly the anchors exposed by its search definitions", async () => {
    const { container } = render(
      <CleanupForm data={mockAdminConfig.cleanup} />,
      { wrapper: createQueryClientWrapper() },
    );
    await screen.findByRole("button", { name: /save/i });
    const rendered = Array.from(
      container.querySelectorAll('[id^="setting-cleanup-"]'),
      (element) => element.id,
    );
    expect(rendered).toHaveLength(cleanupFormSearchFields.length);
    expect(new Set(rendered)).toEqual(
      new Set(cleanupFormSearchFields.map((field) => field.id)),
    );
  });

  it("renders editable fields and a Save button for an admin", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    // Save button is unique to the admin view; await it so the user query has
    // resolved before asserting the admin-only field label.
    expect(
      await screen.findByRole("button", { name: /save/i }),
    ).toBeInTheDocument();
    expect(screen.getByText(/account cooldown \(hours\)/i)).toBeInTheDocument();
  });

  it("bounds the cooldown input with the schema min and max", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/account cooldown \(hours\)/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_BOUNDS.MIN_COOLDOWN_PERIOD_HOURS),
    );
    expect(input).toHaveAttribute(
      "max",
      String(CONFIG_BOUNDS.MAX_COOLDOWN_PERIOD_HOURS),
    );
  });

  it("bounds a cleanup retry field with the schema minimum", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/failed attempts before quarantine/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_BOUNDS.MIN_CLEANUP_VALUE),
    );
  });

  it("renders the validation and report-retention fields for an admin", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    expect(
      screen.getByText(/cleanup report retention \(days\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/on validation failure/i)).toBeInTheDocument();
    // The failure-action radio offers both schema enum values.
    expect(
      screen.getByRole("radio", { name: /quarantine/i }),
    ).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: /warn/i })).toBeInTheDocument();
  });

  it("bounds the report-retention input with the schema min and max", async () => {
    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    await screen.findByRole("button", { name: /save/i });

    const input = screen.getByLabelText(/cleanup report retention \(days\)/i);
    expect(input).toHaveAttribute(
      "min",
      String(CONFIG_BOUNDS.MIN_REPORT_RETENTION_DAYS),
    );
    expect(input).toHaveAttribute(
      "max",
      String(CONFIG_BOUNDS.MAX_REPORT_RETENTION_DAYS),
    );
  });

  it("renders cleanup inputs and radio choices read-only for a manager", async () => {
    getCurrentUser.mockResolvedValue(managerUser);

    render(<CleanupForm data={mockAdminConfig.cleanup} />, {
      wrapper: createQueryClientWrapper(),
    });

    expect(
      await screen.findByText(/account cooldown \(hours\)/i),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/cleanup report retention \(days\)/i),
    ).toBeInTheDocument();
    expect(screen.getByText(/on validation failure/i)).toBeInTheDocument();
    for (const input of screen.getAllByRole("spinbutton"))
      expect(input).toHaveAttribute("readonly");
    expect(screen.getByRole("radiogroup")).toHaveAttribute(
      "aria-readonly",
      "true",
    );
    const selected = screen.getByRole("radio", { checked: true });
    const other = screen
      .getAllByRole("radio")
      .find((radio) => radio !== selected)!;
    await userEvent.click(other);
    expect(selected).toBeChecked();
    expect(other).not.toBeChecked();
    expect(
      screen.queryByRole("button", { name: /save/i }),
    ).not.toBeInTheDocument();
  });
});
